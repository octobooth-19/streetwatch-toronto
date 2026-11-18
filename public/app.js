import {
  filterRecords, distinctValues, formatTorontoTime, hasKnownTiming, safeUrl, TIME_FILTERS,
} from '/lib/disruptions.mjs';
import { TileMap } from '/map.js';

const $ = (id) => document.getElementById(id);
const els = {
  form: $('filters'), q: $('q'), time: $('time'), type: $('type'), impact: $('impact'),
  list: $('list'), empty: $('empty'), count: $('count'), refresh: $('refresh'),
  freshness: $('freshness-text'), banner: $('banner'), details: $('details'),
  detailsBody: $('details-body'), closeDetails: $('close-details'), mapNote: $('map-note'),
  layout: document.querySelector('.layout'),
};

const IMPACT_ORDER = { High: 0, Medium: 1, Low: 2 };
const LIST_LIMIT = 300;

const state = { records: [], filtered: [], selectedId: null, meta: null, loading: false };

const map = new TileMap($('map'), {
  onSelect: (id) => select(id, { from: 'map' }),
  onTileError: () => {
    els.mapNote.textContent = 'Some map tiles could not load. The list still shows every result.';
  },
});
$('zoom-in').addEventListener('click', () => map.zoomBy(1));
$('zoom-out').addEventListener('click', () => map.zoomBy(-1));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function impactBadge(impact) {
  return el('span', { class: `badge impact-${impact.toLowerCase()}` }, `${impact} impact`);
}

const label = (s) => s.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

function timingText(r) {
  if (!hasKnownTiming(r)) return 'Timing not reported';
  return r.end === null
    ? `From ${formatTorontoTime(r.start)} · no end date reported`
    : `${formatTorontoTime(r.start)} – ${formatTorontoTime(r.end)}`;
}

// ---- Data ----

async function load() {
  if (state.loading) return;
  state.loading = true;
  els.refresh.disabled = true;
  els.refresh.textContent = 'Refreshing…';
  try {
    const res = await fetch('/api/disruptions', { cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch { /* handled below */ }
    if (!res.ok || !data) {
      throw new Error(data?.error || `Service responded with HTTP ${res.status}`);
    }
    state.records = data.records;
    state.meta = data;
    populateSelect(els.type, distinctValues(state.records, 'type'), 'All types', label);
    populateSelect(els.impact, distinctValues(state.records, 'maxImpact')
      .sort((a, b) => (IMPACT_ORDER[a] ?? 9) - (IMPACT_ORDER[b] ?? 9)), 'All impacts');
    showBanner(data.stale
      ? `Showing data retrieved ${formatTorontoTime(data.retrievedAt)} because the latest refresh failed: ${data.error}`
      : null);
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
    apply();
  }
}

function updateFreshness() {
  const m = state.meta;
  if (!m) { els.freshness.textContent = 'No data loaded'; return; }
  const newest = Math.max(...state.records.map((r) => r.lastUpdated ?? 0));
  els.freshness.textContent =
    `Retrieved ${formatTorontoTime(m.retrievedAt)}` +
    (newest > 0 ? ` · latest City update ${formatTorontoTime(newest)}` : '');
}

function showBanner(message, retry = false) {
  els.banner.hidden = !message;
  els.banner.replaceChildren();
  if (!message) return;
  els.banner.append(message);
  if (retry) {
    els.banner.append(el('button', { type: 'button', class: 'btn btn-quiet', onclick: load }, 'Retry'));
  }
}

function populateSelect(select, values, allLabel, fmt = (v) => v) {
  const current = select.value;
  select.replaceChildren(el('option', { value: '' }, allLabel),
    ...values.map((v) => el('option', { value: v }, fmt(v))));
  select.value = values.includes(current) ? current : '';
}

// ---- Filtering & rendering ----

function apply() {
  const filters = { query: els.q.value, time: els.time.value, type: els.type.value, impact: els.impact.value };
  state.filtered = filterRecords(state.records, filters).sort((a, b) =>
    (IMPACT_ORDER[a.maxImpact] ?? 9) - (IMPACT_ORDER[b.maxImpact] ?? 9) ||
    (a.road ?? '').localeCompare(b.road ?? ''));
  if (state.selectedId && !state.filtered.some((r) => r.id === state.selectedId)) {
    state.selectedId = null;
  }
  renderList();
  map.setRecords(state.filtered);
  map.select(state.selectedId);
  renderDetails();

  const total = state.filtered.length;
  const unmapped = state.filtered.filter((r) => r.lat === null).length;
  const timeLabel = TIME_FILTERS[filters.time].toLowerCase();
  els.count.textContent = state.meta
    ? `${total.toLocaleString()} restriction${total === 1 ? '' : 's'} · ${timeLabel}`
    : '';
  if (!map.tileErrors) {
    els.mapNote.textContent = unmapped
      ? `${unmapped} result${unmapped === 1 ? ' has' : 's have'} no valid location and appear${unmapped === 1 ? 's' : ''} only in the list.`
      : '';
  }
}

function renderList() {
  const items = state.filtered.slice(0, LIST_LIMIT).map((r) => {
    const btn = el('button', { type: 'button', class: 'item', onclick: () => select(r.id, { from: 'list' }) },
      el('span', { class: 'item-title' }, r.name ?? r.road ?? 'Unnamed location'),
      el('span', { class: 'item-meta' },
        impactBadge(r.maxImpact),
        el('span', {}, label(r.type)),
        el('span', {}, timingText(r)),
        r.lat === null ? el('span', {}, 'Not on map') : null));
    btn.dataset.id = r.id;
    if (r.id === state.selectedId) btn.setAttribute('aria-current', 'true');
    return el('li', {}, btn);
  });
  els.list.replaceChildren(...items);

  if (!state.meta) {
    els.empty.hidden = true;
  } else if (!state.filtered.length) {
    els.empty.hidden = false;
    els.empty.textContent = 'No restrictions match these filters. Try another street spelling, a wider time range, or Reset.';
  } else if (state.filtered.length > LIST_LIMIT) {
    els.empty.hidden = false;
    els.empty.textContent = `Showing the first ${LIST_LIMIT} of ${state.filtered.length.toLocaleString()}. Search for a street or narrow the filters to see more.`;
  } else {
    els.empty.hidden = true;
  }
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
  els.detailsBody.replaceChildren(
    el('h2', { id: 'details-title' }, r.name ?? r.road ?? 'Unnamed location'),
    impactBadge(r.maxImpact),
    r.description ? el('p', { class: 'details-desc' }, r.description) : null,
    el('dl', {}, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', { class: 'details-desc' }, v)])),
    link ? el('a', { href: link, target: '_blank', rel: 'noopener' }, 'View on City of Toronto site') : null,
    el('p', { class: 'map-note' }, `City record ID ${r.id}. Reported by applicants; not field-verified.`),
  );
}

function select(id, { from } = {}) {
  state.selectedId = id;
  for (const b of els.list.querySelectorAll('.item')) {
    if (b.dataset.id === id) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }
  map.select(id, { pan: from === 'list' });
  renderDetails();
  if (from === 'map') {
    els.list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  els.details.scrollIntoView({ block: 'nearest' });
}

// ---- Events ----

let debounce;
els.q.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(apply, 150); });
for (const s of [els.time, els.type, els.impact]) s.addEventListener('change', apply);
els.form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
els.form.addEventListener('reset', () => setTimeout(apply, 0));
els.refresh.addEventListener('click', load);
els.closeDetails.addEventListener('click', () => {
  const id = state.selectedId;
  state.selectedId = null;
  select(null);
  els.list.querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
});

for (const b of document.querySelectorAll('.view-toggle button')) {
  b.addEventListener('click', () => {
    els.layout.dataset.view = b.dataset.view;
    for (const o of document.querySelectorAll('.view-toggle button')) {
      o.setAttribute('aria-pressed', String(o === b));
    }
    if (b.dataset.view === 'map') map.render();
  });
}

load();
