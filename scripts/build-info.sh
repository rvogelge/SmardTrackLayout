#!/usr/bin/env bash
# SmardTrackLayout - model railway track layout editor
# Copyright (C) 2026 Rolf Vogelgesang
#
# This program is free software: you can redistribute it and/or modify it under the terms of
# the GNU General Public License as published by the Free Software Foundation, either
# version 3 of the License, or (at your option) any later version. It is distributed
# WITHOUT ANY WARRANTY; see the GNU General Public License for details (file LICENSE).
#
# SPDX-License-Identifier: GPL-3.0-or-later
# Writes build information (version, git commit, commit date) as JSON, shown in Settings.
# usage: scripts/build-info.sh <output.json>
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:?usage: build-info.sh <output.json>}"
VERSION=$(sed -nE 's/.*"version": *"([^"]+)".*/\1/p' package.json)
if git rev-parse --git-dir >/dev/null 2>&1; then
  FULL=$(git rev-parse HEAD)
  SHORT=$(git rev-parse --short=7 HEAD)
  DATE=$(git log -1 --format=%cI HEAD)
  DIRTY=$([ -n "$(git status --porcelain --untracked-files=no)" ] && echo true || echo false)
  printf '{"version":"%s","commit":"%s","commitFull":"%s","date":"%s","dirty":%s}\n' "$VERSION" "$SHORT" "$FULL" "$DATE" "$DIRTY" > "$OUT"
else
  printf '{"version":"%s","commit":null,"date":null,"dirty":false}\n' "$VERSION" > "$OUT"
fi
echo "› build info: $(cat "$OUT")"
