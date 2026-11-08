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
# Deploy SmardTrackLayout to the Raspberry Pi: copies the project and
# (re)builds + starts the container there with docker compose.
set -euo pipefail
HOST="${DEPLOY_HOST:-pi@192.168.178.74}"
DIR="${DEPLOY_DIR:-SmardTrackLayout}"
cd "$(dirname "$0")"

scripts/build-info.sh public/build.json
rsync -az --delete --exclude .git --exclude data --exclude node_modules ./ "$HOST:$DIR/"
ssh "$HOST" "cd $DIR && docker compose up -d --build && docker image prune -f >/dev/null && docker compose ps"
echo "Deployed: http://${HOST#*@}:8080/"
