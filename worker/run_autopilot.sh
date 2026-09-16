#!/usr/bin/env bash
# ClipFlow autopilot agent — single pass (cron entrypoint, every 4h).
# Loads worker env from ~/.config/clipflow/worker.env (600), prevents
# overlapping runs with flock, logs to worker/logs/autopilot.log.
set -u
cd "$(dirname "$0")" || exit 1
mkdir -p logs
LOG="logs/autopilot.log"
# simple weekly rotation: keep current + one backup
if [ -f "$LOG" ] && [ "$(find "$LOG" -mtime +7 2>/dev/null)" ]; then
  mv -f "$LOG" "logs/autopilot.log.1"
fi
ENV_FILE="$HOME/.config/clipflow/worker.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "[autopilot] missing $ENV_FILE" >>"$LOG" 2>&1
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
exec /usr/bin/flock -n /tmp/clipflow_autopilot.lock \
  /home/hatch/workspace/whop-edit-env/bin/python autopilot.py --once >>"$LOG" 2>&1
