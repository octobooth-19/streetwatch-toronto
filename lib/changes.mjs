// Shared pure helpers for tracking what changed between two City feed snapshots.

const DAY_MS = 86_400_000;
const IMPACT_RANK = { None: 0, Low: 1, Medium: 2, High: 3 };
export const CHANGE_RETENTION_MS = 7 * DAY_MS;
export const CHANGE_LOG_MAX = 600;

const slim = (r, kind, at, extra = {}) => ({
  key: `${kind}:${r.id}:${at}`, kind, at, id: r.id, road: r.road, name: r.name, impact: r.maxImpact,
  type: r.type, lat: r.lat, lon: r.lon, from: r.fromRoad, to: r.toRoad, ...extra,
});

/** Events between two record lists: new, cleared (left the feed) or escalated (impact went up). */
export function diffSnapshots(prev, next, at) {
  const before = new Map(prev.map((r) => [r.id, r]));
  const after = new Map(next.map((r) => [r.id, r]));
  const events = [];
  for (const r of next) {
    const old = before.get(r.id);
    if (!old) events.push(slim(r, 'new', at));
    else if ((IMPACT_RANK[r.maxImpact] ?? -1) > (IMPACT_RANK[old.maxImpact] ?? -1)) {
      events.push(slim(r, 'escalated', at, { was: old.maxImpact }));
    }
  }
  for (const r of prev) if (!after.has(r.id)) events.push(slim(r, 'cleared', at));
  return events;
}

/** Newest-first log, trimmed to the last 7 days and a fixed size. */
export function mergeChanges(log, events, now) {
  const seen = new Set();
  return [...events, ...log]
    .filter((e) => now - e.at < CHANGE_RETENTION_MS && !seen.has(e.key) && seen.add(e.key))
    .sort((a, b) => b.at - a.at)
    .slice(0, CHANGE_LOG_MAX);
}

/** Tracks snapshots over time. The first snapshot only sets the baseline. */
export function createChangeTracker() {
  let last = null;
  let log = [];
  let at = null;
  return {
    update(records, now = Date.now()) {
      if (last) log = mergeChanges(log, diffSnapshots(last, records, now), now);
      last = records;
      at = now;
    },
    snapshot: () => ({ generatedAt: at, events: log }),
  };
}
