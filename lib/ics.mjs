// Calendar (.ics) export for a single restriction. Pure, so it runs in browsers and Node.

const encoder = new TextEncoder();
const bytes = (s) => encoder.encode(s).length;
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([;,])/g, '\\$1');
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// RFC 5545: lines are folded at 75 octets with CRLF + space continuation.
function fold(line) {
  const out = [];
  let rest = line;
  while (bytes(rest) > 75) {
    let n = 75;
    while (bytes(rest.slice(0, n)) > 75) n -= 1;
    out.push(rest.slice(0, n));
    rest = ` ${rest.slice(n)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

export function buildIcs(r, { now = Date.now(), siteUrl = '' } = {}) {
  if (r.start === null) return null;
  const end = r.end !== null && r.end > r.start ? r.end : r.start + 3_600_000;
  const description = [
    r.description,
    r.end === null ? 'No end date reported.' : null,
    siteUrl ? `Details: ${siteUrl}` : null,
    'Reported by applicants; not field-verified.',
  ].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//StreetWatch Toronto//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:restriction-${r.id}@streetwatch-toronto`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(r.start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(`${r.maxImpact} impact: ${r.name ?? r.road ?? 'Road restriction'}`)}`,
    `DESCRIPTION:${esc(description)}`,
    r.lat !== null ? `GEO:${r.lat};${r.lon}` : null,
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
