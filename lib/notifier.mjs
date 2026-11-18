// Email / SMS alert service: double opt-in subscriptions, rate limits, provider adapters.
// Providers are configured through environment variables; without credentials the
// service runs in demo mode (messages are logged, not delivered) and says so.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { computeAlerts, formatEmail, formatSms, DEFAULT_KINDS, ALERT_KINDS, emptyState } from './alerts.mjs';
import { normStreet } from './disruptions.mjs';

const MIN = 60_000;
const DAY = 86_400_000;
export const LIMITS = {
  maxStreets: 10, codeTtlMs: 15 * MIN, maxCodeAttempts: 5,
  minGapMs: 10 * MIN, maxPerDay: 12, maxPendingPerAddress: 3,
};

export class ValidationError extends Error {}

// ---------- validation ----------

export function normalizeAddress(channel, raw) {
  const s = String(raw ?? '').trim();
  if (channel === 'email') {
    const email = s.toLowerCase();
    if (email.length > 254 || !/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/.test(email)) {
      throw new ValidationError('Enter a valid email address.');
    }
    return email;
  }
  if (channel === 'sms') {
    const digits = s.replace(/[\s().-]/g, '');
    const e164 = /^\d{10}$/.test(digits) ? `+1${digits}` : /^1\d{10}$/.test(digits) ? `+${digits}` : digits;
    // Canadian / US numbers only: limits cost and toll-fraud exposure.
    if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164)) {
      throw new ValidationError('Enter a Canadian or US mobile number, e.g. 416 555 0123.');
    }
    return e164;
  }
  throw new ValidationError('Choose email or SMS.');
}

export function validateSubscription(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('Invalid request.');
  const channel = body.channel;
  const address = normalizeAddress(channel, body.address);
  if (body.consent !== true) {
    throw new ValidationError('Please confirm you agree to receive alerts. You can stop them at any time.');
  }
  if (!Array.isArray(body.streets) || body.streets.length === 0) {
    throw new ValidationError('Save at least one street first.');
  }
  if (body.streets.length > LIMITS.maxStreets) {
    throw new ValidationError(`You can follow up to ${LIMITS.maxStreets} streets.`);
  }
  const seen = new Set();
  const streets = [];
  for (const s of body.streets) {
    const query = String(s?.query ?? '').trim();
    const label = String(s?.label ?? query).trim().slice(0, 60);
    const id = normStreet(query);
    if (query.length < 2 || query.length > 60 || !id) throw new ValidationError('Street names must be 2–60 characters.');
    if (seen.has(id)) continue;
    seen.add(id);
    streets.push({ id, query, label: label || query });
  }
  const kinds = Array.isArray(body.kinds) ? [...new Set(body.kinds)] : DEFAULT_KINDS;
  if (!kinds.length || kinds.some((k) => !(k in ALERT_KINDS))) {
    throw new ValidationError('Choose at least one valid alert type.');
  }
  return { channel, address, streets, kinds };
}

// ---------- storage ----------

export function createStore(path = null) {
  const subs = new Map();
  let queue = Promise.resolve();

  const persist = () => {
    if (!path) return Promise.resolve();
    queue = queue.then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify([...subs.values()]), { mode: 0o600 });
      await rename(tmp, path);
    });
    return queue;
  };

  return {
    async load() {
      if (!path) return;
      try {
        for (const s of JSON.parse(await readFile(path, 'utf8'))) subs.set(s.id, s);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    },
    all: () => [...subs.values()],
    get: (id) => subs.get(id),
    findByToken: (token) => [...subs.values()].find((s) => s.token === token),
    put(sub) { subs.set(sub.id, sub); return persist(); },
    delete(id) { subs.delete(id); return persist(); },
    flush: () => queue,
  };
}

// ---------- providers ----------

export function createProviders({ env = process.env, fetchImpl = globalThis.fetch, outboxPath = null, log = console.log } = {}) {
  const demo = (channel) => ({
    mode: 'demo',
    async send(msg) {
      const line = { at: new Date().toISOString(), channel, ...msg };
      log(`[demo ${channel}] to=${msg.to} ${msg.subject ?? ''} ${msg.text.replace(/\s+/g, ' ').slice(0, 160)}`);
      if (outboxPath) {
        await mkdir(dirname(outboxPath), { recursive: true });
        await appendFile(outboxPath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      }
    },
  });

  const email = env.RESEND_API_KEY && env.MAIL_FROM
    ? {
      mode: 'live',
      async send({ to, subject, text }) {
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
        });
        if (!res.ok) throw new Error(`Email provider responded with HTTP ${res.status}`);
      },
    }
    : demo('email');

  const hasTwilio = env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID);
  const sms = hasTwilio
    ? {
      mode: 'live',
      async send({ to, text }) {
        const form = new URLSearchParams({ To: to, Body: text });
        if (env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
        else form.set('From', env.TWILIO_FROM);
        const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
        const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form,
        });
        if (!res.ok) throw new Error(`SMS provider responded with HTTP ${res.status}`);
      },
    }
    : demo('sms');

  return { email, sms };
}

// ---------- rate limiting ----------

export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= limit) { hits.set(key, recent); return false; }
      recent.push(t);
      hits.set(key, recent);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
      return true;
    },
  };
}

// ---------- service ----------

const hashCode = (id, code) => createHash('sha256').update(`${id}:${code}`).digest();

export function createNotifier({ store, providers, siteUrl = '', now = Date.now, log = console.error } = {}) {
  const subscribeByIp = createRateLimiter({ limit: 10, windowMs: 60 * MIN, now });
  const subscribeByAddress = createRateLimiter({ limit: LIMITS.maxPendingPerAddress, windowMs: 60 * MIN, now });
  const confirmByIp = createRateLimiter({ limit: 30, windowMs: 15 * MIN, now });
  let lastEvaluated = null;

  const unsubscribeUrl = (sub) => `${siteUrl}/unsubscribe?token=${sub.token}`;

  return {
    modes: () => ({ email: providers.email.mode, sms: providers.sms.mode }),
    activeCount: () => store.all().filter((s) => s.status === 'active').length,

    async subscribe(body, ip = 'unknown') {
      const input = validateSubscription(body);
      if (!subscribeByIp.allow(ip) || !subscribeByAddress.allow(`${input.channel}:${input.address}`)) {
        throw Object.assign(new Error('Too many attempts. Please try again later.'), { status: 429 });
      }
      const id = randomBytes(12).toString('hex');
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const sub = {
        id, ...input, status: 'pending', token: randomBytes(24).toString('hex'),
        codeHash: hashCode(id, code).toString('hex'), codeExpires: now() + LIMITS.codeTtlMs, attempts: 0,
        created: now(), lastSent: 0, sent: { day: 0, count: 0 }, state: emptyState(),
      };
      const provider = providers[input.channel];
      const text = `Your StreetWatch Toronto code is ${code}. It expires in 15 minutes. If you didn't ask for this, ignore it.`;
      await provider.send({ to: input.address, subject: 'Your StreetWatch Toronto verification code', text });
      await store.put(sub);
      return { id, mode: provider.mode, ...(provider.mode === 'demo' ? { demoCode: code } : {}) };
    },

    async confirm({ id, code }, ip = 'unknown') {
      if (!confirmByIp.allow(ip)) throw Object.assign(new Error('Too many attempts. Please try again later.'), { status: 429 });
      const sub = store.get(String(id));
      const fail = () => new ValidationError('That code is not valid. Request a new one.');
      if (!sub || sub.status !== 'pending' || now() > sub.codeExpires || sub.attempts >= LIMITS.maxCodeAttempts) {
        throw fail();
      }
      sub.attempts += 1;
      const ok = /^\d{6}$/.test(String(code)) && timingSafeEqual(hashCode(sub.id, String(code)), Buffer.from(sub.codeHash, 'hex'));
      if (!ok) { await store.put(sub); throw fail(); }
      for (const other of store.all()) {
        if (other.id !== sub.id && other.channel === sub.channel && other.address === sub.address) await store.delete(other.id);
      }
      sub.status = 'active';
      sub.codeHash = null;
      await store.put(sub);
      return { token: sub.token, channel: sub.channel };
    },

    async unsubscribe(token) {
      const sub = typeof token === 'string' && token.length >= 32 ? store.findByToken(token) : null;
      if (!sub) return false;
      await store.delete(sub.id);
      return true;
    },

    /** Lets a confirmed subscriber change streets or alert types; the unguessable token is the credential. */
    async update({ token, streets, kinds }) {
      const sub = typeof token === 'string' && token.length >= 32 ? store.findByToken(token) : null;
      if (!sub || sub.status !== 'active') throw new ValidationError('This subscription is no longer active.');
      const next = validateSubscription({ channel: sub.channel, address: sub.address, consent: true, streets, kinds });
      sub.streets = next.streets;
      sub.kinds = next.kinds;
      await store.put(sub);
      return { streets: sub.streets.length };
    },

    /** Evaluates every active subscription against the latest records and sends batched alerts. */
    async evaluate(records) {
      const t = now();
      const day = Math.floor(t / DAY);
      let sent = 0;
      for (const sub of store.all()) {
        if (sub.status === 'pending' && t > sub.codeExpires + DAY) { await store.delete(sub.id); continue; }
        if (sub.status !== 'active') continue;
        if (t - sub.lastSent < LIMITS.minGapMs) continue;
        if (sub.sent.day === day && sub.sent.count >= LIMITS.maxPerDay) continue;
        const { alerts, state } = computeAlerts({ records, watches: sub.streets, kinds: sub.kinds, state: sub.state, now: t });
        if (alerts.length === 0) { sub.state = state; await store.put(sub); continue; }

        const shown = alerts.slice(0, 8);
        const more = alerts.length - shown.length;
        const batch = more > 0
          ? [...shown, { title: `…and ${more} more`, detail: 'Open StreetWatch Toronto for the full list.' }]
          : shown;
        try {
          if (sub.channel === 'email') {
            const { subject, text } = formatEmail(batch, { siteUrl, unsubscribeUrl: unsubscribeUrl(sub) });
            await providers.email.send({ to: sub.address, subject, text });
          } else {
            await providers.sms.send({ to: sub.address, text: formatSms(batch) });
          }
        } catch (err) {
          log(`Alert delivery failed for ${sub.id}: ${err.message}`);
          continue; // keep the old state so the alerts are retried next cycle
        }
        sub.state = state;
        sub.lastSent = t;
        sub.sent = { day, count: (sub.sent.day === day ? sub.sent.count : 0) + 1 };
        await store.put(sub);
        sent += 1;
      }
      lastEvaluated = t;
      return { sent, at: lastEvaluated };
    },
  };
}

/** Polls the feed cache and evaluates subscriptions whenever a fresh snapshot arrives. */
export function startWatcher({ cache, notifier, intervalMs = 5 * MIN, log = console.error }) {
  let lastRetrieved = null;
  let running = false;
  const tick = async () => {
    if (running || notifier.activeCount() === 0) return;
    running = true;
    try {
      const data = await cache.get();
      if (data.records && !data.stale && data.retrievedAt !== lastRetrieved) {
        lastRetrieved = data.retrievedAt;
        await notifier.evaluate(data.records);
      }
    } catch (err) {
      log(`Alert watcher error: ${err.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
