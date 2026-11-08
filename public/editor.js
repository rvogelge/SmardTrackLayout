import { parseXtp, partPaths } from './xtp.js';

const $ = (s) => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const MM = 25.4;
const DEFAULT_LIBS = ['mrklnhoc-de.xtp', 'HO-Marklin C-Track.xtp'];
const CONNECT_DIST = 0.03;   // inches: endpoints closer than this are connected
const CONNECT_ANGLE = 2;     // degrees
const SNAP_PX = 22;          // screen pixels for drag snapping

const svg = $('#canvas'), world = $('#world'), partsLayer = $('#parts'), overlay = $('#overlay');

const S = window.__stl = {
  libList: [], libs: new Map(), lib: null,
  parts: [], nextId: 1, els: new Map(),
  sel: new Set(), active: null, lastPlace: null,
  view: { tx: 0, ty: 0, z: 12 },
  undo: [], redo: [], conn: new Map(), allEnds: [],
  labels: false, drag: null, snap: null,
};

// ---------------------------------------------------------------- utilities
const rad = (d) => (d * Math.PI) / 180;
const norm = (a) => ((a % 360) + 360) % 360;
const angDiff = (a, b) => { const d = norm(a - b); return Math.min(d, 360 - d); };
const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const endKey = (pid, i) => pid + ':' + i;

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
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
  const r = rad(delta), c = Math.cos(r), s = Math.sin(r), dx = p.x - px, dy = p.y - py;
  p.x = px + dx * c + dy * s; p.y = py - dx * s + dy * c; p.rot = norm(p.rot + delta);
}
function partBBox(p) {
  const d = def(p); if (!d) return { x0: p.x - 1, y0: p.y - 1, x1: p.x + 1, y1: p.y + 1 };
  const b = d.bbox, pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => toWorld(p, x, y));
  return { x0: Math.min(...pts.map((q) => q[0])), y0: Math.min(...pts.map((q) => q[1])), x1: Math.max(...pts.map((q) => q[0])), y1: Math.max(...pts.map((q) => q[1])) };
}
const partCenter = (p) => { const d = def(p); if (!d) return [p.x, p.y]; const b = d.bbox; return toWorld(p, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2); };
const byId = (id) => S.parts.find((p) => p.id === id);

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

function libGroup(name) {
  const m = name.match(/^([A-Za-z0-9]+)-/);
  return m ? m[1] : 'Other';
}

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
      b.addEventListener('click', () => placePart(S.lib, d.title));
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
function applyView() {
  const { tx, ty, z } = S.view;
  world.setAttribute('transform', `translate(${tx} ${ty}) scale(${z} ${-z})`);
  const major = (100 / MM) * z, minor = (10 / MM) * z;
  const m = minor >= 7 ? minor : major;
  svg.style.backgroundSize = `${major}px ${major}px, ${major}px ${major}px, ${m}px ${m}px, ${m}px ${m}px`;
  svg.style.backgroundPosition = `${tx}px ${ty}px`;
  $('#stZoom').textContent = `zoom ${Math.round((z / 12) * 100)}%`;
  renderOverlay();
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

function renderAll() {
  partsLayer.innerHTML = ''; S.els.clear();
  for (const p of S.parts) { const g = buildPartEl(p); S.els.set(p.id, g); partsLayer.append(g); }
  computeConnections(); renderSelection(); renderOverlay(); updateStatus();
}

function renderSelection() {
  for (const [id, g] of S.els) g.classList.toggle('sel', S.sel.has(id));
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
      const [x, y] = partCenter(p);
      const t = el('text', { class: 'label', transform: `translate(${x} ${y}) scale(${1 / z} ${-1 / z})` });
      t.textContent = d.partno; overlay.append(t);
    }
  }
}

function updateStatus() {
  const open = S.allEnds.filter((e) => !S.conn.has(endKey(e.pid, e.i))).length;
  $('#stCounts').textContent = `${S.parts.length} pieces · ${open} open ends${S.sel.size ? ` · ${S.sel.size} selected` : ''}`;
  $('#emptyHint').hidden = S.parts.length > 0;
  $('#btnUndo').disabled = !S.undo.length; $('#btnRedo').disabled = !S.redo.length;
  const one = S.sel.size === 1 && S.lastPlace && S.sel.has(S.lastPlace.pid);
  $('#btnFlip').disabled = !one;
  $('#btnDelete').disabled = $('#btnRotL').disabled = $('#btnRotR').disabled = !S.sel.size;
  let hint = '';
  if (S.sel.size === 1) {
    const d = def(byId([...S.sel][0]));
    if (d) hint = `${d.desc}${d.partno ? ' · ' + d.partno : ''} · ${d.mfr}`;
  } else if (!S.active && S.parts.length) hint = 'Click an orange open end to choose where the next piece attaches.';
  $('#stHint').textContent = hint;
  scheduleAutosave();
}

const refresh = () => { computeConnections(); renderSelection(); renderOverlay(); updateStatus(); };

// ---------------------------------------------------------------- history
const snapshot = () => JSON.stringify({ parts: S.parts, nextId: S.nextId });
function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 200) S.undo.shift(); S.redo = []; }
function restore(snap) {
  const o = JSON.parse(snap); S.parts = o.parts; S.nextId = o.nextId;
  S.sel = new Set([...S.sel].filter((id) => byId(id))); S.lastPlace = null;
  renderAll();
}
function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); }
function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); }

// ---------------------------------------------------------------- editing
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
  if (!S.sel.size) return;
  pushUndo();
  const sel = S.parts.filter((p) => S.sel.has(p.id));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of sel) { const b = partBBox(p); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (const p of sel) { rotateAbout(p, cx, cy, delta); setPose(S.els.get(p.id), p); }
  S.lastPlace = null;
  refresh();
}

function deleteSelection() {
  if (!S.sel.size) return;
  pushUndo();
  S.parts = S.parts.filter((p) => !S.sel.has(p.id));
  for (const id of S.sel) { S.els.get(id)?.remove(); S.els.delete(id); }
  S.sel.clear(); S.lastPlace = null;
  refresh();
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
  for (const p of S.parts) if (movingIds.has(p.id)) { rotateAbout(p, m.x, m.y, delta); p.x += t.x - m.x; p.y += t.y - m.y; }
}

// ---------------------------------------------------------------- pointer handling
function toWorldPt(cx, cy) {
  const r = svg.getBoundingClientRect(), { tx, ty, z } = S.view;
  return [(cx - r.left - tx) / z, (ty - (cy - r.top)) / z];
}

svg.addEventListener('pointerdown', (ev) => {
  svg.setPointerCapture(ev.pointerId);
  const [wx, wy] = toWorldPt(ev.clientX, ev.clientY);
  const endEl = ev.target.closest('.end');
  const partEl = ev.target.closest('.part');
  if (ev.button === 1 || (ev.button === 0 && !endEl && !partEl && !ev.shiftKey)) {
    S.drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, tx: S.view.tx, ty: S.view.ty, moved: false };
    svg.classList.add('panning'); return;
  }
  if (ev.button !== 0) return;
  if (endEl) {
    S.active = { pid: +endEl.dataset.pid, i: +endEl.dataset.i };
    renderOverlay(); updateStatus(); return;
  }
  if (partEl) {
    const id = +partEl.dataset.id;
    if (ev.shiftKey) { if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id); }
    else if (!S.sel.has(id)) S.sel = new Set([id]);
    renderSelection(); updateStatus();
    if (!S.sel.has(id)) return;
    const ids = new Set(S.sel);
    S.drag = { mode: 'move', wx, wy, ids, orig: S.parts.filter((p) => ids.has(p.id)).map((p) => ({ ...p })), moved: false, sx: ev.clientX, sy: ev.clientY };
    return;
  }
  // shift + empty space: box select
  S.drag = { mode: 'box', sx: ev.clientX, sy: ev.clientY, wx, wy };
});

svg.addEventListener('pointermove', (ev) => {
  const [wx, wy] = toWorldPt(ev.clientX, ev.clientY);
  $('#stCoords').textContent = `x ${Math.round(wx * MM)} mm · y ${Math.round(wy * MM)} mm`;
  const D = S.drag; if (!D) return;
  if (D.mode === 'pan') {
    S.view.tx = D.tx + ev.clientX - D.sx; S.view.ty = D.ty + ev.clientY - D.sy; D.moved = true; applyView(); return;
  }
  if (D.mode === 'move') {
    if (!D.moved && Math.hypot(ev.clientX - D.sx, ev.clientY - D.sy) < 3) return;
    if (!D.moved) { pushUndo(); D.moved = true; S.lastPlace = null; }
    const dx = wx - D.wx, dy = wy - D.wy;
    for (const o of D.orig) { const p = byId(o.id); p.x = o.x + dx; p.y = o.y + dy; p.rot = o.rot; }
    S.snap = ev.altKey ? null : findSnap(D.ids);
    if (S.snap) applySnap(D.ids, S.snap);
    for (const id of D.ids) setPose(S.els.get(id), byId(id));
    S.allEnds = S.parts.flatMap(ends);
    renderOverlay(); return;
  }
  if (D.mode === 'box') {
    const r = svg.getBoundingClientRect(), b = $('#boxSel');
    const x = Math.min(D.sx, ev.clientX) - r.left, y = Math.min(D.sy, ev.clientY) - r.top;
    Object.entries({ x, y, width: Math.abs(ev.clientX - D.sx), height: Math.abs(ev.clientY - D.sy) }).forEach(([k, v]) => b.setAttribute(k, v));
    b.hidden = false; D.wx2 = wx; D.wy2 = wy;
  }
});

function endDrag(ev) {
  const D = S.drag; S.drag = null; svg.classList.remove('panning');
  if (!D) return;
  if (D.mode === 'pan' && !D.moved && ev.type === 'pointerup') { S.sel.clear(); S.lastPlace = null; renderSelection(); updateStatus(); }
  if (D.mode === 'move' && D.moved) { S.snap = null; refresh(); }
  if (D.mode === 'box') {
    $('#boxSel').hidden = true;
    if (D.wx2 != null) {
      const x0 = Math.min(D.wx, D.wx2), x1 = Math.max(D.wx, D.wx2), y0 = Math.min(D.wy, D.wy2), y1 = Math.max(D.wy, D.wy2);
      for (const p of S.parts) { const [cx, cy] = partCenter(p); if (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) S.sel.add(p.id); }
      renderSelection(); updateStatus();
    }
  }
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);

svg.addEventListener('dblclick', (ev) => {
  const partEl = ev.target.closest('.part'); if (!partEl) return;
  S.sel = connectedGroup(+partEl.dataset.id); renderSelection(); updateStatus();
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
  placePart(lib, title, toWorldPt(ev.clientX, ev.clientY));
});

function fitView() {
  const r = svg.getBoundingClientRect();
  if (!S.parts.length) { S.view = { tx: r.width / 2, ty: r.height / 2, z: 12 }; applyView(); return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of S.parts) { const b = partBBox(p); x0 = Math.min(x0, b.x0); y0 = Math.min(y0, b.y0); x1 = Math.max(x1, b.x1); y1 = Math.max(y1, b.y1); }
  const z = Math.min(200, Math.max(0.6, Math.min(r.width / (x1 - x0 + 4), r.height / (y1 - y0 + 4))));
  S.view = { z, tx: r.width / 2 - z * (x0 + x1) / 2, ty: r.height / 2 + z * (y0 + y1) / 2 };
  applyView();
}

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', (ev) => {
  if (ev.target.closest('input, select, textarea') && ev.key !== 'Escape') {
    if (!((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's')) return;
  }
  const k = ev.key.toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
  if (mod && k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { ev.preventDefault(); redo(); return; }
  if (mod && k === 's') { ev.preventDefault(); saveServer(); return; }
  if (mod && k === 'o') { ev.preventDefault(); openDialog(); return; }
  if (mod && k === 'a') { ev.preventDefault(); S.sel = new Set(S.parts.map((p) => p.id)); renderSelection(); updateStatus(); return; }
  if (mod) return;
  if (k === 'delete' || k === 'backspace') { ev.preventDefault(); deleteSelection(); }
  else if (k === 'r') rotateSelection(ev.shiftKey ? -step() : step());
  else if (k === 'tab') { ev.preventDefault(); flipLast(); }
  else if (k === 'f') fitView();
  else if (k === 'escape') { S.sel.clear(); S.active = null; S.lastPlace = null; ev.target.blur?.(); renderSelection(); renderOverlay(); updateStatus(); }
});
const step = () => parseFloat($('#rotStep').value);

// ---------------------------------------------------------------- persistence
function layoutDoc() {
  return {
    format: 'smardtracklayout', version: 1, name: $('#layoutName').value.trim() || 'Untitled', units: 'inch',
    libraries: [...new Set(S.parts.map((p) => p.lib))],
    parts: S.parts.map(({ lib, title, x, y, rot }) => ({ lib, title, x: +x.toFixed(5), y: +y.toFixed(5), rot: +rot.toFixed(4) })),
  };
}

async function loadDoc(doc, { keepView = false } = {}) {
  if (!doc || !Array.isArray(doc.parts)) throw new Error('not a SmardTrackLayout file');
  const libs = [...new Set(doc.parts.map((p) => p.lib))];
  const failed = [];
  await Promise.all(libs.map((f) => loadLib(f).catch(() => failed.push(f))));
  S.parts = doc.parts.map((p, i) => ({ id: i + 1, lib: p.lib, title: p.title, x: +p.x || 0, y: +p.y || 0, rot: +p.rot || 0 }));
  S.nextId = S.parts.length + 1;
  S.sel.clear(); S.active = null; S.lastPlace = null; S.undo = []; S.redo = [];
  $('#layoutName').value = doc.name || 'Untitled';
  renderAll();
  if (!keepView) fitView();
  const missing = S.parts.filter((p) => !def(p)).length;
  if (failed.length || missing) toast(`${missing} piece(s) could not be resolved${failed.length ? ' (library unavailable: ' + failed.join(', ') + ')' : ''}`, 5000);
}

let autosaveTimer;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try { localStorage.setItem('stl.autosave', JSON.stringify({ ...layoutDoc(), view: S.view })); } catch { /* ignore */ }
  }, 400);
}

// Running inside the macOS app (WKWebView with a native bridge)?
const native = window.webkit?.messageHandlers?.stl;
const WHERE = native ? '' : ' on the server';

async function saveServer() {
  const doc = layoutDoc();
  const res = await fetch('api/layouts/' + encodeURIComponent(doc.name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc) });
  if (res.ok) toast(`Saved “${doc.name}”${WHERE}`);
  else toast('Save failed: ' + ((await res.json().catch(() => ({}))).error || res.statusText), 5000);
}

async function openDialog() {
  const list = $('#openList'); list.innerHTML = '<div class="muted">Loading…</div>';
  $('#dlgOpen').showModal();
  const items = await fetch('api/layouts').then((r) => r.json()).catch(() => []);
  if (!items.length) { list.innerHTML = `<div class="muted">No layouts saved${WHERE} yet.</div>`; return; }
  list.innerHTML = '';
  for (const it of items) {
    const row = document.createElement('div'); row.className = 'openrow';
    row.innerHTML = `<button type="button" class="open"><span>${esc(it.name)}</span><small>${new Date(it.modified).toLocaleString()}</small></button><button type="button" class="del" title="Delete">✕</button>`;
    row.querySelector('.open').onclick = async () => {
      const doc = await fetch('api/layouts/' + encodeURIComponent(it.name)).then((r) => r.json());
      $('#dlgOpen').close(); await loadDoc(doc).catch((e) => toast(e.message));
    };
    row.querySelector('.del').onclick = async () => {
      if (!confirm(`Delete layout “${it.name}”${WHERE ? ' from the server' : ''}?`)) return;
      await fetch('api/layouts/' + encodeURIComponent(it.name), { method: 'DELETE' }); row.remove();
    };
    list.append(row);
  }
}

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
    : '<div class="muted">The layout is empty.</div>';
  $('#dlgBom').showModal();
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
$('#btnBomCsv').onclick = () => download(`${layoutDoc().name} parts.csv`, 'Part no;Description;Manufacturer;Qty\n' + bomRows().map((r) => [r.partno, r.desc, r.mfr, r.n].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n'), 'text/csv');
$('#btnHelp').onclick = () => $('#dlgHelp').showModal();
$('#btnSave').onclick = saveServer;
$('#btnOpen').onclick = openDialog;
$('#btnNew').onclick = () => {
  if (S.parts.length && !confirm('Start a new layout? Unsaved changes in the current one are lost (except the browser autosave, which is overwritten).')) return;
  loadDoc({ name: 'Untitled', parts: [] });
};
$('#btnExport').onclick = () => { const d = layoutDoc(); download(d.name + '.stl.json', JSON.stringify(d, null, 1), 'application/json'); };
$('#btnImport').onclick = () => $('#fileImport').click();
$('#fileImport').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await loadDoc(JSON.parse(await f.text())); } catch (err) { toast('Import failed: ' + err.message, 5000); }
  e.target.value = '';
};
$('#layoutName').addEventListener('change', scheduleAutosave);
window.addEventListener('resize', applyView);

// API for the macOS app menus
const inField = () => document.activeElement?.matches?.('input, textarea');
window.stlApp = {
  newLayout: () => $('#btnNew').click(), open: openDialog, save: saveServer,
  exportJson: () => $('#btnExport').click(), importJson: () => $('#btnImport').click(),
  undo: () => (inField() ? document.execCommand('undo') : undo()),
  redo: () => (inField() ? document.execCommand('redo') : redo()),
  fit: fitView, partsList: showBom, help: () => $('#dlgHelp').showModal(),
  toggleLabels: () => $('#chkLabels').click(),
};

// ---------------------------------------------------------------- startup
(async function init() {
  const r = svg.getBoundingClientRect();
  S.view = { tx: r.width / 2, ty: r.height / 2, z: 12 };
  applyView();
  S.libList = await fetch('api/libraries').then((x) => x.json()).catch(() => DEFAULT_LIBS);
  fillLibSelect();
  let saved = null, lastLib = null;
  try { saved = JSON.parse(localStorage.getItem('stl.autosave') || 'null'); lastLib = localStorage.getItem('stl.lib'); } catch { /* ignore */ }
  const lib = [lastLib, ...DEFAULT_LIBS].find((f) => f && S.libList.includes(f)) || S.libList[0];
  await selectLib(lib);
  if (saved?.parts?.length) {
    await loadDoc(saved, { keepView: !!saved.view }).catch(() => {});
    if (saved.view) { S.view = saved.view; applyView(); }
  } else updateStatus();
})();
