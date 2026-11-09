// SmardTrackLayout - model railway track layout editor
// Copyright (C) 2026 Rolf Vogelgesang
//
// This program is free software: you can redistribute it and/or modify it under the terms of
// the GNU General Public License as published by the Free Software Foundation, either
// version 3 of the License, or (at your option) any later version. It is distributed
// WITHOUT ANY WARRANTY; see the GNU General Public License for details (file LICENSE).
//
// SPDX-License-Identifier: GPL-3.0-or-later

import { parseXtp, partPaths } from './xtp.js';
import { SYMBOL_LIB, symbolLibrary } from './symbols.js';
import { t as tr, setLang, applyI18n, LANGS, systemLang, currentLang } from './i18n.js';

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
  sel: new Set(), active: null, gapEnd: null, lastPlace: null,
  view: { tx: 0, ty: 0, z: 12 },
  undo: [], redo: [], conn: new Map(), allEnds: [],
  labels: false, drag: null, snap: null,
  tool: 'select', draft: null, typed: '', cursor: null, space: false,
  grid: 10, autoDim: true, dirty: false, lastPanMoved: false,
  layers: [{ id: 1, name: 'Layer 1', visible: true, locked: false }], curLayer: 1,
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

// layers: every part and shape has a layer id; hidden layers are not drawn, locked ones cannot be selected
const layerById = (id) => S.layers.find((l) => l.id === id);
const layerOf = (it) => layerById(it.layer) || S.layers[0];
const isVisible = (it) => layerOf(it).visible !== false;
const isEditable = (it) => { const l = layerOf(it); return l.visible !== false && !l.locked; };
const editableItems = () => [...S.parts, ...S.shapes].filter(isEditable);
function fixLayers() {
  if (!Array.isArray(S.layers) || !S.layers.length) S.layers = [{ id: 1, name: tr('layer.n', { n: 1 }), visible: true, locked: false }];
  const ids = new Set(S.layers.map((l) => l.id));
  for (const it of [...S.parts, ...S.shapes]) if (!ids.has(it.layer)) it.layer = S.layers[0].id;
  if (!ids.has(S.curLayer)) S.curLayer = S.layers[0].id;
  const cur = layerById(S.curLayer); cur.visible = true; cur.locked = false; // the active layer is always usable
}
// drop marking / the active end on items that became hidden or locked
function pruneForLayers() {
  for (const id of [...S.sel]) { const it = itemById(id); if (!it || !isEditable(it)) S.sel.delete(id); }
  if (S.active && !isVisible(byId(S.active.pid) || {})) S.active = null;
  if (S.lastPlace && !S.sel.has(S.lastPlace.pid)) S.lastPlace = null;
}

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
  if (file === SYMBOL_LIB) { const sl = symbolLibrary(); S.libs.set(file, sl); return sl; }
  const res = await fetch('api/library?file=' + encodeURIComponent(file));
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  const lib = parseXtp(await res.text());
  lib.file = file;
  lib.byTitle = new Map(lib.parts.map((p) => [p.title, p]));
  S.libs.set(file, lib);
  return lib;
}

const libGroup = (name) => { const m = name.match(/^([A-Za-z0-9]+)-/); return m ? m[1] : 'Other'; };

function fillLibSelect(sel = $('#libSelect')) {
  sel.innerHTML = '';
  const groups = new Map();
  for (const f of S.libList) { const g = libGroup(f); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(f); }
  const order = [...groups.keys()].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  for (const g of order) {
    const og = document.createElement('optgroup'); og.label = g === 'Other' ? tr('lib.other') : g;
    for (const f of groups.get(g)) { const o = document.createElement('option'); o.value = f; o.textContent = f.replace(/\.xtp$/i, ''); og.append(o); }
    sel.append(og);
  }
}

async function selectLib(file) {
  $('#libSelect').value = file;
  $('#palette').innerHTML = '<div class="muted pad">' + esc(tr('lib.loadingFrom', { f: file })) + '</div>';
  $('#libTitle').textContent = '';
  try {
    const lib = await loadLib(file);
    S.lib = file;
    try { localStorage.setItem('stl.lib', file); } catch { /* ignore */ }
    $('#libTitle').textContent = (lib.contents ? lib.contents + ' · ' : '') + tr('lib.parts', { n: lib.parts.length });
    renderPalette();
  } catch (e) {
    $('#palette').innerHTML = `<div class="muted pad">${esc(tr('lib.failed', { f: file, e: e.message }))}</div>`;
  }
}

// generic symbols carry their own SVG (in mm); the clickable area is their bounding box
function symbolEls(d) {
  const b = d.bbox, g = el('g', { class: 'symg', transform: `scale(${1 / MM})` });
  g.innerHTML = d.svg;
  return [el('path', { class: 'hit', d: `M${b.x0} ${b.y0}H${b.x1}V${b.y1}H${b.x0}Z` }), g];
}

function thumb(d) {
  const b = d.bbox, pad = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.06;
  const s = el('svg', { viewBox: `${b.x0 - pad} ${-b.y1 - pad} ${b.x1 - b.x0 + 2 * pad} ${b.y1 - b.y0 + 2 * pad}`, preserveAspectRatio: 'xMidYMid meet', class: 'part' });
  const g = el('g', { transform: 'scale(1 -1)' });
  if (d.sym) { s.classList.add('symbol'); g.append(symbolEls(d)[1]); }
  else {
    const P = partPaths(d);
    for (const [cls, dd] of [['fill', P.fill], ['outline', P.outline], ['ties', P.ties], ['rails', P.rails]]) if (dd) g.append(el('path', { class: cls, d: dd }));
  }
  s.append(g);
  return s;
}

// the generic symbols come first in every library; their group remembers whether it is open
let symbolsOpen = false;
try { symbolsOpen = localStorage.getItem('stl.symbolsOpen') === '1'; } catch { /* ignore */ }

function renderPalette() {
  const lib = S.libs.get(S.lib); if (!lib) return;
  const q = $('#partSearch').value.trim().toLowerCase();
  const pal = $('#palette'); pal.innerHTML = '';
  const groups = new Map();
  for (const [file, l] of [[SYMBOL_LIB, symbolLibrary()], [S.lib, lib]]) {
    for (const d of l.parts) {
      if (q && !(d.desc + ' ' + d.partno + ' ' + d.group).toLowerCase().includes(q)) continue;
      const key = file + '|' + d.group;
      if (!groups.has(key)) groups.set(key, { file, g: d.group, list: [] });
      groups.get(key).list.push(d);
    }
  }
  if (!groups.size) { pal.innerHTML = `<div class="muted pad">${esc(tr('lib.noMatch'))}</div>`; return; }
  for (const { file, g, list } of groups.values()) {
    const isSym = file === SYMBOL_LIB;
    const det = document.createElement('details'); det.open = !isSym || symbolsOpen || !!q;
    if (isSym) { det.className = 'symgroup'; det.addEventListener('toggle', () => { if (q) return; symbolsOpen = det.open; try { localStorage.setItem('stl.symbolsOpen', det.open ? '1' : '0'); } catch { /* ignore */ } }); }
    const sum = document.createElement('summary');
    const name = isSym ? g : g.replace(lib.contents.split(' ').slice(0, 2).join(' '), '').replace(/^[\s:–-]+/, '') || g;
    sum.innerHTML = `${esc(name)} <span class="n">(${list.length})</span>`;
    const grid = document.createElement('div'); grid.className = 'pgrid';
    for (const d of list) {
      const b = document.createElement('button');
      b.className = 'pitem'; b.title = `${d.desc}${d.partno ? ' — ' + d.partno : ''}\n${tr('part.tip')}`;
      b.draggable = true;
      b.append(thumb(d));
      b.insertAdjacentHTML('beforeend', `<span class="pd">${esc(d.desc)}</span><span class="pn">${esc(d.partno || '')}</span>`);
      b.addEventListener('click', () => { setTool('select'); placePart(file, d.title); });
      b.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/x-stl-part', JSON.stringify({ lib: file, title: d.title })); ev.dataTransfer.effectAllowed = 'copy'; });
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
  // a buffer stop at an open end closes it
  for (const b of S.parts) {
    if (def(b)?.sym !== 'buffer-stop') continue;
    for (const e of all) {
      if (!conn.has(endKey(e.pid, e.i)) && Math.hypot(b.x - e.x, b.y - e.y) < 0.15 && angDiff(e.a, b.rot + 90) < 30) conn.set(endKey(e.pid, e.i), { pid: b.id, i: -1, x: b.x, y: b.y, a: norm(b.rot - 90) });
    }
  }
  S.conn = conn; S.allEnds = all;
  if (S.active && (!byId(S.active.pid) || conn.has(endKey(S.active.pid, S.active.i)))) S.active = null;
  if (S.gapEnd && (!S.active || !byId(S.gapEnd.pid) || conn.has(endKey(S.gapEnd.pid, S.gapEnd.i)))) S.gapEnd = null;
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
  $('#stZoom').textContent = tr('zoom', { p: Math.round((z / 12) * 100) });
  if (z !== lastZ) { lastZ = z; renderShapes(); }
  renderOverlay(); renderUI();
}

function setPose(g, p) { g.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${-p.rot})`); }

function buildPartEl(p) {
  const g = el('g', { class: 'part', 'data-id': p.id });
  const d = def(p);
  if (d?.sym) {
    g.classList.add('symbol'); g.append(...symbolEls(d));
  } else if (!d) {
    g.classList.add('missing');
    g.append(el('path', { class: 'hit', d: 'M-1 -1H1V1H-1Z' }), el('path', { class: 'outline', d: 'M-1 -1H1V1H-1Z' }));
  } else {
    const P = partPaths(d);
    g.append(el('path', { class: 'hit', d: (P.center + P.outline) || 'M0 0' }));
    for (const [cls, dd] of [['fill', P.fill], ['outline', P.outline], ['ties', P.ties], ['rails', P.rails]]) if (dd) g.append(el('path', { class: cls, d: dd }));
  }
  setPose(g, p);
  layerClasses(g, p);
  return g;
}
function layerClasses(g, it) { g.classList.toggle('lhidden', !isVisible(it)); g.classList.toggle('llocked', isVisible(it) && !isEditable(it)); }

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

function buildShapeEl(s, z = S.view.z) {
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
  if (s.id > 0) layerClasses(g, s);
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
  const hidden = new Set(S.parts.filter((p) => !isVisible(p)).map((p) => p.id));
  for (const e of S.allEnds) {
    if (S.conn.has(endKey(e.pid, e.i)) || hidden.has(e.pid)) continue;
    const isActive = S.active && S.active.pid === e.pid && S.active.i === e.i;
    const isGap = S.gapEnd && S.gapEnd.pid === e.pid && S.gapEnd.i === e.i;
    const g = el('g', { class: 'end' + (isActive ? ' active' : '') + (isGap ? ' target' : ''), 'data-pid': e.pid, 'data-i': e.i });
    const dx = Math.sin(rad(e.a)), dy = Math.cos(rad(e.a));
    g.append(el('line', { x1: e.x, y1: e.y, x2: e.x + dx * len, y2: e.y + dy * len }));
    if (isActive) g.append(el('circle', { class: 'ring', cx: e.x, cy: e.y, r: r * 2.4 }));
    g.append(el('circle', { cx: e.x, cy: e.y, r: isActive ? r * 1.4 : r }));
    overlay.append(g);
  }
  const ga = S.gapEnd && S.allEnds.find((e) => e.pid === S.active?.pid && e.i === S.active.i), gb = ga && S.allEnds.find((e) => e.pid === S.gapEnd.pid && e.i === S.gapEnd.i);
  if (ga && gb) { // the gap to fill: dashed line with its length
    overlay.prepend(el('line', { class: 'gapline', x1: ga.x, y1: ga.y, x2: gb.x, y2: gb.y }));
    let th = deg(Math.atan2(gb.y - ga.y, gb.x - ga.x)); if (th > 90) th -= 180; if (th <= -90) th += 180;
    const t = el('text', { class: 'label gaplabel', transform: `translate(${(ga.x + gb.x) / 2} ${(ga.y + gb.y) / 2}) scale(${1 / z} ${-1 / z}) rotate(${-th}) translate(0 -10)` });
    t.textContent = `${(Math.round(Math.hypot(gb.x - ga.x, gb.y - ga.y) * MM * 10) / 10).toLocaleString(currentLang())} mm`; overlay.append(t);
  }
  if (S.snap) overlay.append(el('circle', { class: 'snapring', cx: S.snap.x, cy: S.snap.y, r: 10 / z }));
  if (S.labels) {
    for (const p of S.parts) {
      const d = def(p); if (!d || !d.partno || hidden.has(p.id)) continue;
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
  const tt = el('title'); tt.textContent = tr('rot.handle'); rot.append(tt);
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
  $('#stCounts').textContent = tr('counts', { n: S.parts.length, o: open }) + (S.shapes.length ? tr('counts.drawings', { n: S.shapes.length }) : '') + (S.sel.size ? tr('counts.sel', { n: S.sel.size }) : '');
  $('#emptyHint').hidden = S.parts.length + S.shapes.length > 0 || S.tool !== 'select';
  $('#btnUndo').disabled = !S.undo.length; $('#btnRedo').disabled = !S.redo.length;
  const one = (S.sel.size === 1 && S.lastPlace && S.sel.has(S.lastPlace.pid)) || !!selectedSymbol();
  $('#btnFlip').disabled = !one;
  $('#btnGap').disabled = !S.active;
  $('#btnDelete').disabled = $('#btnRotL').disabled = $('#btnRotR').disabled = !S.sel.size;
  let hint = '';
  if (S.tool !== 'select') hint = tr('th.' + S.tool) + (S.typed ? '  ·  ' + tr('hint.typed', { t: S.typed }) : '');
  else if (S.sel.size === 1) {
    const it = itemById([...S.sel][0]);
    if (it?.pts) hint = shapeInfo(it);
    else { const d = it && def(it); if (d) hint = `${d.desc}${d.partno ? ' · ' + d.partno : ''} · ${d.mfr} · ${f3(it.rot)}°`; }
    if (it && S.layers.length > 1) hint += ' · ' + tr('layer.info', { name: layerOf(it).name });
  } else if (S.gapEnd) hint = tr('gap.hint');
  else if (!S.active && S.parts.length) hint = tr('hint.pickEnd');
  $('#stHint').textContent = hint;
  document.title = `${S.dirty ? '• ' : ''}${$('#layoutName').value || tr('untitled')} — SmardTrackLayout`;
  renderProps();
  renderLayers();
  scheduleAutosave();
}

function shapeInfo(s) {
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (s.type === 'line') return tr('info.line', { l: mm(len(...s.pts)) });
  if (s.type === 'dim') return tr('info.dim', { l: mm(len(...s.pts)) });
  if (s.type === 'circle') return tr('info.circle', { r: mm(len(...s.pts)) });
  if (s.type === 'text') return tr('info.text', { t: s.text, s: mm(s.size) });
  if (isRect(s)) { const [w, h] = rectSize(s); return tr('info.rect', { w: mm(w), h: mm(h) }); }
  const b = shapeBBox(s);
  let per = 0; for (let i = 1; i < s.pts.length; i++) per += len(s.pts[i - 1], s.pts[i]);
  if (s.closed) per += len(s.pts.at(-1), s.pts[0]);
  return tr('info.poly', { kind: tr(s.closed ? 'shape.outline' : 'shape.poly'), n: s.pts.length, w: mm(b.x1 - b.x0), h: mm(b.y1 - b.y0), p: mm(per) });
}

const refresh = () => { computeConnections(); renderSelection(); renderOverlay(); renderUI(); updateStatus(); };

// ---------------------------------------------------------------- history
const snapshot = () => JSON.stringify({ parts: S.parts, shapes: S.shapes, nextId: S.nextId, layers: S.layers, curLayer: S.curLayer });
function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 200) S.undo.shift(); S.redo = []; S.dirty = true; }
function restore(snap) {
  const o = JSON.parse(snap); S.parts = o.parts; S.shapes = o.shapes || []; S.nextId = o.nextId;
  if (o.layers) { // keep what is currently shown / locked: that is view state, not part of the history
    const now = new Map(S.layers.map((l) => [l.id, l]));
    S.layers = o.layers.map((l) => (now.has(l.id) ? { ...l, visible: now.get(l.id).visible, locked: now.get(l.id).locked } : l));
    S.curLayer = o.curLayer;
  }
  fixLayers(); pruneForLayers();
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

// symbols: the nearest point on the centre line of a visible track piece within tol (inches),
// with the track direction there as a part rotation
function trackSnap(x, y, tol, exclude) {
  let best = null;
  for (const p of S.parts) {
    if (p.id === exclude || !isVisible(p)) continue;
    const d = def(p); if (!d?.track.length) continue;
    const b = partBBox(p);
    if (x < b.x0 - tol || x > b.x1 + tol || y < b.y0 - tol || y > b.y1 + tol) continue;
    for (const pl of d.track) {
      const w = pl.map(([px, py]) => toWorld(p, px, py));
      for (let i = 1; i < w.length; i++) {
        const [ax, ay] = w[i - 1], dx = w[i][0] - ax, dy = w[i][1] - ay, L2 = dx * dx + dy * dy;
        if (!L2) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
        const qx = ax + dx * t, qy = ay + dy * t, dist = Math.hypot(x - qx, y - qy);
        if (dist < tol && (!best || dist < best.dist)) best = { dist, x: qx, y: qy, rot: norm(-deg(Math.atan2(dy, dx))) };
      }
    }
  }
  return best;
}
// put a symbol on the track point h, along the track, keeping the side it was facing
function poseOnTrack(p, h) {
  p.x = h.x; p.y = h.y;
  p.rot = angDiff(h.rot, p.rot) <= 90 ? h.rot : norm(h.rot + 180);
}

function placeSymbol(libFile, d, at) {
  pushUndo();
  const p = { id: S.nextId++, lib: libFile, title: d.title, x: 0, y: 0, rot: 0, layer: S.curLayer };
  const anchor = !at && S.active && S.allEnds.find((e) => e.pid === S.active.pid && e.i === S.active.i);
  const [cx, cy] = at || screenCenterWorld();
  const h = anchor ? null : trackSnap(cx, cy, (at ? SNAP_PX : 80) / S.view.z);
  if (anchor) { p.x = anchor.x; p.y = anchor.y; p.rot = norm(anchor.a - 90); } // at the open end, pointing outwards
  else if (h) poseOnTrack(p, h);
  else { const b = d.bbox; p.x = cx - (b.x0 + b.x1) / 2; p.y = cy - (b.y0 + b.y1) / 2; }
  S.parts.push(p);
  const g = buildPartEl(p); S.els.set(p.id, g); partsLayer.append(g);
  S.sel = new Set([p.id]); S.lastPlace = null; // the active open end stays where it is
  refresh();
}

async function placePart(libFile, title, at = null) {
  const lib = await loadLib(libFile);
  const d = lib.byTitle.get(title); if (!d) return;
  if (d.sym) { placeSymbol(libFile, d, at); return; }
  pushUndo();
  const p = { id: S.nextId++, lib: libFile, title, x: 0, y: 0, rot: 0, layer: S.curLayer };
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

const selectedSymbol = () => { if (S.sel.size !== 1) return null; const p = byId([...S.sel][0]); return p && def(p)?.sym ? p : null; };

function flipLast() {
  const sp = selectedSymbol();
  if (sp) { pushUndo(); sp.rot = norm(sp.rot + 180); setPose(S.els.get(sp.id), sp); refresh(); return; } // other side of the track
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
    if (!isMoving && !isVisible(p)) continue;
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
  const hiddenParts = new Set(S.parts.filter((p) => !isVisible(p)).map((p) => p.id));
  for (const s of S.shapes) {
    if (s.id === exclude || !isVisible(s)) continue;
    if (s.type === 'dim') s.pts.forEach(([x, y]) => consider(x, y));
    else if (s.type !== 'text') s.pts.forEach(([x, y]) => consider(x, y));
  }
  for (const e of S.allEnds) if (!hiddenParts.has(e.pid)) consider(e.x, e.y);
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
  s.id = S.nextId++; s.layer ??= S.curLayer; S.shapes.push(s); return s;
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
    const m = raw.match(/^([\d.]+)\s*[x*×]\s*([\d.]+)$/); if (!m) { toast(tr('typedRect')); return true; }
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
    num('w', tr(straight ? 'p.sizeX' : 'p.width'), mm(w), 'mm', (v) => setRectSize(s, 0, v / MM), 1);
    num('h', tr(straight ? 'p.sizeY' : 'p.height'), mm(h), 'mm', (v) => setRectSize(s, 1, v / MM), 1);
    num('a', tr('p.angle'), r2(segAng(s.pts[0], s.pts[1])), '°', (v) => rotateShapeTo(s, segAng(s.pts[0], s.pts[1]), v));
    xy();
  } else if (s.type === 'line') {
    num('l', tr('p.length'), mm(segLen(...s.pts)), 'mm', (v) => setSegLen(s.pts, 0, 1, v / MM), 1);
    num('a', tr('p.angle'), r2(segAng(...s.pts)), '°', (v) => { const L = segLen(...s.pts); s.pts[1] = [s.pts[0][0] + Math.cos(rad(v)) * L, s.pts[0][1] + Math.sin(rad(v)) * L]; });
    xy(tr('p.xStart'), tr('p.yStart'));
  } else if (s.type === 'circle') {
    num('r', tr('p.radius'), mm(segLen(...s.pts)), 'mm', (v) => setSegLen(s.pts, 0, 1, v / MM), 1);
    num('d', tr('p.diameter'), mm(2 * segLen(...s.pts)), 'mm', (v) => setSegLen(s.pts, 0, 1, v / MM / 2), 1);
    xy(tr('p.xCentre'), tr('p.yCentre'));
  } else if (s.type === 'dim') {
    num('l', tr('p.length'), mm(segLen(...s.pts)), 'mm', (v) => setDimLength(s, v / MM), 1);
    num('o', tr('p.offset'), mm(Math.abs(s.off || 0)), 'mm', (v) => { s.off = (Math.sign(s.off || -1)) * v / MM; }, 0);
  } else if (s.type === 'text') {
    F.push({ key: 't', label: tr('p.text'), val: s.text, text: true, set: (v) => { if (String(v).trim()) s.text = String(v).trim(); } });
    num('s', tr('p.height'), mm(s.size), 'mm', (v) => { s.size = v / MM; }, 1);
    num('a', tr('p.angle'), r2(s.angle || 0), '°', (v) => { s.angle = norm(v); });
    xy();
  } else if (s.type === 'poly') {
    const n = s.pts.length, edges = s.closed ? n : n - 1;
    for (let i = 0; i < Math.min(edges, 16); i++) {
      const j = (i + 1) % n;
      num('s' + i, tr('p.side', { n: i + 1 }), mm(segLen(s.pts[i], s.pts[j])), 'mm', (v) => {
        const before = [...s.pts[j]]; setSegLen(s.pts, i, j, v / MM);
        if (!s.closed) for (let k = j + 1; k < n; k++) s.pts[k] = [s.pts[k][0] + s.pts[j][0] - before[0], s.pts[k][1] + s.pts[j][1] - before[1]];
      }, 1);
    }
    xy();
  }
  return F;
}

// the rectangle the size panel works on: a single marked rectangle, also when its own dimensions are marked with it
function panelRect() {
  if (S.tool !== 'select' || !S.sel.size) return null;
  const items = selectedItems(), rects = items.filter(isRect);
  if (rects.length !== 1) return null;
  const r = rects[0];
  return items.every((it) => it === r || (it.type === 'dim' && it.ref?.shape === r.id)) ? r : null;
}
function renderProps() {
  const s = panelRect();
  if (s && !isRect(s)) { propsEl.hidden = true; propsKey = ''; return; }
  if (!s) { propsEl.hidden = true; propsKey = ''; return; }
  const fields = propFields(s);
  const key = s.id + ':' + fields.map((f) => f.key).join(',');
  if (key !== propsKey) {
    propsKey = key;
    const title = tr(isRect(s) ? 'shape.rect' : s.type === 'poly' && s.closed ? 'shape.outline' : s.type === 'dim' && s.ref ? 'shape.dimLinked' : 'shape.' + s.type);
    propsEl.innerHTML = `<div class="ptitle">${title}</div>` + fields.map((f) =>
      `<label><span>${f.label}</span><input data-k="${f.key}" ${f.text ? 'class="ptext"' : 'inputmode="decimal"'} spellcheck="false" autocomplete="off"><em>${f.unit || ''}</em></label>`).join('') +
      `<div class="phint">${s.type === 'dim' && s.ref ? tr('p.dimHint') : ''}${tr('p.hint')}</div>`;
    for (const inp of propsEl.querySelectorAll('input')) inp.addEventListener('change', () => applyProp(inp.dataset.k, inp.value));
  }
  for (const f of fields) { const inp = propsEl.querySelector(`input[data-k="${f.key}"]`); if (inp && inp !== document.activeElement) inp.value = f.val; }
  propsEl.hidden = false;
}

function applyProp(k, raw) {
  const s = panelRect(); if (!s) return;
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
  if (!endEl && !itemEl && !ev.shiftKey) return startPan(ev);
  if (endEl) {
    const r = { pid: +endEl.dataset.pid, i: +endEl.dataset.i };
    // Shift+click: the second end of a gap to fill with straight track
    if (ev.shiftKey && S.active && !(S.active.pid === r.pid && S.active.i === r.i)) S.gapEnd = S.gapEnd?.pid === r.pid && S.gapEnd.i === r.i ? null : r;
    else { S.active = r; if (S.gapEnd?.pid === r.pid && S.gapEnd.i === r.i) S.gapEnd = null; }
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
  // Shift + drag on empty space: mark an area (Shift+Ctrl/Cmd adds to the current marking)
  S.drag = { mode: 'box', sx: ev.clientX, sy: ev.clientY, wx, wy, add: ev.ctrlKey || ev.metaKey, hits: new Set() };
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
  for (const it of editableItems()) {
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
  $('#stCoords').textContent = tr('coords', { x: mm(wx), y: mm(wy) });
  S.mouse = { sx: ev.clientX, sy: ev.clientY, wx, wy, inside: true };
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
    else if (!ev.altKey && D.ids.size === 1 && selectedSymbol()) { // a symbol snaps onto the track centre line
      const p = selectedSymbol(), h = trackSnap(p.x, p.y, SNAP_PX / S.view.z, p.id);
      if (h) { poseOnTrack(p, h); S.snap = { x: h.x, y: h.y }; }
    }
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
  // a click (no drag) on empty space unmarks
  if (D.mode === 'pan' && !D.moved && ev.type === 'pointerup' && ev.button === 0 && S.tool === 'select') { S.sel.clear(); S.lastPlace = null; renderSelection(); renderUI(); updateStatus(); }
  if (['move', 'rotate', 'vertex', 'off', 'redge', 'rcorner'].includes(D.mode)) { S.snap = null; normalizeRects(); renderShapes(); refresh(); }
  if (D.mode === 'box') {
    showBox(false); clearPresel();
    if (ev.type !== 'pointerup') return;
    if (!D.moved) { /* Shift-click on empty space: keep the marking */ }
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
  S.sel = new Set([...connectedGroup(id)].filter((pid) => isEditable(byId(pid)))); renderSelection(); renderUI(); updateStatus();
});

// zoom by factor k keeping the screen point (sx, sy) fixed
function zoomAt(sx, sy, k) {
  const z0 = S.view.z, z = Math.min(400, Math.max(0.6, z0 * k));
  S.view.tx = sx - (sx - S.view.tx) * (z / z0); S.view.ty = sy - (sy - S.view.ty) * (z / z0); S.view.z = z;
  applyView();
}
function zoomCenter(k) { const r = svg.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, k); }

// Mouse wheel zooms. Trackpad: two-finger swipe pans, pinch zooms (Chrome sends pinch as ctrl+wheel).
let trackpadUntil = 0;
svg.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = svg.getBoundingClientRect(), sx = ev.clientX - r.left, sy = ev.clientY - r.top;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return zoomAt(sx, sy, Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0025)));
  const now = performance.now();
  const mouseNotch = ev.deltaX === 0 && ev.wheelDeltaY && ev.wheelDeltaY % 120 === 0; // classic wheel steps
  const trackpad = ev.deltaX !== 0 || now < trackpadUntil || (!mouseNotch &&
    (ev.wheelDeltaY !== undefined ? (ev.wheelDeltaY === -3 * ev.deltaY || Math.abs(ev.wheelDeltaY) < 60) : ev.deltaMode === 0 && !Number.isInteger(ev.deltaY)));
  if (trackpad) {
    trackpadUntil = now + 250;  // keep treating the rest of this swipe as panning
    S.view.tx -= ev.deltaX; S.view.ty -= ev.deltaY; applyView();
    return;
  }
  zoomAt(sx, sy, Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.0015)));
}, { passive: false });

// Safari / macOS app: pinch arrives as gesture events
let gestureScale = 1;
const gesturePoint = (ev) => { const r = svg.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
document.addEventListener('gesturestart', (ev) => { ev.preventDefault(); gestureScale = 1; });
document.addEventListener('gesturechange', (ev) => { ev.preventDefault(); const [x, y] = gesturePoint(ev); zoomAt(x, y, ev.scale / gestureScale); gestureScale = ev.scale; });
document.addEventListener('gestureend', (ev) => ev.preventDefault());

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
  const all = [...S.parts, ...S.shapes], vis = all.filter(isVisible);
  const b = unionBBox(vis.length ? vis : all);
  if (!b) { S.view = { tx: r.width / 2, ty: r.height / 2, z: 12 }; applyView(); return; }
  const z = Math.min(200, Math.max(0.6, Math.min(r.width / (b.x1 - b.x0 + 6), r.height / (b.y1 - b.y0 + 6))));
  S.view = { z, tx: r.width / 2 - z * (b.x0 + b.x1) / 2, ty: r.height / 2 + z * (b.y0 + b.y1) / 2 };
  applyView();
}

// ---------------------------------------------------------------- clipboard (copy / cut / paste / duplicate)
// Kept in memory and in localStorage, so it also works between tabs/windows of the editor.
let pasteCount = 0, copyMouse = null;
svg.addEventListener('pointerleave', () => { if (S.mouse) S.mouse.inside = false; });

function clipData(items) {
  const ids = new Set(items.map((it) => it.id));
  for (const d of S.shapes) if (d.ref && ids.has(d.ref.shape)) ids.add(d.id); // linked dimensions come along
  return {
    format: 'smardtracklayout-clipboard', version: 1,
    parts: S.parts.filter((p) => ids.has(p.id)).map(({ id, lib, title, x, y, rot, layer }) => ({ id, lib, title, x, y, rot, layer })),
    shapes: clone(S.shapes.filter((x) => ids.has(x.id))),
  };
}
function copySelection({ quiet = false } = {}) {
  const items = selectedItems(); if (!items.length) return false;
  const data = clipData(items), text = JSON.stringify(data);
  S.clip = text;
  try { localStorage.setItem('stl.clip', text); } catch { /* ignore */ }
  pasteCount = 0; copyMouse = S.mouse ? { ...S.mouse } : null;
  if (!quiet) toast(tr('copied', { n: data.parts.length + data.shapes.length }));
  return true;
}
function cutSelection() { if (copySelection({ quiet: true })) { const n = S.sel.size; deleteSelection(); toast(tr('cut', { n })); return true; } return false; }
function readClip() {
  let text = null;
  try { text = localStorage.getItem('stl.clip'); } catch { /* ignore */ }
  text = text || S.clip;
  try { const d = JSON.parse(text); return d?.format === 'smardtracklayout-clipboard' ? d : null; } catch { return null; }
}
const hasClip = () => !!readClip();

async function pasteClip({ atCursor = true, data = readClip() } = {}) {
  if (!data) return false;
  await Promise.all([...new Set(data.parts.map((p) => p.lib))].map((f) => loadLib(f).catch(() => null)));
  pushUndo();
  const idMap = new Map(), added = [];
  for (const p of data.parts) { const n = { id: S.nextId++, lib: p.lib, title: p.title, x: p.x, y: p.y, rot: p.rot, layer: S.curLayer }; idMap.set(p.id, n.id); S.parts.push(n); added.push(n); }
  for (const sh of data.shapes) { const n = { ...clone(sh), id: S.nextId++, layer: S.curLayer }; idMap.set(sh.id, n.id); S.shapes.push(n); added.push(n); }
  for (const n of added) if (n.ref) { const id = idMap.get(n.ref.shape); if (id) n.ref = { ...n.ref, shape: id }; else delete n.ref; }
  // where: at the mouse pointer if it moved since copying, otherwise a little offset (cascading)
  const b = unionBBox(added), cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  const moved = S.mouse?.inside && (!copyMouse || Math.hypot(S.mouse.sx - copyMouse.sx, S.mouse.sy - copyMouse.sy) > 30);
  let dx, dy;
  if (atCursor && moved) { const g = S.grid > 0 ? S.grid / MM : 0; dx = S.mouse.wx - cx; dy = S.mouse.wy - cy; if (g) { dx = Math.round(dx / g) * g; dy = Math.round(dy / g) * g; } }
  else { pasteCount++; dx = (20 / MM) * pasteCount; dy = (-20 / MM) * pasteCount; }
  for (const it of added) translateItem(it, dx, dy);
  if (atCursor && moved) { copyMouse = { ...S.mouse }; pasteCount = 0; }
  setTool('select');
  S.sel = new Set(added.map((it) => it.id)); S.lastPlace = null;
  renderAll();
  return true;
}
function duplicateSelection() {
  const items = selectedItems(); if (!items.length) return false;
  pasteClip({ atCursor: false, data: JSON.parse(JSON.stringify(clipData(items))) });
  return true;
}

// menu commands (macOS app Edit menu, browser Edit menu) arrive as DOM clipboard events
const editingText = () => document.activeElement?.matches?.('input, textarea, [contenteditable]');
document.addEventListener('copy', (ev) => { if (!editingText() && copySelection()) ev.preventDefault(); });
document.addEventListener('cut', (ev) => { if (!editingText() && cutSelection()) ev.preventDefault(); });
document.addEventListener('paste', (ev) => {
  if (editingText()) return;
  let data = null;
  try { const d = JSON.parse(ev.clipboardData?.getData('text/plain') || ''); if (d?.format === 'smardtracklayout-clipboard') data = d; } catch { /* not ours */ }
  if (data || hasClip()) { ev.preventDefault(); pasteClip(data ? { data } : {}); }
});

// ---------------------------------------------------------------- keyboard
const TOOL_KEYS = { v: 'select', l: 'line', p: 'poly', b: 'rect', o: 'circle', d: 'dim', t: 'text' };
document.addEventListener('keydown', (ev) => {
  if (!(ev.target instanceof Element)) Object.defineProperty(ev, 'target', { value: document.body });
  if (ev.target.closest('#props') && ev.key === 'Escape') { ev.target.blur(); return; }
  // in the properties panel, Ctrl+Z / Ctrl+Y undo the applied value rather than editing the text field
  const propsUndo = ev.target.closest('#props') && (ev.ctrlKey || ev.metaKey) && 'zy'.includes(ev.key.toLowerCase());
  if (propsUndo) { ev.target.blur(); propsKey = ''; }
  if (!propsUndo && ev.target.closest('input, select, textarea, dialog') && ev.key !== 'Escape') {
    if (!((ev.ctrlKey || ev.metaKey) && 'sop'.includes(ev.key.toLowerCase()))) return;
  }
  if (document.querySelector('dialog[open]')) return;
  const k = ev.key.toLowerCase(), mod = ev.ctrlKey || ev.metaKey;
  if (S.drag?.mode === 'box' && k === 'escape') { cancelBox(); return; }
  if (mod && k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { ev.preventDefault(); redo(); return; }
  if (mod && k === 's') { ev.preventDefault(); ev.shiftKey ? saveAs() : save(); return; }
  if (mod && k === 'o') { ev.preventDefault(); openFile(); return; }
  if (mod && k === 'p' && !ev.shiftKey) { ev.preventDefault(); openPrint(); return; }
  if (mod && k === ',') { ev.preventDefault(); openSettings(); return; }
  if (!mod && k === 'enter' && S.tool === 'select') {
    const f = $('#props:not([hidden]) input'); if (f) { ev.preventDefault(); f.focus(); f.select(); return; }
  }
  if (mod && !ev.shiftKey && !ev.altKey) {
    if (k === 'c' && copySelection()) { ev.preventDefault(); return; }
    if (k === 'x' && cutSelection()) { ev.preventDefault(); return; }
    if (k === 'v' && hasClip()) { ev.preventDefault(); pasteClip(); return; }
    if (k === 'd') { ev.preventDefault(); duplicateSelection(); return; }
  }
  if (mod && k === 'a') { ev.preventDefault(); setTool('select'); S.sel = new Set(editableItems().map((it) => it.id)); renderSelection(); renderUI(); updateStatus(); return; }
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
    if (S.gapEnd) { S.gapEnd = null; renderOverlay(); updateStatus(); return; }
    S.sel.clear(); S.active = null; S.lastPlace = null; ev.target.blur?.(); clearPresel(); showBox(false); renderSelection(); renderOverlay(); renderUI(); updateStatus(); return;
  }
  if (TOOL_KEYS[k] && !ev.shiftKey) { setTool(TOOL_KEYS[k]); return; }
  if (k === 'delete' || k === 'backspace') { ev.preventDefault(); deleteSelection(); }
  else if (k === 'r') rotateSelection(ev.shiftKey ? -step() : step());
  else if (k === 'tab') { ev.preventDefault(); flipLast(); }
  else if (k === 'g') fillGap();
  else if (k === 'f') fitView();
  else if (k === '+' || k === '=') zoomCenter(1.25);
  else if (k === '-') zoomCenter(0.8);
});
document.addEventListener('keyup', (ev) => { if (ev.key === ' ') S.space = false; });
const step = () => { const v = parseFloat(String($('#rotStep').value).replace(',', '.')); return v > 0 ? v : 15; };


// ---------------------------------------------------------------- layers pane
const ICON = {
  eye: '<svg viewBox="0 0 20 20"><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6S1.5 10 1.5 10z"/><circle cx="10" cy="10" r="2.6"/></svg>',
  eyeOff: '<svg viewBox="0 0 20 20"><path d="M1.5 10S5 4 10 4s8.5 6 8.5 6-3.5 6-8.5 6S1.5 10 1.5 10z" opacity=".35"/><path d="M3 17L17 3"/></svg>',
  lock: '<svg viewBox="0 0 20 20"><rect x="4" y="9" width="12" height="8.5" rx="1.5"/><path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9"/></svg>',
  unlock: '<svg viewBox="0 0 20 20" opacity=".45"><rect x="4" y="9" width="12" height="8.5" rx="1.5"/><path d="M6.5 9V6.5a3.5 3.5 0 0 1 6.8-1.2"/></svg>',
  here: '<svg viewBox="0 0 20 20"><path d="M3 10h10M9 6l4 4-4 4M16 4v12"/></svg>',
  pen: '<svg viewBox="0 0 20 20"><path d="M3 17l1-4L13.5 3.5l3 3L7 16z M11.5 5.5l3 3"/></svg>',
  trash: '<svg viewBox="0 0 20 20"><path d="M3.5 5.5h13M8 5.5V3.5h4v2M5.5 5.5l1 11h7l1-11"/></svg>',
};
const layersPane = $('#layersPane'), layerList = $('#layerList');
let layersKey = '', renaming = null;

function layerCounts() {
  const n = new Map(S.layers.map((l) => [l.id, 0]));
  for (const it of [...S.parts, ...S.shapes]) n.set(layerOf(it).id, (n.get(layerOf(it).id) || 0) + 1);
  return n;
}
function renderLayers() {
  if (layersPane.hidden || renaming != null) return;
  const counts = layerCounts(), selLayers = new Set(selectedItems().map((it) => layerOf(it).id));
  const key = JSON.stringify([S.layers, S.curLayer, [...counts], [...selLayers], S.sel.size, document.documentElement.lang]);
  if (key === layersKey) return;
  layersKey = key;
  const one = S.layers.length === 1;
  layerList.innerHTML = S.layers.map((l) => {
    const cur = l.id === S.curLayer, fixed = cur ? ` disabled title="${esc(tr('layer.activeFixed'))}"` : '';
    return `<li class="lrow${cur ? ' cur' : ''}${l.visible === false ? ' off' : ''}${selLayers.has(l.id) ? ' hassel' : ''}" data-layer="${l.id}" title="${esc(tr('layer.activate'))}">
      <button type="button" class="licon" data-act="vis"${fixed || ` title="${esc(tr('layer.show'))}"`}>${l.visible === false ? ICON.eyeOff : ICON.eye}</button>
      <button type="button" class="licon" data-act="lock"${fixed || ` title="${esc(tr('layer.lock'))}"`}>${l.locked ? ICON.lock : ICON.unlock}</button>
      <span class="lname">${esc(l.name)}</span>
      <span class="lcount" title="${esc(tr('layer.count', { n: counts.get(l.id) || 0 }))}">${counts.get(l.id) || 0}</span>
      <button type="button" class="licon" data-act="here" title="${esc(tr('layer.moveHere'))}"${S.sel.size ? '' : ' disabled'}>${ICON.here}</button>
      <button type="button" class="licon" data-act="rename" title="${esc(tr('layer.rename'))}">${ICON.pen}</button>
      <button type="button" class="licon" data-act="del" title="${esc(tr('layer.delete'))}"${one ? ' disabled' : ''}>${ICON.trash}</button>
    </li>`;
  }).join('');
}
const layersChanged = () => { layersKey = ''; S.dirty = true; pruneForLayers(); renderAll(); };

function setActiveLayer(id) {
  const l = layerById(id); if (!l || id === S.curLayer) return;
  S.curLayer = id; l.visible = true; l.locked = false;
  layersChanged();
}
function addLayer() {
  pushUndo();
  const id = Math.max(0, ...S.layers.map((l) => l.id)) + 1;
  const names = new Set(S.layers.map((l) => l.name));
  let n = S.layers.length + 1; while (names.has(tr('layer.n', { n }))) n++;
  S.layers.push({ id, name: tr('layer.n', { n }), visible: true, locked: false });
  S.curLayer = id;
  layersChanged();
  startRename(id);
}
function startRename(id) {
  const li = layerList.querySelector(`[data-layer="${id}"]`), l = layerById(id); if (!li || !l) return;
  renaming = id;
  const span = li.querySelector('.lname'), inp = document.createElement('input');
  inp.className = 'lrename'; inp.value = l.name; inp.maxLength = 60; inp.spellcheck = false;
  span.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const finish = (ok) => {
    if (done) return; done = true; renaming = null;
    const v = inp.value.trim();
    if (ok && v && v !== l.name) { pushUndo(); l.name = v; S.dirty = true; }
    layersKey = ''; renderLayers(); updateStatus();
  };
  inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); } });
  inp.addEventListener('blur', () => finish(true));
}
function deleteLayer(id) {
  if (S.layers.length < 2) return;
  const l = layerById(id), target = layerById(id !== S.curLayer ? S.curLayer : S.layers.find((x) => x.id !== id).id);
  const n = layerCounts().get(id) || 0;
  if (n && !confirm(tr('layer.confirmDelete', { name: l.name, n, target: target.name }))) return;
  pushUndo();
  for (const it of [...S.parts, ...S.shapes]) if (it.layer === id) it.layer = target.id;
  S.layers = S.layers.filter((x) => x.id !== id);
  if (S.curLayer === id) S.curLayer = target.id;
  fixLayers(); layersChanged();
}
function moveSelectionToLayer(id) {
  const l = layerById(id), items = selectedItems(); if (!l || !items.length) return;
  const ids = new Set(items.map((it) => it.id));
  for (const d of S.shapes) if (d.ref && ids.has(d.ref.shape)) ids.add(d.id); // linked dimensions go along
  pushUndo();
  let n = 0;
  for (const it of [...S.parts, ...S.shapes]) if (ids.has(it.id) && it.layer !== id) { it.layer = id; n++; }
  toast(tr('layer.moved', { n, name: l.name }));
  layersChanged();
}
function toggleLayerFlag(id, flag) {
  const l = layerById(id); if (!l || id === S.curLayer) return;
  if (flag === 'visible') l.visible = l.visible === false; else l.locked = !l.locked;
  layersChanged();
}
layerList.addEventListener('click', (ev) => {
  const li = ev.target.closest('[data-layer]'); if (!li || ev.target.closest('input')) return;
  const id = +li.dataset.layer, act = ev.target.closest('[data-act]')?.dataset.act;
  if (act === 'vis') toggleLayerFlag(id, 'visible');
  else if (act === 'lock') toggleLayerFlag(id, 'locked');
  else if (act === 'here') moveSelectionToLayer(id);
  else if (act === 'rename') startRename(id);
  else if (act === 'del') deleteLayer(id);
  else setActiveLayer(id);
});
layerList.addEventListener('dblclick', (ev) => { const li = ev.target.closest('[data-layer]'); if (li && ev.target.closest('.lname')) startRename(+li.dataset.layer); });
$('#layerAdd').onclick = addLayer;

function showLayersPane(on) {
  layersPane.hidden = !on;
  document.body.classList.toggle('with-layers', on);
  $('#btnLayers').classList.toggle('on', on);
  $('#btnLayers').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('stl.layersPane', on ? '1' : '0'); } catch { /* ignore */ }
  layersKey = ''; renderLayers(); applyView();
}
const toggleLayersPane = () => showLayersPane(layersPane.hidden);
$('#btnLayers').onclick = toggleLayersPane;
$('#layersClose').onclick = () => showLayersPane(false);
{ let on = true; try { on = localStorage.getItem('stl.layersPane') !== '0'; } catch { /* ignore */ } layersPane.hidden = !on; document.body.classList.toggle('with-layers', on); $('#btnLayers').classList.toggle('on', on); }

// ---------------------------------------------------------------- persistence
const native = window.webkit?.messageHandlers?.stl; // running inside the macOS app?
const layoutName = () => $('#layoutName').value.trim() || tr('untitled');

function layoutDoc() {
  const r = (v) => +v.toFixed(5);
  return {
    format: 'smardtracklayout', version: 4, name: layoutName(), units: 'inch',
    libraries: [...new Set(S.parts.map((p) => p.lib))],
    layers: S.layers.map(({ id, name, visible, locked }) => ({ id, name, visible: visible !== false, locked: !!locked })),
    activeLayer: S.curLayer,
    parts: S.parts.map(({ lib, title, x, y, rot, layer }) => ({ lib, title, x: r(x), y: r(y), rot: +rot.toFixed(4), layer })),
    shapes: S.shapes.map(({ pts, ...rest }) => ({ ...rest, pts: pts.map(([x, y]) => [r(x), r(y)]) })),
  };
}

async function loadDoc(doc, { keepView = false } = {}) {
  if (!doc || !Array.isArray(doc.parts)) throw new Error('not a SmardTrackLayout file');
  const libs = [...new Set(doc.parts.map((p) => p.lib))];
  const failed = [];
  await Promise.all(libs.map((f) => loadLib(f).catch(() => failed.push(f))));
  // layers (files before version 4 have none: everything goes onto one layer)
  S.layers = Array.isArray(doc.layers) && doc.layers.length
    ? doc.layers.filter((l) => l && Number.isFinite(+l.id)).map((l) => ({ id: +l.id, name: String(l.name || '').slice(0, 60) || tr('layer.n', { n: +l.id }), visible: l.visible !== false, locked: !!l.locked }))
    : [];
  if (!S.layers.length) S.layers = [{ id: 1, name: tr('layer.n', { n: 1 }), visible: true, locked: false }];
  S.curLayer = +doc.activeLayer || S.layers[0].id;
  S.parts = doc.parts.map((p, i) => ({ id: i + 1, lib: p.lib, title: p.title, x: +p.x || 0, y: +p.y || 0, rot: +p.rot || 0, layer: +p.layer || S.layers[0].id }));
  S.nextId = S.parts.length + 1;
  S.shapes = [];
  const idMap = new Map();
  for (const s of doc.shapes || []) {
    if (!Array.isArray(s.pts) || !s.pts.length) continue;
    const old = s.id, c = addShape({ ...clone(s), layer: +s.layer || S.layers[0].id });
    if (old != null) idMap.set(old, c.id);
  }
  for (const s of S.shapes) if (s.ref) { const id = idMap.get(s.ref.shape); if (id) s.ref.shape = id; else delete s.ref; }
  fixLayers();
  normalizeRects();
  for (const d of S.shapes) if (d.type === 'dim' && !d.ref) { const ref = findEdgeRef(...d.pts); if (ref) d.ref = ref; } // older files
  S.sel.clear(); S.active = null; S.lastPlace = null; S.undo = []; S.redo = [];
  $('#layoutName').value = doc.name || tr('untitled');
  setTool('select');
  renderAll();
  if (!keepView) fitView();
  const missing = S.parts.filter((p) => !def(p)).length;
  if (failed.length || missing) toast(tr('load.missing', { n: missing }) + (failed.length ? tr('load.libUnavail', { l: failed.join(', ') }) : ''), 5000);
}

let autosaveTimer;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try { localStorage.setItem('stl.autosave', JSON.stringify({ ...layoutDoc(), view: S.view, dirty: S.dirty, hasFile })); } catch { /* ignore */ }
  }, 400);
}

// Files. "Save" writes back to the file the layout came from (macOS app, or Chrome/Edge via the
// File System Access API); "Save as…" picks a new file, whose name becomes the layout name.
const baseName = (f) => String(f).split(/[\\/]/).pop().replace(/\.json$/i, '').replace(/\.stl$/i, '');
const FILE_TYPES = [{ description: 'SmardTrackLayout layout', accept: { 'application/json': ['.json'] } }];
let fileHandle = null;   // browser: handle of the current file (when supported)
let hasFile = false;     // a current file exists (browser handle, file known to the macOS app, or a downloaded name)
// The file link survives reloads/restarts together with the autosave: the browser keeps the handle in
// IndexedDB (Chrome/Edge), the macOS app keeps the path itself.
const fsApi = !native && !!window.showSaveFilePicker;
function setFileHandle(h) {
  fileHandle = h;
  if (fsApi) idb('readwrite', (st) => (h ? st.put(h, 'currentFile') : st.delete('currentFile'))).catch(() => {});
}
async function writable(h) { // after a reload the browser asks once more for permission to write the file
  if (!h.queryPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

function docFor(name) { $('#layoutName').value = name; return JSON.stringify(layoutDoc(), null, 1); }
function savedAs(name) { $('#layoutName').value = name; hasFile = true; S.dirty = false; updateStatus(); toast(tr('saved', { n: name })); }
async function openText(text, name) { // used by the macOS app after its open panel
  await loadDoc(JSON.parse(text)); $('#layoutName').value = name; hasFile = true; S.dirty = false; updateStatus();
}

async function save() {
  if (native) { native.postMessage({ type: 'save', name: layoutName() + '.stl.json' }); return; } // app: same file, or save panel
  if (!fileHandle) {
    // browsers that can only download: once the layout has a name, Save downloads again under it, without asking
    if (!fsApi && hasFile) { const n = layoutName(); download(n + '.stl.json', docFor(n), 'application/json'); savedAs(n); return; }
    return saveAs();
  }
  try {
    if (!(await writable(fileHandle))) return saveAs();
    const w = await fileHandle.createWritable();
    await w.write(docFor(layoutName())); await w.close();
    savedAs(layoutName());
  } catch (e) { if (e.name !== 'AbortError') toast(tr('saveFailed', { e: e.message }), 5000); }
}

async function saveAs() {
  const name = layoutName();
  if (native) { native.postMessage({ type: 'saveAs', name: name + '.stl.json' }); return; } // app shows the save panel, then calls docFor/savedAs
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name + '.stl.json', types: FILE_TYPES, startIn: startIn() });
      const n = baseName(h.name), w = await h.createWritable();
      await w.write(docFor(n)); await w.close();
      setFileHandle(h); savedAs(n);
    } catch (e) { if (e.name !== 'AbortError') toast(tr('saveFailed', { e: e.message }), 5000); }
    return;
  }
  // browsers without a save dialog API: ask for the name, then download
  const dlg = $('#dlgName'), input = $('#saveName');
  input.value = name === tr('untitled') ? '' : name;
  dlg.showModal(); input.focus(); input.select();
  dlg.onclose = () => {
    dlg.onclose = null;
    const n = input.value.trim();
    if (dlg.returnValue !== 'ok' || !n) return;
    download(n + '.stl.json', docFor(n), 'application/json');
    savedAs(n);
  };
}

async function openFile() {
  if (S.dirty && S.parts.length + S.shapes.length && !confirm(tr('confirmDiscard'))) return;
  if (native) { native.postMessage({ type: 'open' }); return; }
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ types: FILE_TYPES, startIn: startIn() });
      const f = await h.getFile();
      await loadDoc(JSON.parse(await f.text()));
      setFileHandle(h); hasFile = true;
      $('#layoutName').value = baseName(f.name); S.dirty = false; updateStatus();
    } catch (e) { if (e.name !== 'AbortError') toast(tr('openFailed', { e: e.message }), 5000); }
    return;
  }
  $('#fileImport').click();
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
    ? `<table class="bom"><thead><tr><th>${tr('bom.pn')}</th><th>${tr('bom.desc')}</th><th class="n">${tr('bom.qty')}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.partno)}</td><td>${esc(r.desc)}</td><td class="n">${r.n}</td></tr>`).join('')}</tbody><tfoot><tr><th></th><th>${tr('bom.total')}</th><th class="n">${S.parts.length}</th></tr></tfoot></table>`
    : `<div class="muted">${tr('bom.empty')}</div>`;
  $('#dlgBom').showModal();
}

function newLayout() {
  if (S.dirty && S.parts.length + S.shapes.length && !confirm(tr('confirmNew'))) return;
  setFileHandle(null); hasFile = false; native?.postMessage({ type: 'new' });
  if (settings.defaultLib !== S.lib && S.libList.includes(settings.defaultLib)) selectLib(settings.defaultLib);
  loadDoc({ name: tr('untitled'), parts: [], shapes: [] }).then(() => { S.dirty = false; updateStatus(); });
}


// ---------------------------------------------------------------- fill a gap with straight track
// Two open ends that face each other on one line (the active end, plus a second one chosen with
// Shift+click, or found automatically) are joined with straight pieces from the library. The lengths
// are combined so that the pieces fill the gap as exactly as possible.
const GAP_TOL = 0.7;     // mm: a combination "fits" within this (the ends then still count as connected)
const GAP_ANGLE = 0.5;   // degrees
const GAP_SEARCH = 40;   // mm: also offer combinations up to this much shorter / longer

const endOf = (r) => r && S.allEnds.find((e) => e.pid === r.pid && e.i === r.i);
const isOpen = (e) => e && !S.conn.has(endKey(e.pid, e.i));

// geometry of the gap between end a and end b: length along a's direction, sideways offset, angle error
function gapGeom(a, b) {
  const u = [Math.sin(rad(a.a)), Math.cos(rad(a.a))], d = [b.x - a.x, b.y - a.y];
  return { len: (d[0] * u[0] + d[1] * u[1]) * MM, off: Math.abs(d[0] * u[1] - d[1] * u[0]) * MM, ang: angDiff(a.a, b.a + 180) };
}
const gapAligned = (g) => g.ang <= GAP_ANGLE && g.off <= GAP_TOL;

// the open end that best faces end a on its line (for Fill gap without a chosen second end)
function facingEnd(a) {
  let best = null;
  for (const e of S.allEnds) {
    if (e.pid === a.pid || !isOpen(e) || !isVisible(byId(e.pid))) continue;
    const g = gapGeom(a, e);
    if (g.len > GAP_TOL && gapAligned(g) && (!best || g.len < best.g.len)) best = { e, g };
  }
  return best?.e || null;
}

// plain straight pieces of a library: two endpoints facing apart, only straight track; one per length.
// Only the library's main group of straights is used (not transition, switching or uncoupling tracks
// filed elsewhere), unless that group is too small.
function straightsOf(lib) {
  const all = (lib?.parts || []).filter((d) => {
    if (d.sym || d.endpoints.length !== 2 || !d.track.length || d.track.some((pl) => pl.length !== 2)) return false;
    return angDiff(d.endpoints[0].a, d.endpoints[1].a + 180) <= 0.01;
  });
  const n = new Map(); for (const d of all) n.set(d.group, (n.get(d.group) || 0) + 1);
  const main = [...n].sort((a, b) => b[1] - a[1])[0];
  const use = main && main[1] >= 2 ? all.filter((d) => d.group === main[0]) : all;
  const byLen = new Map();
  for (const d of use) {
    const [e0, e1] = d.endpoints;
    const len = Math.hypot(e1.x - e0.x, e1.y - e0.y) * MM;
    if (len < 5) continue;
    const k = Math.round(len * 10), cur = byLen.get(k);
    // several pieces of one length (plain, uncoupler, contact track …): take the plainest, i.e. shortest name
    if (!cur || d.desc.length < cur.d.desc.length) byLen.set(k, { d, len });
  }
  return [...byLen.values()].sort((a, b) => b.len - a.len);
}

// combinations of pieces whose total length is near L (mm): fewest pieces per reachable total
function gapOptions(L, pieces) {
  const U = 10, max = Math.round((L + GAP_SEARCH) * U), lens = pieces.map((p) => Math.round(p.len * U));
  const cnt = new Int32Array(max + 1).fill(-1), prev = new Int16Array(max + 1).fill(-1);
  cnt[0] = 0;
  for (let s = 0; s <= max; s++) {
    if (cnt[s] < 0) continue;
    for (let i = 0; i < lens.length; i++) {
      const t = s + lens[i];
      if (t <= max && (cnt[t] < 0 || cnt[s] + 1 < cnt[t])) { cnt[t] = cnt[s] + 1; prev[t] = i; }
    }
  }
  const out = [];
  for (let s = Math.max(1, Math.round((L - GAP_SEARCH) * U)); s <= max; s++) {
    if (cnt[s] <= 0) continue;
    const use = new Array(pieces.length).fill(0);
    for (let t = s; t > 0; t -= lens[prev[t]]) use[prev[t]]++;
    const total = use.reduce((a, n, i) => a + n * pieces[i].len, 0);
    out.push({ use, n: cnt[s], total, err: total - L });
  }
  const fits = out.filter((o) => Math.abs(o.err) <= GAP_TOL).sort((a, b) => a.n - b.n || Math.abs(a.err) - Math.abs(b.err));
  const byErr = (a, b) => Math.abs(a.err) - Math.abs(b.err) || a.n - b.n;
  const near = (sign) => out.filter((o) => Math.sign(o.err) === sign && Math.abs(o.err) > GAP_TOL).sort(byErr);
  // after the fitting ones the closest shorter and longer combinations, closest first
  const rest = [...near(-1).slice(0, fits.length ? 1 : 2), ...near(1).slice(0, fits.length ? 1 : 2)].sort(byErr);
  return [...fits.slice(0, 3), ...rest].slice(0, 5);
}

function fillGap() {
  const a = endOf(S.active);
  if (!isOpen(a)) { toast(tr('gap.pickFirst'), 4000); return; }
  let b = endOf(S.gapEnd);
  if (!isOpen(b)) b = facingEnd(a);
  if (!b) { toast(tr('gap.pickSecond'), 5000); return; }
  const g = gapGeom(a, b);
  if (!gapAligned(g)) { toast(tr('gap.notAligned', { o: g.off.toFixed(1), a: g.ang.toFixed(1) }), 6000); return; }
  if (g.len <= GAP_TOL) { toast(tr('gap.closed')); return; }
  const libFile = byId(a.pid)?.lib || S.lib, lib = S.libs.get(libFile);
  const pieces = straightsOf(lib);
  if (!pieces.length) { toast(tr('gap.noStraights', { l: libFile.replace(/\.xtp$/i, '') }), 5000); return; }
  const opts = gapOptions(g.len, pieces);
  showGapDialog(a, b, g, libFile, pieces, opts);
}

const fmtMM = (v) => (Math.round(v * 10) / 10).toLocaleString(currentLang(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function showGapDialog(a, b, g, libFile, pieces, opts) {
  const dlg = $('#dlgGap');
  $('#gapInfo').textContent = tr('gap.info', { l: fmtMM(g.len) });
  const list = $('#gapList'); list.innerHTML = '';
  if (!opts.length) list.innerHTML = `<p class="muted">${esc(tr('gap.noCombo'))}</p>`;
  opts.forEach((o, k) => {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'gapopt' + (k === 0 ? ' best' : '');
    const parts = o.use.map((n, i) => (n ? `<span class="gp"><b>${esc(pieces[i].d.partno || fmtMM(pieces[i].len) + ' mm')}</b>${n > 1 ? ` × ${n}` : ''} <small>${esc(fmtMM(pieces[i].len))}</small></span>` : '')).join('');
    const fit = Math.abs(o.err) <= GAP_TOL;
    const dev = fit ? tr('gap.fit') : o.err < 0 ? tr('gap.short', { d: fmtMM(-o.err) }) : tr('gap.long', { d: fmtMM(o.err) });
    btn.innerHTML = `<span class="gparts">${parts}</span><span class="gsum">${esc(tr('gap.pieces', { n: o.n }))} · ${esc(fmtMM(o.total))} mm<br><em class="${fit ? 'ok' : 'warn'}">${esc(dev)}</em></span>`;
    btn.onclick = () => { dlg.close(); insertStraights(a, libFile, pieces, o); };
    list.append(btn);
  });
  dlg.showModal();
  list.querySelector('button')?.focus();
}

function insertStraights(a, libFile, pieces, o) {
  pushUndo();
  // longest pieces first, from the active end towards the other one
  const seq = o.use.flatMap((n, i) => Array(n).fill(pieces[i]));
  let anchor = { x: a.x, y: a.y, a: a.a };
  const added = [];
  for (const pc of seq) {
    const p = { id: S.nextId++, lib: libFile, title: pc.d.title, x: 0, y: 0, rot: 0, layer: S.curLayer };
    attach(p, 0, anchor);
    S.parts.push(p); added.push(p);
    const g = buildPartEl(p); S.els.set(p.id, g); partsLayer.append(g);
    anchor = ends(p)[1];
  }
  S.sel = new Set(added.map((p) => p.id)); S.lastPlace = null; S.gapEnd = null;
  computeConnections();
  if (!S.active || !isOpen(endOf(S.active))) { const last = added.at(-1); const e = isOpen(ends(last)[1]) ? { pid: last.id, i: 1 } : null; S.active = e; }
  refresh();
  toast(tr('gap.inserted', { n: added.length }));
}

$('#btnGap').onclick = fillGap;

// ---------------------------------------------------------------- printing
// The layout is drawn into #printArea (only that is visible in print media): either fitted onto one
// page, or at a true scale (1:1 for track templates, 1:10 …) tiled over as many pages as needed, with an
// overview page that shows how the sheets fit together. Hidden layers are not printed.
const PAPERS = { a4: [210, 297], a3: [297, 420], a2: [420, 594], letter: [215.9, 279.4], legal: [215.9, 355.6], tabloid: [279.4, 431.8] };
const PR_MARGIN = 10, PR_HEAD = 9, PR_PAD = 4; // mm on paper: page margin, header height, gap around a fitted drawing
const PR_KEY = 'stl.print';
const printOpts = { paper: /^en-(US|CA)$/i.test(navigator.language || '') ? 'letter' : 'a4', orient: 'auto', scale: 0, labels: false, bom: true };
try { Object.assign(printOpts, JSON.parse(localStorage.getItem(PR_KEY) || '{}')); } catch { /* ignore */ }
if (!PAPERS[printOpts.paper]) printOpts.paper = 'a4';

const printItems = () => [...S.parts, ...S.shapes].filter(isVisible);
const colName = (c) => (c >= 26 ? colName(Math.floor(c / 26) - 1) : '') + String.fromCharCode(65 + (c % 26));

// page geometry for the options: k = paper mm per world mm
function printPlan(o) {
  const b = unionBBox(printItems()); if (!b) return null;
  const wMM = Math.max(1, (b.x1 - b.x0) * MM), hMM = Math.max(1, (b.y1 - b.y0) * MM);
  const [pw, ph] = PAPERS[o.paper] || PAPERS.a4;
  const plan = (land) => {
    const paperW = land ? ph : pw, paperH = land ? pw : ph;
    const W = paperW - 2 * PR_MARGIN, H = paperH - 2 * PR_MARGIN - PR_HEAD - 0.6; // a little slack, so rounding never spills onto an extra sheet
    if (!o.scale) return { land, paperW, paperH, W, H, k: Math.min((W - 2 * PR_PAD) / wMM, (H - 2 * PR_PAD) / hMM), cols: 1, rows: 1 };
    const k = 1 / o.scale;
    return { land, paperW, paperH, W, H, k, cols: Math.max(1, Math.ceil((wMM * k + 2 * PR_PAD) / W)), rows: Math.max(1, Math.ceil((hMM * k + 2 * PR_PAD) / H)) };
  };
  let p;
  if (o.orient !== 'auto') p = plan(o.orient === 'landscape');
  else {
    const P = plan(false), L = plan(true);
    if (!o.scale) p = L.k > P.k * 1.001 ? L : P;
    else { const n = (x) => x.cols * x.rows; p = n(L) < n(P) || (n(L) === n(P) && wMM > hMM) ? L : P; }
  }
  // sheet grid centred on the layout; sheets with nothing on them are left out
  p.b = b; p.sw = p.W / p.k / MM; p.sh = p.H / p.k / MM; // one sheet's drawing area in world inches
  p.left = (b.x0 + b.x1) / 2 - (p.cols * p.sw) / 2; p.top = (b.y0 + b.y1) / 2 + (p.rows * p.sh) / 2;
  const boxes = printItems().map(itemBBox);
  p.sheets = [];
  for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) {
    const x0 = p.left + c * p.sw, x1 = x0 + p.sw, y1 = p.top - r * p.sh, y0 = y1 - p.sh;
    if (p.cols * p.rows === 1 || boxes.some((q) => q.x1 > x0 && q.x0 < x1 && q.y1 > y0 && q.y0 < y1)) p.sheets.push([r, c]);
  }
  p.tiles = p.sheets.length; p.multi = p.cols * p.rows > 1;
  return p;
}

const scaleText = (p, o) => (o.scale ? `1:${o.scale}` : `≈ 1:${(1 / p.k) >= 10 ? Math.round(1 / p.k) : +(1 / p.k).toFixed(1)}`);

// the drawing as one group in world coordinates (y up), rebuilt for the paper's px-per-inch z
function printWorld(z, labels) {
  const g = el('g', { transform: 'scale(1 -1)' }), shapes = el('g'), parts = el('g'), anno = el('g');
  syncDims();
  for (const s of S.shapes) if (isVisible(s)) (s.type === 'dim' || s.type === 'text' ? anno : shapes).append(buildShapeEl(s, z));
  for (const p of S.parts) if (isVisible(p)) parts.append(buildPartEl(p));
  if (labels) {
    for (const p of S.parts) {
      const d = def(p); if (!d?.partno || !isVisible(p)) continue;
      const [x, y] = itemCenter(p);
      const t = el('text', { class: 'label', transform: `translate(${x} ${y}) scale(${1 / z} ${-1 / z})` });
      t.textContent = d.partno; anno.append(t);
    }
  }
  g.append(shapes, parts, anno);
  for (const e of g.querySelectorAll('.hit, .hitfill')) e.remove();
  for (const e of g.querySelectorAll('.sel, .llocked')) e.classList.remove('sel', 'llocked');
  return g;
}

// a scale bar of a round length, 15–50 mm long on paper
function scaleBar(k) {
  const L = [5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5].find((v) => v * k <= 50) || 5;
  const w = L * k, label = L >= 1000 ? `${L / 1000} m` : `${L} mm`;
  return `<span class="prbar"><svg width="${w + 1}mm" height="3mm" viewBox="-0.5 0 ${w + 1} 3"><path d="M0 0.4V2.6M${w} 0.4V2.6M0 1.5H${w}"/><rect x="0" y="1" width="${w / 2}" height="1"/></svg>${label}</span>`;
}

function printPage(p, o, { label, idx, total, body, noScale = false }) {
  const page = document.createElement('section'); page.className = 'prpage';
  page.style.width = `${p.W}mm`;
  const date = new Date().toLocaleDateString(currentLang(), { dateStyle: 'medium' });
  page.innerHTML = `<header class="prhead"><strong>${esc(layoutName())}</strong>${noScale ? '' : `<span>${esc(tr('print.scaleIs', { s: scaleText(p, o) }))}</span>${scaleBar(p.k)}`}<span class="prdate">${esc(date)}</span>`
    + `<span class="prpg">${esc((label ? label + ' · ' : '') + tr('print.pageN', { i: idx, n: total }))}</span></header>`;
  page.append(body);
  return page;
}

// SVG of the world rectangle [x0, x0 + w] × [yTop - h, yTop] (inches) at wMM × hMM on paper
function printSvg(world, x0, yTop, w, h, wMM, hMM, cls) {
  const s = el('svg', { xmlns: NS, class: cls, width: `${wMM}mm`, height: `${hMM}mm`, viewBox: `${x0} ${-yTop} ${w} ${h}`, preserveAspectRatio: 'xMidYMid meet' });
  s.append(world);
  return s;
}

function buildPrint(o = printOpts) {
  const area = $('#printArea'); area.innerHTML = '';
  const p = printPlan(o); if (!p) return null;
  const z = 96 * p.k;                     // CSS px per world inch on paper
  const { sw: W, sh: H, left, top, multi } = p;
  const world = printWorld(z, o.labels);
  const bom = o.bom && S.parts.length ? bomRows() : null;
  const total = p.tiles + (multi ? 1 : 0) + (bom ? 1 : 0);
  const used = new Set(p.sheets.map(([r, c]) => r + ',' + c));
  let idx = 0;

  if (multi) { // overview: the whole layout fitted onto one sheet, with the sheet grid
    const ovH = p.H - 8; // room for the assembly note below
    const fk = Math.min(p.W / (p.cols * W * MM), ovH / (p.rows * H * MM)), fz = 96 * fk;
    const ov = printSvg(printWorld(fz, false), left, top, p.cols * W, p.rows * H, p.W, ovH, 'prsvg');
    const grid = el('g', { class: 'prgrid' });
    for (let r = 0; r < p.rows; r++) for (let c = 0; c < p.cols; c++) {
      const on = used.has(r + ',' + c);
      grid.append(el('rect', { x: left + c * W, y: -(top - r * H), width: W, height: H, class: on ? '' : 'skip' }));
      if (!on) continue;
      const t = el('text', { x: left + (c + 0.5) * W, y: -(top - (r + 0.5) * H), 'font-size': Math.min(W, H) / 4 });
      t.textContent = colName(c) + (r + 1); grid.append(t);
    }
    ov.append(grid);
    const op = printPage({ ...p, k: fk }, { ...o, scale: 0 }, { label: tr('print.overview'), idx: ++idx, total, body: ov });
    const note = document.createElement('p'); note.className = 'prnote';
    note.textContent = tr('print.assemble', { n: p.tiles, c: p.cols, r: p.rows, s: scaleText(p, o) })
      + (p.tiles < p.cols * p.rows ? ' ' + tr('print.skipped', { n: p.cols * p.rows - p.tiles }) : '');
    op.append(note);
    area.append(op);
  }
  for (const [r, c] of p.sheets) {
    const svgEl = printSvg(multi ? world.cloneNode(true) : world, left + c * W, top - r * H, W, H, p.W, p.H, 'prsvg' + (multi ? ' tile' : ''));
    area.append(printPage(p, o, { label: multi ? tr('print.sheet', { p: colName(c) + (r + 1) }) : '', idx: ++idx, total, body: svgEl }));
  }
  if (bom) {
    const t = document.createElement('div');
    t.innerHTML = `<h2>${esc(tr('bom'))}</h2><table class="bom"><thead><tr><th>${tr('bom.pn')}</th><th>${tr('bom.desc')}</th><th>${tr('bom.mfr')}</th><th class="n">${tr('bom.qty')}</th></tr></thead><tbody>${bom.map((r) => `<tr><td>${esc(r.partno)}</td><td>${esc(r.desc)}</td><td>${esc(r.mfr)}</td><td class="n">${r.n}</td></tr>`).join('')}</tbody><tfoot><tr><th></th><th>${tr('bom.total')}</th><th></th><th class="n">${S.parts.length}</th></tr></tfoot></table>`;
    const bp = printPage(p, o, { idx: ++idx, total, body: t, noScale: true }); bp.classList.add('bompage');
    area.append(bp);
  }
  let st = $('#printPageStyle');
  if (!st) { st = document.createElement('style'); st.id = 'printPageStyle'; document.head.append(st); }
  st.textContent = `@page { size: ${p.paperW}mm ${p.paperH}mm; margin: ${PR_MARGIN}mm; }`;
  return p;
}

function readPrintDialog() {
  return {
    paper: $('#prPaper').value, orient: $('#prOrient').value, scale: +$('#prScale').value,
    labels: $('#prLabels').checked, bom: $('#prBom').checked,
  };
}
function printSummary() {
  const o = readPrintDialog(), p = printPlan(o), out = $('#prSummary');
  if (!p) { out.textContent = ''; return; }
  const orient = tr(p.land ? 'print.landscape' : 'print.portrait');
  out.textContent = p.multi
    ? tr('print.sumTiles', { c: p.cols, r: p.rows, n: p.tiles, s: scaleText(p, o), o: orient })
    : tr('print.sumOne', { s: scaleText(p, o), o: orient });
  out.classList.toggle('warn', p.tiles > 40);
}
function openPrint() {
  if (!printItems().length) { toast(tr('print.empty')); return; }
  const dlg = $('#dlgPrint'); if (dlg.open) return;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('#prPaper').value = printOpts.paper; $('#prOrient').value = printOpts.orient;
  $('#prScale').value = String(printOpts.scale); if ($('#prScale').selectedIndex < 0) $('#prScale').value = '0';
  $('#prLabels').checked = printOpts.labels; $('#prBom').checked = printOpts.bom;
  $('#prBom').disabled = !S.parts.length;
  printSummary();
  dlg.showModal();
}
function runPrint() {
  const p = buildPrint(printOpts); if (!p) return;
  if (native) {
    native.postMessage({ type: 'print', name: layoutName(), paperWidth: p.paperW, paperHeight: p.paperH, landscape: p.land, margin: PR_MARGIN });
    return;
  }
  printedByUs = true;
  setTimeout(() => window.print(), 50); // let the dialog close and the pages lay out first
}
let printedByUs = false;
// the browser's own Print command: print with the last used options
window.addEventListener('beforeprint', () => { if (!printedByUs) buildPrint(printOpts); });
window.addEventListener('afterprint', () => { printedByUs = false; });

for (const id of ['#prPaper', '#prOrient', '#prScale', '#prLabels', '#prBom']) $(id).addEventListener('change', printSummary);
$('#dlgPrint').addEventListener('close', () => {
  if ($('#dlgPrint').returnValue !== 'ok') return;
  Object.assign(printOpts, readPrintDialog());
  try { localStorage.setItem(PR_KEY, JSON.stringify(printOpts)); } catch { /* ignore */ }
  runPrint();
});
$('#btnPrint').onclick = openPrint;

// ---------------------------------------------------------------- settings
// Language and default library are kept per browser (localStorage). The data folder is a directory
// handle in IndexedDB (Chrome/Edge), or, in the macOS app, a path the app keeps in its own defaults.
const SETTINGS_KEY = 'stl.settings';
const settings = { lang: 'auto', defaultLib: DEFAULT_LIBS[0] };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* ignore */ }
const nativeInfo = window.__stlNative || {};   // from the macOS app: { dataDir: custom path or null, documents }
const canPickDir = !native && !!window.showDirectoryPicker;
let dataDir = null;                           // browser: FileSystemDirectoryHandle, null = Documents
const startIn = () => fileHandle || dataDir || 'documents';

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('smardtracklayout', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode), req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => { open.result.close(); resolve(req.result); };
      tx.onerror = () => { open.result.close(); reject(tx.error); };
    };
  });
}
const loadDirHandle = () => idb('readonly', (st) => st.get('dataDir')).catch(() => null);
const storeDirHandle = (h) => idb('readwrite', (st) => (h ? st.put(h, 'dataDir') : st.delete('dataDir'))).catch(() => {});

function applyLanguage({ full = true } = {}) {
  const wasUntitled = $('#layoutName').value.trim() === tr('untitled') || $('#layoutName').value === 'Untitled';
  setLang(settings.lang);
  applyI18n();
  if (wasUntitled) $('#layoutName').value = tr('untitled');
  fitToolbar();
  if (!full) return;
  if (S.libList.length) { const v = $('#libSelect').value; fillLibSelect(); $('#libSelect').value = v; }
  const lib = S.libs.get(S.lib);
  if (lib) $('#libTitle').textContent = (lib.contents ? lib.contents + ' · ' : '') + tr('lib.parts', { n: lib.parts.length });
  renderPalette(); propsKey = ''; layersKey = ''; applyView(); updateStatus();
}
// drop the product name in the toolbar when the buttons would otherwise wrap onto a second row
function fitToolbar() {
  const tb = $('.toolbar'); tb.classList.remove('compact');
  const tops = [...tb.children].map((c) => c.getBoundingClientRect().top);
  if (Math.max(...tops) - Math.min(...tops) > 20) tb.classList.add('compact');
}
window.addEventListener('resize', fitToolbar);

let pendingDir;  // in the dialog: undefined = unchanged, null = back to Documents, else the new folder
function showDir() {
  const cur = pendingDir !== undefined ? pendingDir : native ? nativeInfo.dataDir : dataDir;
  const label = native ? (cur || nativeInfo.documents || '~/Documents') : cur ? cur.name : tr('set.dir.docs');
  const p = $('#setDirPath'); p.textContent = label; p.title = label;
  const can = !!native || canPickDir;
  $('#setDirChoose').disabled = !can;
  $('#setDirReset').disabled = !can || !cur;
  $('#setDirNote').textContent = tr(can ? 'set.dir.note' : 'set.dir.noFs');
}
async function chooseDir() {
  if (native) { native.postMessage({ type: 'chooseDataDir', current: pendingDir ?? nativeInfo.dataDir ?? null }); return; }
  try { pendingDir = await window.showDirectoryPicker({ id: 'stl-data', mode: 'readwrite', startIn: pendingDir || dataDir || 'documents' }); showDir(); }
  catch (e) { if (e.name !== 'AbortError') toast(e.message, 5000); }
}

let buildInfo;
async function renderBuildInfo() {
  if (buildInfo === undefined) buildInfo = await fetch('build.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const b = buildInfo || {};
  const date = b.date ? new Date(b.date).toLocaleString(currentLang(), { dateStyle: 'long', timeStyle: 'short' }) : '–';
  const commit = b.commit
    ? `<a href="https://github.com/rvogelge/SmardTrackLayout/commit/${esc(b.commitFull || b.commit)}" target="_blank" rel="noopener"><code>${esc(b.commit)}</code></a>${b.dirty ? ' · ' + esc(tr('set.modified')) : ''}`
    : esc(tr('set.unknown'));
  $('#buildInfo').innerHTML = `<dt>${esc(tr('set.version'))}</dt><dd>${esc(b.version || '–')}</dd>`
    + `<dt>${esc(tr('set.commit'))}</dt><dd>${commit}</dd><dt>${esc(tr('set.date'))}</dt><dd>${esc(date)}</dd>`;
}

function openSettings() {
  const dlg = $('#dlgSettings'); if (dlg.open) return;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  const ls = $('#setLang'); ls.innerHTML = '';
  ls.append(new Option(tr('set.auto', { l: LANGS[systemLang()] }), 'auto'));
  for (const [k, v] of Object.entries(LANGS)) ls.append(new Option(v, k));
  ls.value = LANGS[settings.lang] ? settings.lang : 'auto';
  const lib = $('#setLib'); fillLibSelect(lib);
  lib.value = S.libList.includes(settings.defaultLib) ? settings.defaultLib : (S.libList.includes(DEFAULT_LIBS[0]) ? DEFAULT_LIBS[0] : S.libList[0]);
  pendingDir = undefined; applyI18n(dlg); showDir(); renderBuildInfo();
  dlg.showModal();
}
$('#dlgSettings').addEventListener('close', () => {
  const dlg = $('#dlgSettings');
  if (dlg.returnValue !== 'ok') { pendingDir = undefined; return; }
  const langChanged = settings.lang !== $('#setLang').value;
  settings.lang = $('#setLang').value;
  settings.defaultLib = $('#setLib').value;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
  if (pendingDir !== undefined) {
    if (native) { nativeInfo.dataDir = pendingDir; native.postMessage({ type: 'setDataDir', path: pendingDir }); }
    else { dataDir = pendingDir; storeDirHandle(pendingDir); }
    pendingDir = undefined;
  }
  if (langChanged) applyLanguage();
  native?.postMessage({ type: 'settings', lang: settings.lang });
  toast(tr('set.saved'));
});
$('#btnSettings').onclick = openSettings;
$('#setDirChoose').onclick = chooseDir;
$('#setDirReset').onclick = () => { pendingDir = null; showDir(); };
$('#setLang').onchange = () => { /* preview the dialog itself in the chosen language */
  setLang($('#setLang').value); applyI18n($('#dlgSettings')); showDir(); renderBuildInfo(); setLang(settings.lang);
};
applyLanguage({ full: false });

// ---------------------------------------------------------------- wiring
$('#libSelect').addEventListener('change', (e) => selectLib(e.target.value));
$('#partSearch').addEventListener('input', renderPalette);
$('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
$('#btnRotL').onclick = () => rotateSelection(-step());
$('#btnRotR').onclick = () => rotateSelection(step());
$('#btnFlip').onclick = flipLast;
$('#btnDelete').onclick = deleteSelection;
$('#zoomIn').onclick = () => zoomCenter(1.25);
$('#zoomOut').onclick = () => zoomCenter(0.8);
$('#zoomFit').onclick = fitView;
$('#chkLabels').onchange = (e) => { S.labels = e.target.checked; renderOverlay(); };
$('#btnBom').onclick = showBom;
$('#btnBomCsv').onclick = () => download(`${layoutName()} ${tr('bom.file')}.csv`, [tr('bom.pn'), tr('bom.desc'), tr('bom.mfr'), tr('bom.qty')].join(';') + '\n' + bomRows().map((r) => [r.partno, r.desc, r.mfr, r.n].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\n'), 'text/csv');
$('#btnHelp').onclick = () => $('#dlgHelp').showModal();
async function showLicense(file) {
  for (const b of document.querySelectorAll('#dlgLicenses .tab')) b.classList.toggle('on', b.dataset.file === file);
  const pre = $('#licenseText'); pre.textContent = tr('loading');
  pre.textContent = await fetch(file).then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText)))).catch((e) => tr('lic.failed', { f: file, e: e.message }));
  pre.scrollTop = 0;
}
function openLicenses() { $('#dlgHelp').close(); $('#dlgLicenses').showModal(); showLicense('legal/NOTICE.txt'); }
$('#btnLicenses').onclick = openLicenses;
for (const b of document.querySelectorAll('#dlgLicenses .tab')) b.onclick = () => showLicense(b.dataset.file);
$('#btnSave').onclick = save;
$('#btnSaveAs').onclick = saveAs;
$('#btnOpen').onclick = openFile;
$('#btnNew').onclick = newLayout;
$('#fileImport').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { await loadDoc(JSON.parse(await f.text())); setFileHandle(null); hasFile = true; $('#layoutName').value = baseName(f.name); S.dirty = false; updateStatus(); } catch (err) { toast(tr('openFailed', { e: err.message }), 5000); }
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
  newLayout, open: openFile, openFile, save, saveAs, saveToFile: saveAs, docFor, savedAs, openText, name: layoutName,
  undo: () => (inField() ? document.execCommand('undo') : undo()),
  redo: () => (inField() ? document.execCommand('redo') : redo()),
  rotate: (d) => rotateSelection(d ?? step()), fillGap: () => fillGap(),
  fit: fitView, partsList: showBom, print: () => openPrint(), help: () => $('#dlgHelp').showModal(),
  toggleLabels: () => $('#chkLabels').click(), tool: setTool,
  licenses: () => openLicenses(), settings: () => openSettings(), toggleLayers: () => toggleLayersPane(),
  dataDirChosen: (path) => { if (path) { pendingDir = path; showDir(); } },
  copy: () => copySelection(), cut: () => cutSelection(), paste: () => pasteClip(), duplicate: () => duplicateSelection(),
};

// ---------------------------------------------------------------- startup
(async function init() {
  const r = svg.getBoundingClientRect();
  S.view = { tx: r.width / 2, ty: r.height / 2, z: 12 };
  try { const g = localStorage.getItem('stl.grid'); if (g != null) { S.grid = +g; $('#gridSnap').value = g; } } catch { /* ignore */ }
  S.layers[0].name = tr('layer.n', { n: 1 });
  applyView();
  S.libList = await fetch('api/libraries').then((x) => x.json()).catch(() => DEFAULT_LIBS);
  fillLibSelect();
  let saved = null, lastLib = null;
  try { saved = JSON.parse(localStorage.getItem('stl.autosave') || 'null'); lastLib = localStorage.getItem('stl.lib'); } catch { /* ignore */ }
  const resume = saved && (saved.parts?.length || saved.shapes?.length);
  // continue with the library last used for the autosaved work; a fresh start uses the default library from the settings
  const lib = [resume ? lastLib : null, settings.defaultLib, ...DEFAULT_LIBS].find((f) => f && S.libList.includes(f)) || S.libList[0];
  await selectLib(lib);
  if (canPickDir) dataDir = (await loadDirHandle()) || null;
  if (resume) {
    await loadDoc(saved, { keepView: !!saved.view }).catch(() => {});
    S.dirty = !!saved.dirty;
    if (saved.view) { S.view = saved.view; applyView(); }
    // reconnect to the file the restored work belongs to, so Save writes there again
    if (saved.hasFile) {
      if (fsApi) { const h = await idb('readonly', (st) => st.get('currentFile')).catch(() => null); if (h) { fileHandle = h; hasFile = true; } }
      else hasFile = true;
    }
  }
  native?.postMessage({ type: 'restore', hasFile: !!(resume && saved.hasFile) });
  updateStatus();
})();
