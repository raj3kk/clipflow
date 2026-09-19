#!/usr/bin/env bash
# Ops monitor — stuck device_jobs detect + auto-requeue + resume checkpoint.
# Single pass (cron entrypoint, every 1 min). pipeline_watch.py ke
# reconcile_device_jobs ka standalone, zyada robust replacement — dono ek
# saath chalana safe hai (race guard), lekin ek hi rakho.
# Logs: worker/logs/ops_monitor.log
set -u
cd "$(dirname "$0")" || exit 1
mkdir -p logs
LOG="logs/ops_monitor.log"
if [ -f "$LOG" ] && [ "$(find "$LOG" -mtime +7 2>/dev/null)" ]; then
  mv -f "$LOG" "logs/ops_monitor.log.1"
fi
ENV_FILE="$HOME/.config/clipflow/worker.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "[ops_monitor] missing $ENV_FILE" >>"$LOG" 2>&1
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
exec /usr/bin/flock -n /tmp/ops_monitor.lock \
  /usr/bin/python3 ops_monitor.py "$@" >>"$LOG" 2>&1
