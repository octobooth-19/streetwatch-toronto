// Saved streets, alert preferences and the on-device inbox. Everything lives in localStorage.

import { computeAlerts, emptyState, DEFAULT_KINDS } from './lib/alerts.mjs';
import { normStreet } from './lib/disruptions.mjs';

const KEY = 'streetwatch.v1';
export const MAX_STREETS = 10;
const INBOX_MAX = 60;

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; }
}

export function createSaved() {
  const data = {
    watches: [], kinds: [...DEFAULT_KINDS], state: emptyState(), inbox: [], seenAt: 0, notify: false, sub: null,
    ...read(),
  };
  const listeners = new Set();
  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* private mode: keep in memory */ }
    for (const fn of listeners) fn();
  };

  return {
    onChange: (fn) => listeners.add(fn),
    watches: () => data.watches,
    kinds: () => data.kinds,
    inbox: () => data.inbox,
    get sub() { return data.sub; },
    get notify() { return data.notify; },
    unread: () => data.inbox.filter((a) => a.at > data.seenAt).length,
    id: (query) => normStreet(query).replace(/ /g, '-'),
    has(query) { const id = normStreet(query).replace(/ /g, '-'); return data.watches.some((w) => w.id === id); },

    add(query, labelText = query) {
      const q = String(query).trim().replace(/\s+/g, ' ');
      const id = normStreet(q).replace(/ /g, '-');
      if (q.length < 2 || !id) return { ok: false, message: 'Enter at least two characters of a street name.' };
      if (data.watches.some((w) => w.id === id)) return { ok: false, message: `You already follow ${q}.` };
      if (data.watches.length >= MAX_STREETS) return { ok: false, message: `You can follow up to ${MAX_STREETS} streets.` };
      data.watches.push({ id, query: q.slice(0, 60), label: String(labelText).trim().slice(0, 60) || q });
      persist();
      return { ok: true, id };
    },

    remove(query) {
      const id = normStreet(query).replace(/ /g, '-');
      data.watches = data.watches.filter((w) => w.id !== id);
      delete data.state.index[id];
      persist();
    },

    setKinds(kinds) { data.kinds = kinds; persist(); },
    setNotify(on) { data.notify = on; persist(); },
    setSub(sub) { data.sub = sub; persist(); },
    markSeen() { if (data.inbox.some((a) => a.at > data.seenAt)) { data.seenAt = Date.now(); persist(); } },
    clearInbox() { data.inbox = []; persist(); },

    /** Runs the alert engine on fresh data and stores anything new in the inbox. */
    evaluate(records, now = Date.now()) {
      if (data.watches.length === 0) return [];
      const { alerts, state } = computeAlerts({ records, watches: data.watches, kinds: data.kinds, state: data.state, now });
      data.state = state;
      data.inbox = [...alerts, ...data.inbox].slice(0, INBOX_MAX);
      persist();
      return alerts;
    },
  };
}

/** Shows OS-level notifications while the app is open (service worker route works on mobile). */
export async function showNotifications(alerts) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || alerts.length === 0) return;
  const reg = await navigator.serviceWorker?.getRegistration?.();
  const show = (title, body, tag) => {
    const options = { body, tag, icon: './icon-192.png', badge: './icon-192.png' };
    if (reg?.showNotification) return reg.showNotification(title, options);
    return new Notification(title, options);
  };
  for (const a of alerts.slice(0, 3)) await show(a.title, a.detail, a.key);
  if (alerts.length > 3) await show('StreetWatch Toronto', `${alerts.length - 3} more updates on your streets`, 'streetwatch-more');
}
