import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, formatEmail, formatSms, emptyState, DEFAULT_KINDS } from '../lib/alerts.mjs';
import {
  normStreet, matchesStreet, distanceKm, lifecycle, torontoDayRange, matchesTime,
} from '../lib/disruptions.mjs';

const H = 3600_000;
const now = Date.UTC(2026, 10, 18, 17); // noon Toronto

const rec = (id, over = {}) => ({
  id, road: 'Queen St W', name: `Queen St W from A to B (${id})`, fromRoad: 'Bathurst St', toRoad: 'Spadina Ave', atRoad: null,
  lat: 43.65, lon: -79.4, line: null, start: now - 5 * H, end: now + 72 * H, type: 'CONSTRUCTION', maxImpact: 'Low',
  currImpact: 'Low', ...over,
});
const watch = { id: 'queen st w', query: 'Queen Street West', label: 'Queen Street West' };

test('street normalisation unifies abbreviations and matches whole words for saved streets', () => {
  assert.equal(normStreet('Queen Street West'), 'queen st w');
  assert.equal(normStreet("St. Clair Ave. W"), 'st clair ave w');
  assert.ok(matchesStreet(rec('1'), 'queen street west'));
  assert.ok(matchesStreet(rec('1'), 'quee'));
  assert.ok(!matchesStreet(rec('1'), 'quee', { whole: true }));
  assert.ok(!matchesStreet(rec('1', { road: 'Queensway', name: 'Queensway', fromRoad: null, toRoad: null }), 'Queen', { whole: true }));
  assert.ok(matchesStreet(rec('1'), 'spadina ave', { whole: true }));
});

test('distance, lifecycle and weekday filters', () => {
  assert.ok(Math.abs(distanceKm(43.6532, -79.3832, 43.7615, -79.4111) - 12.3) < 0.5);
  assert.equal(lifecycle(rec('1'), now), 'active');
  assert.equal(lifecycle(rec('1', { start: now + H }), now), 'upcoming');
  assert.equal(lifecycle(rec('1', { end: now - H }), now), 'ended');
  assert.equal(lifecycle(rec('1', { start: null }), now), 'unknown');
  const [a, b] = torontoDayRange(now, 2);
  assert.equal(b - a, 24 * H);
  assert.ok(matchesTime(rec('1'), 'day:2', now));
  assert.ok(!matchesTime(rec('1', { end: now + 6 * H }), 'day:2', now));
});

test('first evaluation is a silent baseline for new/cleared/escalated', () => {
  const { alerts, state } = computeAlerts({ records: [rec('1'), rec('2')], watches: [watch], now });
  assert.deepEqual(alerts, []);
  assert.deepEqual(Object.keys(state.index[watch.id]).sort(), ['1', '2']);
});

test('detects new, escalated and cleared restrictions, and dedupes repeats', () => {
  const first = computeAlerts({ records: [rec('1'), rec('2')], watches: [watch], now });
  const records = [rec('1', { maxImpact: 'High' }), rec('3')];
  const second = computeAlerts({ records, watches: [watch], state: first.state, now: now + 5 * 60_000 });
  assert.deepEqual(second.alerts.map((a) => a.kind), ['escalated', 'new', 'cleared']);
  assert.match(second.alerts[0].detail, /now High impact \(was Low\)/);
  assert.match(second.alerts[2].detail, /no longer in the City feed/);
  const third = computeAlerts({ records, watches: [watch], state: second.state, now: now + 10 * 60_000 });
  assert.deepEqual(third.alerts, []);
});

test('starting/ending soon fire once even without a baseline, and respect chosen kinds', () => {
  const records = [rec('1', { start: now + 6 * H, end: now + 30 * H }), rec('2', { end: now + 4 * H }), rec('3', { start: now + 3 * 24 * H })];
  const { alerts, state } = computeAlerts({ records, watches: [watch], now });
  assert.deepEqual(alerts.map((a) => [a.kind, a.recordId]).sort(), [['ending', '2'], ['starting', '1']]);
  assert.deepEqual(computeAlerts({ records, watches: [watch], state, now: now + 60_000 }).alerts, []);
  const only = computeAlerts({ records, watches: [watch], kinds: ['cleared'], now });
  assert.deepEqual(only.alerts, []);
});

test('ignores ended restrictions and other streets', () => {
  const first = computeAlerts({ records: [], watches: [watch], now });
  const records = [rec('1', { end: now - H }), rec('9', { road: 'King St E', name: 'King St E', fromRoad: null, toRoad: null })];
  assert.deepEqual(computeAlerts({ records, watches: [watch], state: first.state, now }).alerts, []);
});

test('formats email and short SMS messages', () => {
  const alerts = [{ title: 'New restriction on Queen', detail: 'Queen St W — Construction · Low impact' }];
  const email = formatEmail(alerts, { siteUrl: 'https://x.test', unsubscribeUrl: 'https://x.test/unsubscribe?token=t' });
  assert.equal(email.subject, 'StreetWatch: New restriction on Queen');
  assert.match(email.text, /unsubscribe\?token=t/);
  assert.match(email.text, /not field-verified/);
  const many = Array.from({ length: 12 }, (_, i) => ({ title: `Title ${i}`, detail: 'D'.repeat(60) }));
  const sms = formatSms(many);
  assert.ok(sms.length <= 300);
  assert.ok(sms.endsWith('Reply STOP to end.'));
  assert.ok(DEFAULT_KINDS.length === 5 && emptyState().notified);
});
