// SmardTrackLayout - model railway track layout editor
// Copyright (C) 2026 Rolf Vogelgesang
//
// This program is free software: you can redistribute it and/or modify it under the terms of
// the GNU General Public License as published by the Free Software Foundation, either
// version 3 of the License, or (at your option) any later version. It is distributed
// WITHOUT ANY WARRANTY; see the GNU General Public License for details (file LICENSE).
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Parser for XTrackCAD parameter files (.xtp).
// Units are inches; angles are compass degrees (0 = +y/north, 90 = +x/east, clockwise).

const GAUGE_MM = [
  ['HOn30', 9], ['HOn3', 10.5], ['HOm', 12], ['HOe', 9], ['Nn3', 6.5], ['On30', 16.5], ['On3', 19],
  ['Sn3', 16], ['TTm', 9], ['HO', 16.5], ['H0', 16.5], ['OO', 16.5], ['EM', 18.2], ['TT', 12],
  ['N', 9], ['Z', 6.5], ['T', 3], ['S', 22.5], ['O', 32], ['G', 45], ['1', 45],
];
export function gaugeForScale(scale) {
  for (const [k, mm] of GAUGE_MM) if (scale.toUpperCase().startsWith(k.toUpperCase())) return mm / 25.4;
  return 16.5 / 25.4;
}

const rad = (d) => (d * Math.PI) / 180;
export const arcPoint = (cx, cy, r, a) => [cx + r * Math.sin(rad(a)), cy + r * Math.cos(rad(a))];

function arcPoints(cx, cy, r, a0, a1) {
  const n = Math.max(2, Math.ceil(Math.abs(a1) / 3) + 1);
  const pts = [];
  for (let i = 0; i < n; i++) pts.push(arcPoint(cx, cy, r, a0 + (a1 * i) / (n - 1)));
  return pts;
}

function bezierPoints(p) {
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24, u = 1 - t;
    pts.push([
      u * u * u * p[0] + 3 * u * u * t * p[2] + 3 * u * t * t * p[4] + t * t * t * p[6],
      u * u * u * p[1] + 3 * u * u * t * p[3] + 3 * u * t * t * p[5] + t * t * t * p[7],
    ]);
  }
  return pts;
}

/** Returns { contents, parts: [{ title, scale, mfr, desc, partno, group, kind, endpoints, track, lines, fills, circles, bbox, gauge }] } */
export function parseXtp(text) {
  const lines = text.split(/\r?\n/);
  const parts = [];
  let contents = '', sub = '', cur = null;
  const N = parseFloat;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.search(/\s/);
    const cmd = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();

    if (!cur) {
      if (cmd === 'CONTENTS') contents = rest;
      else if (cmd === 'SUBCONTENTS') sub = rest;
      else if (cmd === 'TURNOUT' || cmd === 'STRUCTURE') {
        const m = rest.match(/^(\S+)\s+"([^"]*)"/);
        if (!m) continue;
        const [mfr = '', desc = '', partno = ''] = m[2].split('\t');
        cur = { kind: cmd, scale: m[1], title: m[2], mfr, desc: desc || m[2], partno, group: sub || 'Parts',
          endpoints: [], track: [], lines: [], fills: [], circles: [] };
      }
      continue;
    }

    if (cmd.startsWith('END')) { finish(cur); parts.push(cur); cur = null; continue; }
    const t = rest.split(/\s+/);
    switch (cmd) {
      case 'E': case 'E4': case 'T': case 'T4':
        cur.endpoints.push({ x: N(t[0]), y: N(t[1]), a: N(t[2]) }); break;
      case 'S': cur.track.push([[N(t[2]), N(t[3])], [N(t[4]), N(t[5])]]); break;
      case 'C': cur.track.push(arcPoints(N(t[3]), N(t[4]), Math.abs(N(t[2])), N(t[5]), N(t[6]))); break;
      case 'W': if (t.length >= 10) cur.track.push(bezierPoints(t.slice(2, 10).map(N))); break;
      case 'L': cur.lines.push([[N(t[2]), N(t[3])], [N(t[4]), N(t[5])]]); break;
      case 'L3': cur.lines.push([[N(t[2]), N(t[3])], [N(t[5]), N(t[6])]]); break;
      case 'A': cur.lines.push(arcPoints(N(t[3]), N(t[4]), Math.abs(N(t[2])), N(t[5]), N(t[6]))); break;
      case 'A3': cur.lines.push(arcPoints(N(t[3]), N(t[4]), Math.abs(N(t[2])), N(t[6]), N(t[7]))); break;
      case 'H': if (t.length >= 10) cur.lines.push(bezierPoints(t.slice(2, 10).map(N))); break;
      case 'G': case 'G3': cur.circles.push({ x: N(t[3]), y: N(t[4]), r: Math.abs(N(t[2])) }); break;
      case 'F': case 'F3': case 'Y': case 'Y3': {
        const n = parseInt(t[2], 10) || 0;
        const pts = [];
        for (let k = 0; k < n && i + 1 < lines.length; k++) {
          const pt = lines[++i].trim().split(/\s+/);
          pts.push([N(pt[0]), N(pt[1])]);
        }
        (cmd[0] === 'F' ? cur.fills : cur.lines).push(pts);
        break;
      }
      default: break; // U, P, X, D, Q, Z ... not needed for drawing
    }
  }
  return { contents, parts: parts.filter((p) => p.track.length || p.lines.length || p.fills.length) };
}

function finish(p) {
  p.gauge = gaugeForScale(p.scale);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = ([x, y], m = 0) => { x0 = Math.min(x0, x - m); y0 = Math.min(y0, y - m); x1 = Math.max(x1, x + m); y1 = Math.max(y1, y + m); };
  for (const pl of p.track) pl.forEach((q) => add(q, p.gauge));
  for (const pl of [...p.lines, ...p.fills]) pl.forEach((q) => add(q));
  for (const c of p.circles) add([c.x, c.y], c.r);
  for (const e of p.endpoints) add([e.x, e.y]);
  if (!isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 1; }
  p.bbox = { x0, y0, x1, y1 };
  p.isTrack = p.endpoints.length > 0;
}

// ---------- SVG path building (in part-local coordinates) ----------
const f = (v) => (Math.round(v * 1000) / 1000).toString();
const polyD = (pts, close = false) => 'M' + pts.map(([x, y]) => f(x) + ' ' + f(y)).join('L') + (close ? 'Z' : '');

function offsetPolyline(pts, d) {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    return [p[0] - (dy / len) * d, p[1] + (dx / len) * d];
  });
}

function tiesAlong(pts, spacing, half) {
  let d = '', carry = spacing / 2;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const len = Math.hypot(bx - ax, by - ay);
    if (!len) continue;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    let s = carry;
    while (s <= len) {
      const x = ax + ux * s, y = ay + uy * s;
      d += `M${f(x - uy * half)} ${f(y + ux * half)}L${f(x + uy * half)} ${f(y - ux * half)}`;
      s += spacing;
    }
    carry = s - len;
  }
  return d;
}

/** Precomputed SVG path data for a part definition (cached on the object). */
export function partPaths(p) {
  if (p._paths) return p._paths;
  const g = p.gauge;
  let rails = '', ties = '', center = '', outline = '', fill = '';
  for (const pl of p.track) {
    rails += polyD(offsetPolyline(pl, g / 2)) + polyD(offsetPolyline(pl, -g / 2));
    ties += tiesAlong(pl, g * 0.45, g * 0.85);
    center += polyD(pl);
  }
  for (const pl of p.lines) outline += polyD(pl);
  for (const pl of p.fills) fill += polyD(pl, true);
  for (const c of p.circles) fill += `M${f(c.x - c.r)} ${f(c.y)}a${f(c.r)} ${f(c.r)} 0 1 0 ${f(2 * c.r)} 0a${f(c.r)} ${f(c.r)} 0 1 0 ${f(-2 * c.r)} 0Z`;
  p._paths = { rails, ties, center, outline, fill };
  return p._paths;
}
