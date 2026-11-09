// SmardTrackLayout - model railway track layout editor
// Copyright (C) 2026 Rolf Vogelgesang
//
// This program is free software: you can redistribute it and/or modify it under the terms of
// the GNU General Public License as published by the Free Software Foundation, either
// version 3 of the License, or (at your option) any later version. It is distributed
// WITHOUT ANY WARRANTY; see the GNU General Public License for details (file LICENSE).
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Generic layout symbols (signals, buffer stops, feeders …) that are not part of any track library.
// They are offered in every library as a built-in pseudo-library and behave like parts without
// endpoints. Drawn in mm, in part coordinates: x runs along the track, the origin lies on the track
// centre line and -y is the right-hand side (where signals stand, seen in the direction of travel).

import { t as tr } from './i18n.js';

export const SYMBOL_LIB = 'stl:symbols';
const MM = 25.4;

// id, bounding box [x0, y0, x1, y1] in mm (the clickable area), SVG markup in mm
const DEFS = [
  ['signal-main', [-1.5, -30, 13.5, -15.5],
    '<path class="sk" d="M0 -16.5V-26H6"/><circle class="sk red" cx="9.5" cy="-26" r="3.5"/>'],
  ['signal-distant', [-1.5, -30, 13.5, -15.5],
    '<path class="sk" d="M0 -16.5V-26H6"/><circle class="sk yel" cx="9.5" cy="-26" r="3.5"/><circle class="sk" cx="9.5" cy="-26" r="1.3"/>'],
  ['signal-combined', [-1.5, -30, 19, -15.5],
    '<path class="sk" d="M0 -16.5V-26H6"/><circle class="sk red" cx="9" cy="-26" r="3"/><circle class="sk yel" cx="15.2" cy="-26" r="3"/>'],
  ['signal-shunt', [-1.5, -26.5, 10, -15.5],
    '<path class="sk" d="M0 -16.5V-23H4"/><circle class="sk wht" cx="6.8" cy="-23" r="2.8"/><path class="sk" d="M4.9 -21.1L8.7 -24.9"/>'],
  ['signal-semaphore', [-1.5, -31, 15, -15.5],
    '<path class="sk" d="M0 -16.5V-29.5"/><rect class="sk red" x="0" y="-31" width="14" height="3" rx=".6"/><rect class="wht" x="6" y="-30.4" width="2" height="1.8"/>'],
  ['buffer-stop', [-16, -15, 0.5, 15],
    '<path class="sk" d="M-4 -9L-15 -4M-4 9L-15 4"/><rect class="sk dark" x="-4" y="-14" width="4" height="28" rx=".8"/>'],
  ['uncoupler', [-13.5, -6.5, 13.5, 6.5],
    '<rect class="sk yel soft" x="-13" y="-6" width="26" height="12" rx="1.5"/><path class="sk" d="M-7 0H7M-4.5 -2.5L-7 0L-4.5 2.5M4.5 -2.5L7 0L4.5 2.5"/>'],
  ['feeder', [-5.5, -29.5, 5.5, -7.5],
    '<path class="sk wire" d="M0 -8V-19"/><circle class="sk red" cx="0" cy="-24" r="5"/><path class="wht" d="M1.2 -20.6L-2.2 -24.4H.4L-1.2 -27.6L2.4 -23.4H-.2Z"/>'],
  ['isolation', [-3, -12.5, 3, 12.5],
    '<path class="sk iso" d="M-1.5 4.5V12M1.5 4.5V12M-1.5 -4.5V-12M1.5 -4.5V-12"/>'],
  ['contact', [-4.5, -3.5, 4.5, 3.5],
    '<rect class="sk blu" x="-4" y="-3" width="8" height="6" rx="1"/><circle class="wht" cx="0" cy="0" r="1.2"/>'],
  ['level-crossing', [-40, -46, 40, 46],
    '<rect class="road" x="-30" y="-45" width="60" height="90"/><path class="sk" d="M-30 -45V45M30 -45V45"/><path class="sk xing" d="M-39 -27l6 6m0 -6l-6 6M33 21l6 6m0 -6l-6 6"/>'],
  ['lamp', [-4.5, -28.5, 4.5, -15.5],
    '<path class="sk" d="M0 -16.5V-20"/><circle class="sk yel" cx="0" cy="-24" r="4"/><path class="sk" d="M-2.8 -26.8L2.8 -21.2M2.8 -26.8L-2.8 -21.2"/>'],
];

// signals and lamps are drawn 30 % larger, scaled about the foot of the mast at the track side,
// and with bold lines
const BIG = new Set(['signal-main', 'signal-distant', 'signal-combined', 'signal-shunt', 'signal-semaphore', 'lamp']);
const BIG_K = 1.3, FOOT = -16.5;
function enlarge([x0, y0, x1, y1], svg) {
  const y = (v) => FOOT + (v - FOOT) * BIG_K;
  return [[x0 * BIG_K, y(y0), x1 * BIG_K, y(y1)].map((v) => Math.round(v * 100) / 100),
    `<g class="big" transform="translate(0 ${FOOT}) scale(${BIG_K}) translate(0 ${-FOOT})">${svg}</g>`];
}

let lib = null;
/** the symbol library in the same shape as a parsed XTrackCAD library (names follow the UI language) */
export function symbolLibrary() {
  if (lib) return lib;
  const parts = DEFS.map(([id, box, markup]) => [id, ...(BIG.has(id) ? enlarge(box, markup) : [box, markup])]).map(([id, [x0, y0, x1, y1], svg]) => ({
    sym: id, title: id, kind: 'SYMBOL', partno: '', scale: '', svg,
    get desc() { return tr('sym.' + id); },
    get mfr() { return tr('sym.mfr'); },
    get group() { return tr('sym.group'); },
    endpoints: [], track: [], lines: [], fills: [], circles: [],
    bbox: { x0: x0 / MM, y0: y0 / MM, x1: x1 / MM, y1: y1 / MM }, isTrack: false,
  }));
  lib = { file: SYMBOL_LIB, contents: '', parts, byTitle: new Map(parts.map((p) => [p.title, p])) };
  return lib;
}
