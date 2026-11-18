// Tabs plus the "My streets" and "Changes" panels.

import { ALERT_KINDS } from './lib/alerts.mjs';
import { matchesStreet, lifecycle, normStreet } from './lib/disruptions.mjs';
import { $, el, relativeTime } from './dom.js';

const TABS = ['results', 'saved', 'changes'];
const KIND_LABEL = { new: 'New', starting: 'Starting', escalated: 'Impact up', ending: 'Ending', cleared: 'Cleared' };

export function initPanels({ state, saved, follow, reveal, setFilters, toast }) {
  const layout = document.querySelector('.layout');
  let config = state.config;
  let feedIndex = null;
  let current = 'results';

  // ---- Tabs ----

  function openTab(name, { focus = false, keepView = false } = {}) {
    if (!TABS.includes(name)) return;
    current = name;
    if (!keepView) {
      layout.dataset.view = 'list';
      for (const b of document.querySelectorAll('.view-toggle button')) b.setAttribute('aria-pressed', String(b.dataset.view === 'list'));
    }
    for (const t of TABS) {
      const tab = $(`tab-${t}`);
      const on = t === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $(`panel-${t}`).hidden = !on;
      if (on && focus) tab.focus();
    }
    if (name === 'saved') { renderSaved(); loadFeedIndex(); saved.markSeen(); }
    if (name === 'changes') renderChanges();
  }

  $('tab-results').parentElement.addEventListener('keydown', (e) => {
    const i = TABS.indexOf(document.activeElement?.id.replace('tab-', ''));
    if (i < 0) return;
    const next = { ArrowRight: (i + 1) % 3, ArrowLeft: (i + 2) % 3, Home: 0, End: 2 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    openTab(TABS[next], { focus: true });
  });
  for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => openTab(t));

  // ---- My streets ----

  const matching = (w) => state.records.filter((r) => matchesStreet(r, w.query, { whole: true }));

  function renderBadge() {
    const n = saved.unread();
    const badge = $('saved-badge');
    badge.hidden = n === 0 || current === 'saved';
    badge.textContent = String(n);
    badge.setAttribute('aria-label', `${n} unread update${n === 1 ? '' : 's'}`);
  }

  function renderSaved() {
    renderBadge();
    const watches = saved.watches();
    $('saved-empty').hidden = watches.length > 0;
    $('saved-list').replaceChildren(...watches.map((w) => {
      const recs = matching(w);
      const active = recs.filter((r) => lifecycle(r, Date.now()) === 'active').length;
      const upcoming = recs.filter((r) => lifecycle(r, Date.now()) === 'upcoming').length;
      const summary = !state.meta ? 'Loading…'
        : recs.length === 0 ? 'Nothing reported right now'
          : [active ? `${active} active` : null, upcoming ? `${upcoming} upcoming` : null,
            recs.length - active - upcoming ? `${recs.length - active - upcoming} other` : null].filter(Boolean).join(' · ');
      return el('li', { class: 'saved-item' },
        el('div', { class: 'saved-main' },
          el('span', { class: 'saved-name' }, w.label),
          el('span', { class: 'saved-sub' }, summary)),
        el('button', {
          type: 'button', class: 'btn btn-quiet btn-small',
          onclick: () => setFilters({ q: w.query, time: 'all', type: '', impact: '' }, 'results'),
        }, 'View'),
        el('button', {
          type: 'button', class: 'btn btn-quiet btn-small', 'aria-label': `Stop following ${w.label}`,
          onclick: () => { saved.remove(w.query); toast(`Stopped following ${w.label}.`); },
        }, 'Remove'));
    }));

    const kinds = new Set(saved.kinds());
    $('kinds').replaceChildren(
      el('legend', {}, 'Alert me when'),
      ...Object.entries(ALERT_KINDS).map(([k, v]) => el('label', { class: 'check' },
        el('input', {
          type: 'checkbox', checked: kinds.has(k),
          onchange: (e) => {
            const on = new Set(saved.kinds());
            if (e.target.checked) on.add(k); else on.delete(k);
            if (on.size === 0) { e.target.checked = true; toast('Keep at least one alert type on.'); return; }
            saved.setKinds([...on]);
          },
        }),
        el('span', {}, el('b', {}, v.label), el('span', { class: 'check-hint' }, v.hint)))));

    renderInbox();
    renderDigest();
    renderFeeds();
    renderNotify();
  }

  function renderInbox() {
    const items = saved.inbox();
    $('clear-inbox').hidden = items.length === 0;
    $('inbox-empty').hidden = items.length > 0;
    $('inbox-list').replaceChildren(...items.slice(0, 30).map((a) => el('li', { class: `feed-item kind-${a.kind}` },
      el('span', { class: 'kind-tag' }, KIND_LABEL[a.kind] ?? a.kind),
      el('div', { class: 'feed-body' },
        el('p', { class: 'feed-title' }, a.title),
        el('p', { class: 'feed-detail' }, a.detail),
        el('p', { class: 'feed-time' }, relativeTime(a.at))),
      a.kind !== 'cleared' ? el('button', {
        type: 'button', class: 'btn btn-quiet btn-small', onclick: () => reveal(a.recordId),
      }, 'Open') : null)));
  }

  $('clear-inbox').addEventListener('click', () => saved.clearInbox());

  // Add a street by name.
  $('add-street').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('street-input');
    const msg = $('add-msg');
    const q = input.value.trim();
    msg.classList.remove('error');
    if (!q) { msg.textContent = 'Type a street name first.'; msg.classList.add('error'); input.focus(); return; }
    if (follow(q)) { msg.textContent = ''; input.value = ''; } else {
      msg.textContent = saved.has(q) ? `You already follow ${q}.` : 'Could not add that street.';
      msg.classList.add('error');
    }
    input.focus();
  });

  // ---- Delivery: browser notifications ----

  const canNotify = 'Notification' in window;
  function renderNotify() {
    const btn = $('notify-toggle');
    const hint = $('notify-hint');
    if (!canNotify) {
      btn.disabled = true;
      btn.textContent = 'Not supported';
      hint.textContent = 'This browser does not support notifications.';
      return;
    }
    const perm = Notification.permission;
    const on = saved.notify && perm === 'granted';
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? 'On' : 'Turn on';
    btn.disabled = perm === 'denied';
    hint.textContent = perm === 'denied'
      ? 'Notifications are blocked for this site. Allow them in your browser settings to use this.'
      : 'Shows a notification on this device when your streets change. It runs while StreetWatch is open or installed, and checks every few minutes.';
  }
  $('notify-toggle').addEventListener('click', async () => {
    if (saved.notify) { saved.setNotify(false); renderNotify(); return; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    saved.setNotify(perm === 'granted');
    renderNotify();
    if (perm === 'granted') toast('Browser notifications are on.');
  });

  // ---- Delivery: email summary via mailto ----

  function renderDigest() {
    const watches = saved.watches();
    const link = $('digest');
    link.hidden = false;
    if (!watches.length) { link.setAttribute('aria-disabled', 'true'); link.href = '#'; link.tabIndex = -1; return; }
    link.removeAttribute('aria-disabled');
    link.tabIndex = 0;
    const lines = watches.flatMap((w) => {
      const recs = matching(w).filter((r) => lifecycle(r, Date.now()) !== 'ended').slice(0, 5);
      return [`${w.label}: ${recs.length ? '' : 'nothing reported'}`,
        ...recs.map((r) => `  - ${r.name ?? r.road} (${r.maxImpact} impact)`), ''];
    });
    const body = `${lines.join('\n')}\nVia StreetWatch Toronto: ${location.href.split('#')[0]}`.slice(0, 1500);
    link.href = `mailto:?subject=${encodeURIComponent('My Toronto street restrictions')}&body=${encodeURIComponent(body)}`;
  }
  $('digest').addEventListener('click', (e) => { if (e.currentTarget.getAttribute('aria-disabled')) e.preventDefault(); });

  // ---- Delivery: per-street feeds (for feed-to-email/SMS services) ----

  async function loadFeedIndex() {
    if (feedIndex !== null || config.mode !== 'static') return;
    feedIndex = [];
    try {
      const res = await fetch('./feeds/index.json', { cache: 'no-store' });
      if (res.ok) feedIndex = await res.json();
    } catch { /* feeds are optional */ }
    renderFeeds();
  }

  function renderFeeds() {
    const slugOf = (w) => normStreet(w.query).replace(/ /g, '-');
    const available = saved.watches().filter((w) => (feedIndex ?? []).includes(slugOf(w)));
    $('feeds').hidden = !feedIndex?.length;
    const links = [
      ...available.map((w) => ({ name: w.label, url: new URL(`./feeds/${slugOf(w)}.atom`, location.href).href })),
      { name: 'All City changes', url: new URL('./feeds/changes.atom', location.href).href },
    ];
    $('feed-list').replaceChildren(...links.map((l) => el('li', {},
      el('span', {}, l.name),
      el('button', {
        type: 'button', class: 'btn btn-quiet btn-small',
        onclick: async () => {
          try { await navigator.clipboard.writeText(l.url); toast(`Feed link for ${l.name} copied.`); } catch { toast(l.url); }
        },
      }, 'Copy feed link'))));
  }

  // ---- Delivery: server email / SMS ----

  const subForm = $('sub-form');
  const codeForm = $('code-form');
  let pending = null;

  async function api(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch { /* fall through */ }
    if (!res.ok) throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
    return data;
  }

  const mask = (channel, address) => (channel === 'sms'
    ? `•••• ${address.slice(-4)}`
    : address.replace(/^(.).*(@.*)$/, '$1•••$2'));

  function setMsg(node, text, isError = false) {
    node.textContent = text;
    node.classList.toggle('error', isError);
  }

  function renderSub() {
    const n = config.notifications ?? { email: 'unavailable', sms: 'unavailable' };
    const live = config.mode === 'live' && (n.email !== 'unavailable' || n.sms !== 'unavailable');
    subForm.hidden = !live;
    codeForm.hidden = !live || !pending;
    const note = $('static-note');
    note.hidden = live;
    if (!live) {
      note.textContent = 'Email and text message alerts need the StreetWatch notification server with email and SMS provider keys. This hosted site has no server, so it offers browser notifications, email summaries and feeds instead. See the README to run the server.';
      return;
    }
    for (const radio of subForm.querySelectorAll('input[name="channel"]')) {
      radio.disabled = n[radio.value] === 'unavailable';
      if (radio.disabled && radio.checked) {
        const other = subForm.querySelector('input[name="channel"]:not(:disabled)');
        if (other) other.checked = true;
      }
    }
    syncChannel();
    const sub = saved.sub;
    const demo = n.email === 'demo' || n.sms === 'demo';
    if (sub) {
      setMsg($('sub-status'), `Alerts are on for ${mask(sub.channel, sub.address)}. `);
      const stop = el('a', { href: `./unsubscribe?token=${encodeURIComponent(sub.token)}` }, 'Stop alerts');
      $('sub-status').append(stop);
      $('sub-submit').textContent = 'Update contact';
    } else {
      setMsg($('sub-status'), demo
        ? 'Demo mode: this server has no email or SMS provider keys, so no real messages are sent. The flow works end to end and shows your code on screen.'
        : 'Get a message when something changes on the streets you follow, even if this site is closed. We send a code first to confirm it is you.');
      $('sub-submit').textContent = 'Send verification code';
    }
  }

  function syncChannel() {
    const sms = subForm.querySelector('input[name="channel"]:checked')?.value === 'sms';
    $('sub-address-label').textContent = sms ? 'Mobile number (Canada or US)' : 'Email address';
    $('sub-address').type = sms ? 'tel' : 'email';
    $('sub-address').autocomplete = sms ? 'tel' : 'email';
    $('sub-address').placeholder = sms ? '+1 416 555 0123' : 'you@example.com';
  }
  for (const radio of subForm.querySelectorAll('input[name="channel"]')) radio.addEventListener('change', syncChannel);

  subForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('sub-msg');
    const channel = subForm.querySelector('input[name="channel"]:checked').value;
    const address = $('sub-address').value.trim();
    if (!saved.watches().length) { setMsg(msg, 'Follow at least one street first.', true); return; }
    if (!address) { setMsg(msg, channel === 'sms' ? 'Enter your mobile number.' : 'Enter your email address.', true); $('sub-address').focus(); return; }
    if (!$('sub-consent').checked) { setMsg(msg, 'Please tick the box to confirm you agree to receive alerts.', true); return; }
    const submit = $('sub-submit');
    submit.disabled = true;
    setMsg(msg, 'Sending…');
    try {
      const res = await api('./api/subscriptions', {
        channel, address, consent: true, kinds: saved.kinds(),
        streets: saved.watches().map((w) => ({ query: w.query, label: w.label })),
      });
      pending = { id: res.id, channel, address };
      codeForm.hidden = false;
      $('sub-code').value = res.demoCode ?? '';
      setMsg(msg, res.demoCode
        ? `Demo mode: no message was sent. Your code is ${res.demoCode}.`
        : `We sent a 6-digit code to ${mask(channel, address)}. It expires in 15 minutes.`);
      $('sub-code').focus();
    } catch (err) {
      setMsg(msg, err.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  codeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('code-msg');
    const code = $('sub-code').value.trim();
    if (!/^\d{6}$/.test(code)) { setMsg(msg, 'Enter the 6-digit code.', true); return; }
    try {
      const res = await api('./api/subscriptions/confirm', { id: pending.id, code });
      saved.setSub({ token: res.token, channel: pending.channel, address: pending.address });
      pending = null;
      $('sub-address').value = '';
      $('sub-consent').checked = false;
      setMsg($('sub-msg'), '');
      setMsg(msg, '');
      codeForm.hidden = true;
      renderSub();
      toast('Alerts are on.');
    } catch (err) {
      setMsg(msg, err.message, true);
    }
  });

  // Keep the server in step when streets or alert types change.
  let syncTimer;
  function syncServer() {
    const sub = saved.sub;
    if (!sub || !saved.watches().length) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      api('./api/subscriptions/update', {
        token: sub.token, kinds: saved.kinds(),
        streets: saved.watches().map((w) => ({ query: w.query, label: w.label })),
      }).catch((err) => {
        if (/no longer active/.test(err.message)) saved.setSub(null);
      });
    }, 800);
  }

  // ---- Changes ----

  function renderChanges() {
    const { generatedAt, events } = state.changes;
    const mine = $('changes-mine').checked;
    const watches = saved.watches();
    let shown = events;
    if (mine) {
      shown = events.filter((e) => watches.some((w) => matchesStreet(
        { road: e.road, name: e.name, fromRoad: e.from, toRoad: e.to, atRoad: null }, w.query, { whole: true })));
    }
    $('changes-summary').textContent = generatedAt
      ? `What changed in the City feed over the last 7 days. Last compared ${relativeTime(generatedAt)}.`
      : 'Change history is not available yet.';
    $('changes-empty').hidden = shown.length > 0;
    $('changes-empty').textContent = !generatedAt
      ? 'The change log starts after the first comparison. Check back after the next update.'
      : mine && !watches.length
        ? 'Follow a street to see changes on just your streets.'
        : mine ? 'Nothing has changed on your streets in the last 7 days.' : 'No changes recorded in the last 7 days.';
    $('changes-list').replaceChildren(...shown.slice(0, 100).map((e) => el('li', { class: `feed-item kind-${e.kind}` },
      el('span', { class: 'kind-tag' }, KIND_LABEL[e.kind] ?? e.kind),
      el('div', { class: 'feed-body' },
        el('p', { class: 'feed-title' }, e.name ?? e.road ?? 'Unnamed location'),
        el('p', { class: 'feed-detail' },
          e.kind === 'escalated' ? `${e.impact} impact (was ${e.was})` : `${e.impact} impact`,
          e.from && e.to ? ` · ${e.from} to ${e.to}` : ''),
        el('p', { class: 'feed-time' }, relativeTime(e.at))),
      e.kind !== 'cleared' && state.records.some((r) => r.id === e.id)
        ? el('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => reveal(e.id) }, 'Open')
        : null)));
  }
  $('changes-mine').addEventListener('change', renderChanges);

  saved.onChange(() => {
    renderBadge();
    if (current === 'saved') { renderSaved(); saved.markSeen(); }
    if (current === 'changes') renderChanges();
    syncServer();
  });

  renderBadge();
  renderSub();

  return {
    openTab,
    setConfig(c) { config = c; renderSub(); },
    onData() {
      renderBadge();
      if (current === 'saved') renderSaved();
      if (current === 'changes') renderChanges();
    },
  };
}
