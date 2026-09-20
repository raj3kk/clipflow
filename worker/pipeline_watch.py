#!/usr/bin/env python3
"""
pipeline_watch.py — Run Now → full pipeline request watcher (1-min cron).

POST /api/devices/:id/run-pipeline se `pending` request aati hai.
Is script ka kaam:
  1. `pending` requests oldest-first uthao (service_role).
  2. Request ko `running` mark karo (started_at).
  3. Shared cap check: v1 posts.posted_at + v2 device_jobs.created_at,
     rolling 24h — terminal-failed jobs (3+ attempts me complete na hui)
     cap me count NAHI hoti (user-set rule 2026-09-19) — >=4 → request
     `failed`, note='cap_full_24h'.
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

ORPHAN RECLAIM (KAM 1, 2026-09-19): `running` request ka planner dead mile
(VM reboot → worker_boot badla, ya worker_pid dead) to status wapas
`pending` hota hai — sirf note nahi. attempts>=3 → terminal failed.

AUTO-RETRY (KAM 3, 2026-09-19): definitive fail (non-cap, attempts<3) pe
`failed` + `next_retry_at` (attempts*5 min baad); promote_retries() use
wapas `pending` karta hai. cap_full_24h kabhi retry nahi hota.

STAGE (KAM 2): handle() stage='taiyaar_ho_raha' set karta hai; planner
(PLANNER_REQUEST_ID env) har phase pe stage update karta hai.
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
# TESTING MODE (2026-09-20 — user order): saari limits TEMPORARILY removed
# jab tak production chain pass nahi hoti. cap check poori tarah bypass.
TESTING_NO_LIMITS = True
PLANNER_TIMEOUT_S = 50 * 60
MAX_ATTEMPTS = 3          # ek request zyada se zyada 3 baar try hogi (reclaim+retry milake)
RETRY_BACKOFF_MIN = 5     # failed → dobara koshish: attempts*5 min baad
STALE_RUNNING_MIN = 90    # bina pid/boot info ke itne min purana running = stale


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(msg: str) -> None:
    print(f"[pipeline_watch] {now_iso()} {msg}", flush=True)


def boot_id() -> str:
    """VM boot identifier — reboot ke baad badal jata hai (orphan detect)."""
    try:
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("btime "):
                    return line.split()[1]
    except Exception:  # noqa: BLE001
        pass
    return "unknown"


def _worker_alive(pid: int) -> bool:
    """worker_pid wala process zinda hai AUR wahi pipeline_watch hai?

    Sirf pid number check karna kaafi nahi (pid reuse ho sakta hai) —
    cmdline me pipeline_watch hona chahiye.
    """
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            cmd = f.read().replace(b"\0", b" ").decode("utf-8", "replace")
        return "pipeline_watch" in cmd
    except Exception:  # noqa: BLE001
        return False


def _planner_alive_on_vm() -> bool:
    """Kya is VM pe koi planner_v2.py process chal raha hai?

    Purane code ki rows me worker_pid nahi hota — tab yehi check batata hai
    ki planner zinda hai ya VM reboot me mar gaya.
    """
    try:
        out = subprocess.run(["pgrep", "-f", "[p]lanner_v2[.]py"],
                             capture_output=True, text=True, timeout=5)
        return out.returncode == 0 and bool(out.stdout.strip())
    except Exception:  # noqa: BLE001
        return True  # pata na chale to working maano (safe side)


def mark(req_id: str, status: str, note: str | None = None,
         extra: dict | None = None) -> None:
    patch = {"status": status,
             "finished_at": now_iso() if status in ("done", "failed") else None}
    if status == "running":
        patch["started_at"] = now_iso()
    if note is not None:
        patch["note"] = note[:500]
    if extra:
        patch.update(extra)
    config.sb_patch("pipeline_requests", req_id, patch)


def requeue(req_id: str, note: str) -> None:
    """Transient blip → request wapas `pending` (agla run retry karega).

    Kabhi failed mark nahi hota — yahi 2026-09-19 ka core fix hai.
    Stage/pid/boot bhi reset taaki reclaim dobara na phase.
    """
    try:
        config.sb_patch("pipeline_requests", req_id,
                        {"status": "pending", "started_at": None,
                         "finished_at": None, "note": note[:500],
                         "stage": None, "stage_at": None,
                         "worker_pid": None, "worker_boot": None,
                         "next_retry_at": None})
    except Exception as e:  # noqa: BLE001
        log(f"{req_id}: requeue bhi fail ({type(e).__name__}) — "
            f"request pending/running hi rahegi, agla fetch retry karega")
        return
    log(f"{req_id}: transient → wapas pending (retry agle run me)")


def mark_failed(req_id: str, note: str, attempts: int,
                retryable: bool = True) -> None:
    """Definitive failure.

    retryable (non-cap, attempts<MAX) → status `failed` + `next_retry_at`
    (kuch min baad khud-b-khud dobara koshish hogi — KAM 3 auto-retry).
    cap_full_24h ya 3 attempts poore → terminal failed, koi retry nahi.
    """
    extra: dict = {"stage": None, "stage_at": None}
    clean = note
    if retryable and attempts < MAX_ATTEMPTS:
        wait_min = RETRY_BACKOFF_MIN * max(attempts, 1)
        extra["next_retry_at"] = (
            datetime.now(timezone.utc)
            + timedelta(minutes=wait_min)).isoformat()
        clean = (f"{note} | dobara koshish {wait_min} min baad "
                 f"({attempts}/{MAX_ATTEMPTS})")
        log(f"{req_id}: failed → auto-retry {wait_min} min me "
            f"(attempt {attempts}/{MAX_ATTEMPTS})")
    else:
        extra["next_retry_at"] = None
        if attempts >= MAX_ATTEMPTS:
            clean = f"{note} | {MAX_ATTEMPTS} koshish ke baad ruk gaya"
        log(f"{req_id}: failed (terminal) — {note[:120]}")
    try:
        mark(req_id, "failed", clean, extra=extra)
    except Exception as e:  # noqa: BLE001
        log(f"{req_id}: mark(failed) bhi fail ({type(e).__name__})")


def mark_done(req_id: str, note: str) -> None:
    try:
        mark(req_id, "done", note,
             extra={"stage": "ho_gaya", "stage_at": now_iso()})
    except Exception as e:  # noqa: BLE001
        log(f"{req_id}: mark(done) fail ({type(e).__name__}) — "
            f"planner safal tha, request running reh sakti hai (reclaim dekhega)")


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


def _terminal_failure(j: dict) -> bool:
    """Ye job terminal failure hai — cap me count NAHI hogi.

    Rule (user-set 2026-09-19): jo automation 3+ attempts me sahi se
    complete NA hui (terminal failed, max attempts exhausted, bina proper
    completion ke fail) wo rolling 24h cap me count NAHI hoti. Sirf genuine
    attempts (queued/dispatched/running) aur successful completions gine
    jate hain. TS twin: lib/device_jobs.ts :: isTerminalFailure.
    """
    # 'failed' phone ki report pe hi terminal hota hai (attempts bache hon
    # to wapas 'queued'); 'timeout' sirf attempts>=max_attempts pe lagta hai.
    # Dono terminal failure = cap me count NAHI. Abhi-dispatched/running
    # (attempts exhaust bhi ho to) GENUINE attempt hai — fail hote hi cap
    # se bahar. TS twin: lib/device_jobs.ts :: isTerminalFailure.
    return (j.get("status") or "") in ("failed", "timeout")


def cap_count(uid: str) -> int:
    """v1 posts + v2 jobs (terminal-failure excluded), rolling 24h."""
    since = (datetime.now(timezone.utc)
             - timedelta(hours=CAP_WINDOW_H)).isoformat()
    posts = config.sb_request("GET", "/rest/v1/posts", query={
        "user_id": f"eq.{uid}", "posted_at": f"gte.{since}",
        "select": "id", "limit": "50"})
    jobs = config.sb_request("GET", "/rest/v1/device_jobs", query={
        "user_id": f"eq.{uid}", "created_at": f"gte.{since}",
        "status": "in.(queued,dispatched,running,succeeded,failed,timeout)",
        "select": "id,status,attempts,max_attempts", "limit": "50"})
    n_posts = len(posts) if isinstance(posts, list) else 0
    jobs = jobs if isinstance(jobs, list) else []
    n_jobs = sum(1 for j in jobs if not _terminal_failure(j))
    return n_posts + n_jobs


def run_planner(device_id: str, req_id: str) -> tuple[str, str]:
    """planner_v2.py --once chalao. Returns (outcome, tail_note).

    PLANNER_REQUEST_ID env se planner har phase pe pipeline_requests.stage
    update karta hai (website pe live progress — KAM 2).
    """
    env = dict(os.environ)
    env["PLANNER_DEVICE_ID"] = device_id
    env["PLANNER_REQUEST_ID"] = req_id
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
    attempts = req.get("attempts") or 0
    log(f"request {req_id} device={device_id} user={uid} "
        f"attempt={attempts + 1}/{MAX_ATTEMPTS}")

    # 1. running mark — attempts+1, worker pid/boot (orphan detect ke liye),
    #    stage reset. Ye bhi na ho paya to pending hi rehne do.
    try:
        mark(req_id, "running", extra={
            "attempts": attempts + 1,
            "worker_pid": os.getpid(),
            "worker_boot": boot_id(),
            "stage": "taiyaar_ho_raha",
            "stage_at": now_iso(),
            "next_retry_at": None,
        })
    except Exception as e:  # noqa: BLE001
        log(f"{req_id}: mark(running) failed "
            f"({type(e).__name__}: {e}) — pending rehta hai")
        return
    attempts += 1

    # 2. cap check — TESTING MODE me poori tarah bypass (user order 2026-09-20)
    # Production me wapas lagana hai jab full chain pass ho jaye.
    n = 0
    if not TESTING_NO_LIMITS:
        try:
            n = cap_count(uid)
        except Exception as e:  # noqa: BLE001
            if isinstance(e, config.TransientError) or _looks_transient_text(str(e)):
                requeue(req_id, f"transient cap-check: {type(e).__name__}: {e}")
            else:
                tb = traceback.format_exc()
                mark_failed(req_id,
                            f"cap check me dikkat: {type(e).__name__}\n{tb[-400:]}",
                            attempts)
                log(f"{req_id}: cap check definitive error → failed")
            return
        if n >= CAP_MAX:
            # cap-full kabhi auto-retry nahi hota — kal ka window wait karo
            mark_failed(req_id, "cap_full_24h", attempts, retryable=False)
            log(f"{req_id}: cap full (>=4/24h) → failed (no retry)")
            return

    # 3. planner chalao
    try:
        outcome, detail = run_planner(device_id, req_id)
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()
        if isinstance(e, config.TransientError) or _looks_transient_text(str(e)):
            requeue(req_id,
                    f"transient planner-launch: {type(e).__name__}: {e}")
        else:
            mark_failed(req_id,
                        f"watcher dikkat: {type(e).__name__}\n{tb[-400:]}",
                        attempts)
            log(f"{req_id}: watcher error {type(e).__name__} → failed")
        return

    # 4. planner ka outcome — definitive hi failed, transient wapas pending
    if outcome == "enqueued":
        mark_done(req_id, "pipeline enqueued")
        log(f"{req_id}: planner enqueued → done")
        return
    # discover_pending = "discover chal raha hai, wait karo" — FAIL NAHI HAI.
    # (2026-09-20 fix: pehle ye 3 attempts ke baad fail ho jata tha)
    if outcome == "skipped:discover_pending":
        requeue(req_id, "discover chal raha hai — agle tick me phir dekhenge")
        log(f"{req_id}: discover_pending → requeue (not failed)")
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
    mark_failed(req_id, note, attempts)
    log(f"{req_id}: planner outcome {outcome} → failed (auto-retry if eligible)")


def reclaim_orphans() -> None:
    """`running` requests jinka planner dead hai → wapas `pending`.

    Yahi KAM 1 ka core fix hai: sirf note NAHI, status bhi `pending` hota hai
    taaki agla watcher pass use uthaye. Teen case:
    1. VM reboot (worker_boot badal gaya) → turant orphan → turant reclaim.
    2. worker_pid dead (process nahi hai) → orphan → reclaim.
    3. Bina pid/boot info ke 90+ min purana → stale → reclaim.
    MAX_ATTEMPTS poore → terminal failed (infinite loop nahi).
    """
    try:
        running = config.sb_request(
            "GET", "/rest/v1/pipeline_requests",
            query={"status": "eq.running",
                   "select": "id,started_at,attempts,worker_pid,worker_boot",
                   "limit": "20"})
    except Exception as e:  # noqa: BLE001
        log(f"orphan-reclaim fetch failed ({type(e).__name__}) — skip")
        return
    boot = boot_id()
    now = datetime.now(timezone.utc)
    for r in running or []:
        rid = r["id"]
        att = r.get("attempts") or 0
        rboot = r.get("worker_boot")
        rpid = r.get("worker_pid")
        orphan = False
        reason = ""
        if rboot and rboot != boot:
            orphan, reason = True, "server restart hua tha"
        elif rpid and not _worker_alive(int(rpid)):
            orphan, reason = True, "planner process band ho gaya tha"
        else:
            started = r.get("started_at")
            age_min = 0.0
            if started:
                try:
                    age_min = (now - datetime.fromisoformat(started)
                               ).total_seconds() / 60
                except Exception:  # noqa: BLE001
                    age_min = 0.0
            if rpid or rboot:
                # pid/boot info hai aur process zinda → kaam chal raha hai
                if age_min > STALE_RUNNING_MIN:
                    orphan = True
                    reason = f"{int(age_min)} min se atka tha"
            elif not _planner_alive_on_vm():
                # purani row, VM pe koi planner nahi → pakka orphan
                # (VM reboot case — turant reclaim, 90 min wait nahi)
                orphan, reason = True, "server restart me planner ruk gaya tha"
            elif age_min > STALE_RUNNING_MIN:
                orphan = True
                reason = f"{int(age_min)} min se atka tha"
        if not orphan:
            continue
        if att >= MAX_ATTEMPTS:
            mark(rid, "failed",
                 f"{MAX_ATTEMPTS} koshish ke baad bhi poora nahi hua "
                 f"(aakhri wajah: {reason})"[:500],
                 extra={"stage": None, "stage_at": None,
                        "next_retry_at": None})
            log(f"{rid}: orphan lekin {MAX_ATTEMPTS} attempts → terminal failed")
            continue
        try:
            config.sb_patch("pipeline_requests", rid, {
                "status": "pending", "started_at": None, "finished_at": None,
                "worker_pid": None, "worker_boot": None,
                "stage": None, "stage_at": None, "next_retry_at": None,
                "note": (f"{reason} — dobara koshish ho rahi hai "
                         f"({att + 1}/{MAX_ATTEMPTS})")[:500]})
            log(f"{rid}: orphan ({reason}) → wapas pending "
                f"({att + 1}/{MAX_ATTEMPTS})")
        except Exception as e:  # noqa: BLE001
            log(f"{rid}: orphan requeue fail ({type(e).__name__})")


# ---------------------------------------------------------------------------
# KAM 4: phone-job heartbeat watchdog (P0, 2026-09-19).
# phone-poll se INDEPENDENT — pipeline_watch har 1 min chalta hai, isliye
# phone marr jaye (poll na aaye) tab bhi recovery hoti hai.
# TS twin: lib/device_jobs.ts :: reconcileStaleJobs (schedule-tick + jobs/next).
# Per-job cutoff: heartbeat_count>0 (heartbeat-capable app) → 10 min bina
# heartbeat = dead; purana app (0) → claim-time (last_heartbeat/created_at)
# se 45 min legacy cutoff — zinda lambi run beech me wapas queue na ho.
HEARTBEAT_TIMEOUT_MIN = 10
LEGACY_HEARTBEAT_TIMEOUT_MIN = 45


def _hb_stale(job: dict) -> bool:
    hb_count = job.get("heartbeat_count") or 0
    cutoff_min = (HEARTBEAT_TIMEOUT_MIN if hb_count > 0
                  else LEGACY_HEARTBEAT_TIMEOUT_MIN)
    base = job.get("last_heartbeat") or job.get("created_at")
    if not base:
        return False
    try:
        base_dt = datetime.fromisoformat(str(base).replace("Z", "+00:00"))
    except ValueError:
        return False
    if base_dt.tzinfo is None:
        base_dt = base_dt.replace(tzinfo=timezone.utc)
    age_min = (datetime.now(timezone.utc) - base_dt).total_seconds() / 60
    return age_min > cutoff_min


def reconcile_device_jobs() -> None:
    """KAM 4: dispatched/running jobs ka heartbeat stale → requeue/timeout."""
    try:
        jobs = config.sb_request(
            "GET", "/rest/v1/device_jobs",
            query={"status": "in.(dispatched,running)",
                   "select": ("id,user_id,device_id,attempts,max_attempts,"
                              "heartbeat_count,last_heartbeat,created_at"),
                   "limit": "50"})
    except Exception as e:  # noqa: BLE001
        log(f"device-job watchdog fetch failed ({type(e).__name__}) — skip")
        return
    requeued = timed_out = 0
    for j in jobs or []:
        if not _hb_stale(j):
            continue
        uid, did, jid = j.get("user_id"), j.get("device_id"), j["id"]
        att = j.get("attempts") or 0
        max_att = j.get("max_attempts") or 3
        try:
            if att < max_att:
                # NOTE (2026-09-19 fix): device_jobs me `note` column NAHI
                # hai — use PATCH me bhejne se PostgREST 400 (PGRST204) aata
                # hai aur poora watchdog action fail ho jata tha. Wajah
                # job_runs.result me record hoti hai (neeche).
                config.sb_patch("device_jobs", jid, {
                    "status": "queued",
                    "run_after": (datetime.now(timezone.utc)
                                  + timedelta(minutes=1)).isoformat()})
                config.sb_request("POST", "/rest/v1/job_runs", body=[{
                    "user_id": uid, "device_id": did, "job_id": jid,
                    "status": "timeout_requeued",
                    "finished_at": now_iso(),
                    "result": {"reason": "watchdog: heartbeat stale"}}])
                requeued += 1
                log(f"{jid}: heartbeat stale → requeued ({att}/{max_att})")
            else:
                # (note column nahi hai — wajah job_runs.result me hai)
                config.sb_patch("device_jobs", jid, {
                    "status": "timeout"})
                config.sb_request("POST", "/rest/v1/job_runs", body=[{
                    "user_id": uid, "device_id": did, "job_id": jid,
                    "status": "timeout",
                    "finished_at": now_iso(),
                    "result": {"reason": "watchdog: heartbeat stale — "
                                         "attempts exhausted"}}])
                # activity_log ka asli schema: user_id, actor, event,
                # detail(jsonb), ts — kind/title/ref_type wale purane
                # column kabhi the hi nahi (2026-09-19 fix).
                config.sb_request("POST", "/rest/v1/activity_log", body=[{
                    "user_id": uid, "actor": "worker",
                    "event": "job_timeout",
                    "detail": {"text": ("Phone se heartbeat band (watchdog) — "
                                        "attempts khatm, timeout mark kiya."
                                        )[:500]}}])
                timed_out += 1
                log(f"{jid}: heartbeat stale → TIMEOUT ({att}/{max_att})")
        except Exception as e:  # noqa: BLE001
            log(f"{jid}: watchdog update fail ({type(e).__name__})")
    if requeued or timed_out:
        log(f"watchdog: requeued={requeued} timed_out={timed_out}")


def promote_retries() -> None:
    """KAM 3: `failed` + next_retry_at aa gaya → wapas `pending` (auto-retry).

    Har retry pe stage reset; attempts handle() me +1 hota hai.
    """
    try:
        due = config.sb_request(
            "GET", "/rest/v1/pipeline_requests",
            query={"status": "eq.failed",
                   "next_retry_at": f"lte.{now_iso()}",
                   "select": "id,attempts",
                   "limit": "20"})
    except Exception as e:  # noqa: BLE001
        log(f"retry-promote fetch failed ({type(e).__name__}) — skip")
        return
    for r in due or []:
        att = r.get("attempts") or 0
        if att >= MAX_ATTEMPTS:
            continue
        try:
            config.sb_patch("pipeline_requests", r["id"], {
                "status": "pending", "started_at": None, "finished_at": None,
                "stage": None, "stage_at": None, "next_retry_at": None,
                "worker_pid": None, "worker_boot": None,
                "note": (f"dobara koshish ho rahi hai "
                         f"({att + 1}/{MAX_ATTEMPTS})")[:500]})
            log(f"{r['id']}: auto-retry → pending ({att + 1}/{MAX_ATTEMPTS})")
        except Exception as e:  # noqa: BLE001
            log(f"{r['id']}: promote retry fail ({type(e).__name__})")


def main() -> int:
    if config.MISSING_CORE:
        log(f"FATAL: env missing: {config.MISSING_CORE}")
        return 2
    try:
        pending = config.sb_request("GET", "/rest/v1/pipeline_requests",
                                    query={"status": "eq.pending",
                                           "select": "id,user_id,device_id,created_at,attempts",
                                           "order": "created_at.asc",
                                           "limit": "20"})
    except config.TransientError as e:
        # Network blip — FATAL nahi; agla run (1-min) retry karega
        log(f"transient fetch blip ({e}) — next run retry karega")
        return 0
    except Exception as e:  # noqa: BLE001
        log(f"FATAL: fetch failed {type(e).__name__}: {e}")
        return 1
    reclaim_orphans()
    promote_retries()
    reconcile_device_jobs()  # P0 watchdog — phone-poll independent
    if not pending:
        log("no pending requests")
        return 0
    for req in pending:
        handle(req)
    return 0


if __name__ == "__main__":
    sys.exit(main())
