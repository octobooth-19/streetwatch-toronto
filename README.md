# StreetWatch Toronto

**Follow your streets. Know before you go.**

StreetWatch Toronto turns the City of Toronto's road-restriction data into something you can *follow*. Save the streets you care about, choose which changes matter, and get told when they happen, so you don't have to keep checking the City portal.

**Live site:** https://octobooth-19.github.io/streetwatch-toronto/

## Built by

Chris, Dave & Chris

## Features

**Follow streets**
- Save streets (for example *Bloor St W*) on your device. Saved streets, alert choices and your inbox live in `localStorage`; no account needed.
- Choose what you hear about: **new** restriction, **starting within 24 hours**, **impact increased**, **ending within 24 hours**, **cleared**.
- An in-app inbox lists what changed since you last looked, and a badge shows what is unread.
- Optional **browser notifications** while the site is open or installed.

**Email and text message alerts (needs the notification server, see below)**
- Subscribe an email address or a mobile number to your saved streets and alert choices.
- Double opt-in with a 6-digit code, one-click unsubscribe links, rate limiting, and a background watcher that checks the City feed every 5 minutes and sends only what is new.

**Understand what is happening**
- Interactive map with clustering, plus a keyboard-accessible list that holds every result.
- **What changed** feed: restrictions that appeared, escalated or cleared in the last 7 days (the live server tracks this continuously; the hosted site compares each 15-minute snapshot with the previous one).
- 7-day outlook strip, filters for time window, type, impact and street, and a **near me** radius filter.
- Per-restriction details with schedule, segment, impact, and the source link.
- **Add to calendar** (`.ics`) and **Share** for any restriction.
- Per-street **Atom feeds** for people who use feed readers or feed-to-email services.
- Installable **PWA** with an offline-friendly shell and a mobile bottom-sheet layout.

## What the hosted site can and cannot do

GitHub Pages serves static files only, so the hosted site **does not send email or text messages**. Pages gets a fresh data snapshot every 15 minutes and offers browser notifications, an email digest draft (opens your mail app), calendar export, and Atom feeds. The email and SMS sign-up appears only when the app is served by the notification server and is configured as below. The site says so in the My streets panel.

Real email and SMS delivery needs a long-running Node process plus provider credentials. It has been unit-tested with mocked providers, but it has **not** been run against live Resend or Twilio accounts.

## Run it locally

Node.js 20 or newer. There are no packages to install.

```sh
npm start        # http://127.0.0.1:8080   (PORT and HOST change this)
npm test         # node:test suite
npm run build    # static Pages build into ./dist
```

Without provider keys, `npm start` runs email and SMS in **demo mode**: nothing is delivered, messages are written to `.data/outbox.log`, and the verification code is shown on screen so you can try the whole flow.

### Turn on real alerts

Host `server.mjs` anywhere that runs Node (a small VM, Fly.io, Render, Railway, and so on) and set:

| Variable | Purpose |
| --- | --- |
| `RESEND_API_KEY`, `MAIL_FROM` | Email through [Resend](https://resend.com). `MAIL_FROM` must be a sender you have verified. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Text messages through [Twilio](https://www.twilio.com). |
| `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | The sending number or messaging service. |
| `SITE_URL` | Public address of the server, used in message links and unsubscribe URLs. |
| `DATA_DIR` | Where subscriptions and the change log are stored (default `.data/`). Put it on a persistent volume. |
| `PORT`, `HOST` | Listen address (default `127.0.0.1:8080`). |
| `TRUST_PROXY=1` | Read client IPs from `X-Forwarded-For` when behind a reverse proxy. |
| `ALLOWED_ORIGIN` | Allow the Pages site to call this server's subscription API (CORS). |

Email only, SMS only, or both work. Whichever channel has no credentials stays in demo mode. Check carrier and local rules for SMS consent before sending to real people.

## How it works

| Path | Purpose |
| --- | --- |
| `server.mjs` | Static files, `/api/disruptions`, the subscription API, unsubscribe links, and the background watcher. Fetches only the fixed City feed (45 s timeout, 25 MB limit, schema check, 60 s shared cache). If a refresh fails it serves the last good snapshot marked `stale`. |
| `lib/disruptions.mjs` | Shared (server and browser) normalization, Toronto-time windows and filtering. |
| `lib/alerts.mjs` | Pure alert engine: which restrictions on which saved streets deserve a message, with de-duplication state, and email/SMS formatting. |
| `lib/changes.mjs` | Diffs two snapshots into new / escalated / cleared events and keeps a 7-day log. |
| `lib/ics.mjs` | Calendar file generation. |
| `lib/notifier.mjs` | Subscription store, verification codes, rate limiting, Resend and Twilio providers, and the watcher. |
| `scripts/build-site.mjs` | Builds the static site: data snapshot, change log, per-street Atom feeds, manifest. |
| `.github/workflows/pages.yml` | Tests, builds and deploys to GitHub Pages on every push and every 15 minutes. |
| `public/` | Dependency-free front end: `app.js`, `panels.js`, `saved.js`, `map.js`, `dom.js`, service worker and manifest. |

The City feed rejects cross-origin browser requests, so the browser never calls it directly. Locally the server proxies it; on Pages the workflow downloads it and publishes a snapshot next to the site.

## Data caveats

- Restrictions are reported by applicants and are **not field-verified**. Actual conditions may differ.
- "Active now" means the reported date range includes the current moment, not that crews are working right now.
- Records without usable coordinates stay in the list and are labelled "Not on map".
- Saved-street matching is by street name, so *Bloor St W* also matches segments described relative to it.

## Licences and attribution

- Contains information licensed under the [Open Government Licence – Toronto](https://open.toronto.ca/open-data-license/). Source: [Road Restrictions](https://open.toronto.ca/dataset/road-restrictions/), City of Toronto Open Data. Not affiliated with or endorsed by the City of Toronto.
- Map tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, used under the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). Public OSM tiles are best-effort and not meant for heavy traffic; swap `TILE_URL` in `public/map.js` (and the CSP `img-src` in `server.mjs`) before large-scale use.
