import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeAddress, validateSubscription, ValidationError, createStore, createProviders,
  createNotifier, createRateLimiter, startWatcher, LIMITS,
} from '../lib/notifier.mjs';

const H = 3600_000;
let clock = Date.UTC(2026, 10, 18, 17);
const now = () => clock;
const rec = (id, over = {}) => ({
  id, road: 'Queen St W', name: `Queen St W (${id})`, fromRoad: null, toRoad: null, atRoad: null,
  start: clock - H, end: clock + 48 * H, maxImpact: 'Low', type: 'CONSTRUCTION', lat: 43.65, lon: -79.4, ...over,
});
const body = (over = {}) => ({
  channel: 'email', address: 'Rider@Example.com', consent: true,
  streets: [{ query: 'Queen Street West', label: 'Queen Street West' }], kinds: ['new', 'cleared'], ...over,
});

function setup() {
  const sent = [];
  const providers = {
    email: { mode: 'demo', send: async (m) => sent.push({ channel: 'email', ...m }) },
    sms: { mode: 'demo', send: async (m) => sent.push({ channel: 'sms', ...m }) },
  };
  const notifier = createNotifier({ store: createStore(), providers, siteUrl: 'https://x.test', now, log: () => {} });
  return { sent, notifier };
}

test('normalises and validates addresses', () => {
  assert.equal(normalizeAddress('email', ' Rider@Example.COM '), 'rider@example.com');
  assert.equal(normalizeAddress('sms', '(416) 555-0123'), '+14165550123');
  assert.equal(normalizeAddress('sms', '1 416 555 0123'), '+14165550123');
  for (const bad of ['nope', 'a@b', 'a b@c.com', '<x>@y.com']) assert.throws(() => normalizeAddress('email', bad), ValidationError);
  for (const bad of ['123', '+44 20 7946 0958', '416 055 0123']) assert.throws(() => normalizeAddress('sms', bad), ValidationError);
});

test('validates subscriptions: consent, street limits, kinds, de-duplication', () => {
  assert.throws(() => validateSubscription(body({ consent: false })), /agree/);
  assert.throws(() => validateSubscription(body({ streets: [] })), /at least one street/);
  assert.throws(() => validateSubscription(body({ kinds: ['bogus'] })), /alert type/);
  assert.throws(() => validateSubscription(body({
    streets: Array.from({ length: LIMITS.maxStreets + 1 }, (_, i) => ({ query: `Street ${i}` })),
  })), /up to/);
  const ok = validateSubscription(body({ streets: [{ query: 'Queen Street West' }, { query: 'queen st w' }] }));
  assert.equal(ok.streets.length, 1);
  assert.equal(ok.address, 'rider@example.com');
});

test('double opt-in: code is required, wrong codes are limited, then alerts are sent once', async () => {
  const { sent, notifier } = setup();
  const { id, demoCode } = await notifier.subscribe(body());
  assert.match(demoCode, /^\d{6}$/);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, new RegExp(demoCode));

  await notifier.evaluate([rec('1')]);
  assert.equal(sent.length, 1, 'pending subscriptions get no alerts');

  await assert.rejects(notifier.confirm({ id, code: '000000' }), /not valid/);
  const { token } = await notifier.confirm({ id, code: demoCode });
  assert.ok(token.length >= 32);

  await notifier.evaluate([rec('1')]); // baseline
  assert.equal(sent.length, 1);
  clock += 15 * 60_000;
  await notifier.evaluate([rec('1'), rec('2')]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].to, 'rider@example.com');
  assert.match(sent[1].subject, /New restriction on Queen Street West/);
  assert.match(sent[1].text, /unsubscribe\?token=/);

  clock += 15 * 60_000;
  await notifier.evaluate([rec('1'), rec('2')]);
  assert.equal(sent.length, 2, 'no repeat for the same change');
});

test('codes expire and lock after repeated failures', async () => {
  const { notifier } = setup();
  const a = await notifier.subscribe(body());
  for (let i = 0; i < LIMITS.maxCodeAttempts; i++) await assert.rejects(notifier.confirm({ id: a.id, code: '111111' }));
  await assert.rejects(notifier.confirm({ id: a.id, code: a.demoCode }), /not valid/);
  const b = await notifier.subscribe(body({ address: 'other@example.com' }));
  clock += LIMITS.codeTtlMs + 1000;
  await assert.rejects(notifier.confirm({ id: b.id, code: b.demoCode }), /not valid/);
});

test('rate limits sign-ups per address and per IP', async () => {
  const { notifier } = setup();
  for (let i = 0; i < LIMITS.maxPendingPerAddress; i++) await notifier.subscribe(body());
  await assert.rejects(notifier.subscribe(body()), (e) => e.status === 429);
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => clock });
  assert.deepEqual([limiter.allow('a'), limiter.allow('a'), limiter.allow('a'), limiter.allow('b')], [true, true, false, true]);
});

test('subscribers can update streets with their token only', async () => {
  const { sent, notifier } = setup();
  const { id, demoCode } = await notifier.subscribe(body());
  await assert.rejects(notifier.update({ token: 'x'.repeat(48), streets: [{ query: 'King St' }] }), /no longer active/);
  const { token } = await notifier.confirm({ id, code: demoCode });
  await assert.rejects(notifier.update({ token, streets: [] }), /at least one street/);
  await notifier.update({ token, streets: [{ query: 'King St E' }], kinds: ['new'] });
  await notifier.evaluate([rec('1', { road: 'King St E', name: 'King St E' })]);
  clock += 15 * 60_000;
  await notifier.evaluate([rec('1', { road: 'King St E', name: 'King St E' }), rec('2', { road: 'King St E', name: 'King St E' })]);
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /King St E/);
});

test('unsubscribe removes the subscription and rejects bad tokens', async () => {
  const { sent, notifier } = setup();
  const { id, demoCode } = await notifier.subscribe(body());
  const { token } = await notifier.confirm({ id, code: demoCode });
  assert.equal(await notifier.unsubscribe('short'), false);
  assert.equal(await notifier.unsubscribe(token), true);
  assert.equal(notifier.activeCount(), 0);
  await notifier.evaluate([rec('1')]);
  assert.equal(sent.length, 1);
});

test('failed deliveries are retried and never counted as sent', async () => {
  let fail = true;
  const sent = [];
  const providers = {
    email: { mode: 'live', send: async (m) => { if (fail && sent.length > 0) throw new Error('boom'); sent.push(m); } },
    sms: { mode: 'demo', send: async () => {} },
  };
  const notifier = createNotifier({ store: createStore(), providers, now, log: () => {} });
  const { id, demoCode } = await notifier.subscribe(body({ kinds: ['new'] })).then(async (r) => ({ id: r.id, demoCode: sent[0].text.match(/\d{6}/)[0] }));
  await notifier.confirm({ id, code: demoCode });
  await notifier.evaluate([rec('1')]);
  clock += 15 * 60_000;
  await notifier.evaluate([rec('1'), rec('2')]);
  assert.equal(sent.length, 1, 'delivery failed');
  fail = false;
  clock += 15 * 60_000;
  await notifier.evaluate([rec('1'), rec('2')]);
  assert.equal(sent.length, 2, 'retried after recovery');
});

test('store persists subscriptions to disk with private permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sw-'));
  try {
    const path = join(dir, 'subs.json');
    const store = createStore(path);
    await store.put({ id: 'a', status: 'active', token: 't'.repeat(40) });
    await store.flush();
    const again = createStore(path);
    await again.load();
    assert.equal(again.get('a').status, 'active');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('providers use demo mode without credentials and call live APIs with them', async () => {
  const logs = [];
  const demo = createProviders({ env: {}, log: (l) => logs.push(l) });
  assert.deepEqual([demo.email.mode, demo.sms.mode], ['demo', 'demo']);
  await demo.sms.send({ to: '+14165550123', text: 'hi' });
  assert.equal(logs.length, 1);

  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
  const live = createProviders({
    env: { RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.ca', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15550001111' },
    fetchImpl,
  });
  assert.deepEqual([live.email.mode, live.sms.mode], ['live', 'live']);
  await live.email.send({ to: 'x@y.ca', subject: 's', text: 't' });
  await live.sms.send({ to: '+14165550123', text: 't' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.deepEqual(JSON.parse(calls[0].init.body).to, ['x@y.ca']);
  assert.match(calls[1].url, /api\.twilio\.com.*AC1.*Messages\.json/);
  assert.equal(calls[1].init.body.get('From'), '+15550001111');
  const failing = createProviders({ env: { RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.ca' }, fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(failing.email.send({ to: 'x@y.ca', subject: 's', text: 't' }), /HTTP 500/);
});

test('watcher evaluates once per fresh snapshot and skips stale data', async () => {
  const { notifier } = setup();
  const { id, demoCode } = await notifier.subscribe(body());
  await notifier.confirm({ id, code: demoCode });
  let data = { records: [rec('1')], retrievedAt: 1, stale: false };
  let evaluations = 0;
  const spy = { activeCount: () => 1, evaluate: async (r) => { evaluations++; return notifier.evaluate(r); } };
  const w = startWatcher({ cache: { get: async () => data }, notifier: spy, intervalMs: 3600_000, log: () => {} });
  await w.tick(); await w.tick();
  assert.equal(evaluations, 1);
  data = { ...data, stale: true, retrievedAt: 2 };
  await w.tick();
  assert.equal(evaluations, 1);
  data = { records: [rec('1')], retrievedAt: 3, stale: false };
  await w.tick();
  assert.equal(evaluations, 2);
  w.stop();
});
