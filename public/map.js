// Minimal dependency-free slippy map: OSM raster tiles, markers, one highlighted line.

const TILE_SIZE = 256;
const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const MIN_ZOOM = 10;
const MAX_ZOOM = 18;
const CLUSTER_BELOW_ZOOM = 15;
const CLUSTER_CELL = 52;
const IMPACT_RANK = { High: 3, Medium: 2, Low: 1 };
const BOUNDS = { minLat: 43.55, maxLat: 43.88, minLon: -79.65, maxLon: -79.1 };
const SVG_NS = 'http://www.w3.org/2000/svg';

function project(lat, lon, z) {
  const scale = TILE_SIZE * 2 ** z;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  };
}

function unproject(x, y, z) {
  const scale = TILE_SIZE * 2 ** z;
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lon };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class TileMap {
  constructor(container, { onSelect, onTileError } = {}) {
    this.el = container;
    this.onSelect = onSelect;
    this.onTileError = onTileError;
    this.zoom = 12;
    this.center = { lat: 43.7, lon: -79.39 };
    this.records = [];
    this.selectedId = null;
    this.user = null;
    this.tileErrors = 0;

    this.tiles = document.createElement('div');
    this.tiles.className = 'map-tiles';
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('class', 'map-lines');
    this.svg.setAttribute('aria-hidden', 'true');
    this.markers = document.createElement('div');
    this.markers.className = 'map-markers';
    this.el.append(this.tiles, this.svg, this.markers);

    this.#bindInput();
    new ResizeObserver(() => this.render()).observe(this.el);
  }

  setRecords(records) {
    this.records = records.filter((r) => r.lat !== null);
    this.render();
  }

  select(id, { pan = false } = {}) {
    this.selectedId = id;
    const r = this.records.find((x) => x.id === id);
    if (r && pan) {
      this.center = { lat: r.lat, lon: r.lon };
      if (this.zoom < 14) this.zoom = 15;
    }
    this.render();
  }

  setUser(point) {
    this.user = point;
    this.render();
  }

  /** Frames the given records, or the whole city when there are none. */
  fit(records) {
    const pts = records.filter((r) => r.lat !== null);
    const { w, h } = this.#size();
    if (!pts.length || !w || !h) {
      this.center = { lat: 43.7, lon: -79.39 };
      this.zoom = 12;
      this.render();
      return;
    }
    const lats = pts.map((r) => r.lat);
    const lons = pts.map((r) => r.lon);
    const box = { n: Math.max(...lats), s: Math.min(...lats), e: Math.max(...lons), w: Math.min(...lons) };
    let z = 16;
    for (; z > MIN_ZOOM; z--) {
      const a = project(box.n, box.w, z);
      const b = project(box.s, box.e, z);
      if (b.x - a.x <= w - 90 && b.y - a.y <= h - 90) break;
    }
    this.zoom = z;
    this.center = { lat: (box.n + box.s) / 2, lon: (box.e + box.w) / 2 };
    this.render();
  }

  zoomBy(delta, anchor) {
    const z = clamp(this.zoom + delta, MIN_ZOOM, MAX_ZOOM);
    if (z === this.zoom) return;
    if (anchor) {
      // Keep the geographic point under the anchor fixed.
      const ll = this.#pointToLatLon(anchor.x, anchor.y);
      this.zoom = z;
      const p = project(ll.lat, ll.lon, z);
      const { w, h } = this.#size();
      this.center = unproject(p.x - anchor.x + w / 2, p.y - anchor.y + h / 2, z);
    } else {
      this.zoom = z;
    }
    this.render();
  }

  panBy(dx, dy) {
    const c = project(this.center.lat, this.center.lon, this.zoom);
    this.center = unproject(c.x + dx, c.y + dy, this.zoom);
    this.render();
  }

  #size() {
    return { w: this.el.clientWidth, h: this.el.clientHeight };
  }

  #pointToLatLon(px, py) {
    const { w, h } = this.#size();
    const c = project(this.center.lat, this.center.lon, this.zoom);
    return unproject(c.x - w / 2 + px, c.y - h / 2 + py, this.zoom);
  }

  #clampCenter() {
    this.center.lat = clamp(this.center.lat, BOUNDS.minLat, BOUNDS.maxLat);
    this.center.lon = clamp(this.center.lon, BOUNDS.minLon, BOUNDS.maxLon);
  }

  render() {
    const { w, h } = this.#size();
    if (!w || !h) return;
    this.#clampCenter();
    const z = this.zoom;
    const c = project(this.center.lat, this.center.lon, z);
    const ox = c.x - w / 2;
    const oy = c.y - h / 2;
    const max = 2 ** z;

    // Tiles: reuse existing <img> elements by key, render only visible ones.
    const wanted = new Map();
    for (let tx = Math.floor(ox / TILE_SIZE); tx <= Math.floor((ox + w) / TILE_SIZE); tx++) {
      for (let ty = Math.floor(oy / TILE_SIZE); ty <= Math.floor((oy + h) / TILE_SIZE); ty++) {
        if (tx < 0 || ty < 0 || tx >= max || ty >= max) continue;
        wanted.set(`${z}/${tx}/${ty}`, [tx, ty]);
      }
    }
    for (const img of [...this.tiles.children]) {
      if (!wanted.has(img.dataset.key)) img.remove();
    }
    const existing = new Map([...this.tiles.children].map((img) => [img.dataset.key, img]));
    for (const [key, [tx, ty]] of wanted) {
      let img = existing.get(key);
      if (!img) {
        img = document.createElement('img');
        img.alt = '';
        img.draggable = false;
        img.dataset.key = key;
        img.width = img.height = TILE_SIZE;
        img.addEventListener('error', () => {
          img.classList.add('tile-failed');
          this.tileErrors++;
          this.onTileError?.(this.tileErrors);
        }, { once: true });
        img.src = TILE_URL(z, tx, ty);
        this.tiles.append(img);
      }
      img.style.transform = `translate(${tx * TILE_SIZE - ox}px, ${ty * TILE_SIZE - oy}px)`;
    }

    // Markers: only those in the viewport; nearby ones merge into clusters when zoomed out.
    this.markers.replaceChildren();
    const frag = document.createDocumentFragment();
    const cells = new Map();
    let selectedEl = null;
    const clustering = z < CLUSTER_BELOW_ZOOM;
    for (const r of this.records) {
      const p = project(r.lat, r.lon, z);
      const x = p.x - ox;
      const y = p.y - oy;
      if (x < -30 || y < -30 || x > w + 30 || y > h + 30) continue;
      if (clustering && r.id !== this.selectedId) {
        const key = `${Math.floor(x / CLUSTER_CELL)}:${Math.floor(y / CLUSTER_CELL)}`;
        const cell = cells.get(key);
        if (cell) cell.push({ r, x, y });
        else cells.set(key, [{ r, x, y }]);
        continue;
      }
      const m = this.#marker(r, x, y);
      if (r.id === this.selectedId) selectedEl = m;
      else frag.append(m);
    }
    for (const group of cells.values()) {
      if (group.length === 1) { frag.append(this.#marker(group[0].r, group[0].x, group[0].y)); continue; }
      const x = group.reduce((sum, g) => sum + g.x, 0) / group.length;
      const y = group.reduce((sum, g) => sum + g.y, 0) / group.length;
      const worst = group.reduce((a, g) => ((IMPACT_RANK[g.r.maxImpact] ?? 0) > (IMPACT_RANK[a] ?? 0) ? g.r.maxImpact : a), 'Unknown');
      const ll = unproject(x + ox, y + oy, z);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `cluster impact-${worst.toLowerCase()}`;
      b.textContent = group.length > 999 ? '999+' : String(group.length);
      b.style.transform = `translate(${x}px, ${y}px)`;
      b.tabIndex = -1;
      b.setAttribute('aria-label', `${group.length} restrictions, highest impact ${worst}. Zoom in.`);
      b.dataset.lat = String(ll.lat);
      b.dataset.lon = String(ll.lon);
      frag.append(b);
    }
    this.markers.append(frag);
    if (selectedEl) this.markers.append(selectedEl); // draw on top

    if (this.user) {
      const p = project(this.user.lat, this.user.lon, z);
      const dot = document.createElement('span');
      dot.className = 'user-dot';
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Your location');
      dot.style.transform = `translate(${p.x - ox}px, ${p.y - oy}px)`;
      this.markers.append(dot);
    }

    // Selected segment line.
    this.svg.replaceChildren();
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const sel = this.records.find((r) => r.id === this.selectedId);
    if (sel?.line) {
      const pts = sel.line.map(([lat, lon]) => {
        const p = project(lat, lon, z);
        return `${(p.x - ox).toFixed(1)},${(p.y - oy).toFixed(1)}`;
      });
      const pl = document.createElementNS(SVG_NS, 'polyline');
      pl.setAttribute('points', pts.join(' '));
      this.svg.append(pl);
    }
  }

  #marker(r, x, y) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `marker impact-${r.maxImpact.toLowerCase()}`;
    b.style.transform = `translate(${x}px, ${y}px)`;
    b.tabIndex = -1; // The list is the keyboard path; avoid hundreds of tab stops.
    b.setAttribute('aria-label', `${r.name ?? r.road ?? 'Restriction'} (${r.maxImpact} impact)`);
    b.dataset.id = r.id;
    if (r.id === this.selectedId) b.classList.add('selected');
    return b;
  }

  #bindInput() {
    const el = this.el;
    el.addEventListener('click', (e) => {
      if (this.dragged) return;
      const cluster = e.target.closest('.cluster');
      if (cluster) {
        this.center = { lat: Number(cluster.dataset.lat), lon: Number(cluster.dataset.lon) };
        this.zoom = Math.min(MAX_ZOOM, this.zoom + 2);
        this.render();
        return;
      }
      const b = e.target.closest('.marker');
      if (b) this.onSelect?.(b.dataset.id);
    });

    const pointers = new Map();
    let last = null;
    let pinchDist = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.map-controls')) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      last = { x: e.clientX, y: e.clientY };
      this.dragged = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist && Math.abs(d - pinchDist) > 60) {
          const rect = el.getBoundingClientRect();
          this.zoomBy(d > pinchDist ? 1 : -1, { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top });
          pinchDist = d;
        } else if (!pinchDist) pinchDist = d;
        this.dragged = true;
        return;
      }
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      if (!this.dragged && Math.abs(dx) + Math.abs(dy) > 3) {
        this.dragged = true;
        // Capture only once a drag begins, otherwise taps on markers are retargeted to the map.
        el.setPointerCapture?.(e.pointerId);
      }
      if (this.dragged) {
        this.panBy(-dx, -dy);
        last = { x: e.clientX, y: e.clientY };
      }
    });
    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = null;
      // Let the click handler see `dragged` before resetting.
      setTimeout(() => { if (!pointers.size) this.dragged = false; }, 0);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    let wheelLock = 0;
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const t = performance.now();
      if (t - wheelLock < 200) return;
      wheelLock = t;
      const rect = el.getBoundingClientRect();
      this.zoomBy(e.deltaY < 0 ? 1 : -1, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    }, { passive: false });

    el.addEventListener('keydown', (e) => {
      const step = 80;
      const actions = {
        ArrowUp: () => this.panBy(0, -step), ArrowDown: () => this.panBy(0, step),
        ArrowLeft: () => this.panBy(-step, 0), ArrowRight: () => this.panBy(step, 0),
        '+': () => this.zoomBy(1), '=': () => this.zoomBy(1), '-': () => this.zoomBy(-1),
      };
      if (actions[e.key] && e.target === el) { e.preventDefault(); actions[e.key](); }
    });
  }
}
