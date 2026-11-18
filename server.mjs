import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { normalizeFeed } from './lib/disruptions.mjs';

export const FEED_URL = 'https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json';

const ROOT = dirname(fileURLToPath(import.meta.url));

const STATIC_FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/map.js': ['public/map.js', 'text/javascript; charset=utf-8'],
  '/lib/disruptions.mjs': ['lib/disruptions.mjs', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https://tile.openstreetmap.org; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

async function readLimited(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`City feed exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetches the City feed with a shared short-lived cache and coalesced
 * concurrent requests. On failure, the last good snapshot is returned as stale.
 */
export function createFeedCache({
  fetchImpl = globalThis.fetch,
  ttlMs = 60_000,
  timeoutMs = 20_000,
  maxBytes = 25 * 1024 * 1024,
  now = Date.now,
} = {}) {
  let snapshot = null; // { records, skipped, retrievedAt }
  let lastAttempt = 0;
  let lastError = null;
  let inflight = null;

  async function fetchFeed() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(FEED_URL, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'StreetWatchToronto/0.1' },
      });
      if (!res.ok) throw new Error(`City feed responded with HTTP ${res.status}`);
      const body = await readLimited(res, maxBytes);
      let json;
      try { json = JSON.parse(body); } catch { throw new Error('City feed returned invalid JSON'); }
      return normalizeFeed(json);
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`City feed timed out after ${timeoutMs} ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function result() {
    return snapshot
      ? { ...snapshot, stale: lastError !== null, error: lastError }
      : { records: null, stale: false, error: lastError, retrievedAt: null };
  }

  async function get() {
    if (now() - lastAttempt < ttlMs && (snapshot || lastError)) return result();
    if (!inflight) {
      inflight = fetchFeed()
        .then((data) => {
          snapshot = { ...data, retrievedAt: now() };
          lastError = null;
        })
        .catch((err) => { lastError = err.message; })
        .finally(() => { lastAttempt = now(); inflight = null; });
    }
    await inflight;
    return result();
  }

  return { get };
}

export function createHandler({ cache = createFeedCache() } = {}) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS }).end();
      return;
    }

    if (url.pathname === '/api/disruptions') {
      const data = await cache.get();
      const status = data.records ? 200 : 502;
      const body = JSON.stringify({
        source: FEED_URL,
        retrievedAt: data.retrievedAt,
        stale: data.stale,
        error: data.error,
        skipped: data.skipped ?? 0,
        records: data.records ?? [],
      });
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...SECURITY_HEADERS,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204, SECURITY_HEADERS).end();
      return;
    }

    const entry = STATIC_FILES[url.pathname];
    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Not found');
      return;
    }
    try {
      const file = await readFile(join(ROOT, entry[0]));
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      res.end(req.method === 'HEAD' ? undefined : file);
    } catch {
      res.writeHead(500, SECURITY_HEADERS).end();
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '127.0.0.1';
  createServer(createHandler()).listen(port, host, () => {
    console.log(`StreetWatch Toronto running at http://${host}:${port}`);
  });
}
