// Shared by the Node service and the browser. Must not import Node built-ins.

export const TORONTO_TZ = 'America/Toronto';
const TORONTO_BOUNDS = { minLat: 43.4, maxLat: 44.1, minLon: -79.9, maxLon: -78.9 };

function text(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' || s.toLowerCase() === 'null' ? null : s;
}

export function parseEpoch(value) {
  const s = text(value);
  if (s === null || !/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) return null;
  // Reject implausible dates (before 2000 or after 2100).
  if (n < 946_684_800_000 || n > 4_102_444_800_000) return null;
  return n;
}

function parseCoord(value, min, max) {
  const s = text(value);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

export function parsePolyline(value) {
  const s = text(value);
  if (s === null) return null;
  let pairs;
  try {
    pairs = JSON.parse(`[${s}]`);
  } catch {
    return null;
  }
  if (!Array.isArray(pairs) || pairs.length < 2) return null;
  const points = [];
  for (const p of pairs) {
    if (!Array.isArray(p) || p.length !== 2) return null;
    const [lon, lat] = p.map(Number);
    if (!inToronto(lat, lon)) return null;
    points.push([lat, lon]);
  }
  return points;
}

function inToronto(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= TORONTO_BOUNDS.minLat && lat <= TORONTO_BOUNDS.maxLat &&
    lon >= TORONTO_BOUNDS.minLon && lon <= TORONTO_BOUNDS.maxLon;
}

export function safeUrl(value) {
  const s = text(value);
  if (s === null) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = text(raw.id);
  if (id === null) return null;

  let lat = parseCoord(raw.latitude, -90, 90);
  let lon = parseCoord(raw.longitude, -180, 180);
  if (lat === null || lon === null || !inToronto(lat, lon)) { lat = null; lon = null; }

  const schedule = [];
  const everyday = text(raw.scheduleEveryday);
  if (everyday) schedule.push({ day: 'Every day', hours: everyday });
  for (const day of DAYS) {
    const hours = text(raw[`schedule${day}`]);
    if (hours) schedule.push({ day, hours });
  }

  return {
    id,
    road: text(raw.road),
    name: text(raw.name),
    district: text(raw.district),
    lat,
    lon,
    line: parsePolyline(raw.geoPolyline),
    start: parseEpoch(raw.startTime),
    end: parseEpoch(raw.endTime),
    lastUpdated: parseEpoch(raw.lastUpdated),
    type: text(raw.type) ?? 'Unknown',
    currImpact: text(raw.currImpact) ?? 'Unknown',
    maxImpact: text(raw.maxImpact) ?? 'Unknown',
    description: text(raw.description),
    workPeriod: text(raw.workPeriod),
    directions: text(raw.directionsAffected),
    fromRoad: text(raw.fromRoad),
    toRoad: text(raw.toRoad),
    atRoad: text(raw.atRoad),
    schedule,
    url: safeUrl(raw.URL),
  };
}

export function normalizeFeed(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.Closure)) {
    throw new Error('Unexpected feed format: missing "Closure" array');
  }
  const records = [];
  const seen = new Set();
  let skipped = 0;
  for (const raw of json.Closure) {
    const r = normalizeRecord(raw);
    if (!r || seen.has(r.id)) { skipped++; continue; }
    seen.add(r.id);
    records.push(r);
  }
  return { records, skipped };
}

// ---- Toronto calendar helpers ----

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TORONTO_TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function torontoParts(ts) {
  const o = {};
  for (const p of partsFmt.formatToParts(new Date(ts))) o[p.type] = Number(p.value);
  return o;
}

function offsetAt(ts) {
  const p = torontoParts(ts);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** UTC instant of local midnight in Toronto for the given Y/M/D (month 1-based). */
export function torontoMidnight(year, month, day) {
  const naive = Date.UTC(year, month - 1, day);
  let ts = naive - offsetAt(naive);
  ts = naive - offsetAt(ts);
  return ts;
}

/** [start, end) of the Toronto calendar day containing `now`, extended by `days`. */
export function torontoDayWindow(now, days = 1) {
  const p = torontoParts(now);
  const start = torontoMidnight(p.year, p.month, p.day);
  const endDate = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  const end = torontoMidnight(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, endDate.getUTCDate());
  return [start, end];
}

/** [start, end) of the Toronto calendar day `offset` days after the day containing `now`. */
export function torontoDayRange(now, offset = 0) {
  const p = torontoParts(now);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + offset));
  const e = new Date(Date.UTC(p.year, p.month - 1, p.day + offset + 1));
  return [
    torontoMidnight(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()),
    torontoMidnight(e.getUTCFullYear(), e.getUTCMonth() + 1, e.getUTCDate()),
  ];
}

export function hasKnownTiming(r) {
  return r.start !== null && (r.end === null || r.end >= r.start);
}

function overlaps(r, from, to) {
  if (!hasKnownTiming(r)) return false;
  return r.start < to && (r.end === null || r.end >= from);
}

/** 'active' | 'upcoming' | 'ended' | 'unknown' based on the reported date range. */
export function lifecycle(r, now) {
  if (!hasKnownTiming(r)) return 'unknown';
  if (r.start > now) return 'upcoming';
  if (r.end !== null && r.end < now) return 'ended';
  return 'active';
}

export const TIME_FILTERS = {
  now: 'Active now',
  today: 'Today',
  week: 'Next 7 days',
  all: 'All dates',
  unknown: 'Unknown timing',
};

export function matchesTime(r, filter, now) {
  switch (filter) {
    case 'now': return overlaps(r, now, now + 1);
    case 'today': { const [a, b] = torontoDayWindow(now, 1); return overlaps(r, a, b); }
    case 'week': { const [a, b] = torontoDayWindow(now, 7); return overlaps(r, a, b); }
    case 'unknown': return !hasKnownTiming(r);
    default: {
      const day = /^day:([0-6])$/.exec(filter);
      if (!day) return true;
      const [a, b] = torontoDayRange(now, Number(day[1]));
      return overlaps(r, a, b);
    }
  }
}

const ABBREV = {
  street: 'st', avenue: 'ave', road: 'rd', boulevard: 'blvd', drive: 'dr', crescent: 'cres',
  court: 'crt', place: 'pl', lane: 'ln', terrace: 'terr', trail: 'trl', square: 'sq', parkway: 'pkwy',
  highway: 'hwy', west: 'w', east: 'e', north: 'n', south: 's', saint: 'st',
};

/** Lower-cases and unifies abbreviations so "Queen Street West" matches "Queen St W". */
export function normStreet(value) {
  if (value === null || value === undefined) return '';
  return String(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
    .map((w) => ABBREV[w] ?? w).join(' ');
}

const streetText = new WeakMap();
function recordStreetText(r) {
  let t = streetText.get(r);
  if (t === undefined) {
    t = [r.road, r.name, r.fromRoad, r.toRoad, r.atRoad].map(normStreet).filter(Boolean).join(' | ');
    streetText.set(r, t);
  }
  return t;
}

/** Search matches at word starts ("quee" finds Queen St W); `whole` requires complete words (saved streets). */
export function matchesStreet(r, query, { whole = false } = {}) {
  const q = normStreet(query);
  if (!q) return true;
  const text = ` ${recordStreetText(r).replace(/ \| /g, '  ')} `;
  return text.includes(whole ? ` ${q} ` : ` ${q}`);
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

export function filterRecords(records, { query = '', time = 'now', type = '', impact = '', near = null } = {}, now = Date.now()) {
  return records.filter((r) =>
    matchesTime(r, time, now) &&
    (!type || r.type === type) &&
    (!impact || r.maxImpact === impact) &&
    matchesStreet(r, query) &&
    (!near || (r.lat !== null && distanceKm(near.lat, near.lon, r.lat, r.lon) <= near.km)));
}

export function distinctValues(records, key) {
  return [...new Set(records.map((r) => r[key]))].sort();
}

export function formatTorontoTime(ts) {
  if (ts === null || ts === undefined) return 'Not reported';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TORONTO_TZ, dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(ts));
}
