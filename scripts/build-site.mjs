// Builds the static site (GitHub Pages) into dist/: the web app, a fresh snapshot of the City feed,
// a 7-day change log (by diffing against the previously published snapshot) and per-street Atom feeds.
//
//   node scripts/build-site.mjs [--out dist] [--feed-file path/to/feed.json]
//   SITE_URL=https://example.github.io/streetwatch-toronto/ node scripts/build-site.mjs

import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { normalizeFeed, normStreet, matchesStreet, lifecycle, formatTorontoTime } from '../lib/disruptions.mjs';
import { diffSnapshots, mergeChanges } from '../lib/changes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FEED_URL = 'https://secure.toronto.ca/opendata/cart/road_restrictions/v3?format=json';
const SHARED_LIB = ['disruptions.mjs', 'alerts.mjs', 'changes.mjs', 'ics.mjs'];
const MIN_RECORDS = 100; // a feed smaller than this is treated as a failure, so a bad fetch never replaces good data
const MAX_FEEDS = 3000;
const KIND = { new: 'New', escalated: 'Impact increased', cleared: 'Cleared' };

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const out = join(ROOT, opt('out', 'dist'));
const siteUrl = (process.env.SITE_URL || 'https://octobooth-19.github.io/streetwatch-toronto/').replace(/\/?$/, '/');

async function fetchJson(url, { timeoutMs = 90_000, retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json', 'User-Agent': 'StreetWatchToronto/1.0 (+https://github.com/octobooth-19/streetwatch-toronto)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn(`fetch ${url} failed (attempt ${attempt}/${retries}): ${err.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastErr;
}

const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const iso = (ms) => new Date(ms).toISOString();

function atom({ title, id, url, updated, entries, subtitle }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(title)}</title>
  <subtitle>${esc(subtitle)}</subtitle>
  <id>${esc(id)}</id>
  <updated>${iso(updated)}</updated>
  <link rel="self" href="${esc(url)}"/>
  <link rel="alternate" href="${esc(siteUrl)}"/>
${entries.map((e) => `  <entry>
    <id>${esc(e.id)}</id>
    <title>${esc(e.title)}</title>
    <updated>${iso(e.updated)}</updated>
    <link href="${esc(e.link)}"/>
    <summary>${esc(e.summary)}</summary>
  </entry>`).join('\n')}
</feed>
`;
}

function recordEntry(r, now) {
  const when = r.start !== null && r.start > now ? `starts ${formatTorontoTime(r.start)}`
    : r.end !== null ? `ends ${formatTorontoTime(r.end)}` : 'no end date reported';
  return {
    id: `urn:streetwatch:${r.id}:${r.lastUpdated ?? 0}:${r.maxImpact}`,
    title: `${r.name ?? r.road ?? 'Road restriction'} (${r.maxImpact} impact)`,
    updated: r.lastUpdated ?? now,
    link: `${siteUrl}#id=${encodeURIComponent(r.id)}&time=all`,
    summary: [r.description, `${r.type.replace(/_/g, ' ').toLowerCase()}, ${when}.`, 'Reported by applicants; not field-verified.']
      .filter(Boolean).join(' '),
  };
}

async function previousSnapshot() {
  const prev = { records: null, events: [] };
  try { prev.records = (await fetchJson(`${siteUrl}data/disruptions.json?t=${Date.now()}`, { timeoutMs: 30_000, retries: 1 })).records; } catch { /* first deploy */ }
  try { prev.events = (await fetchJson(`${siteUrl}data/changes.json?t=${Date.now()}`, { timeoutMs: 30_000, retries: 1 })).events ?? []; } catch { /* first deploy */ }
  return prev;
}

async function main() {
  const feedFile = opt('feed-file');
  const raw = feedFile ? JSON.parse(await readFile(feedFile, 'utf8')) : await fetchJson(FEED_URL);
  const { records, skipped } = normalizeFeed(raw);
  if (records.length < MIN_RECORDS) throw new Error(`City feed returned only ${records.length} records; refusing to publish.`);

  const now = Date.now();
  const prev = feedFile ? { records: null, events: [] } : await previousSnapshot();
  const events = prev.records ? diffSnapshots(prev.records, records, now) : [];
  const changes = { generatedAt: now, events: mergeChanges(prev.events, events, now) };

  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'lib'), { recursive: true });
  await mkdir(join(out, 'data'), { recursive: true });
  await mkdir(join(out, 'feeds'), { recursive: true });
  await cp(join(ROOT, 'public'), out, { recursive: true });
  for (const f of SHARED_LIB) await cp(join(ROOT, 'lib', f), join(out, 'lib', f));

  await writeFile(join(out, 'data', 'disruptions.json'), JSON.stringify({
    source: FEED_URL, retrievedAt: now, stale: false, error: null, skipped, records,
  }));
  await writeFile(join(out, 'data', 'changes.json'), JSON.stringify(changes));
  await writeFile(join(out, 'config.json'), JSON.stringify({ mode: 'static', notifications: { email: 'unavailable', sms: 'unavailable' } }));
  await writeFile(join(out, '.nojekyll'), '');

  // Per-street feeds: one per distinct street name that has a current or upcoming restriction.
  const live = records.filter((r) => lifecycle(r, now) !== 'ended');
  const streets = new Map();
  for (const r of live) {
    for (const name of [r.road, r.fromRoad, r.toRoad, r.atRoad]) {
      const slug = normStreet(name).replace(/ /g, '-');
      if (slug.length >= 2 && !streets.has(slug)) streets.set(slug, normStreet(name));
    }
  }
  const slugs = [];
  for (const [slug, query] of [...streets].slice(0, MAX_FEEDS)) {
    const matches = live.filter((r) => matchesStreet(r, query, { whole: true }))
      .sort((a, b) => (b.lastUpdated ?? 0) - (a.lastUpdated ?? 0)).slice(0, 40);
    if (!matches.length) continue;
    slugs.push(slug);
    await writeFile(join(out, 'feeds', `${slug}.atom`), atom({
      title: `StreetWatch Toronto: ${query}`,
      subtitle: 'Current and upcoming road restrictions on this street. Source: City of Toronto Open Data.',
      id: `urn:streetwatch:feed:${slug}`, url: `${siteUrl}feeds/${slug}.atom`, updated: now,
      entries: matches.map((r) => recordEntry(r, now)),
    }));
  }
  await writeFile(join(out, 'feeds', 'index.json'), JSON.stringify(slugs.sort()));
  await writeFile(join(out, 'feeds', 'changes.atom'), atom({
    title: 'StreetWatch Toronto: all City changes',
    subtitle: 'New, escalated and cleared road restrictions over the last 7 days.',
    id: 'urn:streetwatch:feed:changes', url: `${siteUrl}feeds/changes.atom`, updated: now,
    entries: changes.events.slice(0, 100).map((e) => ({
      id: `urn:streetwatch:change:${e.key}`,
      title: `${KIND[e.kind] ?? e.kind}: ${e.name ?? e.road ?? 'Road restriction'}`,
      updated: e.at,
      link: `${siteUrl}#id=${encodeURIComponent(e.id)}&time=all`,
      summary: `${e.impact} impact${e.was ? ` (was ${e.was})` : ''}${e.from && e.to ? `, ${e.from} to ${e.to}` : ''}.`,
    })),
  }));

  console.log(`Built ${out}: ${records.length} records, ${events.length} new changes (${changes.events.length} in log), ${slugs.length} street feeds.`);
}

main().catch((err) => { console.error(`Build failed: ${err.message}`); process.exit(1); });
