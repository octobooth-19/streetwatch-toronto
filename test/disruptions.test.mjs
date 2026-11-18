import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEpoch, parsePolyline, safeUrl, normalizeRecord, normalizeFeed,
  torontoDayWindow, torontoMidnight, matchesTime, filterRecords,
} from '../lib/disruptions.mjs';

const base = {
  id: '1', road: 'Queen St W', name: 'Queen St W from Bathurst St to Spadina Ave',
  latitude: '43.65', longitude: '-79.40', startTime: '1795345200000', endTime: '1795388400000',
  type: 'CONSTRUCTION', maxImpact: 'High', currImpact: 'Low',
  geoPolyline: '[-79.40,43.65],[-79.39,43.651]', URL: 'https://www.toronto.ca/x',
};

test('parses millisecond epoch strings and rejects junk', () => {
  assert.equal(parseEpoch('1795345200000'), 1795345200000);
  for (const v of [null, '', 'null', 'abc', '12.5', '0']) assert.equal(parseEpoch(v), null);
});

test('normalizes records, flagging invalid coordinates and geometry', () => {
  const r = normalizeRecord(base);
  assert.deepEqual([r.lat, r.lon], [43.65, -79.4]);
  assert.deepEqual(r.line, [[43.65, -79.4], [43.651, -79.39]]);
  const bad = normalizeRecord({ ...base, latitude: '0', longitude: 'x', geoPolyline: '[oops', type: null, maxImpact: '' });
  assert.equal(bad.lat, null);
  assert.equal(bad.line, null);
  assert.equal(bad.type, 'Unknown');
  assert.equal(bad.maxImpact, 'Unknown');
  assert.equal(parsePolyline('[-79.4,43.65]'), null);
});

test('only allows http(s) source links', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('not a url'), null);
  assert.equal(safeUrl('https://toronto.ca/a'), 'https://toronto.ca/a');
});

test('normalizeFeed rejects unexpected shapes and drops duplicate/invalid ids', () => {
  assert.throws(() => normalizeFeed({}), /Closure/);
  const { records, skipped } = normalizeFeed({ Closure: [base, base, { id: null }] });
  assert.equal(records.length, 1);
  assert.equal(skipped, 2);
});

test('Toronto day windows follow local midnight, including DST changes', () => {
  // 2026-03-08 is a 23-hour day (spring forward); 2026-11-01 is 25 hours.
  assert.equal(torontoMidnight(2026, 3, 8), Date.UTC(2026, 2, 8, 5));
  assert.equal(torontoMidnight(2026, 3, 9), Date.UTC(2026, 2, 9, 4));
  const [a, b] = torontoDayWindow(Date.UTC(2026, 2, 8, 17), 1);
  assert.equal(b - a, 23 * 3600_000);
  const [c, d] = torontoDayWindow(Date.UTC(2026, 10, 1, 17), 1);
  assert.equal(d - c, 25 * 3600_000);
  // 11pm Toronto on Nov 18 is already Nov 19 in UTC, but still "today" locally.
  const [e] = torontoDayWindow(Date.UTC(2026, 10, 19, 4), 1);
  assert.equal(e, Date.UTC(2026, 10, 18, 5));
});

test('time filters: active now, today, next 7 days, unknown', () => {
  const now = Date.UTC(2026, 10, 18, 17); // noon Toronto
  const h = 3600_000;
  const rec = (start, end) => ({ ...normalizeRecord(base), start, end });
  const current = rec(now - h, now + h);
  const expired = rec(now - 10 * h, now - 9 * h); // 3am today
  const laterToday = rec(now + 5 * h, now + 6 * h);
  const nextWeek = rec(now + 4 * 24 * h, null);
  const farFuture = rec(now + 9 * 24 * h, now + 10 * 24 * h);
  const unknown = rec(null, null);
  const all = [current, expired, laterToday, nextWeek, farFuture, unknown];
  const pick = (f) => all.filter((r) => matchesTime(r, f, now));
  assert.deepEqual(pick('now'), [current]);
  assert.deepEqual(pick('today'), [current, expired, laterToday]);
  assert.deepEqual(pick('week'), [current, expired, laterToday, nextWeek]);
  assert.deepEqual(pick('unknown'), [unknown]);
  assert.equal(pick('all').length, all.length);
});

test('filterRecords combines search, type and impact', () => {
  const a = normalizeRecord(base);
  const b = normalizeRecord({ ...base, id: '2', road: 'Bloor St', name: 'Bloor St at Yonge', type: 'ROAD_CLOSED', maxImpact: 'Low' });
  const now = 1795345200000 + 1000;
  assert.deepEqual(filterRecords([a, b], { query: 'spadina' }, now).map((r) => r.id), ['1']);
  assert.deepEqual(filterRecords([a, b], { query: 'BLOOR' }, now).map((r) => r.id), ['2']);
  assert.deepEqual(filterRecords([a, b], { type: 'ROAD_CLOSED' }, now).map((r) => r.id), ['2']);
  assert.deepEqual(filterRecords([a, b], { impact: 'High' }, now).map((r) => r.id), ['1']);
});
