import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFeedCache, createHandler } from '../server.mjs';

const feed = { Closure: [{ id: '1', road: 'Queen St W', startTime: '1795345200000' }] };
const ok = (body = feed) => async () => new Response(JSON.stringify(body), { status: 200 });

function clock(t = 0) { const c = () => c.t; c.t = t; return c; }

test('caches results and coalesces concurrent requests', async () => {
  let calls = 0;
  const now = clock();
  const cache = createFeedCache({ now, ttlMs: 60_000, fetchImpl: async (...a) => { calls++; return ok()(...a); } });
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(calls, 1);
  assert.equal(a.records.length, 1);
  assert.equal(b.records.length, 1);
  await cache.get();
  assert.equal(calls, 1);
  now.t = 61_000;
  await cache.get();
  assert.equal(calls, 2);
});

test('reports non-200, malformed and timeout errors with no snapshot', async () => {
  const cases = [
    [async () => new Response('nope', { status: 403 }), /HTTP 403/],
    [async () => new Response('{not json', { status: 200 }), /invalid JSON/],
    [async () => new Response('{"x":1}', { status: 200 }), /Closure/],
    [(url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
    })), /timed out/],
  ];
  for (const [fetchImpl, pattern] of cases) {
    const r = await createFeedCache({ fetchImpl, timeoutMs: 20 }).get();
    assert.equal(r.records, null);
    assert.match(r.error, pattern);
  }
});

test('enforces the response size limit', async () => {
  const r = await createFeedCache({ fetchImpl: ok(), maxBytes: 10 }).get();
  assert.match(r.error, /exceeded/);
});

test('serves the last good snapshot as stale when refresh fails', async () => {
  const now = clock();
  let fail = false;
  const cache = createFeedCache({
    now, ttlMs: 1000,
    fetchImpl: async () => (fail ? new Response('', { status: 500 }) : ok()()),
  });
  const first = await cache.get();
  assert.equal(first.stale, false);
  fail = true;
  now.t = 5000;
  const second = await cache.get();
  assert.equal(second.stale, true);
  assert.equal(second.records.length, 1);
  assert.equal(second.retrievedAt, 0);
  assert.match(second.error, /HTTP 500/);
});

test('API returns 502 when unavailable, 200 with records otherwise; unknown paths 404', async () => {
  const run = async (cache, path) => {
    const server = createServer(createHandler({ cache })).listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      return await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    } finally { server.close(); }
  };
  const down = await run({ get: async () => ({ records: null, error: 'boom', stale: false }) }, '/api/disruptions');
  assert.equal(down.status, 502);
  assert.equal((await down.json()).error, 'boom');
  const up = await run({ get: async () => ({ records: [{ id: '1' }], stale: false, error: null, retrievedAt: 1 }) }, '/api/disruptions');
  assert.equal(up.status, 200);
  assert.equal((await up.json()).records.length, 1);
  assert.equal((await run({ get: async () => ({}) }, '/../server.mjs')).status, 404);
  assert.equal((await run({ get: async () => ({}) }, '/')).status, 200);
});

import { createStore, createNotifier } from '../lib/notifier.mjs';
import { createChangeTracker } from '../lib/changes.mjs';

async function withServer(options, fn) {
  const server = createServer(createHandler(options)).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}

const post = (base, path, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(`${base}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('serves only allow-listed static files and shared modules', async () => {
  await withServer({ cache: { get: async () => ({}) } }, async (base) => {
    for (const [path, status] of [
      ['/lib/disruptions.mjs', 200], ['/lib/alerts.mjs', 200], ['/lib/notifier.mjs', 404], ['/lib/..%2fserver.mjs', 404],
      ['/server.mjs', 404], ['/package.json', 404], ['/%2e%2e/server.mjs', 404], ['/styles.css', 200], ['/app.js', 200],
    ]) assert.equal((await fetch(`${base}${path}`)).status, status, path);
    const res = await fetch(`${base}/`);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

test('config reports notification availability; change log is served', async () => {
  const changes = createChangeTracker();
  changes.update([{ id: '1', maxImpact: 'Low' }], 1000);
  changes.update([{ id: '1', maxImpact: 'High' }, { id: '2', maxImpact: 'Low' }], 2000);
  await withServer({ cache: { get: async () => ({}) }, changes }, async (base) => {
    assert.deepEqual((await (await fetch(`${base}/config.json`)).json()).notifications, { email: 'unavailable', sms: 'unavailable' });
    const log = await (await fetch(`${base}/data/changes.json`)).json();
    assert.deepEqual(log.events.map((e) => e.kind).sort(), ['escalated', 'new']);
    assert.equal((await post(base, '/api/subscriptions', {})).status, 503);
  });
});

test('subscription API: validation, content type, body limit, confirm and unsubscribe', async () => {
  const sent = [];
  const providers = {
    email: { mode: 'demo', send: async (m) => sent.push(m) },
    sms: { mode: 'demo', send: async (m) => sent.push(m) },
  };
  const notifier = createNotifier({ store: createStore(), providers, siteUrl: 'https://x.test', log: () => {} });
  await withServer({ cache: { get: async () => ({}) }, notifier }, async (base) => {
    assert.deepEqual((await (await fetch(`${base}/config.json`)).json()).notifications, { email: 'demo', sms: 'demo' });
    const valid = { channel: 'email', address: 'a@example.com', consent: true, streets: [{ query: 'Queen St W' }], kinds: ['new'] };

    assert.equal((await post(base, '/api/subscriptions', valid, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post(base, '/api/subscriptions', '{oops')).status, 400);
    assert.equal((await post(base, '/api/subscriptions', { ...valid, consent: false })).status, 400);
    assert.equal((await post(base, '/api/subscriptions', 'x'.repeat(5000))).status, 413);
    assert.equal(sent.length, 0);

    const created = await post(base, '/api/subscriptions', valid);
    assert.equal(created.status, 201);
    const { id, demoCode } = await created.json();
    assert.equal((await post(base, '/api/subscriptions/confirm', { id, code: '999999' })).status, 400);
    const confirmed = await post(base, '/api/subscriptions/confirm', { id, code: demoCode });
    assert.equal(confirmed.status, 200);
    const { token } = await confirmed.json();

    const page = await fetch(`${base}/unsubscribe?token=${token}"><script>`);
    assert.equal(page.status, 200);
    assert.doesNotMatch(await page.text(), /<script>/);
    const done = await post(base, '/unsubscribe', `token=${token}`, { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.match(await done.text(), /Alerts stopped/);
    assert.equal(notifier.activeCount(), 0);
  });
});

test('CORS is only enabled for the configured origin', async () => {
  await withServer({ cache: { get: async () => ({}) }, allowedOrigin: 'https://app.example' }, async (base) => {
    const pre = await fetch(`${base}/api/subscriptions`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://app.example');
  });
  await withServer({ cache: { get: async () => ({}) }, allowedOrigin: '' }, async (base) => {
    assert.equal((await fetch(`${base}/config.json`)).headers.get('access-control-allow-origin'), null);
  });
});
