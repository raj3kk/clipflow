#!/usr/bin/env python3
"""
pipeline_watch.py — Run Now → full pipeline request watcher (5-min cron).

POST /api/devices/:id/run-pipeline se `pending` request aati hai.
Is script ka kaam:
  1. `pending` requests oldest-first uthao (service_role).
  2. Request ko `running` mark karo (started_at).
  3. Shared cap check: v1 posts.posted_at + v2 device_jobs.created_at,
     rolling 24h, statuses include 'failed' (standing rule: failed run bhi
     ek run hai) — >=4 → request `failed`, note='cap_full_24h'.
  4. Varna subprocess me `planner_v2.py --once` chalao (non-dry-run,
     env PLANNER_DEVICE_ID=<device_id>, timeout ~50 min).
  5. Planner ke outcome se `done`/`failed` + note set karo.
     'enqueued' → done. Cap-skip ('skipped:cap') → failed, note me reason.
     Baaki 'skipped:*' / error / timeout → failed + note.

Overlap: wrapper (run_pipeline_watch.sh) flock -n rakhta hai.
Ek request fail ho to doosri continue karti hai.
Secrets kabhi log nahi hote.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402

VENV_PY = os.path.expanduser("~/workspace/whop-edit-env/bin/python")
PLANNER = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "planner_v2.py")
CAP_MAX = 4
CAP_WINDOW_H = 24
PLANNER_TIMEOUT_S = 50 * 60


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(msg: str) -> None:
    print(f"[pipeline_watch] {now_iso()} {msg}", flush=True)


def mark(req_id: str, status: str, note: str | None = None) -> None:
    patch = {"status": status,
             "finished_at": now_iso() if status in ("done", "failed") else None}
    if status == "running":
        patch["started_at"] = now_iso()
    if note is not None:
        patch["note"] = note[:500]
    config.sb_patch("pipeline_requests", req_id, patch)


def cap_count(uid: str) -> int:
    """v1 posts + v2 jobs, rolling 24h. 'failed' count hota hai."""
    since = (datetime.now(timezone.utc)
             - timedelta(hours=CAP_WINDOW_H)).isoformat()
    posts = config.sb_request("GET", "/rest/v1/posts", query={
        "user_id": f"eq.{uid}", "posted_at": f"gte.{since}",
        "select": "id", "limit": "50"})
    jobs = config.sb_request("GET", "/rest/v1/device_jobs", query={
        "user_id": f"eq.{uid}", "created_at": f"gte.{since}",
        "status": "in.(queued,dispatched,running,succeeded,failed)",
        "select": "id", "limit": "50"})
    n_posts = len(posts) if isinstance(posts, list) else 0
    n_jobs = len(jobs) if isinstance(jobs, list) else 0
    return n_posts + n_jobs


def run_planner(device_id: str) -> tuple[str, str]:
    """planner_v2.py --once chalao. Returns (outcome, tail_note)."""
    env = dict(os.environ)
    env["PLANNER_DEVICE_ID"] = device_id
    try:
        proc = subprocess.run(
            [VENV_PY, PLANNER, "--once"],
            env=env, capture_output=True, text=True,
            timeout=PLANNER_TIMEOUT_S,
            cwd=os.path.dirname(os.path.abspath(__file__)),
        )
    except subprocess.TimeoutExpired:
        return ("timeout", "planner 50min timeout")
    tail = (proc.stdout or "")[-1500:]
    for line in tail.splitlines():
        print(line)  # planner ka apna log preserve karo
    m = re.search(r"^.*done:\s*(\S+)\s*$", tail, re.MULTILINE)
    if proc.returncode != 0:
        return (f"error:exit{proc.returncode}", (proc.stderr or "")[-300:])
    if not m:
        return ("error:no_outcome", tail[-300:])
    return (m.group(1), "")


def handle(req: dict) -> None:
    req_id = req["id"]
    device_id = req["device_id"]
    uid = req["user_id"]
    log(f"request {req_id} device={device_id} user={uid}")
    try:
        mark(req_id, "running")
        if cap_count(uid) >= CAP_MAX:
            mark(req_id, "failed", "cap_full_24h")
            log(f"{req_id}: cap full (>=4/24h) → failed")
            return
        outcome, detail = run_planner(device_id)
        if outcome == "enqueued":
            mark(req_id, "done", "pipeline enqueued")
            log(f"{req_id}: planner enqueued → done")
        else:
            note = outcome if outcome.startswith(("skipped:", "error:", "timeout")) else f"failed:{outcome}"
            if detail:
                note = f"{note} | {detail}"[:500]
            mark(req_id, "failed", note)
            log(f"{req_id}: planner outcome {outcome} → failed")
    except Exception as e:  # noqa: BLE001
        try:
            mark(req_id, "failed", f"watcher_error:{type(e).__name__}")
        except Exception:
            pass
        log(f"{req_id}: watcher error {type(e).__name__}")


def main() -> int:
    if config.MISSING_CORE:
        log(f"FATAL: env missing: {config.MISSING_CORE}")
        return 2
    try:
        pending = config.sb_request("GET", "/rest/v1/pipeline_requests",
                                    query={"status": "eq.pending",
                                           "select": "id,user_id,device_id,created_at",
                                           "order": "created_at.asc",
                                           "limit": "20"})
    except Exception as e:  # noqa: BLE001
        log(f"FATAL: fetch failed {type(e).__name__}")
        return 1
    if not pending:
        log("no pending requests")
        return 0
    for req in pending:
        handle(req)
    return 0


if __name__ == "__main__":
    sys.exit(main())
