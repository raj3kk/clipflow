#!/usr/bin/env python3
"""
pipeline_watch.py — Run Now → full pipeline request watcher (1-min cron).

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
     Baaki 'skipped:*' / definitive error / timeout → failed + note.

TRANSIENT RULE (2026-09-19 fix): network blip (RemoteDisconnected,
IncompleteRead, timeout, 5xx) kabhi bhi request ko permanent `failed`
NAHI karta — request wapas `pending` hoti hai taaki agla run retry kare.
Sirf DEFINITIVE outcome pe failed: cap_full_24h, planner ka definitive
skip/error (apne retries ke baad).

Overlap: wrapper (run_pipeline_watch.sh) flock -n rakhta hai.
Ek request fail ho to doosri continue karti hai.
Secrets kabhi log nahi hote.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import traceback
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


def requeue(req_id: str, note: str) -> None:
    """Transient blip → request wapas `pending` (agla run retry karega).

    Kabhi failed mark nahi hota — yahi 2026-09-19 ka core fix hai.
    """
    try:
        config.sb_patch("pipeline_requests", req_id,
                        {"status": "pending", "started_at": None,
                         "finished_at": None, "note": note[:500]})
    except Exception as e:  # noqa: BLE001
        log(f"{req_id}: requeue bhi fail ({type(e).__name__}) — "
            f"request pending/running hi rahegi, agla fetch retry karega")
        return
    log(f"{req_id}: transient → wapas pending (retry agle run me)")


def mark_failed(req_id: str, note: str) -> None:
    """Definitive failure — poora message note me (sirf class name nahi)."""
    try:
        mark(req_id, "failed", note)
    except Exception as e:  # noqa: BLE001
        log(f"{req_id}: mark(failed) bhi fail ({type(e).__name__})")


def mark_done(req_id: str, note: str) -> None:
    try:
        mark(req_id, "done", note)
    except Exception as e:  # noqa: BLE001
        log(f"{req_id}: mark(done) fail ({type(e).__name__}) — "
            f"planner safal tha, request running reh sakti hai (stale-reclaim dekhega)")


# Planner ke stderr/outcome me ye markers = network blip (transient),
# definitive error nahi.
_TRANSIENT_MARKERS = (
    "remotedisconnected", "incompleteread", "timeout", "timed out",
    "urlerror", "connection reset", "connection aborted",
    "network failed", "bad gateway", "service unavailable",
    "gateway timeout", "temporary failure",
)


def _looks_transient_text(s: str) -> bool:
    low = (s or "").lower()
    return any(m in low for m in _TRANSIENT_MARKERS)


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

    # 1. running mark — ye bhi na ho paya to pending hi rehne do
    try:
        mark(req_id, "running")
    except Exception as e:  # noqa: BLE001
        log(f"{req_id}: mark(running) failed "
            f"({type(e).__name__}: {e}) — pending rehta hai")
        return

    # 2. cap check — transient blip → wapas pending, kabhi failed nahi
    try:
        n = cap_count(uid)
    except Exception as e:  # noqa: BLE001
        if isinstance(e, config.TransientError) or _looks_transient_text(str(e)):
            requeue(req_id, f"transient cap-check: {type(e).__name__}: {e}")
        else:
            tb = traceback.format_exc()
            mark_failed(req_id,
                        f"cap_check_error: {type(e).__name__}: {e}\n{tb[-700:]}")
            log(f"{req_id}: cap check definitive error → failed")
        return
    if n >= CAP_MAX:
        mark_failed(req_id, "cap_full_24h")
        log(f"{req_id}: cap full (>=4/24h) → failed")
        return

    # 3. planner chalao
    try:
        outcome, detail = run_planner(device_id)
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()
        if isinstance(e, config.TransientError) or _looks_transient_text(str(e)):
            requeue(req_id,
                    f"transient planner-launch: {type(e).__name__}: {e}")
        else:
            mark_failed(req_id,
                        f"watcher_error: {type(e).__name__}: {e}\n{tb[-700:]}")
            log(f"{req_id}: watcher error {type(e).__name__} → failed")
        return

    # 4. planner ka outcome — definitive hi failed, transient wapas pending
    if outcome == "enqueued":
        mark_done(req_id, "pipeline enqueued")
        log(f"{req_id}: planner enqueued → done")
        return
    note = (outcome if outcome.startswith(("skipped:", "error:", "timeout"))
            else f"failed:{outcome}")
    if detail:
        note = f"{note} | {detail}"[:480]
    blob = f"{outcome} {detail}"
    if outcome.startswith(("error:", "timeout")) and _looks_transient_text(blob):
        # Planner apne retries ke baad bhi network blip me gira —
        # definitive nahi, agla run retry karega.
        requeue(req_id, f"transient planner: {note}")
        return
    mark_failed(req_id, note)
    log(f"{req_id}: planner outcome {outcome} → failed")


STALE_RUNNING_MIN = 90


def reclaim_stale_running() -> None:
    """90 min se atki `running` requests wapas `pending` (stuck 409 guard kholo)."""
    try:
        cutoff = (datetime.now(timezone.utc)
                  - timedelta(minutes=STALE_RUNNING_MIN)).isoformat()
        stale = config.sb_request(
            "GET", "/rest/v1/pipeline_requests",
            query={"status": "eq.running",
                   "started_at": f"lt.{cutoff}",
                   "select": "id,started_at",
                   "limit": "20"})
    except Exception as e:  # noqa: BLE001
        log(f"stale-reclaim fetch failed ({type(e).__name__}) — skip")
        return
    for s in stale or []:
        requeue(s["id"],
                f"stale running (>{STALE_RUNNING_MIN}m, {s.get('started_at')}) — wapas pending")


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
    except config.TransientError as e:
        # Network blip — FATAL nahi; agla run (1-min) retry karega
        log(f"transient fetch blip ({e}) — next run retry karega")
        return 0
    except Exception as e:  # noqa: BLE001
        log(f"FATAL: fetch failed {type(e).__name__}: {e}")
        return 1
    reclaim_stale_running()
    if not pending:
        log("no pending requests")
        return 0
    for req in pending:
        handle(req)
    return 0


if __name__ == "__main__":
    sys.exit(main())
