#!/usr/bin/env bash
# Deploy SmardTrackLayout to the Raspberry Pi: copies the project and
# (re)builds + starts the container there with docker compose.
set -euo pipefail
HOST="${DEPLOY_HOST:-pi@192.168.178.74}"
DIR="${DEPLOY_DIR:-SmardTrackLayout}"
cd "$(dirname "$0")"

rsync -az --delete --exclude .git --exclude data --exclude node_modules ./ "$HOST:$DIR/"
ssh "$HOST" "cd $DIR && docker compose up -d --build && docker image prune -f >/dev/null && docker compose ps"
echo "Deployed: http://${HOST#*@}:8080/"
