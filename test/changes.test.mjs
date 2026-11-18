import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, mergeChanges, createChangeTracker, CHANGE_RETENTION_MS } from '../lib/changes.mjs';
import { buildIcs } from '../lib/ics.mjs';

const r = (id, maxImpact = 'Low') => ({ id, road: 'Queen St W', name: `Queen ${id}`, maxImpact, type: 'CONSTRUCTION', lat: 43.65, lon: -79.4 });

test('diffSnapshots reports new, escalated and cleared restrictions', () => {
  const events = diffSnapshots([r('1'), r('2', 'Medium'), r('3', 'High')], [r('2', 'High'), r('3', 'Low'), r('4')], 100);
  assert.deepEqual(events.map((e) => `${e.kind}:${e.id}`).sort(), ['cleared:1', 'escalated:2', 'new:4']);
  assert.equal(events.find((e) => e.kind === 'escalated').was, 'Medium');
});

test('change log is deduplicated, newest first and limited to a week', () => {
  const now = 10 * CHANGE_RETENTION_MS;
  const old = { key: 'old', at: now - CHANGE_RETENTION_MS - 1 };
  const a = { key: 'a', at: now - 1000 };
  const b = { key: 'b', at: now - 10 };
  assert.deepEqual(mergeChanges([a, old], [b, a], now).map((e) => e.key), ['b', 'a']);
});

test('tracker treats the first snapshot as a baseline', () => {
  const t = createChangeTracker();
  t.update([r('1')], 1000);
  assert.deepEqual(t.snapshot().events, []);
  t.update([r('1'), r('2')], 2000);
  assert.deepEqual(t.snapshot().events.map((e) => e.id), ['2']);
});

test('ICS export escapes text, folds long lines and skips records without a start', () => {
  const start = Date.UTC(2026, 10, 20, 14);
  const ics = buildIcs({
    id: '9', name: 'Queen St W, from A; to B', road: 'Queen St W', maxImpact: 'High', start, end: null,
    description: 'x'.repeat(200), lat: 43.65, lon: -79.4,
  }, { now: Date.UTC(2026, 10, 18) });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261120T140000Z/);
  assert.match(ics, /DTEND:20261120T150000Z/);
  assert.match(ics, /SUMMARY:High impact: Queen St W\\, from A\\; to B/);
  assert.match(ics, /GEO:43.65;-79.4/);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75);
  assert.equal(buildIcs({ id: '1', start: null }), null);
});
