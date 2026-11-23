// Grafici a linee in SVG, senza dipendenze: una sola scala Y, mirino con tooltip,
// mirino condiviso tra grafici affiancati, navigazione da tastiera.
const NS = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function ticks(min, max, count) {
  const raw = (max - min) / Math.max(count, 1);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

const COLORS = { grid: '#2c2c2a', axis: '#383835', surface: '#1a1a19', hair: '#898781' };

export class LineChart {
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = { yFormat: String, xFormat: String, yTicks: 4, xTicks: 6, breakOver: Infinity, ...opts };
    this.series = [];
    this.xs = [];
    this.peers = [];
    this.current = null;

    this.svg = svg('svg', { tabindex: '0', 'aria-label': opts.label ?? 'Grafico' });
    this.tip = document.createElement('div');
    this.tip.className = 'tip';
    this.tip.hidden = true;
    host.append(this.svg, this.tip);

    this.svg.addEventListener('pointermove', (e) => this.onPointer(e));
    this.svg.addEventListener('pointerleave', () => this.clearAll());
    this.svg.addEventListener('blur', () => this.clearAll());
    this.svg.addEventListener('click', () => this.pick());
    this.svg.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => this.draw()).observe(host);
  }

  setData(series) {
    this.series = series.map((s) => ({ ...s, map: new Map(s.points) }));
    this.xs = [...new Set(series.flatMap((s) => s.points.map((p) => p[0])))].sort((a, b) => a - b);
    this.draw();
  }

  domain() {
    const { yDomain, zero } = this.opts;
    if (yDomain) return yDomain;
    const ys = this.series.flatMap((s) => s.points.map((p) => p[1]));
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    if (zero) {
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 0);
    }
    const pad = (hi - lo || 1) * 0.08;
    return [lo - pad, hi + pad];
  }

  draw() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    this.svg.replaceChildren();
    this.svg.setAttribute('width', w);
    this.svg.setAttribute('height', h);
    this.geom = null;
    if (!w || !h || !this.xs.length) return;

    const m = { l: 46, r: this.opts.directLabels ? 38 : 8, t: 6, b: this.opts.hideXAxis ? 4 : 17 };
    const [y0, y1] = this.domain();
    const x0 = this.xs[0];
    const x1 = this.xs[this.xs.length - 1];
    const px = (x) => m.l + ((x - x0) / (x1 - x0 || 1)) * (w - m.l - m.r);
    const py = (y) => h - m.b - ((y - y0) / (y1 - y0 || 1)) * (h - m.t - m.b);
    this.geom = { px, py, m, h };

    const yCount = Math.max(1, Math.min(this.opts.yTicks, Math.floor((h - m.t - m.b) / 22)));
    for (const v of ticks(y0, y1, yCount)) {
      this.svg.append(svg('line', { x1: m.l, x2: w - m.r, y1: py(v), y2: py(v), stroke: COLORS.grid, 'stroke-width': 1 }));
      const t = svg('text', { x: m.l - 6, y: py(v) + 3, 'text-anchor': 'end' });
      t.textContent = this.opts.yFormat(v);
      this.svg.append(t);
    }
    if (this.opts.zero) {
      this.svg.append(svg('line', { x1: m.l, x2: w - m.r, y1: py(0), y2: py(0), stroke: COLORS.hair, 'stroke-width': 1 }));
    }
    if (!this.opts.hideXAxis) {
      for (const v of ticks(x0, x1, this.opts.xTicks)) {
        const t = svg('text', { x: px(v), y: h - 4, 'text-anchor': 'middle' });
        t.textContent = this.opts.xFormat(v);
        this.svg.append(t);
      }
    }

    for (const s of this.series) {
      let d = '';
      let prev = null;
      for (const [x, y] of s.points) {
        d += `${prev == null || x - prev > this.opts.breakOver ? 'M' : 'L'}${px(x).toFixed(1)},${py(y).toFixed(1)}`;
        prev = x;
      }
      this.svg.append(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }

    if (this.opts.directLabels) this.drawDirectLabels(w, m, px, py);

    this.hair = svg('line', { y1: m.t, y2: h - m.b, stroke: COLORS.hair, 'stroke-width': 1, visibility: 'hidden' });
    this.dots = svg('g');
    this.svg.append(this.hair, this.dots);
    if (this.current != null) this.show(this.current, false);
  }

  drawDirectLabels(w, m, px, py) {
    const labels = this.series
      .filter((s) => s.points.length)
      .map((s) => {
        const [x, y] = s.points[s.points.length - 1];
        return { name: s.name, x: px(x), y: py(y) };
      })
      .sort((a, b) => a.y - b.y);
    const lineHeight = 12;
    const lastY = this.geom.h - 8;
    labels.forEach((l, i) => {
      if (i && l.y - labels[i - 1].y < lineHeight) l.y = labels[i - 1].y + lineHeight;
    });
    // Se la pila sfora in basso si risale, così nessuna etichetta resta tagliata.
    for (let i = labels.length - 1; i >= 0; i--) {
      labels[i].y = Math.max(Math.min(labels[i].y, lastY - (labels.length - 1 - i) * lineHeight), 6);
    }
    labels.forEach((l) => {
      const t = svg('text', { class: 'direct', x: w - m.r + 5, y: l.y + 4 });
      t.textContent = l.name;
      this.svg.append(t);
    });
  }

  nearest(x) {
    let best = this.xs[0];
    for (const v of this.xs) if (Math.abs(v - x) < Math.abs(best - x)) best = v;
    return best;
  }

  onPointer(e) {
    if (!this.geom || !this.xs.length) return;
    const rect = this.svg.getBoundingClientRect();
    const { m } = this.geom;
    const frac = (e.clientX - rect.left - m.l) / (rect.width - m.l - m.r);
    const x0 = this.xs[0];
    const x1 = this.xs[this.xs.length - 1];
    this.showAll(this.nearest(x0 + Math.min(Math.max(frac, 0), 1) * (x1 - x0)));
  }

  onKey(e) {
    if (!this.xs.length) return;
    if (e.key === 'Enter') return this.pick();
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const i = this.current == null ? 0 : this.xs.indexOf(this.current);
    const next = Math.min(Math.max(i + (e.key === 'ArrowRight' ? 1 : -1), 0), this.xs.length - 1);
    this.showAll(this.xs[next]);
  }

  pick() {
    if (this.current != null) this.opts.onPick?.(this.current);
  }

  showAll(x) {
    this.show(x, true);
    for (const p of this.peers) p.show(x, false);
  }

  clearAll() {
    this.clear();
    for (const p of this.peers) p.clear();
  }

  clear() {
    this.current = null;
    this.tip.hidden = true;
    this.hair?.setAttribute('visibility', 'hidden');
    this.dots?.replaceChildren();
  }

  show(x, withTip) {
    if (!this.geom) return;
    this.current = x;
    const { px, py } = this.geom;
    const X = px(x);
    this.hair.setAttribute('x1', X);
    this.hair.setAttribute('x2', X);
    this.hair.setAttribute('visibility', 'visible');
    this.dots.replaceChildren();
    for (const s of this.series) {
      if (!s.map.has(x)) continue;
      this.dots.append(svg('circle', { cx: X, cy: py(s.map.get(x)), r: 4, fill: s.color, stroke: COLORS.surface, 'stroke-width': 2 }));
    }
    if (withTip) this.renderTip(x, X);
    else this.tip.hidden = true;
  }

  renderTip(x, X) {
    const head = document.createElement('p');
    head.className = 'x';
    head.textContent = this.opts.xFormat(x);
    const rows = this.series
      .filter((s) => s.map.has(x))
      .map((s) => {
        const row = document.createElement('div');
        const key = document.createElement('i');
        key.style.setProperty('--key', s.color);
        const value = document.createElement('b');
        value.textContent = this.opts.yFormat(s.map.get(x));
        const name = document.createElement('span');
        name.textContent = s.name;
        row.append(key, value, name);
        return row;
      });
    this.tip.replaceChildren(head, ...rows);
    this.tip.hidden = false;
    const width = this.tip.offsetWidth;
    const left = X + 12 + width > this.host.clientWidth ? X - 12 - width : X + 12;
    this.tip.style.left = `${Math.max(left, 0)}px`;
  }
}

// Vista tabellare degli stessi dati, alternativa ai grafici.
export function tableFor(charts, xHead, xFormat) {
  const xs = [...new Set(charts.flatMap((c) => c.xs))].sort((a, b) => a - b);
  const cols = charts.flatMap((c) => c.series.map((s) => ({ title: `${c.opts.title ?? ''} ${s.name}`.trim(), map: s.map, fmt: c.opts.yFormat })));
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const title of [xHead, ...cols.map((c) => c.title)]) {
    const th = document.createElement('th');
    th.textContent = title;
    head.append(th);
  }
  const body = table.createTBody();
  for (const x of xs) {
    const row = body.insertRow();
    row.insertCell().textContent = xFormat(x);
    for (const c of cols) row.insertCell().textContent = c.map.has(x) ? c.fmt(c.map.get(x)) : '—';
  }
  const box = document.createElement('div');
  box.className = 'table-view';
  box.append(table);
  return box;
}
