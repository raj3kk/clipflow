#!/usr/bin/env bash
# ClipFlow Whop OTP worker — single pass (cron entrypoint, every 2 min).
# Narrow scope: only processes pending `whop_otp` interventions (user-initiated
# Whop email-OTP logins). Does NOT run the clipping autopilot.
set -u
cd "$(dirname "$0")" || exit 1
mkdir -p logs
LOG="logs/whop_otp.log"
if [ -f "$LOG" ] && [ "$(find "$LOG" -mtime +7 2>/dev/null)" ]; then
  mv -f "$LOG" "logs/whop_otp.log.1"
fi
ENV_FILE="$HOME/.config/clipflow/worker.env"
if [ ! -f "$ENV_FILE" ]; then
  echo "[whop_otp] missing $ENV_FILE" >>"$LOG" 2>&1
  exit 1
fi
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
exec /usr/bin/flock -n /tmp/clipflow_whop_otp.lock \
  /home/hatch/workspace/whop-edit-env/bin/python whop_otp.py >>"$LOG" 2>&1
