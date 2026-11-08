import { parseXtp, partPaths } from './xtp.js';

const $ = (s) => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const MM = 25.4;
const DEFAULT_LIBS = ['mrklnhoc-de.xtp', 'HO-Marklin C-Track.xtp'];
const CONNECT_DIST = 0.03;   // inches: endpoints closer than this are connected
const CONNECT_ANGLE = 2;     // degrees
const SNAP_PX = 22;          // screen px: track snapping while dragging
const PICK_PX = 10;          // screen px: drawing snaps to vertices / ends
const AUTO_DIM_OFFSET = 60 / MM;

const svg = $('#canvas'), world = $('#world');
const shapesLayer = $('#shapes'), partsLayer = $('#parts'), annoLayer = $('#anno'), overlay = $('#overlay'), ui = $('#ui');

const S = window.__stl = {
  libList: [], libs: new Map(), lib: null,
  parts: [], shapes: [], nextId: 1, els: new Map(),
  sel: new Set(), active: null, lastPlace: null,
  view: { tx: 0, ty: 0, z: 12 },
  undo: [], redo: [], conn: new Map(), allEnds: [],
  labels: false, drag: null, snap: null,
  tool: 'select', draft: null, typed: '', cursor: null, space: false,
  grid: 10, autoDim: true, dirty: false, lastPanMoved: false,
};

// ---------------------------------------------------------------- utilities
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const norm = (a) => ((a % 360) + 360) % 360;
const angDiff = (a, b) => { const d = norm(a - b); return Math.min(d, 360 - d); };
const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const endKey = (pid, i) => pid + ':' + i;
const f3 = (v) => Math.round(v * 1000) / 1000;
const mm = (inch) => Math.round(inch * MM);
const clone = (o) => JSON.parse(JSON.stringify(o));

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// compass rotation (clockwise, degrees) of point p about (px,py)
function rotPt([x, y], px, py, delta) {
  const r = rad(delta), c = Math.cos(r), s = Math.sin(r), dx = x - px, dy = y - py;
  return [px + dx * c + dy * s, py - dx * s + dy * c];
}
function toWorld(p, x, y) {
  const r = rad(p.rot), c = Math.cos(r), s = Math.sin(r);
  return [p.x + x * c + y * s, p.y - x * s + y * c];
}
const def = (p) => S.libs.get(p.lib)?.byTitle.get(p.title);
function ends(p) {
  const d = def(p); if (!d) return [];
  return d.endpoints.map((e, i) => { const [x, y] = toWorld(p, e.x, e.y); return { pid: p.id, i, x, y, a: norm(e.a + p.rot) }; });
}
function rotateAbout(p, px, py, delta) {
  [p.x, p.y] = rotPt([p.x, p.y], px, py, delta); p.rot = norm(p.rot + delta);
}
const byId = (id) => S.parts.find((p) => p.id === id);
const shapeById = (id) => S.shapes.find((s) => s.id === id);
const itemById = (id) => byId(id) || shapeById(id);
const selectedItems = () => [...S.parts, ...S.shapes].filter((it) => S.sel.has(it.id));

function bboxOf(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}
function partBBox(p) {
  const d = def(p); if (!d) return { x0: p.x - 1, y0: p.y - 1, x1: p.x + 1, y1: p.y + 1 };
  const b = d.bbox;
  return bboxOf([[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => toWorld(p, x, y)));
}
function dimGeom(s) {
  const [p1, p2] = s.pts, dx = p2[0] - p1[0], dy = p2[1] - p1[1], L = Math.hypot(dx, dy) || 1e-9;
  const u = [dx / L, dy / L], n = [-u[1], u[0]], o = s.off || 0;
  return { p1, p2, u, n, L, a: [p1[0] + n[0] * o, p1[1] + n[1] * o], b: [p2[0] + n[0] * o, p2[1] + n[1] * o] };
}
function textCorners(s) {
  const w = Math.max(1, s.text.length) * s.size * 0.58, h = s.size, [x, y] = s.pts[0];
  return [[0, -0.25 * h], [w, -0.25 * h], [w, h], [0, h]].map(([a, b]) => rotPt([x + a, y + b], x, y, s.angle || 0));
}
function shapeBBox(s) {
  if (s.type === 'circle') { const r = Math.hypot(s.pts[1][0] - s.pts[0][0], s.pts[1][1] - s.pts[0][1]); const [x, y] = s.pts[0]; return { x0: x - r, y0: y - r, x1: x + r, y1: y + r }; }
  if (s.type === 'dim') { const g = dimGeom(s); return bboxOf([g.p1, g.p2, g.a, g.b]); }
  if (s.type === 'text') return bboxOf(textCorners(s));
  return bboxOf(s.pts);
}
const itemBBox = (it) => (it.pts ? shapeBBox(it) : partBBox(it));
const itemCenter = (it) => { const b = itemBBox(it); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]; };
function unionBBox(items) {
  const bs = items.map(itemBBox);
  return bs.length ? { x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) } : null;
}
function rotateItem(it, px, py, delta) {
  if (it.pts) { it.pts = it.pts.map((p) => rotPt(p, px, py, delta)); if (it.type === 'text') it.angle = norm((it.angle || 0) + delta); }
  else rotateAbout(it, px, py, delta);
}
function translateItem(it, dx, dy) {
  if (it.pts) it.pts = it.pts.map(([x, y]) => [x + dx, y + dy]); else { it.x += dx; it.y += dy; }
}

// ---------------------------------------------------------------- libraries
async function loadLib(file) {
  if (S.libs.has(file)) return S.libs.get(file);
  const res = await fetch('api/library?file=' + encodeURIComponent(file));
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  const lib = parseXtp(await res.text());
  lib.file = file;
  lib.byTitle = new Map(lib.parts.map((p) => [p.title, p]));
  S.libs.set(file, lib);
  return lib;
}

const libGroup = (name) => { const m = name.match(/^([A-Za-z0-9]+)-/); return m ? m[1] : 'Other'; };

function fillLibSelect() {
  const sel = $('#libSelect'); sel.innerHTML = '';
  const groups = new Map();
  for (const f of S.libList) { const g = libGroup(f); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(f); }
  const order = [...groups.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  for (const g of order) {
    const og = document.createElement('optgroup'); og.label = g === 'Other' ? 'Other / unprefixed' : g;
    for (const f of groups.get(g)) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.xtp$/i, ''); og.append(o); }
    sel.append(og);
  }
}

async function selectLib(file) {
  $('#libSelect').value = file;
  $('#palette').innerHTML = '<div class="muted pad">Loading ' + esc(file) + ' from SourceForge…</div>';
  $('#libTitle').textContent = '';
  try {
    const lib = await loadLib(file);
    S.lib = file;
    try { localStorage.setItem('stl.lib', file); } catch { /* ignore */ }
    $('#libTitle').textContent = lib.contents ? `${lib.contents} · ${lib.parts.length} parts` : `${lib.parts.length} parts`;
    renderPalette();
  } catch (e) {
    $('#palette').innerHTML = `<div class="muted pad">Could not load ${esc(file)}: ${esc(e.message)}</div>`;
  }
}

function thumb(d) {
  const b = d.bbox, pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.06;
  const s = el('svg', { viewBox: `${b.x0 - pad} ${-b.y1 - pad} ${b.x1 - b.x0 + 2 * pad} ${b.y1 - b.y0 + 2 * pad}`, preserveAspectRatio: 'xMidYMid meet', class: 'part' });
  const g = el('g', { transform: 'scale(1 -1)' });
  const P = partPaths(d);
  for (const [cls, dd] of [['fill', P.fill], ['outline', P.outline], ['ties', P.ties], ['rails', P.rails]]) if (dd) g.append(el('path', { class: cls, d: dd }));
  s.append(g);
  return s;
}

function renderPalette() {
  const lib = S.libs.get(S.lib); if (!lib) return;
  const q = $('#partSearch').value.trim().toLowerCase();
  const pal = $('#palette'); pal.innerHTML = '';
  const groups = new Map();
  for (const d of lib.parts) {
    if (q && !(d.desc + ' ' + d.partno + ' ' + d.group).toLowerCase().includes(q)) continue;
    if (!groups.has(d.group)) groups.set(d.group, []);
    groups.get(d.group).push(d);
  }
  if (!groups.size) { pal.innerHTML = '<div class="muted pad">No matching parts.</div>'; return; }
  for (const [g, list] of groups) {
    const det = document.createElement('details'); det.open = true;
    const sum = document.createElement('summary');
    sum.innerHTML = `${esc(g.replace(lib.contents.split(' ').slice(0, 2).join(' '), '').replace(/^[\s:–-]+/, '') || g)} <span class="n">(${list.length})</span>`;
    const grid = document.createElement('div'); grid.className = 'pgrid';
    for (const d of list) {
      const b = document.createElement('button');
      b.className = 'pitem'; b.title = `${d.desc}${d.partno ? ' — ' + d.partno : ''}\nClick to place, or drag onto the canvas`;
      b.draggable = true;
      b.append(thumb(d));
      b.insertAdjacentHTML('beforeend', `<span class="pd">${esc(d.desc)}</span><span class="pn">${esc(d.partno || '')}</span>`);
      b.addEventListener('click', () => { setTool('select'); placePart(S.lib, d.title); });
      b.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/x-stl-part', JSON.stringify({ lib: S.lib, title: d.title })); ev.dataTransfer.effectAllowed = 'copy'; });
      grid.append(b);
    }
    det.append(sum, grid); pal.append(det);
  }
}

// ---------------------------------------------------------------- connections
function computeConnections() {
  const grid = new Map(), all = [], C = 0.1;
  const cell = (x, y) => Math.floor(x / C) + ',' + Math.floor(y / C);
  for (const p of S.parts) for (const e of ends(p)) {
    all.push(e); const k = cell(e.x, e.y);
    if (!grid.has(k)) grid.set(k, []); grid.get(k).push(e);
  }
  const conn = new Map();
  for (const e of all) {
    const cx = Math.floor(e.x / C), cy = Math.floor(e.y / C);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const o of grid.get((cx + dx) + ',' + (cy + dy)) || []) {
        if (o.pid === e.pid) continue;
        if (Math.hypot(o.x - e.x, o.y - e.y) < CONNECT_DIST && angDiff(e.a, o.a + 180) < CONNECT_ANGLE) conn.set(endKey(e.pid, e.i), o);
      }
    }
  }
  S.conn = conn; S.allEnds = all;
  if (S.active && (!byId(S.active.pid) || conn.has(endKey(S.active.pid, S.active.i)))) S.active = null;
}

function connectedGroup(id) {
  const seen = new Set([id]), stack = [id];
  while (stack.length) {
    const p = byId(stack.pop());
    for (const e of ends(p)) { const o = S.conn.get(endKey(p.id, e.i)); if (o && !seen.has(o.pid)) { seen.add(o.pid); stack.push(o.pid); } }
  }
  return seen;
}

// ---------------------------------------------------------------- rendering
let lastZ = 0;
function applyView() {
  const { tx, ty, z } = S.view;
  world.setAttribute('transform', `translate(${tx} ${ty}) scale(${z} ${-z})`);
  const major = (100 / MM) * z, minor = (10 / MM) * z;
  const m = minor >= 7 ? minor : major;
  svg.style.backgroundSize = `${major}px ${major}px, ${major}px ${major}px, ${m}px ${m}px, ${m}px ${m}px`;
  svg.style.backgroundPosition = `${tx}px ${ty}px`;
  $('#stZoom').textContent = `zoom ${Math.round((z / 12) * 100)}%`;
  if (z !== lastZ) { lastZ = z; renderShapes(); }
  renderOverlay(); renderUI();
}

function setPose(g, p) { g.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${-p.rot})`); }

function buildPartEl(p) {
  const g = el('g', { class: 'part', 'data-id': p.id });
  const d = def(p);
  if (!d) {
    g.classList.add('missing');
    g.append(el('path', { class: 'hit', d: 'M-1 -1H1V1H-1Z' }), el('path', { class: 'outline', d: 'M-1 -1H1V1H-1Z' }));
  } else {
    const P = partPaths(d);
    g.append(el('path', { class: 'hit', d: (P.center + P.outline) || 'M0 0' }));
    for (const [cls, dd] of [['fill', P.fill], ['outline', P.outline], ['ties', P.ties], ['rails', P.rails]]) if (dd) g.append(el('path', { class: cls, d: dd }));
  }
  setPose(g, p);
  return g;
}

const ptsD = (pts, close) => 'M' + pts.map(([x, y]) => f3(x) + ' ' + f3(y)).join('L') + (close ? 'Z' : '');
function circleD([cx, cy], r) { return `M${f3(cx - r)} ${f3(cy)}a${f3(r)} ${f3(r)} 0 1 0 ${f3(2 * r)} 0a${f3(r)} ${f3(r)} 0 1 0 ${f3(-2 * r)} 0Z`; }

function dimParts(s, z) {
  const g = dimGeom(s), { u, n, a, b } = g, sg = (s.off || 0) >= 0 ? 1 : -1;
  const gap = 4 / z, ext = 7 / z, ah = 11 / z, aw = 3.5 / z;
  const P = (p, k, m) => [p[0] + u[0] * k + n[0] * m, p[1] + u[1] * k + n[1] * m];
  const lines = ptsD([P(g.p1, 0, sg * gap), P(a, 0, sg * ext)]) + ptsD([P(g.p2, 0, sg * gap), P(b, 0, sg * ext)]) + ptsD([a, b]);
  const flip = g.L < (2.6 * ah) ? -1 : 1; // short dims: arrows outside
  const arrows = ptsD([a, P(a, ah * flip, aw), P(a, ah * flip, -aw)], true) + ptsD([b, P(b, -ah * flip, aw), P(b, -ah * flip, -aw)], true);
  let th = deg(Math.atan2(u[1], u[0])); if (th > 90) th -= 180; if (th <= -90) th += 180;
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return { lines, arrows, mid, th, label: `${mm(g.L)}` };
}

function buildShapeEl(s) {
  const z = S.view.z;
  const g = el('g', { class: `shape ${s.type}${S.sel.has(s.id) ? ' sel' : ''}`, 'data-id': s.id });
  if (s.type === 'dim') {
    const D = dimParts(s, z);
    g.append(el('path', { class: 'hit', d: D.lines }), el('path', { class: 'dline', d: D.lines }), el('path', { class: 'darrow', d: D.arrows }));
    const t = el('text', { class: 'dtext', transform: `translate(${D.mid[0]} ${D.mid[1]}) scale(${1 / z} ${-1 / z}) rotate(${-D.th})` });
    t.textContent = D.label; g.append(t);
  } else if (s.type === 'text') {
    const [x, y] = s.pts[0];
    g.append(el('path', { class: 'hitfill', d: ptsD(textCorners(s), true) }));
    const t = el('text', { class: 'stext', 'font-size': s.size, transform: `translate(${x} ${y}) rotate(${-(s.angle || 0)}) scale(1 -1)` });
    t.textContent = s.text; g.append(t);
  } else {
    const d = s.type === 'circle'
      ? circleD(s.pts[0], Math.hypot(s.pts[1][0] - s.pts[0][0], s.pts[1][1] - s.pts[0][1]))
      : ptsD(s.pts, s.type === 'poly' && s.closed);
    if (isRect(s)) { g.classList.add('rect'); g.append(el('path', { class: 'hitfill', d })); }
    g.append(el('path', { class: 'hit', d }), el('path', { class: 'stroke', d }));
  }
  return g;
}

// dimensions linked to an edge of another shape follow that edge
function syncDims() {
  for (const d of S.shapes) {
    if (d.type !== 'dim' || !d.ref) continue;
    const t = shapeById(d.ref.shape), n = t?.pts?.length || 0;
    if (!t || t.type === 'text' || t.type === 'dim' || d.ref.edge >= (t.closed ? n : n - 1)) { delete d.ref; continue; }
    const a = t.pts[d.ref.edge], b = t.pts[(d.ref.edge + 1) % n];
    d.pts = d.ref.rev ? [[...b], [...a]] : [[...a], [...b]];
  }
}

function renderShapes() {
  syncDims();
  shapesLayer.innerHTML = ''; annoLayer.innerHTML = '';
  for (const s of S.shapes) (s.type === 'dim' || s.type === 'text' ? annoLayer : shapesLayer).append(buildShapeEl(s));
}

function renderAll() {
  partsLayer.innerHTML = ''; S.els.clear();
  for (const p of S.parts) { const g = buildPartEl(p); S.els.set(p.id, g); partsLayer.append(g); }
  renderShapes();
  computeConnections(); renderSelection(); renderOverlay(); renderUI(); updateStatus();
}

function renderSelection() {
  for (const [id, g] of S.els) g.classList.toggle('sel', S.sel.has(id));
  for (const g of svg.querySelectorAll('.shape')) g.classList.toggle('sel', S.sel.has(+g.dataset.id));
}

function renderOverlay() {
  overlay.innerHTML = '';
  const z = S.view.z, r = 4.5 / z, len = 13 / z;
  for (const e of S.allEnds) {
    if (S.conn.has(endKey(e.pid, e.i))) continue;
    const isActive = S.active && S.active.pid === e.pid && S.active.i === e.i;
    const g = el('g', { class: 'end' + (isActive ? ' active' : ''), 'data-pid': e.pid, 'data-i': e.i });
    const dx = Math.sin(rad(e.a)), dy = Math.cos(rad(e.a));
    g.append(el('line', { x1: e.x, y1: e.y, x2: e.x + dx * len, y2: e.y + dy * len }));
    if (isActive) g.append(el('circle', { class: 'ring', cx: e.x, cy: e.y, r: r * 2.4 }));
    g.append(el('circle', { cx: e.x, cy: e.y, r: isActive ? r * 1.4 : r }));
    overlay.append(g);
  }
  if (S.snap) overlay.append(el('circle', { class: 'snapring', cx: S.snap.x, cy: S.snap.y, r: 10 / z }));
  if (S.labels) {
    for (const p of S.parts) {
      const d = def(p); if (!d || !d.partno) continue;
      const [x, y] = itemCenter(p);
      const t = el('text', { class: 'label', transform: `translate(${x} ${y}) scale(${1 / z} ${-1 / z})` });
      t.textContent = d.partno; overlay.append(t);
    }
  }
  renderDraft();
}

// screen-space handles: rotation handle for the selection, vertex handles for a single shape
const toScreen = ([x, y]) => [S.view.tx + x * S.view.z, S.view.ty - y * S.view.z];
function renderUI() {
  ui.innerHTML = '';
  if (S.tool !== 'select' || !S.sel.size || (S.drag && S.drag.mode === 'move')) return;
  const items = selectedItems(); const b = unionBBox(items); if (!b) return;
  const [sx0, sy0] = toScreen([b.x0, b.y1]), [sx1, sy1] = toScreen([b.x1, b.y0]);
  ui.append(el('rect', { class: 'selbox', x: sx0 - 6, y: sy0 - 6, width: sx1 - sx0 + 12, height: sy1 - sy0 + 12 }));
  const hx = (sx0 + sx1) / 2, hy = sy0 - 34;
  const rot = el('g', { class: 'rothandle', 'data-handle': 'rot' });
  rot.append(el('line', { x1: hx, y1: sy0 - 6, x2: hx, y2: hy + 8 }), el('circle', { cx: hx, cy: hy, r: 8 }),
    el('path', { d: `M${hx - 4} ${hy - 1}a4 4 0 1 1 1.5 3.2`, class: 'roticon' }));
  const tt = el('title'); tt.textContent = 'Drag to rotate (Shift: free, otherwise in rotation steps)'; rot.append(tt);
  ui.append(rot);
  if (items.length === 1 && items[0].pts && items[0].type !== 'text') {
    const s = items[0];
    if (isRect(s)) {
      // edge handles change only width or height, corner handles keep the rectangle
      s.pts.forEach((p, i) => {
        const q = s.pts[(i + 1) % 4], [x, y] = toScreen([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
        const horiz = Math.abs(q[0] - p[0]) * S.view.z > Math.abs(q[1] - p[1]) * S.view.z;
        ui.append(el('rect', { class: 'ehandle ' + (horiz ? 'ns' : 'ew'), 'data-handle': 'redge', 'data-idx': i,
          x: x - (horiz ? 9 : 4), y: y - (horiz ? 4 : 9), width: horiz ? 18 : 8, height: horiz ? 8 : 18, rx: 3 }));
      });
      s.pts.forEach((p, i) => { const [x, y] = toScreen(p); ui.append(el('rect', { class: 'vhandle', 'data-handle': 'rcorner', 'data-idx': i, x: x - 5, y: y - 5, width: 10, height: 10 })); });
      return;
    }
    s.pts.forEach((p, i) => { const [x, y] = toScreen(p); ui.append(el('rect', { class: 'vhandle', 'data-handle': 'v', 'data-idx': i, x: x - 5, y: y - 5, width: 10, height: 10 })); });
    if (s.type === 'dim') {
      const g = dimGeom(s), [x, y] = toScreen([(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2]);
      ui.append(el('circle', { class: 'vhandle off', 'data-handle': 'off', cx: x, cy: y - 0, r: 5 }));
    }
  }
}

function updateStatus() {
  const open = S.allEnds.filter((e) => !S.conn.has(endKey(e.pid, e.i))).length;
  $('#stCounts').textContent = `${S.parts.length} pieces · ${open} open ends${S.shapes.length ? ` · ${S.shapes.length} drawings` : ''}${S.sel.size ? ` · ${S.sel.size} selected` : ''}`;
  $('#emptyHint').hidden = S.parts.length + S.shapes.length > 0 || S.tool !== 'select';
  $('#btnUndo').disabled = !S.undo.length; $('#btnRedo').disabled = !S.redo.length;
  const one = S.sel.size === 1 && S.lastPlace && S.sel.has(S.lastPlace.pid);
  $('#btnFlip').disabled = !one;
  $('#btnDelete').disabled = $('#btnRotL').disabled = $('#btnRotR').disabled = !S.sel.size;
  let hint = '';
  if (S.tool !== 'select') hint = TOOL_HINTS[S.tool] + (S.typed ? `  ·  typed: ${S.typed}` : '');
  else if (S.sel.size === 1) {
    const it = itemById([...S.sel][0]);
    if (it?.pts) hint = shapeInfo(it);
    else { const d = it && def(it); if (d) hint = `${d.desc}${d.partno ? ' · ' + d.partno : ''} · ${d.mfr} · ${f3(it.rot)}°`; }
  } else if (!S.active && S.parts.length) hint = 'Click an orange open end to choose where the next piece attaches.';
  $('#stHint').textContent = hint;
  document.title = `${S.dirty ? '• ' : ''}${$('#layoutName').value || 'Untitled'} — SmardTrackLayout`;
  renderProps();
  scheduleAutosave();
}

function shapeInfo(s) {
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (s.type === 'line') return `Line · ${mm(len(...s.pts))} mm`;
  if (s.type === 'dim') return `Dimension · ${mm(len(...s.pts))} mm`;
  if (s.type === 'circle') return `Circle · r ${mm(len(...s.pts))} mm`;
  if (s.type === 'text') return `Text “${s.text}” · ${mm(s.size)} mm`;
  if (isRect(s)) { const [w, h] = rectSize(s); return `Rectangle · ${mm(w)} × ${mm(h)} mm · drag the edge bars to change width or height`; }
  const b = shapeBBox(s);
  let per = 0; for (let i = 1; i < s.pts.length; i++) per += len(s.pts[i - 1], s.pts[i]);
  if (s.closed) per += len(s.pts.at(-1), s.pts[0]);
  return `${s.closed ? 'Outline' : 'Polyline'} · ${s.pts.length} points · ${mm(b.x1 - b.x0)} × ${mm(b.y1 - b.y0)} mm · perimeter ${mm(per)} mm`;
}

const refresh = () => { computeConnections(); renderSelection(); renderOverlay(); renderUI(); updateStatus(); };

// ---------------------------------------------------------------- history
const snapshot = () => JSON.stringify({ parts: S.parts, shapes: S.shapes, nextId: S.nextId });
function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 200) S.undo.shift(); S.redo = []; S.dirty = true; }
function restore(snap) {
  const o = JSON.parse(snap); S.parts = o.parts; S.shapes = o.shapes || []; S.nextId = o.nextId;
  S.sel = new Set([...S.sel].filter((id) => itemById(id))); S.lastPlace = null; S.dirty = true;
  renderAll();
}
function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); }
function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); }

// ---------------------------------------------------------------- track editing
function attach(p, ei, anchor) {
  const e = def(p).endpoints[ei];
  p.rot = norm(anchor.a + 180 - e.a); p.x = 0; p.y = 0;
  const [wx, wy] = toWorld(p, e.x, e.y);
  p.x = anchor.x - wx; p.y = anchor.y - wy;
}

function chooseNextActive(p, skipIdx) {
  // prefer the "forward" end: for a free-standing piece that is endpoint 1, not the start end 0
  const es = ends(p).filter((e) => e.i !== skipIdx && !S.conn.has(endKey(p.id, e.i)))
    .sort((a, b) => (a.i === 0) - (b.i === 0));
  S.active = es.length ? { pid: p.id, i: es[0].i } : null;
}

function screenCenterWorld() {
  const r = svg.getBoundingClientRect();
  return toWorldPt(r.left + r.width / 2, r.top + r.height / 2);
}

async function placePart(libFile, title, at = null) {
  const lib = await loadLib(libFile);
  const d = lib.byTitle.get(title); if (!d) return;
  pushUndo();
  const p = { id: S.nextId++, lib: libFile, title, x: 0, y: 0, rot: 0 };
  let anchor = null;
  if (!at && S.active && d.endpoints.length) anchor = S.allEnds.find((e) => e.pid === S.active.pid && e.i === S.active.i);
  let attachedIdx = -1;
  if (anchor) { attach(p, 0, anchor); attachedIdx = 0; }
  else {
    const [cx, cy] = at || screenCenterWorld(), b = d.bbox;
    p.x = cx - (b.x0 + b.x1) / 2; p.y = cy - (b.y0 + b.y1) / 2;
  }
  S.parts.push(p);
  const g = buildPartEl(p); S.els.set(p.id, g); partsLayer.append(g);
  if (at) { // dropped onto the canvas: snap if near an open end
    computeConnections();
    const snap = findSnap(new Set([p.id]));
    if (snap) { applySnap(new Set([p.id]), snap); setPose(g, p); anchor = snap.target; attachedIdx = snap.moving.i; }
  }
  S.sel = new Set([p.id]);
  S.lastPlace = anchor ? { pid: p.id, anchor: { x: anchor.x, y: anchor.y, a: anchor.a }, ei: attachedIdx } : null;
  computeConnections();
  chooseNextActive(p, attachedIdx);
  refresh();
}

function flipLast() {
  const L = S.lastPlace; if (!L) return;
  const p = byId(L.pid); const d = p && def(p); if (!d || d.endpoints.length < 2) return;
  pushUndo();
  L.ei = (L.ei + 1) % d.endpoints.length;
  attach(p, L.ei, L.anchor);
  setPose(S.els.get(p.id), p);
  computeConnections();
  chooseNextActive(p, L.ei);
  refresh();
}

function rotateSelection(delta) {
  const items = selectedItems(); if (!items.length) return;
  pushUndo();
  const b = unionBBox(items), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  for (const it of items) { rotateItem(it, cx, cy, delta); if (!it.pts) setPose(S.els.get(it.id), it); }
  if (items.some((it) => it.pts)) { normalizeRects(); renderShapes(); }
  S.lastPlace = null;
  refresh();
}

function deleteSelection() {
  if (!S.sel.size) return;
  pushUndo();
  S.parts = S.parts.filter((p) => !S.sel.has(p.id));
  S.shapes = S.shapes.filter((s) => !S.sel.has(s.id) && !(s.ref && S.sel.has(s.ref.shape)));
  for (const id of S.sel) { S.els.get(id)?.remove(); S.els.delete(id); }
  S.sel.clear(); S.lastPlace = null;
  renderShapes(); refresh();
}

// snapping: find the closest pair (free moving end, free static end)
function findSnap(movingIds) {
  const tol = SNAP_PX / S.view.z;
  const staticFree = [], movingFree = [];
  for (const p of S.parts) {
    const isMoving = movingIds.has(p.id);
    for (const e of ends(p)) {
      const o = S.conn.get(endKey(p.id, e.i));
      const otherMoving = o && movingIds.has(o.pid);
      if (isMoving && (!o || !otherMoving)) movingFree.push(e);
      if (!isMoving && (!o || otherMoving)) staticFree.push(e);
    }
  }
  let best = null;
  for (const m of movingFree) for (const t of staticFree) {
    const dist = Math.hypot(m.x - t.x, m.y - t.y);
    if (dist < tol && (!best || dist < best.dist)) best = { dist, moving: m, target: t, x: t.x, y: t.y };
  }
  return best;
}

function applySnap(movingIds, snap) {
  const { moving: m, target: t } = snap;
  const delta = norm(t.a + 180 - m.a);
  for (const it of [...S.parts, ...S.shapes]) if (movingIds.has(it.id)) { rotateItem(it, m.x, m.y, delta); translateItem(it, t.x - m.x, t.y - m.y); }
}

// ---------------------------------------------------------------- drawing tools
const TOOL_HINTS = {
  line: 'Line: click start and end. Type a length in mm + Enter. Shift: 15° steps. Esc: done.',
  poly: 'Polyline: click points; click the first point to close, Enter / double-click / right-click to finish. Type a length + Enter.',
  rect: 'Rectangle: click two corners, or click one corner and type e.g. 2400x1200 + Enter.',
  circle: 'Circle: click the centre, then the radius (or type the radius in mm + Enter).',
  dim: 'Dimension: click two points, then where the dimension line goes. Snaps to corners and track ends.',
  text: 'Text: click where the text goes.',
};

function setTool(t) {
  if (S.tool === t && t !== 'select') t = 'select';
  S.tool = t; S.draft = null; S.typed = '';
  for (const b of document.querySelectorAll('.drawbar [data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  svg.classList.toggle('drawing', t !== 'select');
  if (t !== 'select') { S.sel.clear(); renderSelection(); }
  $('#measure').hidden = true;
  renderOverlay(); renderUI(); updateStatus();
}

// snap a world point to vertices, track ends, or the grid
function snapPoint(wx, wy, exclude = -1) {
  const tol = PICK_PX / S.view.z;
  let best = null, bd = tol;
  const consider = (x, y) => { const d = Math.hypot(x - wx, y - wy); if (d < bd) { bd = d; best = { x, y, kind: 'vertex' }; } };
  for (const s of S.shapes) {
    if (s.id === exclude) continue;
    if (s.type === 'dim') s.pts.forEach(([x, y]) => consider(x, y));
    else if (s.type !== 'text') s.pts.forEach(([x, y]) => consider(x, y));
  }
  for (const e of S.allEnds) consider(e.x, e.y);
  if (S.draft && S.draft.pts.length >= 2) consider(...S.draft.pts[0]);
  if (best) return best;
  if (S.grid > 0) { const g = S.grid / MM; return { x: Math.round(wx / g) * g, y: Math.round(wy / g) * g, kind: 'grid' }; }
  return { x: wx, y: wy, kind: null };
}

function draftPoint(ev) {
  const [wx, wy] = toWorldPt(ev.clientX, ev.clientY);
  const D = S.draft, last = D?.pts.at(-1);
  if (last && ev.shiftKey && D.type !== 'rect') {
    const dx = wx - last[0], dy = wy - last[1], L = Math.hypot(dx, dy);
    const a = Math.round(deg(Math.atan2(dy, dx)) / 15) * 15;
    const g = S.grid > 0 ? S.grid / MM : 0, Lq = g ? Math.round(L / g) * g : L;
    return { x: last[0] + Math.cos(rad(a)) * Lq, y: last[1] + Math.sin(rad(a)) * Lq, kind: 'ortho' };
  }
  return snapPoint(wx, wy);
}

function addShape(s) {
  s.id = S.nextId++; S.shapes.push(s); return s;
}
// rectangles: closed 4-point polys, counter-clockwise from the lower-left corner,
// so edge 0 = width (bottom), edge 1 = height (right); negative dim offsets lie outside
function isRect(s) {
  if (s?.type !== 'poly' || !s.closed || s.pts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = s.pts[i], b = s.pts[(i + 1) % 4], c = s.pts[(i + 2) % 4];
    const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
    const lu = Math.hypot(...u), lv = Math.hypot(...v);
    if (lu < 1e-6 || lv < 1e-6 || Math.abs(u[0] * v[0] + u[1] * v[1]) / (lu * lv) > 0.01) return false;
  }
  return true;
}
// put rectangle corners in a fixed order: counter-clockwise, starting so edge 0 points along +x
// (then edge 0 = size in X, edge 1 = size in Y); linked dimensions are re-pointed to the same edges
function normalizeRect(s) {
  if (!isRect(s)) return;
  const P = s.pts;
  let area = 0; for (let i = 0; i < 4; i++) { const a = P[i], b = P[(i + 1) % 4]; area += a[0] * b[1] - b[0] * a[1]; }
  const idx = area < 0 ? [0, 3, 2, 1] : [0, 1, 2, 3];
  let best = 0, score = -Infinity;
  for (let k = 0; k < 4; k++) {
    const a = P[idx[k]], b = P[idx[(k + 1) % 4]], ux = (b[0] - a[0]) / (Math.hypot(b[0] - a[0], b[1] - a[1]) || 1);
    if (ux > score + 1e-9) { score = ux; best = k; }
  }
  const order = [0, 1, 2, 3].map((j) => idx[(best + j) % 4]);
  s.rect = true;
  if (order.every((o, j) => o === j)) return;
  s.pts = order.map((o) => [...P[o]]);
  for (const d of S.shapes) {
    if (d.type !== 'dim' || d.ref?.shape !== s.id) continue;
    const na = order.indexOf(d.ref.edge), nb = order.indexOf((d.ref.edge + 1) % 4);
    d.ref = (na + 1) % 4 === nb ? { shape: s.id, edge: na, rev: !!d.ref.rev } : { shape: s.id, edge: nb, rev: !d.ref.rev };
  }
}
const normalizeRects = () => { for (const s of S.shapes) if (s.type === 'poly') normalizeRect(s); };

// which part of a rectangle is under the pointer: a corner, an edge, or the inside
function rectGrip(s, wx, wy) {
  const tol = 9 / S.view.z;
  for (let k = 0; k < 4; k++) if (Math.hypot(s.pts[k][0] - wx, s.pts[k][1] - wy) < tol * 1.2) return { mode: 'rcorner', idx: k };
  for (let i = 0; i < 4; i++) {
    const a = s.pts[i], b = s.pts[(i + 1) % 4], ab = [b[0] - a[0], b[1] - a[1]], L2 = ab[0] ** 2 + ab[1] ** 2;
    const t = Math.max(0, Math.min(1, ((wx - a[0]) * ab[0] + (wy - a[1]) * ab[1]) / L2));
    if (Math.hypot(a[0] + ab[0] * t - wx, a[1] + ab[1] * t - wy) < tol) return { mode: 'redge', idx: i };
  }
  return null;
}
function gripCursor(s, grip) {
  if (!grip) return 'move';
  const a = s.pts[grip.idx], b = s.pts[(grip.idx + 1) % 4];
  if (grip.mode === 'redge') return Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? 'ns-resize' : 'ew-resize';
  return grip.idx % 2 === 0 ? 'nesw-resize' : 'nwse-resize';
}
function makeRect(a, b) {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  return { type: 'poly', closed: true, rect: true, pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
}
function addRectDims(r) {
  addShape({ type: 'dim', ref: { shape: r.id, edge: 0 }, pts: [r.pts[0], r.pts[1]], off: -AUTO_DIM_OFFSET });
  addShape({ type: 'dim', ref: { shape: r.id, edge: 3 }, pts: [r.pts[3], r.pts[0]], off: -AUTO_DIM_OFFSET });
}
// a dimension drawn exactly between two neighbouring corners gets linked to that edge
function findEdgeRef(p1, p2) {
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
  for (const s of S.shapes) {
    if (!s.pts || s.type === 'dim' || s.type === 'text' || s.type === 'circle') continue;
    const n = s.pts.length, edges = s.closed ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      const a = s.pts[i], b = s.pts[(i + 1) % n];
      if (same(a, p1) && same(b, p2)) return { shape: s.id, edge: i };
      if (same(a, p2) && same(b, p1)) return { shape: s.id, edge: i, rev: true };
    }
  }
  return null;
}

function commitShape(s, { autoDims = false } = {}) {
  pushUndo();
  addShape(s);
  if (s.type === 'poly') normalizeRect(s);
  if (s.type === 'dim') { const ref = findEdgeRef(...s.pts); if (ref) s.ref = ref; }
  if (autoDims && S.autoDim) addRectDims(s);
  renderShapes(); updateStatus();
}

function commitPoint(p) {
  const pt = [p.x, p.y];
  const D = S.draft, t = S.tool;
  S.typed = '';
  if (t === 'text') { openTextDialog(null, pt); return; }
  if (!D) { S.draft = { type: t, pts: [pt], cur: pt }; return; }
  const last = D.pts.at(-1), same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
  if (t === 'line') { if (!same(last, pt)) commitShape({ type: 'line', pts: [last, pt] }); S.draft = null; }
  else if (t === 'rect') {
    const [a, b] = [D.pts[0], pt];
    if (Math.abs(a[0] - b[0]) > 1e-6 && Math.abs(a[1] - b[1]) > 1e-6) {
      commitShape(makeRect(a, b), { autoDims: true });
    }
    S.draft = null;
  } else if (t === 'circle') { if (!same(last, pt)) commitShape({ type: 'circle', pts: [last, pt] }); S.draft = null; }
  else if (t === 'poly') {
    if (D.pts.length >= 3 && same(pt, D.pts[0])) { commitShape({ type: 'poly', closed: true, pts: D.pts }); S.draft = null; }
    else if (!same(last, pt)) D.pts.push(pt);
  } else if (t === 'dim') {
    if (D.pts.length === 1) { if (!same(last, pt)) D.pts.push(pt); }
    else { commitShape({ type: 'dim', pts: D.pts, off: dimOffset(D.pts, pt) }); S.draft = null; }
  }
}

function dimOffset([p1, p2], [x, y]) {
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1], L = Math.hypot(dx, dy) || 1;
  return ((x - p1[0]) * -dy + (y - p1[1]) * dx) / L;
}

function finishPoly() {
  const D = S.draft;
  if (D && D.type === 'poly' && D.pts.length >= 2) commitShape({ type: 'poly', closed: false, pts: D.pts });
  S.draft = null; S.typed = '';
  renderOverlay(); updateStatus();
}

// typed numbers while drawing: a length (mm) along the cursor direction, or WxH for rectangles
function applyTyped() {
  const raw = S.typed.trim().toLowerCase().replace(/,/g, '.'); S.typed = '';
  const D = S.draft; if (!D || !raw) return false;
  const last = D.pts.at(-1), cur = D.cur || last;
  if (D.type === 'rect') {
    const m = raw.match(/^([\d.]+)\s*[x*×]\s*([\d.]+)$/); if (!m) { toast('Type width x height in mm, e.g. 2400x1200'); return true; }
    const sx = Math.sign(cur[0] - last[0]) || 1, sy = Math.sign(cur[1] - last[1]) || 1;
    commitPoint({ x: last[0] + sx * m[1] / MM, y: last[1] + sy * m[2] / MM }); return true;
  }
  const len = parseFloat(raw) / MM; if (!isFinite(len) || len <= 0) return true;
  if (D.type === 'dim' && D.pts.length === 2) {
    const sg = Math.sign(dimOffset(D.pts, cur)) || 1;
    commitShape({ type: 'dim', pts: D.pts, off: sg * len }); S.draft = null; return true;
  }
  let dx = cur[0] - last[0], dy = cur[1] - last[1], L = Math.hypot(dx, dy);
  if (L < 1e-9) { dx = 1; dy = 0; L = 1; }
  commitPoint({ x: last[0] + (dx / L) * len, y: last[1] + (dy / L) * len });
  return true;
}

function renderDraft() {
  const D = S.draft, z = S.view.z, m = $('#measure');
  if (S.cursor && S.tool !== 'select' && S.cursor.kind) {
    const s = 7 / z, { x, y, kind } = S.cursor;
    overlay.append(el('rect', { class: 'snapmark ' + kind, x: x - s / 2, y: y - s / 2, width: s, height: s }));
  }
  if (!D) { m.hidden = true; return; }
  const cur = D.cur, last = D.pts.at(-1);
  let d = '', info = '';
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const angle = (a, b) => norm(deg(Math.atan2(b[1] - a[1], b[0] - a[0])));
  if (D.type === 'line' || D.type === 'poly') { d = ptsD([...D.pts, cur]); info = `${mm(len(last, cur))} mm · ${f3(angle(last, cur)).toFixed(1)}°`; }
  else if (D.type === 'rect') { const [a, b] = [D.pts[0], cur]; d = ptsD([a, [b[0], a[1]], b, [a[0], b[1]]], true); info = `${mm(Math.abs(b[0] - a[0]))} × ${mm(Math.abs(b[1] - a[1]))} mm`; }
  else if (D.type === 'circle') { d = circleD(last, len(last, cur)) + ptsD([last, cur]); info = `r ${mm(len(last, cur))} mm`; }
  else if (D.type === 'dim') {
    if (D.pts.length === 1) { d = ptsD([last, cur]); info = `${mm(len(last, cur))} mm`; }
    else {
      const ghost = { type: 'dim', pts: D.pts, off: dimOffset(D.pts, cur), id: -1 };
      const g = buildShapeEl(ghost); g.classList.add('draft'); overlay.append(g);
      info = `${mm(len(...D.pts))} mm`;
    }
  }
  if (d) overlay.append(el('path', { class: 'draftpath', d }));
  if (S.typed) info = `⌨ ${S.typed}▏`;
  const [sx, sy] = toScreen(cur);
  m.textContent = info; m.style.left = sx + 16 + 'px'; m.style.top = sy + 14 + 'px'; m.hidden = !info;
}

// text dialog (create or edit)
let textTarget = null;
function openTextDialog(shape, pt) {
  textTarget = { shape, pt };
  $('#textValue').value = shape ? shape.text : '';
  $('#textSize').value = shape ? mm(shape.size) : (+localStorage.getItem?.('stl.textSize') || 40);
  $('#dlgText').showModal(); $('#textValue').focus();
}
$('#dlgText').addEventListener('close', () => {
  const T = textTarget; textTarget = null;
  if (!T || $('#dlgText').returnValue !== 'ok') return;
  const text = $('#textValue').value.trim(), size = Math.max(1, +$('#textSize').value || 40) / MM;
  try { localStorage.setItem('stl.textSize', String(Math.round(size * MM))); } catch { /* ignore */ }
  if (!text) return;
  if (T.shape) { pushUndo(); T.shape.text = text; T.shape.size = size; renderShapes(); refresh(); }
  else commitShape({ type: 'text', pts: [T.pt], text, size, angle: 0 });
});

// ---------------------------------------------------------------- properties panel (keyboard entry)
const propsEl = $('#props');
let propsKey = '';
const segLen = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const segAng = (a, b) => norm(deg(Math.atan2(b[1] - a[1], b[0] - a[0])));
const r2 = (v) => +v.toFixed(2);

// width (axis 0) or height (axis 1) of a rectangle; the lower-left corner stays put
function setRectSize(s, axis, len) {
  const a = s.pts[axis], b = s.pts[axis + 1], cur = segLen(a, b);
  if (cur < 1e-9 || !(len > 0)) return;
  const u = unit(sub(b, a)), d = len - cur;
  for (const i of axis === 0 ? [1, 2] : [2, 3]) s.pts[i] = [s.pts[i][0] + u[0] * d, s.pts[i][1] + u[1] * d];
}
function setSegLen(pts, i, j, len) {
  const u = unit(sub(pts[j], pts[i]));
  pts[j] = [pts[i][0] + u[0] * len, pts[i][1] + u[1] * len];
}
function rotateShapeTo(s, cur, target) {
  const [cx, cy] = itemCenter(s); rotateItem(s, cx, cy, -(target - cur));
}
// typing a dimension value resizes what it measures
function setDimLength(d, len) {
  const t = d.ref && shapeById(d.ref.shape);
  if (t && isRect(t)) return setRectSize(t, d.ref.edge % 2, len);
  if (t) { const n = t.pts.length, i = d.ref.edge, j = (i + 1) % n; return setSegLen(t.pts, d.ref.rev ? j : i, d.ref.rev ? i : j, len); }
  setSegLen(d.pts, 0, 1, len);
}
const moveTo = (s, x, y) => translateItem(s, x - s.pts[0][0], y - s.pts[0][1]);

function propFields(s) {
  const F = [], num = (key, label, val, unit, set, min) => F.push({ key, label, val, unit, set, min });
  const xy = (lx = 'X', ly = 'Y') => {
    num('x', lx, mm(s.pts[0][0]), 'mm', (v) => moveTo(s, v / MM, s.pts[0][1]));
    num('y', ly, mm(s.pts[0][1]), 'mm', (v) => moveTo(s, s.pts[0][0], v / MM));
  };
  if (isRect(s)) {
    const [w, h] = rectSize(s);
    const straight = Math.abs(s.pts[1][1] - s.pts[0][1]) < 1e-6;
    num('w', straight ? 'Size X' : 'Width', mm(w), 'mm', (v) => setRectSize(s, 0, v / MM), 1);
    num('h', straight ? 'Size Y' : 'Height', mm(h), 'mm', (v) => setRectSize(s, 1, v / MM), 1);
    num('a', 'Angle', r2(segAng(s.pts[0], s.pts[1])), '°', (v) => rotateShapeTo(s, segAng(s.pts[0], s.pts[1]), v));
    xy();
  } else if (s.type === 'line') {
    num('l', 'Length', mm(segLen(...s.pts)), 'mm', (v) => setSegLen(s.pts, 0, 1, v / MM), 1);
    num('a', 'Angle', r2(segAng(...s.pts)), '°', (v) => { const L = segLen(...s.pts); s.pts[1] = [s.pts[0][0] + Math.cos(rad(v)) * L, s.pts[0][1] + Math.sin(rad(v)) * L]; });
    xy('X start', 'Y start');
  } else if (s.type === 'circle') {
    num('r', 'Radius', mm(segLen(...s.pts)), 'mm', (v) => setSegLen(s.pts, 0, 1, v / MM), 1);
    num('d', 'Diameter', mm(2 * segLen(...s.pts)), 'mm', (v) => setSegLen(s.pts, 0, 1, v / MM / 2), 1);
    xy('X centre', 'Y centre');
  } else if (s.type === 'dim') {
    num('l', 'Length', mm(segLen(...s.pts)), 'mm', (v) => setDimLength(s, v / MM), 1);
    num('o', 'Offset', mm(Math.abs(s.off || 0)), 'mm', (v) => { s.off = (Math.sign(s.off || -1)) * v / MM; }, 0);
  } else if (s.type === 'text') {
    F.push({ key: 't', label: 'Text', val: s.text, text: true, set: (v) => { if (String(v).trim()) s.text = String(v).trim(); } });
    num('s', 'Height', mm(s.size), 'mm', (v) => { s.size = v / MM; }, 1);
    num('a', 'Angle', r2(s.angle || 0), '°', (v) => { s.angle = norm(v); });
    xy();
  } else if (s.type === 'poly') {
    const n = s.pts.length, edges = s.closed ? n : n - 1;
    for (let i = 0; i < Math.min(edges, 16); i++) {
      const j = (i + 1) % n;
      num('s' + i, `Side ${i + 1}`, mm(segLen(s.pts[i], s.pts[j])), 'mm', (v) => {
        const before = [...s.pts[j]]; setSegLen(s.pts, i, j, v / MM);
        if (!s.closed) for (let k = j + 1; k < n; k++) s.pts[k] = [s.pts[k][0] + s.pts[j][0] - before[0], s.pts[k][1] + s.pts[j][1] - before[1]];
      }, 1);
    }
    xy();
  }
  return F;
}

const PROP_TITLES = { line: 'Line', circle: 'Circle', dim: 'Dimension', text: 'Text', poly: 'Polyline' };
function renderProps() {
  const s = S.tool === 'select' && S.sel.size === 1 ? shapeById([...S.sel][0]) : null;
  if (!s) { propsEl.hidden = true; propsKey = ''; return; }
  const fields = propFields(s);
  const key = s.id + ':' + fields.map((f) => f.key).join(',');
  if (key !== propsKey) {
    propsKey = key;
    const title = isRect(s) ? 'Rectangle' : s.type === 'poly' && s.closed ? 'Outline' : s.type === 'dim' && s.ref ? 'Dimension (linked)' : PROP_TITLES[s.type];
    propsEl.innerHTML = `<div class="ptitle">${title}</div>` + fields.map((f) =>
      `<label><span>${f.label}</span><input data-k="${f.key}" ${f.text ? 'class="ptext"' : 'inputmode="decimal"'} spellcheck="false" autocomplete="off"><em>${f.unit || ''}</em></label>`).join('') +
      `<div class="phint">${s.type === 'dim' && s.ref ? 'Changing the length resizes the measured shape. ' : ''}Enter applies · Tab next</div>`;
    for (const inp of propsEl.querySelectorAll('input')) inp.addEventListener('change', () => applyProp(inp.dataset.k, inp.value));
  }
  for (const f of fields) { const inp = propsEl.querySelector(`input[data-k="${f.key}"]`); if (inp && inp !== document.activeElement) inp.value = f.val; }
  propsEl.hidden = false;
}

function applyProp(k, raw) {
  const s = shapeById([...S.sel][0]); if (!s) return;
  const f = propFields(s).find((x) => x.key === k); if (!f) return;
  let v = raw;
  if (!f.text) {
    v = parseFloat(String(raw).replace(',', '.'));
    if (!isFinite(v)) { propsKey = ''; renderProps(); return; }
    if (f.min != null) v = Math.max(f.min, v);
  }
  pushUndo(); f.set(v); normalizeRect(s); renderShapes(); refresh();
  const nf = propFields(s).find((x) => x.key === k), inp = propsEl.querySelector(`input[data-k="${k}"]`);
  if (nf && inp) inp.value = nf.val;
}

// ---------------------------------------------------------------- pointer handling
function toWorldPt(cx, cy) {
  const r = svg.getBoundingClientRect(), { tx, ty, z } = S.view;
  return [(cx - r.left - tx) / z, (ty - (cy - r.top)) / z];
}

function startPan(ev) {
  S.drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, tx: S.view.tx, ty: S.view.ty, moved: false };
  svg.classList.add('panning');
}

svg.addEventListener('pointerdown', (ev) => {
  svg.setPointerCapture(ev.pointerId);
  const [wx, wy] = toWorldPt(ev.clientX, ev.clientY);
  if (ev.button === 1 || (ev.button === 0 && S.space)) return startPan(ev);

  const handle = ev.target.closest('[data-handle]');
  if (ev.button === 2) return startPan(ev);
  if (ev.button !== 0) return;
  if (handle) {
    const items = selectedItems(), h = handle.dataset.handle;
    if (h === 'rot') {
      const b = unionBBox(items), c = [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
      S.drag = { mode: 'rotate', c, a0: deg(Math.atan2(wy - c[1], wx - c[0])), orig: clone(items), moved: false };
    } else {
      S.drag = { mode: h === 'v' ? 'vertex' : h, id: items[0].id, idx: +handle.dataset.idx, orig: clone(items[0].pts), moved: false };
    }
    return;
  }
  if (S.tool !== 'select') { const p = draftPoint(ev); commitPoint(p); renderOverlay(); updateStatus(); return; }

  const endEl = ev.target.closest('.end');
  const itemEl = ev.target.closest('.part, .shape');
  if (endEl) {
    S.active = { pid: +endEl.dataset.pid, i: +endEl.dataset.i };
    renderOverlay(); updateStatus(); return;
  }
  if (itemEl) {
    const id = +itemEl.dataset.id, rs = shapeById(id);
    if (isRect(rs) && !ev.shiftKey && (!S.sel.has(id) || S.sel.size === 1)) {
      const grip = rectGrip(rs, wx, wy);
      if (grip) {
        S.sel = new Set([id]); renderSelection(); renderUI(); updateStatus();
        S.drag = { mode: grip.mode, id, idx: grip.idx, orig: clone(rs.pts), moved: false };
        return;
      }
    }
    if (ev.shiftKey) { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); }
    else if (!S.sel.has(id)) S.sel = new Set([id]);
    renderSelection(); renderUI(); updateStatus();
    if (!S.sel.has(id)) return;
    const ids = new Set(S.sel);
    S.drag = { mode: 'move', wx, wy, ids, orig: clone(selectedItems()), moved: false, sx: ev.clientX, sy: ev.clientY };
    return;
  }
  // empty space: rubber-band selection (Shift adds to the current selection)
  S.drag = { mode: 'box', sx: ev.clientX, sy: ev.clientY, wx, wy, add: ev.shiftKey, hits: new Set() };
});

const boxEl = $('#boxSel');
const showBox = (on) => { boxEl.style.display = on ? '' : 'none'; };
showBox(false);
function clearPresel() { for (const g of svg.querySelectorAll('.presel')) g.classList.remove('presel'); }
function cancelBox() { showBox(false); clearPresel(); S.drag = null; }

// left-to-right: items completely inside; right-to-left: items touching the box
function boxHits(D) {
  const x0 = Math.min(D.wx, D.wx2), x1 = Math.max(D.wx, D.wx2), y0 = Math.min(D.wy, D.wy2), y1 = Math.max(D.wy, D.wy2);
  const crossing = D.wx2 < D.wx, hits = new Set();
  for (const it of [...S.parts, ...S.shapes]) {
    const b = itemBBox(it);
    const inside = b.x0 >= x0 && b.x1 <= x1 && b.y0 >= y0 && b.y1 <= y1;
    const touch = b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1;
    if (crossing ? touch : inside) hits.add(it.id);
  }
  return hits;
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const unit = (v) => { const L = Math.hypot(v[0], v[1]) || 1; return [v[0] / L, v[1] / L]; };
const snapLen = (L) => { const g = S.grid > 0 ? S.grid / MM : 0; return g ? Math.round(L / g) * g : L; };
const MIN_SIZE = 1 / MM;

// move edge i of a rectangle along its outward normal; returns the new size across that edge
function dragRectEdge(s, orig, i, w) {
  const a = orig[i], b = orig[(i + 1) % 4], u = unit(sub(b, a)), nOut = [u[1], -u[0]];
  const opp = orig[(i + 2) % 4], size0 = dot(sub(a, opp), nOut);
  const size = Math.max(MIN_SIZE, snapLen(size0 + dot(sub(w, a), nOut))), d = size - size0;
  s.pts = orig.map((p) => [...p]);
  for (const k of [i, (i + 1) % 4]) s.pts[k] = [orig[k][0] + nOut[0] * d, orig[k][1] + nOut[1] * d];
}
// drag corner k, the opposite corner stays fixed and the shape stays rectangular
function dragRectCorner(s, orig, k, w) {
  const o = orig[(k + 2) % 4], u = unit(sub(orig[1], orig[0])), v = unit(sub(orig[3], orig[0]));
  const c0 = sub(orig[k], o), c = sub(w, o);
  const su = Math.sign(dot(c0, u)) || 1, sv = Math.sign(dot(c0, v)) || 1;
  const A = su * Math.max(MIN_SIZE, snapLen(su * dot(c, u))), B = sv * Math.max(MIN_SIZE, snapLen(sv * dot(c, v)));
  const P = (x, y) => [o[0] + u[0] * x + v[0] * y, o[1] + u[1] * x + v[1] * y];
  // corner order relative to the fixed corner o (index k+2): k+3 lies along u or v
  const along = (idx) => Math.abs(dot(sub(orig[idx], o), u)) > Math.abs(dot(sub(orig[idx], o), v));
  s.pts = orig.map((p) => [...p]);
  s.pts[k] = P(A, B);
  for (const idx of [(k + 1) % 4, (k + 3) % 4]) s.pts[idx] = along(idx) ? P(A, 0) : P(0, B);
}
const rectSize = (s) => [Math.hypot(...sub(s.pts[1], s.pts[0])), Math.hypot(...sub(s.pts[2], s.pts[1]))];
function showMeasure(ev, text) {
  const m = $('#measure'), r = svg.getBoundingClientRect();
  m.textContent = text; m.hidden = false;
  m.style.left = ev.clientX - r.left + 16 + 'px'; m.style.top = ev.clientY - r.top + 14 + 'px';
}

function restoreItems(orig) {
  for (const o of orig) { const it = itemById(o.id); if (it) Object.assign(it, clone(o)); }
}

svg.addEventListener('pointermove', (ev) => {
  const [wx, wy] = toWorldPt(ev.clientX, ev.clientY);
  $('#stCoords').textContent = `x ${mm(wx)} mm · y ${mm(wy)} mm`;
  const D = S.drag;
  if (!D) {
    if (S.tool === 'select') { // resize cursors over rectangle sides and corners
      const g = ev.target.closest?.('.shape.rect'), rs = g && shapeById(+g.dataset.id);
      if (rs && (!S.sel.has(rs.id) || S.sel.size === 1)) g.style.cursor = gripCursor(rs, rectGrip(rs, wx, wy));
    }
    if (S.tool !== 'select') {
      const p = draftPoint(ev); S.cursor = p;
      if (S.draft) S.draft.cur = [p.x, p.y];
      renderOverlay();
    }
    return;
  }
  if (D.mode === 'pan') {
    S.view.tx = D.tx + ev.clientX - D.sx; S.view.ty = D.ty + ev.clientY - D.sy; D.moved = true; applyView(); return;
  }
  if (D.mode === 'move') {
    if (!D.moved && Math.hypot(ev.clientX - D.sx, ev.clientY - D.sy) < 3) return;
    if (!D.moved) { pushUndo(); D.moved = true; S.lastPlace = null; ui.innerHTML = ''; }
    restoreItems(D.orig);
    for (const o of D.orig) translateItem(itemById(o.id), wx - D.wx, wy - D.wy);
    S.snap = ev.altKey ? null : findSnap(D.ids);
    if (S.snap) applySnap(D.ids, S.snap);
    for (const o of D.orig) if (!o.pts) setPose(S.els.get(o.id), byId(o.id));
    if (D.orig.some((o) => o.pts)) renderShapes();
    S.allEnds = S.parts.flatMap(ends);
    renderOverlay(); return;
  }
  if (D.mode === 'rotate') {
    if (!D.moved) { pushUndo(); D.moved = true; S.lastPlace = null; }
    let delta = -(deg(Math.atan2(wy - D.c[1], wx - D.c[0])) - D.a0);
    delta = ((delta + 540) % 360) - 180;
    if (!ev.shiftKey) { const st = step(); delta = Math.round(delta / st) * st; }
    restoreItems(D.orig);
    for (const o of D.orig) { const it = itemById(o.id); rotateItem(it, D.c[0], D.c[1], delta); if (!it.pts) setPose(S.els.get(it.id), it); }
    if (D.orig.some((o) => o.pts)) renderShapes();
    S.allEnds = S.parts.flatMap(ends);
    renderOverlay(); renderUI();
    const m = $('#measure'), r = svg.getBoundingClientRect();
    m.textContent = `${delta > 0 ? '+' : ''}${f3(delta)}°`; m.hidden = false;
    m.style.left = ev.clientX - r.left + 16 + 'px'; m.style.top = ev.clientY - r.top + 14 + 'px';
    return;
  }
  if (['vertex', 'off', 'redge', 'rcorner'].includes(D.mode)) {
    if (!D.moved) { pushUndo(); D.moved = true; }
    const s = shapeById(D.id);
    if (D.mode === 'off') s.off = dimOffset(s.pts, [wx, wy]);
    else if (D.mode === 'redge') { dragRectEdge(s, D.orig, D.idx, [wx, wy]); const [w, h] = rectSize(s); showMeasure(ev, `${mm(w)} × ${mm(h)} mm`); }
    else if (D.mode === 'rcorner') { const p = snapPoint(wx, wy, s.id); dragRectCorner(s, D.orig, D.idx, [p.x, p.y]); const [w, h] = rectSize(s); showMeasure(ev, `${mm(w)} × ${mm(h)} mm`); }
    else { const p = snapPoint(wx, wy, s.id); s.pts[D.idx] = [p.x, p.y]; if (s.type === 'dim') delete s.ref; }
    renderShapes(); renderUI(); updateStatus();
    return;
  }
  if (D.mode === 'box') {
    if (!D.moved && Math.hypot(ev.clientX - D.sx, ev.clientY - D.sy) < 4) return;
    D.moved = true;
    const r = svg.getBoundingClientRect();
    const x = Math.min(D.sx, ev.clientX) - r.left, y = Math.min(D.sy, ev.clientY) - r.top;
    Object.entries({ x, y, width: Math.abs(ev.clientX - D.sx), height: Math.abs(ev.clientY - D.sy) }).forEach(([k, v]) => boxEl.setAttribute(k, v));
    D.wx2 = wx; D.wy2 = wy;
    boxEl.classList.toggle('crossing', D.wx2 < D.wx);
    showBox(true);
    D.hits = boxHits(D);
    clearPresel();
    for (const id of D.hits) (S.els.get(id) || svg.querySelector(`.shape[data-id="${id}"]`))?.classList.add('presel');
  }
});

function endDrag(ev) {
  const D = S.drag; S.drag = null; svg.classList.remove('panning');
  $('#measure').hidden = S.tool === 'select' || !S.draft;
  if (!D) return;
  if (D.mode === 'pan') S.lastPanMoved = D.moved;
  if (['move', 'rotate', 'vertex', 'off', 'redge', 'rcorner'].includes(D.mode)) { S.snap = null; normalizeRects(); renderShapes(); refresh(); }
  if (D.mode === 'box') {
    showBox(false); clearPresel();
    if (ev.type !== 'pointerup') return;
    if (!D.moved) { if (!D.add) { S.sel.clear(); S.lastPlace = null; } }  // plain click on empty space: unmark
    else S.sel = D.add ? new Set([...S.sel, ...D.hits]) : D.hits;
    renderSelection(); renderUI(); updateStatus();
  }
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);
svg.addEventListener('contextmenu', (ev) => {
  ev.preventDefault();
  if (S.tool === 'select' || S.lastPanMoved) { S.lastPanMoved = false; return; }
  if (S.draft?.type === 'poly') finishPoly(); else { S.draft = null; renderOverlay(); }
});

svg.addEventListener('dblclick', (ev) => {
  if (S.tool === 'poly' && S.draft) {
    const pts = S.draft.pts; // the two clicks of the double-click added a duplicate point
    while (pts.length > 2 && Math.hypot(pts.at(-1)[0] - pts.at(-2)[0], pts.at(-1)[1] - pts.at(-2)[1]) < PICK_PX / S.view.z) pts.pop();
    finishPoly(); return;
  }
  if (S.tool !== 'select') return;
  const itemEl = ev.target.closest('.part, .shape'); if (!itemEl) return;
  const id = +itemEl.dataset.id, s = shapeById(id);
  if (s?.type === 'text') { openTextDialog(s); return; }
  if (s) return;
  S.sel = connectedGroup(id); renderSelection(); renderUI(); updateStatus();
});

svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = svg.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top;
  const z0 = S.view.z, z = Math.min(400, Math.max(0.6, z0 * Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015))));
  S.view.tx = sx - (sx - S.view.tx) * (z / z0); S.view.ty = sy - (sy - S.view.ty) * (z / z0); S.view.z = z;
  applyView();
}, { passive: false });

svg.addEventListener('dragover', (ev) => { if (ev.dataTransfer.types.includes('text/x-stl-part')) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
svg.addEventListener('drop', (ev) => {
  const data = ev.dataTransfer.getData('text/x-stl-part'); if (!data) return;
  ev.preventDefault();
  const { lib, title } = JSON.parse(data);
  setTool('select');
  placePart(lib, title, toWorldPt(ev.clientX, ev.clientY));
});

function fitView() {
  const r = svg.getBoundingClientRect();
  const b = unionBBox([...S.parts, ...S.shapes]);
  if (!b) { S.view = { tx: r.width / 2, ty: r.height / 2, z: 12 }; applyView(); return; }
  const z = Math.min(200, Math.max(0.6, Math.min(r.width / (b.x1 - b.x0 + 6), r.height / (b.y1 - b.y0 + 6))));
  S.view = { z, tx: r.width / 2 - z * (b.x0 + b.x1) / 2, ty: r.height / 2 + z * (b.y0 + b.y1) / 2 };
  applyView();
}

// ---------------------------------------------------------------- keyboard
const TOOL_KEYS = { v: 'select', l: 'line', p: 'poly', b: 'rect', o: 'circle', d: 'dim', t: 'text' };
document.addEventListener('keydown', (ev) => {
  if (ev.target.closest('#props') && ev.key === 'Escape') { ev.target.blur(); return; }
  // in the properties panel, Ctrl+Z / Ctrl+Y undo the applied value rather than editing the text field
  const propsUndo = ev.target.closest('#props') && (ev.ctrlKey || ev.metaKey) && 'zy'.includes(ev.key.toLowerCase());
  if (propsUndo) { ev.target.blur(); propsKey = ''; }
  if (!propsUndo && ev.target.closest('input, select, textarea, dialog') && ev.key !== 'Escape') {
    if (!((ev.ctrlKey || ev.metaKey) && 'so'.includes(ev.key.toLowerCase()))) return;
  }
  if (document.querySelector('dialog[open]')) return;
  const k = ev.key.toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
  if (S.drag?.mode === 'box' && k === 'escape') { cancelBox(); return; }
  if (mod && k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { ev.preventDefault(); redo(); return; }
  if (mod && k === 's') { ev.preventDefault(); saveAs(); return; }
  if (mod && k === 'o') { ev.preventDefault(); openFile(); return; }
  if (!mod && k === 'enter' && S.tool === 'select') {
    const f = $('#props:not([hidden]) input'); if (f) { ev.preventDefault(); f.focus(); f.select(); return; }
  }
  if (mod && k === 'a') { ev.preventDefault(); setTool('select'); S.sel = new Set([...S.parts, ...S.shapes].map((it) => it.id)); renderSelection(); renderUI(); updateStatus(); return; }
  if (mod) return;
  if (k === ' ') { S.space = true; return; }

  // number entry while drawing
  if (S.tool !== 'select' && S.draft && /^[\d.,x*]$/.test(k)) { S.typed += k; renderOverlay(); updateStatus(); ev.preventDefault(); return; }
  if (S.tool !== 'select' && k === 'enter') { ev.preventDefault(); if (!applyTyped() && S.draft?.type === 'poly') finishPoly(); renderOverlay(); updateStatus(); return; }
  if (S.tool !== 'select' && k === 'backspace') {
    ev.preventDefault();
    if (S.typed) S.typed = S.typed.slice(0, -1);
    else if (S.draft?.pts.length > 1) S.draft.pts.pop(); else S.draft = null;
    renderOverlay(); updateStatus(); return;
  }
  if (k === 'escape') {
    if (S.draft) { S.draft.type === 'poly' ? finishPoly() : (S.draft = null); S.typed = ''; renderOverlay(); updateStatus(); return; }
    if (S.tool !== 'select') { setTool('select'); return; }
    S.sel.clear(); S.active = null; S.lastPlace = null; ev.target.blur?.(); clearPresel(); showBox(false); renderSelection(); renderOverlay(); renderUI(); updateStatus(); return;
  }
  if (TOOL_KEYS[k] && !ev.shiftKey) { setTool(TOOL_KEYS[k]); return; }
  if (k === 'delete' || k === 'backspace') { ev.preventDefault(); deleteSelection(); }
  else if (k === 'r') rotateSelection(ev.shiftKey ? -step() : step());
  else if (k === 'tab') { ev.preventDefault(); flipLast(); }
  else if (k === 'f') fitView();
});
document.addEventListener('keyup', (ev) => { if (ev.key === ' ') S.space = false; });
const step = () => { const v = parseFloat(String($('#rotStep').value).replace(',', '.')); return v > 0 ? v : 15; };

// ---------------------------------------------------------------- persistence
const native = window.webkit?.messageHandlers?.stl; // running inside the macOS app?
const layoutName = () => $('#layoutName').value.trim() || 'Untitled';

function layoutDoc() {
  const r = (v) => +v.toFixed(5);
  return {
    format: 'smardtracklayout', version: 3, name: layoutName(), units: 'inch',
    libraries: [...new Set(S.parts.map((p) => p.lib))],
    parts: S.parts.map(({ lib, title, x, y, rot }) => ({ lib, title, x: r(x), y: r(y), rot: +rot.toFixed(4) })),
    shapes: S.shapes.map(({ pts, ...rest }) => ({ ...rest, pts: pts.map(([x, y]) => [r(x), r(y)]) })),
  };
}

async function loadDoc(doc, { keepView = false } = {}) {
  if (!doc || !Array.isArray(doc.parts)) throw new Error('not a SmardTrackLayout file');
  const libs = [...new Set(doc.parts.map((p) => p.lib))];
  const failed = [];
  await Promise.all(libs.map((f) => loadLib(f).catch(() => failed.push(f))));
  S.parts = doc.parts.map((p, i) => ({ id: i + 1, lib: p.lib, title: p.title, x: +p.x || 0, y: +p.y || 0, rot: +p.rot || 0 }));
  S.nextId = S.parts.length + 1;
  S.shapes = [];
  const idMap = new Map();
  for (const s of doc.shapes || []) {
    if (!Array.isArray(s.pts) || !s.pts.length) continue;
    const old = s.id, c = addShape(clone(s));
    if (old != null) idMap.set(old, c.id);
  }
  for (const s of S.shapes) if (s.ref) { const id = idMap.get(s.ref.shape); if (id) s.ref.shape = id; else delete s.ref; }
  normalizeRects();
  for (const d of S.shapes) if (d.type === 'dim' && !d.ref) { const ref = findEdgeRef(...d.pts); if (ref) d.ref = ref; } // older files
  S.sel.clear(); S.active = null; S.lastPlace = null; S.undo = []; S.redo = [];
  $('#layoutName').value = doc.name || 'Untitled';
  setTool('select');
  renderAll();
  if (!keepView) fitView();
  const missing = S.parts.filter((p) => !def(p)).length;
  if (failed.length || missing) toast(`${missing} piece(s) could not be resolved${failed.length ? ' (library unavailable: ' + failed.join(', ') + ')' : ''}`, 5000);
}

let autosaveTimer;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try { localStorage.setItem('stl.autosave', JSON.stringify({ ...layoutDoc(), view: S.view, dirty: S.dirty })); } catch { /* ignore */ }
  }, 400);
}

// Save as…: write the layout to a file; the chosen file name becomes the layout name
const baseName = (f) => String(f).split(/[\\/]/).pop().replace(/\.json$/i, '').replace(/\.stl$/i, '');
function docFor(name) { $('#layoutName').value = name; return JSON.stringify(layoutDoc(), null, 1); }
function savedAs(name) { $('#layoutName').value = name; S.dirty = false; updateStatus(); toast(`Saved “${name}”`); }

async function saveAs() {
  const name = layoutName();
  if (native) { native.postMessage({ type: 'saveAs', name: name + '.stl.json' }); return; } // app shows the save panel, then calls docFor/savedAs
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name + '.stl.json', types: [{ description: 'SmardTrackLayout layout', accept: { 'application/json': ['.json'] } }] });
      const n = baseName(h.name), w = await h.createWritable();
      await w.write(docFor(n)); await w.close();
      savedAs(n);
    } catch (e) { if (e.name !== 'AbortError') toast('Save failed: ' + e.message, 5000); }
    return;
  }
  // browsers without a save dialog API: ask for the name, then download
  const dlg = $('#dlgName'), input = $('#saveName');
  input.value = name === 'Untitled' ? '' : name;
  dlg.showModal(); input.focus(); input.select();
  dlg.onclose = () => {
    dlg.onclose = null;
    const n = input.value.trim();
    if (dlg.returnValue !== 'ok' || !n) return;
    download(n + '.stl.json', docFor(n), 'application/json');
    savedAs(n);
  };
}
const openFile = () => {
  if (S.dirty && S.parts.length + S.shapes.length && !confirm('Discard unsaved changes to the current layout?')) return;
  $('#fileImport').click();
};

function download(name, text, type) {
  if (native) { native.postMessage({ type: 'download', name, text }); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function bomRows() {
  const m = new Map();
  for (const p of S.parts) {
    const d = def(p); const key = p.lib + '|' + p.title;
    if (!m.has(key)) m.set(key, { partno: d?.partno || '', desc: d?.desc || p.title, mfr: d?.mfr || '', n: 0 });
    m.get(key).n++;
  }
  return [...m.values()].sort((a, b) => a.partno.localeCompare(b.partno, undefined, { numeric: true }));
}

function showBom() {
  const rows = bomRows();
  $('#bomBody').innerHTML = rows.length
    ? `<table class="bom"><thead><tr><th>Part no.</th><th>Description</th><th class="n">Qty</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.partno)}</td><td>${esc(r.desc)}</td><td class="n">${r.n}</td></tr>`).join('')}</tbody><tfoot><tr><th></th><th>Total</th><th class="n">${S.parts.length}</th></tr></tfoot></table>`
    : '<div class="muted">The layout has no track pieces.</div>';
  $('#dlgBom').showModal();
}

function newLayout() {
  if (S.dirty && S.parts.length + S.shapes.length && !confirm('Start a new layout? Unsaved changes in the current one are lost.')) return;
  loadDoc({ name: 'Untitled', parts: [], shapes: [] }).then(() => { S.dirty = false; updateStatus(); });
}

// ---------------------------------------------------------------- wiring
$('#libSelect').addEventListener('change', (e) => selectLib(e.target.value));
$('#partSearch').addEventListener('input', renderPalette);
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnRotL').onclick = () => rotateSelection(-step());
$('#btnRotR').onclick = () => rotateSelection(step());
$('#btnFlip').onclick = flipLast;
$('#btnDelete').onclick = deleteSelection;
$('#btnFit').onclick = fitView;
$('#chkLabels').onchange = (e) => { S.labels = e.target.checked; renderOverlay(); };
$('#btnBom').onclick = showBom;
$('#btnBomCsv').onclick = () => download(`${layoutName()} parts.csv`, 'Part no;Description;Manufacturer;Qty\n' + bomRows().map((r) => [r.partno, r.desc, r.mfr, r.n].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n'), 'text/csv');
$('#btnHelp').onclick = () => $('#dlgHelp').showModal();
$('#btnSave').onclick = saveAs;
$('#btnOpen').onclick = openFile;
$('#btnNew').onclick = newLayout;
$('#fileImport').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await loadDoc(JSON.parse(await f.text())); $('#layoutName').value = baseName(f.name); S.dirty = false; updateStatus(); } catch (err) { toast('Open failed: ' + err.message, 5000); }
  e.target.value = '';
};
$('#layoutName').addEventListener('change', () => { S.dirty = true; updateStatus(); });
for (const b of document.querySelectorAll('.drawbar [data-tool]')) b.onclick = () => setTool(b.dataset.tool);
$('#gridSnap').onchange = (e) => { S.grid = +e.target.value; try { localStorage.setItem('stl.grid', e.target.value); } catch { /* ignore */ } };
$('#chkAutoDim').onchange = (e) => { S.autoDim = e.target.checked; };
window.addEventListener('resize', applyView);
window.addEventListener('beforeunload', (e) => { if (!native && S.dirty && S.parts.length + S.shapes.length) e.preventDefault(); });

// API for the macOS app menus
const inField = () => document.activeElement?.matches?.('input, textarea');
window.stlApp = {
  newLayout, open: openFile, openFile, save: saveAs, saveAs, saveToFile: saveAs, docFor, savedAs,
  undo: () => (inField() ? document.execCommand('undo') : undo()),
  redo: () => (inField() ? document.execCommand('redo') : redo()),
  rotate: (d) => rotateSelection(d ?? step()),
  fit: fitView, partsList: showBom, help: () => $('#dlgHelp').showModal(),
  toggleLabels: () => $('#chkLabels').click(), tool: setTool,
};

// ---------------------------------------------------------------- startup
(async function init() {
  const r = svg.getBoundingClientRect();
  S.view = { tx: r.width / 2, ty: r.height / 2, z: 12 };
  try { const g = localStorage.getItem('stl.grid'); if (g != null) { S.grid = +g; $('#gridSnap').value = g; } } catch { /* ignore */ }
  applyView();
  S.libList = await fetch('api/libraries').then((x) => x.json()).catch(() => DEFAULT_LIBS);
  fillLibSelect();
  let saved = null, lastLib = null;
  try { saved = JSON.parse(localStorage.getItem('stl.autosave') || 'null'); lastLib = localStorage.getItem('stl.lib'); } catch { /* ignore */ }
  const lib = [lastLib, ...DEFAULT_LIBS].find((f) => f && S.libList.includes(f)) || S.libList[0];
  await selectLib(lib);
  if (saved && (saved.parts?.length || saved.shapes?.length)) {
    await loadDoc(saved, { keepView: !!saved.view }).catch(() => {});
    S.dirty = !!saved.dirty;
    if (saved.view) { S.view = saved.view; applyView(); }
  }
  updateStatus();
})();
