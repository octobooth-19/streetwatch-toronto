// Pure alert engine shared by the browser (saved streets) and the notification server.
// State is plain JSON so it can live in localStorage or a subscription record.

import { matchesStreet, lifecycle, formatTorontoTime } from './disruptions.mjs';

export const ALERT_KINDS = {
  new: { label: 'New restriction', hint: 'A restriction appears on a saved street' },
  starting: { label: 'Starting within 24 hours', hint: 'Planned work is about to begin' },
  escalated: { label: 'Impact increased', hint: 'The reported impact goes up' },
  ending: { label: 'Ending within 24 hours', hint: 'Work is about to finish' },
  cleared: { label: 'Cleared', hint: 'A restriction is removed from the City feed' },
};

export const DEFAULT_KINDS = Object.keys(ALERT_KINDS);

const KIND_ORDER = ['escalated', 'new', 'starting', 'ending', 'cleared'];
const IMPACT_RANK = { None: 0, Low: 1, Medium: 2, High: 3 };
const DAY_MS = 86_400_000;
const NOTIFIED_TTL_MS = 14 * DAY_MS;

export const emptyState = () => ({ index: {}, notified: {} });

const rank = (impact) => IMPACT_RANK[impact] ?? -1;
const labelOf = (r) => r.name ?? r.road ?? 'Unnamed location';

function describe(r, now) {
  const parts = [r.type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()),
    `${r.maxImpact} impact`];
  if (r.start !== null && r.start > now) parts.push(`starts ${formatTorontoTime(r.start)}`);
  else if (r.end !== null) parts.push(`ends ${formatTorontoTime(r.end)}`);
  return parts.join(' · ');
}

/**
 * Compares the current records with the last state, for each watched street.
 * The first evaluation of a watch is a silent baseline for new/escalated/cleared,
 * so adding a street never floods the user with every existing restriction.
 */
export function computeAlerts({ records, watches, kinds = DEFAULT_KINDS, state = emptyState(), now = Date.now() }) {
  const enabled = new Set(kinds);
  const next = { index: {}, notified: {} };
  const alerts = [];

  for (const [key, at] of Object.entries(state.notified ?? {})) {
    if (now - at < NOTIFIED_TTL_MS) next.notified[key] = at;
  }

  const emit = (alert) => {
    if (!enabled.has(alert.kind) || next.notified[alert.key] !== undefined) return;
    next.notified[alert.key] = now;
    alerts.push(alert);
  };

  for (const watch of watches) {
    const current = {};
    const matching = records.filter((r) => matchesStreet(r, watch.query, { whole: true }));
    for (const r of matching) {
      if (lifecycle(r, now) !== 'ended') current[r.id] = [r.maxImpact, labelOf(r)];
    }
    next.index[watch.id] = current;

    const base = { watchId: watch.id, watchLabel: watch.label ?? watch.query, at: now };
    const prev = state.index?.[watch.id];

    if (prev) {
      for (const r of matching) {
        const before = prev[r.id];
        if (lifecycle(r, now) === 'ended') continue;
        if (!before) {
          emit({ ...base, key: `new:${watch.id}:${r.id}`, kind: 'new', recordId: r.id,
            title: `New restriction on ${watch.label ?? watch.query}`, detail: `${labelOf(r)} — ${describe(r, now)}` });
        } else if (rank(r.maxImpact) > rank(before[0])) {
          emit({ ...base, key: `escalated:${watch.id}:${r.id}:${r.maxImpact}`, kind: 'escalated', recordId: r.id,
            title: `Impact increased on ${watch.label ?? watch.query}`,
            detail: `${labelOf(r)} — now ${r.maxImpact} impact (was ${before[0]})` });
        }
      }
      for (const [id, [, label]] of Object.entries(prev)) {
        if (!current[id]) {
          emit({ ...base, key: `cleared:${watch.id}:${id}`, kind: 'cleared', recordId: id,
            title: `Cleared on ${watch.label ?? watch.query}`, detail: `${label} is no longer in the City feed` });
        }
      }
    }

    for (const r of matching) {
      const phase = lifecycle(r, now);
      if (phase === 'upcoming' && r.start - now <= DAY_MS) {
        emit({ ...base, key: `starting:${watch.id}:${r.id}:${r.start}`, kind: 'starting', recordId: r.id,
          title: `Starting soon on ${watch.label ?? watch.query}`, detail: `${labelOf(r)} — ${describe(r, now)}` });
      } else if (phase === 'active' && r.end !== null && r.end - now <= DAY_MS) {
        emit({ ...base, key: `ending:${watch.id}:${r.id}:${r.end}`, kind: 'ending', recordId: r.id,
          title: `Ending soon on ${watch.label ?? watch.query}`, detail: `${labelOf(r)} — ${describe(r, now)}` });
      }
    }
  }

  alerts.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return { alerts, state: next };
}

/** Plain-text email body and subject for a batch of alerts. */
export function formatEmail(alerts, { siteUrl = '', unsubscribeUrl = '' } = {}) {
  const subject = alerts.length === 1
    ? `StreetWatch: ${alerts[0].title}`
    : `StreetWatch: ${alerts.length} updates on your saved streets`;
  const lines = alerts.map((a) => `• ${a.title}\n  ${a.detail}`);
  const text = [
    ...lines, '',
    siteUrl ? `Open StreetWatch Toronto: ${siteUrl}` : null,
    'Restrictions are reported by applicants and are not field-verified.',
    unsubscribeUrl ? `Stop these emails: ${unsubscribeUrl}` : null,
  ].filter((l) => l !== null).join('\n');
  return { subject, text };
}

/** Compact SMS body (kept to two segments). */
export function formatSms(alerts, { max = 300 } = {}) {
  const head = alerts.length === 1 ? 'StreetWatch: ' : `StreetWatch (${alerts.length} updates): `;
  const tail = ' Reply STOP to end.';
  let body = head + alerts.map((a) => `${a.title}. ${a.detail}.`).join(' ');
  if (body.length + tail.length > max) body = `${body.slice(0, max - tail.length - 1).trimEnd()}…`;
  return body + tail;
}
