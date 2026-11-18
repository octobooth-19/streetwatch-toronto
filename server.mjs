import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, extname, resolve, sep } from 'node:path';
import { normalizeFeed } from './lib/disruptions.mjs';
import { createChangeTracker } from './lib/changes.mjs';
import { createNotifier, createProviders, createStore, startWatcher, ValidationError } from './lib/notifier.mjs';

export const FEED_URL = 'https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
// Only these shared modules are exposed to browsers; server-only code stays private.
const SHARED_LIB = new Set(['disruptions.mjs', 'alerts.mjs', 'changes.mjs', 'ics.mjs']);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' https://tile.openstreetmap.org; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
  timeoutMs = 45_000,
  maxBytes = 25 * 1024 * 1024,
  now = Date.now,
  onSnapshot = null,
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
          onSnapshot?.(snapshot);
        })
        .catch((err) => { lastError = err.message; })
        .finally(() => { lastAttempt = now(); inflight = null; });
    }
    await inflight;
    return result();
  }

  return { get };
}

const PAGE = (title, body) => `<!doctype html><html lang="en-CA"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="./styles.css"></head><body class="plain-page"><main class="plain-card">${body}</main></body></html>`;

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

async function readBody(req, maxBytes = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('Request too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function sendFile(res, req, file, type) {
  const data = await readFile(file);
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
  res.end(req.method === 'HEAD' ? undefined : data);
}

export function createHandler({
  cache = createFeedCache(), notifier = null, changes = null,
  allowedOrigin = process.env.ALLOWED_ORIGIN || '', trustProxy = process.env.TRUST_PROXY === '1', siteUrl = '',
} = {}) {
  const cors = allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin' } : {};
  const json = (res, status, body, extra = {}) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...cors, ...extra,
    });
    res.end(JSON.stringify(body));
  };

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const { pathname } = url;

      if (req.method === 'OPTIONS' && allowedOrigin) {
        res.writeHead(204, {
          ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400', ...SECURITY_HEADERS,
        }).end();
        return;
      }

      if (req.method === 'POST') return await handlePost(req, res, pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD, POST', ...SECURITY_HEADERS }).end();
        return;
      }

      if (pathname === '/api/disruptions' || pathname === '/data/disruptions.json') {
        const data = await cache.get();
        const body = JSON.stringify({
          source: FEED_URL, retrievedAt: data.retrievedAt, stale: data.stale, error: data.error,
          skipped: data.skipped ?? 0, records: data.records ?? [],
        });
        res.writeHead(data.records ? 200 : 502, {
          'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...cors,
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }

      if (pathname === '/data/changes.json') {
        return json(res, 200, changes ? changes.snapshot() : { generatedAt: null, events: [] });
      }

      if (pathname === '/config.json') {
        const modes = notifier?.modes();
        return json(res, 200, {
          mode: 'live',
          notifications: notifier
            ? { email: modes.email, sms: modes.sms }
            : { email: 'unavailable', sms: 'unavailable' },
        });
      }

      if (pathname === '/unsubscribe') {
        const token = url.searchParams.get('token') ?? '';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
        res.end(PAGE('Stop StreetWatch alerts', `<h1>Stop StreetWatch alerts?</h1>
<p>You will no longer receive notifications about your saved streets.</p>
<form method="post" action="./unsubscribe"><input type="hidden" name="token" value="${encodeURIComponent(token)}">
<button class="btn" type="submit">Yes, stop alerts</button></form>`));
        return;
      }

      if (pathname === '/favicon.ico') {
        res.writeHead(204, SECURITY_HEADERS).end();
        return;
      }

      const file = await resolveStatic(pathname);
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }).end('Not found');
        return;
      }
      await sendFile(res, req, file.path, file.type);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      json(res, err.status ?? 500, { error: err.status ? err.message : 'Something went wrong.' });
    }
  };

  async function resolveStatic(pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (decoded.includes('\0')) return null;
    const lib = /^\/lib\/([\w.-]+)$/.exec(decoded);
    let target;
    if (lib) target = SHARED_LIB.has(lib[1]) ? join(ROOT, 'lib', lib[1]) : null;
    else target = resolve(PUBLIC_DIR, `.${decoded === '/' ? '/index.html' : decoded}`);
    if (!target || (!lib && !target.startsWith(PUBLIC_DIR + sep))) return null;
    const type = TYPES[extname(target)];
    if (!type) return null;
    try {
      if (!(await stat(target)).isFile()) return null;
    } catch { return null; }
    return { path: target, type };
  }

  async function handlePost(req, res, pathname) {
    if (!notifier) return json(res, 503, { error: 'Email and SMS alerts are not enabled on this server.' });
    const ip = clientIp(req, trustProxy);

    if (pathname === '/unsubscribe') {
      const form = new URLSearchParams(await readBody(req));
      const done = await notifier.unsubscribe(decodeURIComponent(form.get('token') ?? ''));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
      res.end(PAGE('Alerts stopped', done
        ? '<h1>Alerts stopped</h1><p>You will not receive any more StreetWatch messages.</p>'
        : '<h1>Already stopped</h1><p>This link is no longer active.</p>'));
      return;
    }

    if (!['/api/subscriptions', '/api/subscriptions/confirm', '/api/subscriptions/update', '/api/subscriptions/unsubscribe'].includes(pathname)) {
      return json(res, 404, { error: 'Not found' });
    }
    // A JSON content type forces a CORS preflight, so other sites cannot submit these forms blindly.
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return json(res, 415, { error: 'Content-Type must be application/json.' });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (err) {
      if (err.status) throw err;
      return json(res, 400, { error: 'Invalid JSON.' });
    }
    try {
      if (pathname === '/api/subscriptions') return json(res, 201, await notifier.subscribe(body, ip));
      if (pathname === '/api/subscriptions/confirm') return json(res, 200, await notifier.confirm(body ?? {}, ip));
      if (pathname === '/api/subscriptions/update') return json(res, 200, await notifier.update(body ?? {}));
      return json(res, 200, { removed: await notifier.unsubscribe(body?.token) });
    } catch (err) {
      if (err instanceof ValidationError) return json(res, 400, { error: err.message });
      if (err.status) return json(res, err.status, { error: err.message });
      console.error(`Subscription request failed: ${err.message}`);
      return json(res, 502, { error: 'We could not send the message. Please try again later.' });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '127.0.0.1';
  const dataDir = process.env.DATA_DIR || join(ROOT, '.data');
  const changes = createChangeTracker();
  const cache = createFeedCache({ onSnapshot: (s) => changes.update(s.records, s.retrievedAt) });
  const store = createStore(join(dataDir, 'subscriptions.json'));
  await store.load();
  const providers = createProviders({ outboxPath: join(dataDir, 'outbox.log') });
  const siteUrl = process.env.SITE_URL || `http://${host}:${port}`;
  const notifier = createNotifier({ store, providers, siteUrl });
  startWatcher({ cache, notifier });
  createServer(createHandler({ cache, notifier, changes, siteUrl })).listen(port, host, () => {
    const { email, sms } = notifier.modes();
    console.log(`StreetWatch Toronto running at http://${host}:${port} (email: ${email}, sms: ${sms})`);
  });
}
