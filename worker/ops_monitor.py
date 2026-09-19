#!/usr/bin/env python3
"""
ops_monitor.py — ClipFlow ops monitor / repair worker (stuck device_jobs).

Har run me single pass: `dispatched`/`running` jobs jinka phone marr gaya
(heartbeat band) unhe detect karke repair karta hai — dobara `queued`,
taaki phone wahi job phir se uthaye. Koi naya job create NAHI hota.

Stuck detection (per-job cutoff — lib/device_jobs.ts ke reconcileStaleJobs
jaisa, phone-poll se independent):
  * heartbeat_count > 0  → aakhri heartbeat se 10+ min → STUCK
    (heartbeat-capable app: har step pe + har 45s me heartbeat bhejta hai)
  * heartbeat_count = 0/NULL → claim-time (last_heartbeat, nahi to
    created_at) se 45+ min → STUCK (purana app, lambi run safe)

Repair:
  * attempts < max_attempts → status='queued', run_after=now(),
    last_heartbeat=NULL (naya claim fresh start), payload me
    `resume_from_step` (0-based step index, current_step label se parse —
    checkpoint se resume, shuru se nahi). `current_step` PRESERVE rehta hai
    (PATCH me chheda hi nahi jata) taaki Live page + app ko pata rahe
    kaam kahan tak pahuncha tha.
  * attempts >= max_attempts → status='failed' (terminal). Naya job NAHI
    banta, retry NAHI hota — human review ke liye.

ATTEMPTS NOTE: attempts watchdog me increment NAHI hota — claim route
(POST /api/devices/jobs/next) atomic claim pe `attempts+1` karta hai.
Watchdog me bhi +1 karne se ek requeue-claim cycle me 2 attempts jalte.
Terminal check `attempts >= max_attempts` isi claim-count pe hota hai.

Idempotency:
  * PATCH conditional hai: `id=eq.X & status=in.(dispatched,running)` —
    doosra worker/monitor pehle handle kar chuka ho to PATCH no-op.
  * Jeetne wala apna `_ops_marker` payload me likhta hai; verify-select me
    marker match hua tabhi job_runs/activity_log audit rows likhi jati hain.
    Ek run me ek job ek hi baar repair hoti hai; agle run me job `queued`
    hai to watchdog use chhoota hi nahi (sirf dispatched/running dekhta hai).

`note` column device_jobs me NAHI hai (PostgREST 400 hota hai) — wajah
job_runs.result + activity_log.detail me record hoti hai.

Usage:
  python3 ops_monitor.py            # live single pass
  python3 ops_monitor.py --dry-run  # sirf batayega, kuchh badlega nahi
  python3 ops_monitor.py --limit 50

Cron: run_ops_monitor.sh (flock-guarded, har 1 min) — pipeline_watch.py ke
reconcile_device_jobs ka standalone, zyada robust replacement. Dono ek
saath chalana safe hai (race guard), lekin ek hi rakho taaki audit
double na ho.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402

HEARTBEAT_TIMEOUT_MIN = 10   # heartbeat-capable app: itne min bina heartbeat = dead
LEGACY_TIMEOUT_MIN = 45      # purana app (heartbeat_count=0): claim-time se
FETCH_LIMIT = 100
DEFAULT_MAX_ATTEMPTS = 3

# current_step label format (app JobHeartbeat): "step 3/10 (upload)" /
# "step 3/10 (upload) ✓" (khatm) / "step 3/10 (upload) ✗: wajah" (fail)
_STEP_RE = re.compile(r"^\s*step\s+(\d+)\s*/\s*(\d+)", re.IGNORECASE)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(msg: str) -> None:
    print(f"[ops_monitor] {now_iso()} {msg}", flush=True)


def _parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def is_stale(job: dict) -> tuple[bool, str]:
    """Stuck hai? → (stale, wajah)."""
    hb_count = job.get("heartbeat_count") or 0
    if hb_count > 0:
        cutoff = HEARTBEAT_TIMEOUT_MIN
        base_raw = job.get("last_heartbeat")
        base_kind = "aakhri heartbeat"
    else:
        cutoff = LEGACY_TIMEOUT_MIN
        base_raw = job.get("last_heartbeat") or job.get("created_at")
        base_kind = "claim-time"
    base = _parse_dt(base_raw)
    if base is None:
        return False, "time samajh nahi aaya — chhoda"
    age_min = (datetime.now(timezone.utc) - base).total_seconds() / 60
    if age_min > cutoff:
        return True, (f"{base_kind} se {age_min:.0f} min — koi heartbeat nahi "
                       f"(cutoff {cutoff} min)")
    return False, ""


def parse_resume_index(current_step: str | None, payload: dict) -> tuple[int | None, str]:
    """current_step label se 0-based resume index.

    "step 3/10 (upload) ✓" → 3 (step 3 poora, 4th se aage)
    "step 3/10 (upload)" / "✗" → 2 (step 3 dobara — poora hone ka saboot nahi)
    parse na ho → None (app shuru se chalayega — safe default)
    saare step ✓ lekin result miss → total (koi step nahi, sirf report)
    """
    if not current_step or not str(current_step).strip():
        return None, "current_step khaali tha — app shuru se chalayega"
    label = str(current_step).strip()
    m = _STEP_RE.match(label)
    if not m:
        return None, f"label parse nahi hua ({label[:40]!r}) — shuru se"
    n = int(m.group(1))          # 1-based step number
    total = int(m.group(2))
    steps = (payload or {}).get("steps")
    if isinstance(steps, list) and steps:
        total = len(steps)       # label se zyada bharosa payload pe
    if total <= 0:
        return None, "steps hi nahi mile — shuru se"
    done = label.rstrip().endswith("✓")
    idx = n if done else max(n - 1, 0)
    if idx >= total:
        # saare steps ✓ — dobara chalane ki zaroorat nahi, sirf report
        return total, f"saare {total} steps ✓ the — sirf report bhejega"
    return idx, (f"label '{label[:60]}' → step {idx} se resume"
                 + (" (✓ wala chhoda)" if done else " (adhura step dobara)"))


def conditional_patch(jid: str, patch: dict) -> None:
    """PATCH sirf tab jab job abhi bhi dispatched/running hai (race guard)."""
    config.sb_request("PATCH", "/rest/v1/device_jobs", body=patch, query={
        "id": f"eq.{jid}", "status": "in.(dispatched,running)"})


def fetch_job(jid: str) -> dict | None:
    rows = config.sb_select("device_jobs", {"id": jid},
                            select="id,status,attempts,payload,current_step",
                            limit=1)
    return rows[0] if rows else None


def audit_requeued(job: dict, reason: str, resume_idx: int | None,
                   dry_run: bool) -> None:
    jid, uid, did = job["id"], job.get("user_id"), job.get("device_id")
    if dry_run:
        log(f"  [dry-run] job_runs(activity) skip — requeued likha jata")
        return
    config.sb_request("POST", "/rest/v1/job_runs", body=[{
        "user_id": uid, "device_id": did, "job_id": jid,
        "status": "requeued", "finished_at": now_iso(),
        "result": {"reason": f"ops_monitor: {reason}"[:400],
                   "resume_from_step": resume_idx,
                   "attempt": job.get("attempts") or 0,
                   "monitor": "ops_monitor"}}])
    config.sb_request("POST", "/rest/v1/activity_log", body=[{
        "user_id": uid, "actor": "worker", "event": "job_requeued",
        "detail": {"text": (
            f"Job {jid[:8]}… phone se heartbeat band tha — wapas queue "
            f"me dala ({reason}). "
            + (f"Step {resume_idx} se resume hoga."
               if resume_idx else "Shuru se chalega."))[:500]}}])


def audit_failed(job: dict, reason: str, dry_run: bool) -> None:
    jid, uid, did = job["id"], job.get("user_id"), job.get("device_id")
    if dry_run:
        log(f"  [dry-run] job_runs(activity) skip — failed likha jata")
        return
    config.sb_request("POST", "/rest/v1/job_runs", body=[{
        "user_id": uid, "device_id": did, "job_id": jid,
        "status": "failed", "finished_at": now_iso(),
        "result": {"reason": f"ops_monitor: {reason}"[:400],
                   "attempt": job.get("attempts") or 0,
                   "max_attempts": job.get("max_attempts") or DEFAULT_MAX_ATTEMPTS,
                   "monitor": "ops_monitor"}}])
    config.sb_request("POST", "/rest/v1/activity_log", body=[{
        "user_id": uid, "actor": "worker", "event": "job_failed",
        "detail": {"text": (
            f"Job {jid[:8]}… {reason} — attempts khatm, failed mark kiya. "
            f"Live tab me dekhein; zaroorat ho to Run Now se dobara chalayein."
        )[:500]}}])


def handle(job: dict, dry_run: bool) -> str:
    """Ek stuck job repair karo. Returns: 'requeued' | 'failed' | 'skipped'."""
    jid = job["id"]
    stale, reason = is_stale(job)
    if not stale:
        return "skipped"
    attempts = job.get("attempts") or 0
    max_attempts = job.get("max_attempts") or DEFAULT_MAX_ATTEMPTS
    cur = job.get("current_step")
    payload = job.get("payload") if isinstance(job.get("payload"), dict) else {}
    marker = f"opsm:{uuid.uuid4().hex[:12]}"

    if attempts >= max_attempts:
        log(f"{jid}: STUCK ({reason}) — attempts {attempts}/{max_attempts} "
            f"khatm → FAILED (terminal, naya job nahi banega)")
        patch = {"status": "failed", "last_heartbeat": None,
                 "payload": {**payload, "_ops_marker": marker}}
        if dry_run:
            log(f"  [dry-run] PATCH {patch}")
            audit_failed(job, reason, dry_run=True)
            return "failed"
        try:
            conditional_patch(jid, patch)
        except Exception as e:  # noqa: BLE001
            log(f"{jid}: failed-mark PATCH fail ({type(e).__name__}) — chhoda")
            return "skipped"
        fresh = fetch_job(jid)
        if not fresh or (fresh.get("payload") or {}).get("_ops_marker") != marker:
            log(f"{jid}: race — kisi aur ne pehle handle kar liya, audit skip")
            return "skipped"
        audit_failed(job, reason, dry_run=False)
        return "failed"

    resume_idx, resume_note = parse_resume_index(cur, payload)
    new_payload = {**payload,
                   "resume_from_step": resume_idx,
                   "resume_from_label": str(cur or "")[:120],
                   "resume_note": resume_note[:200],
                   "_ops_marker": marker}
    log(f"{jid}: STUCK ({reason}) — wapas queued "
        f"(attempt {attempts}/{max_attempts}). {resume_note}. "
        f"current_step preserved: {(str(cur or '')[:50] or '—')}")
    patch = {"status": "queued", "run_after": now_iso(),
             "last_heartbeat": None, "payload": new_payload}
    if dry_run:
        log(f"  [dry-run] PATCH status=queued run_after=now "
            f"last_heartbeat=NULL resume_from_step={resume_idx}")
        audit_requeued(job, reason, resume_idx, dry_run=True)
        return "requeued"
    try:
        conditional_patch(jid, patch)
    except Exception as e:  # noqa: BLE001
        log(f"{jid}: requeue PATCH fail ({type(e).__name__}) — chhoda")
        return "skipped"
    fresh = fetch_job(jid)
    if not fresh or (fresh.get("payload") or {}).get("_ops_marker") != marker:
        log(f"{jid}: race — kisi aur ne pehle handle kar liya, audit skip")
        return "skipped"
    audit_requeued(job, reason, resume_idx, dry_run=False)
    return "requeued"


def main() -> int:
    ap = argparse.ArgumentParser(description="ClipFlow ops monitor — stuck device_jobs repair")
    ap.add_argument("--dry-run", action="store_true",
                    help="sirf batayega, kuchh badlega nahi")
    ap.add_argument("--limit", type=int, default=FETCH_LIMIT,
                    help="ek run me zyada se zyada kitne jobs dekhe")
    args = ap.parse_args()

    if config.MISSING_CORE:
        log(f"FATAL: env missing: {config.MISSING_CORE}")
        return 2
    if args.dry_run:
        log("*** DRY-RUN: koi write NAHI hoga — sirf report ***")
    else:
        log("LIVE mode: stuck jobs repair honge (status/payload writes)")

    try:
        jobs = config.sb_request(
            "GET", "/rest/v1/device_jobs",
            query={"status": "in.(dispatched,running)",
                   "select": ("id,user_id,device_id,type,status,attempts,"
                              "max_attempts,heartbeat_count,last_heartbeat,"
                              "created_at,current_step,payload"),
                   "order": "created_at.asc",
                   "limit": str(args.limit)})
    except Exception as e:  # noqa: BLE001
        log(f"FATAL: fetch failed {type(e).__name__}: {e}")
        return 1
    jobs = jobs or []
    log(f"{len(jobs)} live job(s) mile (dispatched/running)")

    counts = {"requeued": 0, "failed": 0, "skipped": 0, "healthy": 0}
    for job in jobs:
        stale, _ = is_stale(job)
        if not stale:
            counts["healthy"] += 1
            continue
        try:
            outcome = handle(job, args.dry_run)
        except Exception as e:  # noqa: BLE001
            log(f"{job.get('id')}: handle me dikkat ({type(e).__name__}: {e}) — chhoda")
            outcome = "skipped"
        counts[outcome] = counts.get(outcome, 0) + 1

    log(f"summary: healthy={counts['healthy']} requeued={counts['requeued']} "
        f"failed={counts['failed']} skipped={counts['skipped']}"
        + (" (dry-run — kuchh badla nahi)" if args.dry_run else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
