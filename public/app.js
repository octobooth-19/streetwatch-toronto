import {
  filterRecords, distinctValues, formatTorontoTime, hasKnownTiming, safeUrl, distanceKm, torontoDayRange,
} from './lib/disruptions.mjs';
import { buildIcs } from './lib/ics.mjs';
import { TileMap } from './map.js';
import { $, el, label, impactBadge, relativeTime, toast, download } from './dom.js';
import { createSaved, showNotifications } from './saved.js';
import { initPanels } from './panels.js';

const IMPACT_ORDER = { High: 0, Medium: 1, Low: 2 };
const PAGE = 100;
const POLL_MS = 5 * 60_000;
const DAY = 86_400_000;
const TZ = 'America/Toronto';

const CHIPS = [
  { id: 'now', text: 'Active now', filters: { time: 'now', type: '', impact: '' } },
  { id: 'closed', text: 'Road closed', filters: { time: 'now', type: 'ROAD_CLOSED', impact: '' } },
  { id: 'high', text: 'High impact', filters: { time: 'now', type: '', impact: 'High' } },
];

const els = {
  form: $('filters'), q: $('q'), time: $('time'), type: $('type'), impact: $('impact'),
  near: $('near'), radius: $('radius'),
  list: $('list'), empty: $('empty'), more: $('more'), count: $('count'), followQuery: $('follow-query'),
  refresh: $('refresh'), freshness: $('freshness-text'), banner: $('banner'),
  details: $('details'), detailsBody: $('details-body'), closeDetails: $('close-details'),
  mapNote: $('map-note'), chips: $('chips'), week: $('week'), layout: document.querySelector('.layout'),
};

const state = {
  records: [], filtered: [], dist: new Map(), selectedId: null, meta: null, loading: false,
  config: { mode: 'static', notifications: { email: 'unavailable', sms: 'unavailable' } },
  changes: { generatedAt: null, events: [] }, near: null, page: 1, loadedAt: 0,
};

const saved = createSaved();

const map = new TileMap($('map'), {
  onSelect: (id) => select(id, { from: 'map' }),
  onTileError: () => {
    els.mapNote.textContent = 'Some map tiles could not load. The list still shows every result.';
  },
});
$('zoom-in').addEventListener('click', () => map.zoomBy(1));
$('zoom-out').addEventListener('click', () => map.zoomBy(-1));
$('zoom-fit').addEventListener('click', () => map.fit(state.filtered));

function timingText(r) {
  if (!hasKnownTiming(r)) return 'Timing not reported';
  return r.end === null
    ? `From ${formatTorontoTime(r.start)} · no end date reported`
    : `${formatTorontoTime(r.start)} – ${formatTorontoTime(r.end)}`;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  let data = null;
  try { data = await res.json(); } catch { /* handled below */ }
  if (!res.ok || !data) throw new Error(data?.error || `Service responded with HTTP ${res.status}`);
  return data;
}

// ---- Data ----

async function load({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  els.refresh.disabled = true;
  els.refresh.textContent = 'Refreshing…';
  try {
    const stamp = Date.now();
    const [data, changes] = await Promise.all([
      fetchJson(`./data/disruptions.json?t=${stamp}`),
      fetchJson(`./data/changes.json?t=${stamp}`).catch(() => null),
    ]);
    state.records = data.records;
    state.meta = data;
    state.loadedAt = stamp;
    if (changes) state.changes = changes;
    populateSelect(els.type, distinctValues(state.records, 'type'), 'All types', label);
    populateSelect(els.impact, distinctValues(state.records, 'maxImpact')
      .sort((a, b) => (IMPACT_ORDER[a] ?? 9) - (IMPACT_ORDER[b] ?? 9)), 'All impacts');
    populateDays();
    showBanner(data.stale
      ? `Showing data retrieved ${formatTorontoTime(data.retrievedAt)} because the latest City refresh failed: ${data.error}`
      : null);
    if (!data.stale && data.records.length > 0) notifyFresh(saved.evaluate(state.records), quiet);
  } catch (err) {
    if (state.meta) {
      showBanner(`Refresh failed (${err.message}). Showing data retrieved ${formatTorontoTime(state.meta.retrievedAt)}.`);
    } else {
      showBanner(`City road restriction data is unavailable right now: ${err.message}`, true);
    }
  } finally {
    state.loading = false;
    els.refresh.disabled = false;
    els.refresh.textContent = 'Refresh';
    updateFreshness();
    apply({ keepPage: true });
    panels.onData();
  }
}

function notifyFresh(alerts, quiet) {
  if (!alerts.length) return;
  showNotifications(alerts).catch(() => {});
  if (!quiet) toast(`${alerts.length} update${alerts.length === 1 ? '' : 's'} on your streets. Open My streets to read them.`);
}

function updateFreshness() {
  const m = state.meta;
  if (!m) { els.freshness.textContent = 'No data loaded'; return; }
  els.freshness.textContent =
    `City data ${relativeTime(m.retrievedAt)} · ${formatTorontoTime(m.retrievedAt)}`;
}

function showBanner(message, retry = false) {
  els.banner.hidden = !message;
  els.banner.replaceChildren();
  if (!message) return;
  els.banner.append(message);
  if (retry) els.banner.append(el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => load() }, 'Retry'));
}

function populateSelect(select, values, allLabel, fmt = (v) => v) {
  const current = select.value;
  select.replaceChildren(el('option', { value: '' }, allLabel),
    ...values.map((v) => el('option', { value: v }, fmt(v))));
  select.value = values.includes(current) ? current : '';
}

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
const weekdayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short' });
const longDayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric' });

function populateDays() {
  const current = els.time.value;
  for (const o of [...els.time.querySelectorAll('option[data-day]')]) o.remove();
  const now = Date.now();
  const anchor = els.time.querySelector('option[value="week"]');
  for (let i = 6; i >= 1; i--) {
    const opt = el('option', { value: `day:${i}` }, dayFmt.format(torontoDayRange(now, i)[0]));
    opt.dataset.day = String(i);
    anchor.after(opt);
  }
  els.time.value = [...els.time.options].some((o) => o.value === current) ? current : 'now';
}

// ---- Filtering & rendering ----

function currentFilters() {
  return {
    query: els.q.value, time: els.time.value, type: els.type.value, impact: els.impact.value,
    near: state.near ? { ...state.near, km: Number(els.radius.value) } : null,
  };
}

function apply({ keepPage = false } = {}) {
  if (!keepPage) state.page = 1;
  const f = currentFilters();
  const found = filterRecords(state.records, f);
  state.dist = new Map();
  if (f.near) {
    for (const r of found) state.dist.set(r.id, distanceKm(f.near.lat, f.near.lon, r.lat, r.lon));
    found.sort((a, b) => state.dist.get(a.id) - state.dist.get(b.id));
  } else {
    found.sort((a, b) => (IMPACT_ORDER[a.maxImpact] ?? 9) - (IMPACT_ORDER[b.maxImpact] ?? 9) ||
      (a.road ?? '').localeCompare(b.road ?? ''));
  }
  state.filtered = found;
  if (state.selectedId && !found.some((r) => r.id === state.selectedId)) state.selectedId = null;

  renderList();
  map.setRecords(found);
  map.select(state.selectedId);
  renderDetails();
  renderOverview();
  renderCount(f);
  renderFollowQuery();
  writeHash();
}

function renderCount(f) {
  const total = state.filtered.length;
  const unmapped = state.filtered.filter((r) => r.lat === null).length;
  const when = els.time.selectedOptions[0]?.textContent.toLowerCase() ?? '';
  els.count.textContent = state.meta
    ? `${total.toLocaleString()} restriction${total === 1 ? '' : 's'} · ${when}${f.near ? ` · within ${f.near.km} km of you` : ''}`
    : '';
  if (!map.tileErrors) {
    els.mapNote.textContent = unmapped
      ? `${unmapped} result${unmapped === 1 ? ' has' : 's have'} no valid location and appear${unmapped === 1 ? 's' : ''} only in the list.`
      : '';
  }
}

function renderFollowQuery() {
  const q = els.q.value.trim();
  const show = q.length >= 2 && !saved.has(q);
  els.followQuery.hidden = !show;
  if (show) els.followQuery.textContent = `Follow “${q}”`;
}

function renderList() {
  const shown = state.filtered.slice(0, state.page * PAGE);
  els.list.replaceChildren(...shown.map((r) => {
    const km = state.dist.get(r.id);
    const btn = el('button', { type: 'button', class: 'item', onclick: () => select(r.id, { from: 'list' }) },
      el('span', { class: 'item-title' }, r.name ?? r.road ?? 'Unnamed location'),
      el('span', { class: 'item-meta' },
        impactBadge(r.maxImpact),
        el('span', {}, label(r.type)),
        el('span', {}, timingText(r)),
        km !== undefined ? el('span', {}, `${km < 10 ? km.toFixed(1) : Math.round(km)} km away`) : null,
        r.lat === null ? el('span', {}, 'Not on map') : null));
    btn.dataset.id = r.id;
    if (r.id === state.selectedId) btn.setAttribute('aria-current', 'true');
    return el('li', {}, btn);
  }));

  const remaining = state.filtered.length - shown.length;
  els.more.hidden = remaining <= 0;
  if (remaining > 0) els.more.textContent = `Show ${Math.min(PAGE, remaining)} more (${remaining.toLocaleString()} remaining)`;

  const q = els.q.value.trim();
  els.empty.hidden = !state.meta || state.filtered.length > 0;
  if (!els.empty.hidden) {
    els.empty.textContent = q
      ? `Nothing matches “${q}” with these filters. Try a shorter name (“Queen” instead of “Queen Street West”), choose All dates, or follow this street to be told when something appears.`
      : 'No restrictions match these filters. Try a wider time range, remove the location filter, or press Reset.';
  }
}

function renderOverview() {
  const f = currentFilters();
  const base = { query: f.query, near: f.near };
  const active = (c) => c.filters.time === f.time && c.filters.type === f.type && c.filters.impact === f.impact;

  const chips = CHIPS.map((c) => {
    const n = filterRecords(state.records, { ...base, ...c.filters }).length;
    return el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(active(c)),
      onclick: () => setFilters(c.filters, 'results'),
    }, c.text, el('span', { class: 'chip-count' }, n.toLocaleString()));
  });
  if (state.changes.generatedAt) {
    const n = state.changes.events.filter((e) => Date.now() - e.at < DAY).length;
    chips.push(el('button', { type: 'button', class: 'chip', onclick: () => panels.openTab('changes') },
      'Changed in 24 h', el('span', { class: 'chip-count' }, n.toLocaleString())));
  }
  els.chips.replaceChildren(...chips);

  const now = Date.now();
  const counts = [];
  for (let i = 0; i < 7; i++) counts.push(filterRecords(state.records, { ...f, time: `day:${i}` }).length);
  const max = Math.max(1, ...counts);
  els.week.replaceChildren(...counts.map((n, i) => {
    const [start] = torontoDayRange(now, i);
    const value = i === 0 ? 'today' : `day:${i}`;
    const fill = el('span', { class: 'day-fill' });
    fill.style.transform = `scaleX(${n ? Math.max(0.06, n / max) : 0})`;
    return el('button', {
      type: 'button', class: 'day', 'aria-pressed': String(f.time === value),
      'aria-label': `${longDayFmt.format(start)}: ${n} restriction${n === 1 ? '' : 's'}`,
      onclick: () => setFilters({ time: value }, 'results'),
    },
    el('span', { class: 'day-name' }, i === 0 ? 'Today' : weekdayFmt.format(start)),
    el('span', { class: 'day-count' }, n.toLocaleString()),
    el('span', { class: 'day-bar', 'aria-hidden': 'true' }, fill));
  }));
}

function setFilters(values, tab) {
  for (const [k, v] of Object.entries(values)) if (k in els) els[k].value = v;
  if (tab) panels.openTab(tab);
  apply();
}

// ---- Details ----

function follow(query, labelText) {
  const res = saved.add(query, labelText);
  if (!res.ok) { toast(res.message); return false; }
  notifyFresh(saved.evaluate(state.records), true);
  toast(`Following ${query}. Updates will appear in My streets.`);
  return true;
}

function renderDetails() {
  const r = state.filtered.find((x) => x.id === state.selectedId);
  els.details.hidden = !r;
  if (!r) return;

  const rows = [
    ['Road', r.road],
    ['Segment', r.fromRoad && r.toRoad ? `${r.fromRoad} to ${r.toRoad}` : r.atRoad ? `At ${r.atRoad}` : null],
    ['Type', label(r.type)],
    ['Reported impact', `${r.maxImpact} (current: ${r.currImpact})`],
    ['Starts', formatTorontoTime(r.start)],
    ['Ends', r.end === null ? 'No end date reported' : formatTorontoTime(r.end)],
    ['Work period', r.workPeriod],
    ['Schedule', r.schedule.length ? r.schedule.map((s) => `${s.day}: ${s.hours}`).join('\n') : null],
    ['Directions', r.directions ? label(r.directions) : null],
    ['District', r.district],
    ['City last updated', formatTorontoTime(r.lastUpdated)],
    ['Map', r.lat === null ? 'No valid location reported' : null],
  ].filter(([, v]) => v);

  const link = safeUrl(r.url);
  const street = r.road ?? r.name;
  const following = street ? saved.has(street) : false;
  const ics = buildIcs(r, { siteUrl: location.href.split('#')[0] });

  els.detailsBody.replaceChildren(
    el('h2', { id: 'details-title' }, r.name ?? r.road ?? 'Unnamed location'),
    impactBadge(r.maxImpact),
    el('div', { class: 'actions' },
      street ? el('button', {
        type: 'button', class: 'btn btn-small', 'aria-pressed': String(following),
        onclick: () => {
          if (following) { saved.remove(street); toast(`Stopped following ${street}.`); } else follow(street);
          renderDetails();
          renderFollowQuery();
        },
      }, following ? `Following ${street}` : `Follow ${street}`) : null,
      el('button', {
        type: 'button', class: 'btn btn-quiet btn-small', disabled: !ics,
        title: ics ? 'Download a calendar event' : 'No start time reported',
        onclick: () => download(`streetwatch-${r.id}.ics`, ics, 'text/calendar'),
      }, 'Add to calendar'),
      el('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => share(r) }, 'Share')),
    r.description ? el('p', { class: 'details-desc' }, r.description) : null,
    el('dl', {}, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', { class: 'details-desc' }, v)])),
    link ? el('a', { href: link, target: '_blank', rel: 'noopener' }, 'View on City of Toronto site') : null,
    el('p', { class: 'map-note' }, `City record ID ${r.id}. Reported by applicants; not field-verified.`),
  );
}

async function share(r) {
  const url = `${location.origin}${location.pathname}#id=${encodeURIComponent(r.id)}&time=all`;
  const title = `${r.name ?? r.road ?? 'Road restriction'} — StreetWatch Toronto`;
  try {
    if (navigator.share) { await navigator.share({ title, url }); return; }
    await navigator.clipboard.writeText(url);
    toast('Link copied.');
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Could not share. Copy the address from your browser instead.');
  }
}

function select(id, { from } = {}) {
  state.selectedId = id;
  for (const b of els.list.querySelectorAll('.item')) {
    if (b.dataset.id === id) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }
  map.select(id, { pan: from === 'list' });
  renderDetails();
  writeHash();
  if (id && from === 'map') {
    panels.openTab('results', { keepView: true });
    els.list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  if (id) els.details.scrollIntoView({ block: 'nearest' });
}

/** Opens a record from anywhere (changes feed, inbox). Widens the time filter if needed. */
function reveal(id) {
  const rec = state.records.find((r) => r.id === id);
  if (!rec) { toast('That restriction is no longer in the City feed.'); return; }
  if (!state.filtered.some((r) => r.id === id)) { els.time.value = 'all'; els.type.value = ''; els.impact.value = ''; apply(); }
  panels.openTab('results');
  select(id, { from: 'list' });
  els.list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}

// ---- Near me ----

function setNear(on) {
  els.near.setAttribute('aria-pressed', String(on));
  els.radius.hidden = !on;
  els.near.textContent = on ? 'Near me: on' : 'Use my location';
  if (!on) { state.near = null; map.setUser(null); apply(); return; }
  if (!navigator.geolocation) { toast('Location is not available in this browser.'); setNear(false); return; }
  els.near.disabled = true;
  els.near.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition((pos) => {
    state.near = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    els.near.disabled = false;
    els.near.textContent = 'Near me: on';
    map.setUser(state.near);
    if (els.time.value === 'week' || els.time.value === 'unknown') els.time.value = 'now';
    apply();
    map.fit(state.filtered.slice(0, 200));
  }, (err) => {
    els.near.disabled = false;
    toast(err.code === 1 ? 'Location permission was denied. You can still search by street name.' : 'Could not find your location.');
    setNear(false);
  }, { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 });
}

// ---- URL hash ----

function writeHash() {
  const p = new URLSearchParams();
  if (els.q.value.trim()) p.set('q', els.q.value.trim());
  if (els.time.value !== 'now') p.set('time', els.time.value);
  if (els.type.value) p.set('type', els.type.value);
  if (els.impact.value) p.set('impact', els.impact.value);
  if (state.selectedId) p.set('id', state.selectedId);
  const hash = p.toString();
  if (hash !== location.hash.slice(1)) {
    history.replaceState(null, '', hash ? `#${hash}` : `${location.pathname}${location.search}`);
  }
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  els.q.value = p.get('q') ?? '';
  const time = p.get('time') ?? (p.get('id') ? 'all' : 'now');
  els.time.value = [...els.time.options].some((o) => o.value === time) ? time : 'now';
  state.pendingType = p.get('type') ?? '';
  state.pendingImpact = p.get('impact') ?? '';
  state.selectedId = p.get('id');
}

// ---- Events ----

let debounce;
els.q.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(apply, 150);
  renderFollowQuery();
});
for (const s of [els.time, els.type, els.impact, els.radius]) s.addEventListener('change', () => apply());
els.form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
els.form.addEventListener('reset', () => {
  setTimeout(() => {
    if (state.near) setNear(false);
    else apply();
  }, 0);
});
els.near.addEventListener('click', () => setNear(els.near.getAttribute('aria-pressed') !== 'true'));
els.refresh.addEventListener('click', () => load());
els.more.addEventListener('click', () => { state.page += 1; renderList(); });
els.followQuery.addEventListener('click', () => {
  const q = els.q.value.trim();
  if (follow(q)) renderFollowQuery();
});
els.closeDetails.addEventListener('click', closeDetails);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.details.hidden && !e.target.closest?.('input, select, textarea')) closeDetails();
});

function closeDetails() {
  const id = state.selectedId;
  select(null);
  if (id) els.list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
}

for (const b of document.querySelectorAll('.view-toggle button')) {
  b.addEventListener('click', () => {
    els.layout.dataset.view = b.dataset.view;
    for (const o of document.querySelectorAll('.view-toggle button')) o.setAttribute('aria-pressed', String(o === b));
    if (b.dataset.view === 'map') map.render();
  });
}

setInterval(() => { if (!document.hidden) load({ quiet: false }); }, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - state.loadedAt > POLL_MS / 2) load();
  else if (!document.hidden) updateFreshness();
});

saved.onChange(() => { renderFollowQuery(); });

// ---- Boot ----

const panels = initPanels({ state, saved, follow, reveal, setFilters, toast });

async function boot() {
  try { state.config = await fetchJson('./config.json'); } catch { /* static hosting: keep defaults */ }
  readHash();
  panels.setConfig(state.config);
  await load({ quiet: true });
  if (state.pendingType) els.type.value = state.pendingType;
  if (state.pendingImpact) els.impact.value = state.pendingImpact;
  apply();
  if (state.selectedId) {
    const r = state.records.find((x) => x.id === state.selectedId);
    if (r && state.filtered.some((x) => x.id === r.id)) select(r.id, { from: 'list' });
  }
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
