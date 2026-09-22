#!/usr/bin/env bash
# Run Now → full pipeline watcher — single pass (cron entrypoint, every 1 min).
# Loads worker env from ~/.config/clipflow/worker.env (600), prevents
# overlapping runs with flock, logs to worker/logs/pipeline_watch.log.
set -u
cd "$(dirname "$0")" || exit 1
mkdir -p logs
LOG="logs/pipeline_watch.log"
if [ -f "$LOG" ] && [ "$(find "$LOG" -mtime +7 2>/dev/null)" ]; then
  mv -f "$LOG" "logs/pipeline_watch.log.1"
fi
ENV_FILE="$HOME/.config/clipflow/worker.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "[pipeline_watch] missing $ENV_FILE" >>"$LOG" 2>&1
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
exec /usr/bin/flock -n /tmp/pipeline_watch.lock \
  /usr/bin/python3 pipeline_watch.py "$@" >>"$LOG" 2>&1
