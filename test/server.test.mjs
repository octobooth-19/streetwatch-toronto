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
