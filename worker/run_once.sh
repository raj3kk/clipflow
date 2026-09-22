#!/usr/bin/env bash
# ClipFlow pipeline worker — single pass (cron entrypoint).
# Quiet: stdout/stderr go to worker/logs/pipeline.log (rotated weekly).
# DRY-RUN by default: set CLIPFLOW_LIVE=1 in the environment ONLY when the
# owner explicitly enables real posting.
set -u
cd "$(dirname "$0")" || exit 1
mkdir -p logs
LOG="logs/pipeline.log"
# simple weekly rotation: keep current + one backup
if [ -f "$LOG" ] && [ "$(find "$LOG" -mtime +7 2>/dev/null)" ]; then
  mv -f "$LOG" "logs/pipeline.log.1"
fi
exec /home/hatch/workspace/whop-edit-env/bin/python pipeline_worker.py --once >>"$LOG" 2>&1
