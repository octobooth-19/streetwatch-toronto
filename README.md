# StreetWatch Toronto

A mobile-friendly map and searchable list of Toronto road restrictions — closures, construction, and hazards — for residents checking nearby streets before heading out.

Data comes from the City of Toronto's [Road Restrictions](https://open.toronto.ca/dataset/road-restrictions/) open dataset.

## Run locally

Requires Node.js 20+. No packages to install.

```sh
npm start          # http://127.0.0.1:8080  (set PORT / HOST to change)
npm test           # node:test suite
```

The app must be served by `server.mjs` (not opened as a file) because the browser loads data through the same-origin `/api/disruptions` endpoint.

## Features

- Street search across road, segment, from/to/at road names
- Time filter: **Active now** (default), **Today**, **Next 7 days**, All dates, Unknown timing — calculated in `America/Toronto`, DST-aware
- Type and reported (max) impact filters, using the City's own labels
- Map and list share one filtered result set; selecting either highlights the other and opens full details (schedule, segment, source link)
- Manual Refresh, with retrieval time and latest City update time shown separately
- Mobile List/Map switch; keyboard-accessible list is a complete alternative to the map

Out of scope for v1: accounts, saved streets, notifications, routing.

## How it works

| File | Purpose |
| --- | --- |
| `server.mjs` | Static file server + `/api/disruptions`. Fetches only the fixed City feed, with a 20 s timeout, 25 MB limit, schema check, 60 s shared cache, and coalesced concurrent requests. If a refresh fails, the last good snapshot is served marked `stale`; with no snapshot it returns HTTP 502. |
| `lib/disruptions.mjs` | Shared (server + browser) normalization, Toronto date windows, and filtering. |
| `public/map.js` | Dependency-free slippy map: OpenStreetMap raster tiles, markers, selected-segment line, drag/pinch/wheel/keyboard pan & zoom. |
| `public/app.js` | UI state, list, details, filters. Source text is always rendered as text; links are limited to http(s). |

## Data caveats

- Restrictions are reported by applicants and are **not field-verified**; actual conditions may differ.
- "Active now" means the reported date range includes now — not that crews are working at this instant. Recurring schedules are displayed but not evaluated.
- Records without valid coordinates stay in the list and are labelled "Not on map". Records without a valid start date appear only under *Unknown timing*. Records with no end date are treated as ongoing and labelled as such.
- The list shows the first 300 matches; search or filter to narrow.

## Licences and attribution

- Contains information licensed under the [Open Government Licence – Toronto](https://open.toronto.ca/open-data-license/). Not affiliated with or endorsed by the City of Toronto.
- Map tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, used under the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

## Before a public launch

- Hosting must run a long-lived Node.js process (or adapt `/api/disruptions` to an equivalent).
- Public OSM tiles are best-effort and not intended for heavy traffic; swap `TILE_URL` in `public/map.js` (and the CSP `img-src` in `server.mjs`) for a production tile provider.
- Confirm the City feed remains reachable from the hosting environment (it returned HTTP 403 to some browser-origin requests during planning, which is why it's proxied server-side).
