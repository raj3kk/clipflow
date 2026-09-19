#!/usr/bin/env bash
# Schedule tick keepalive — VM-level backup for the Meta scheduler cron
# `clipflow-schedule-tick` (har 15 min). Scheduler dead ho jaye to ye /etc/cron.d
# entry tick chalata rahega. Endpoint idempotent hai (idempotency keys +
# pipeline_already_pending guard), isliye double-fire harmless hai.
#
# Crontab: */15 * * * * root HOME=/home/hatch /bin/bash /home/hatch/workspace/clipflow/worker/run_schedule_tick.sh
set -u
cd "$(dirname "$0")" || exit 1
mkdir -p logs
LOG="logs/schedule_tick_syscron.log"
if [ -f "$LOG" ] && [ "$(find "$LOG" -mtime +7 2>/dev/null)" ]; then
  mv -f "$LOG" "logs/schedule_tick_syscron.log.1"
fi

tick() {
  local env_file="$HOME/.config/clipflow/worker.env"
  if [ ! -f "$env_file" ]; then
    echo "$(date -u +%FT%TZ) missing $env_file"
    return 1
  fi
  local ws
  ws=$(grep -o "WORKER_SECRET=.*" "$env_file" | cut -d= -f2)
  local out
  out=$(curl -s -m 90 -X POST https://clipflow-webbuilder1.vercel.app/api/devices/schedule-tick \
    -H "x-worker-secret: $ws" 2>&1)
  ws=""
  local ts
  ts=$(date -u +%FT%TZ)
  local summary
  summary=$(echo "$out" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print('checked=%s created=%d skipped=%d reconciled=%d' % (
        d.get('devices_checked', '?'), len(d.get('created', [])),
        len(d.get('skipped', [])), len(d.get('reconciled', []))))
except Exception:
    print('TICK-FAIL')
")
  if [ "$summary" = "TICK-FAIL" ]; then
    echo "$ts TICK-FAIL $(echo "$out" | head -c 200)"
  else
    echo "$ts $summary"
  fi
}

# flock: scheduler wala agent-run aur ye overlap na karein (endpoint waise
# bhi idempotent hai — ye sirf log-rotation race rokta hai).
export -f tick
/usr/bin/flock -n /tmp/schedule_tick_syscron.lock \
  /bin/bash -c 'tick' >>"$LOG" 2>&1 || true
