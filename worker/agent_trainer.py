#!/usr/bin/env python3
"""agent_trainer.py — run ke baad agent skills ko seekh/padhao (training loop).

Iska kaam:
  1. Pichhle 24h ke terminal device_jobs (succeeded/failed/timeout, max 200)
     + unke job_runs scan karo.
  2. Har job type ko skill_key se map karo (job type -> skill):
       automation         -> upload-coordinator, submit-verifier
       join_campaign      -> campaign-scout
       verify_campaigns   -> campaign-scout
       discover_campaigns -> campaign-scout
  3. Har (user, skill) ke liye agent_memory me skill_lesson likho —
     (user, skill, error-signature) key se dedup, taaki wahi galti ka
     lesson dobara-dobara na likhe.
  4. agent_skills ka eval_history badhao aur mastery_score dobara compute
     karo, aur fail-closed gate lagao: mastery < 0.6 -> needs_review=true.

MASTERY FORMULA (transparent, rule-based — koi fake ML nahi):
    mastery = 0.5 * success_rate(last 10 evals)
           + 0.3 * success_rate(last 30 evals)
           + 0.2 * 0.5   (prior: koi history nahi ho to bhi ~0.1 se start,
                           taaki gate fail-closed rahe)
    success_rate([]) = 0.0  (no history = fail-closed ki taraf)

Eval entry: {"ts": iso8601, "outcome": "success"|"fail", "job_id": <id>}.
eval_history cap: 50 entries (purani sabse pehle hat-ti hain).

Tables (migration me bane; maujood hone chahiye):
    agent_memory(user_id, agent_id, kind, key, content jsonb,
                 importance, expires_at)
    agent_skills(user_id, skill_key, version, spec, mastery_score,
                 eval_history jsonb, needs_review)

CLI:
    python agent_trainer.py --dry-run   # default: sirf print, kuch nahi likhega
    python agent_trainer.py --apply     # asal me DB me likhega
Koi write --apply ke bina nahi hoti.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import config  # noqa: E402

# --------------------------------------------------------------------------
# helpers (planner_v2.py jaisa hi pattern)
# --------------------------------------------------------------------------

def log(msg: str) -> None:
    print(f"[agent_trainer] {msg}", flush=True)


def sb_retry(method: str, path: str, query: dict | None = None,
             body: dict | None = None, tries: int = 10):
    # config.sb_request ke andar hi transient retry + backoff + jitter hai.
    return config.sb_request(method, path, body=body, query=query,
                             timeout=60, tries=tries)


def sb_get_rows(table: str, query: dict) -> list:
    res = sb_retry("GET", f"/rest/v1/{table}", query=query)
    if isinstance(res, list):
        return [r for r in res if isinstance(r, dict)]
    return [res] if isinstance(res, dict) else []


# --------------------------------------------------------------------------
# mapping + outcome
# --------------------------------------------------------------------------

JOB_TYPE_TO_SKILLS: dict[str, list[str]] = {
    # automation job = render -> upload -> submit ka full chain;
    # dono skills touch hote hain (fail kahin bhi ho).
    "automation": ["upload-coordinator", "submit-verifier"],
    "join_campaign": ["campaign-scout"],
    "verify_campaigns": ["campaign-scout"],
    "discover_campaigns": ["campaign-scout"],
}

TERMINAL_STATUSES = ("succeeded", "failed", "timeout")

MASTERY_GATE = 0.6
EVAL_HISTORY_CAP = 50
LESSON_TTL_DAYS = 90


def _as_dict(v) -> dict:
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        try:
            d = json.loads(v or "{}")
            return d if isinstance(d, dict) else {}
        except Exception:
            return {}
    return {}


def error_signature(job: dict, latest_run_result: dict) -> str:
    """Fail ka 'signature' — chhota, stable, dedup-able string.

    Pehle job_runs ka latest result, phir job.result, phir status.
    IDs/hexes normalize nahi karte — sirf lowercase + truncate (120).
    Succeeded jobs ke liye signature 'ok'."""
    status = (job.get("status") or "").lower()
    if status == "succeeded":
        return "ok"
    raw = (latest_run_result.get("error")
           or latest_run_result.get("reason")
           or _as_dict(job.get("result")).get("error")
           or _as_dict(job.get("result")).get("reason")
           or status or "fail")
    sig = re.sub(r"\s+", " ", str(raw)).strip().lower()[:120]
    return sig or "fail"


def outcome_of(status: str) -> str:
    return "success" if (status or "").lower() == "succeeded" else "fail"


# --------------------------------------------------------------------------
# mastery
# --------------------------------------------------------------------------

def mastery_score(history: list) -> float:
    """mastery = 0.5*last10_success_rate + 0.3*last30_success_rate + 0.2*0.5.

    history: eval entries (nayi sabse pehle, ya purani — slice-tail lete hain).
    Empty history -> 0.1 (fail-closed, gate pakdega)."""
    if not history:
        return 0.2 * 0.5
    tail = history[-50:]  # sabse nayi entries
    last10 = tail[-10:]
    last30 = tail[-30:]

    def rate(evs: list) -> float:
        return sum(1 for e in evs
                   if e.get("outcome") == "success") / len(evs)

    return round(0.5 * rate(last10) + 0.3 * rate(last30) + 0.2 * 0.5, 4)


# --------------------------------------------------------------------------
# scan
# --------------------------------------------------------------------------

def scan_jobs(hours: int = 24, limit: int = 200) -> list:
    since = (datetime.now(timezone.utc)
             - timedelta(hours=hours)).isoformat()
    rows = sb_get_rows("device_jobs", {
        "created_at": f"gte.{since}",
        "status": f"in.({','.join(TERMINAL_STATUSES)})",
        "select": "id,user_id,type,status,created_at,result",
        "order": "created_at.desc",
        "limit": str(limit),
    })
    log(f"scan: pichhle {hours}h me {len(rows)} terminal jobs mile")
    return rows


def latest_run_results(job_ids: list[str]) -> dict[str, dict]:
    """Har job_id -> latest job_runs.result (empty dict agar koi run nahi)."""
    out: dict[str, dict] = {}
    if not job_ids:
        return out
    # PostgREST URL length safe rakho: 50 id ke chunk me.
    for i in range(0, len(job_ids), 50):
        chunk = job_ids[i:i + 50]
        rows = sb_get_rows("job_runs", {
            "job_id": f"in.({','.join(chunk)})",
            "select": "job_id,result,created_at",
            "order": "created_at.desc",
            "limit": str(len(chunk) * 20),
        })
        for r in rows:
            jid = r.get("job_id")
            if jid and jid not in out:
                out[jid] = _as_dict(r.get("result"))
    return out


# --------------------------------------------------------------------------
# plan (dry-run aur apply dono ke liye same)
# --------------------------------------------------------------------------

def build_plan(jobs: list, run_results: dict[str, dict]) -> dict:
    """Returns plan dict: lessons (list of rows to insert),
    skill_updates (list of (user_id, skill_key, history, mastery, review))."""
    lessons: list[dict] = []
    seen_lesson_keys: set[str] = set()
    # (user_id, skill_key) -> list of eval entries
    evals: dict[tuple[str, str], list[dict]] = {}
    now = datetime.now(timezone.utc).isoformat()

    for j in jobs:
        jtype = (j.get("type") or "").strip()
        skills = JOB_TYPE_TO_SKILLS.get(jtype)
        if not skills:
            continue
        uid = j.get("user_id") or ""
        if not uid:
            continue
        status = (j.get("status") or "")
        oc = outcome_of(status)
        sig = error_signature(j, run_results.get(j.get("id"), {}))
        ts = j.get("created_at") or now
        for sk in skills:
            evals.setdefault((uid, sk), []).append({
                "ts": ts, "outcome": oc, "job_id": j.get("id"),
                "job_type": jtype,
            })
            if oc == "fail":
                # ONE lesson per (user, skill, error-signature), dedup by key
                raw_key = f"skill_lesson:{sk}:{sig}"
                key = "skill_lesson:" + hashlib.sha1(
                    raw_key.encode()).hexdigest()[:16]
                if key in seen_lesson_keys:
                    continue
                seen_lesson_keys.add(key)
                lessons.append({
                    "user_id": uid,
                    "agent_id": None,
                    "kind": "skill_lesson",
                    "key": key,
                    "content": {
                        "skill_key": sk,
                        "job_type": jtype,
                        "job_id": j.get("id"),
                        "outcome": oc,
                        "error_signature": sig,
                        "lesson": (f"{jtype} job {j.get('id', '')[:8]} me fail "
                                   f"— signature: {sig}. Agli baar ye pattern "
                                   f"dikhe to run fail-closed rakho, "
                                   f"retry-blind mat karo."),
                    },
                    "importance": 0.7,
                    "expires_at": (datetime.now(timezone.utc)
                                   + timedelta(days=LESSON_TTL_DAYS)
                                   ).isoformat(),
                })

    skill_updates = []
    for (uid, sk), new_evals in evals.items():
        existing = sb_get_rows("agent_skills", {
            "user_id": f"eq.{uid}", "skill_key": f"eq.{sk}",
            "select": "id,version,eval_history,mastery_score",
            "limit": "1",
        })
        row = existing[0] if existing else None
        hist = row.get("eval_history") if row else []
        if isinstance(hist, str):
            try:
                hist = json.loads(hist or "[]")
            except Exception:
                hist = []
        if not isinstance(hist, list):
            hist = []
        merged = (hist + sorted(new_evals, key=lambda e: e.get("ts", "")))
        merged = merged[-EVAL_HISTORY_CAP:]
        m = mastery_score(merged)
        review = m < MASTERY_GATE
        skill_updates.append({
            "user_id": uid, "skill_key": sk, "row_id": row.get("id") if row else None,
            "version": (row.get("version") if row else None) or "1",
            "new_evals": len(new_evals), "eval_history": merged,
            "mastery_score": m, "needs_review": review,
            "prev_mastery": row.get("mastery_score") if row else None,
        })
    return {"lessons": lessons, "skill_updates": skill_updates}


def print_plan(plan: dict) -> None:
    lessons = plan["lessons"]
    updates = plan["skill_updates"]
    log(f"PLAN: {len(lessons)} skill_lesson(s), "
        f"{len(updates)} skill row(s) update honge")
    for u in updates:
        log(f"  skill={u['skill_key']} user={u['user_id'][:8]}… "
            f"+{u['new_evals']} evals mastery {u['prev_mastery']} -> "
            f"{u['mastery_score']} needs_review={u['needs_review']}")
    for l in lessons:
        c = l["content"]
        log(f"  lesson: {c['skill_key']} / {c['error_signature'][:60]}")


def apply_plan(plan: dict) -> None:
    # 1) lessons — dedup key se pehle check, taaki dobara na likhe
    wrote_lessons = 0
    skipped = 0
    for l in plan["lessons"]:
        exist = sb_get_rows("agent_memory", {
            "user_id": f"eq.{l['user_id']}",
            "kind": "eq.skill_lesson",
            "key": f"eq.{l['key']}",
            "select": "id", "limit": "1",
        })
        if exist:
            skipped += 1
            continue
        sb_retry("POST", "/rest/v1/agent_memory", body=l, query={})
        wrote_lessons += 1
    log(f"lessons: {wrote_lessons} likhe, {skipped} pehle se the (skip)")

    # 2) skill rows — read-then-write (upsert constraint pe bharosa nahi)
    patched = 0
    created = 0
    for u in plan["skill_updates"]:
        patch = {
            "eval_history": u["eval_history"],
            "mastery_score": u["mastery_score"],
            "needs_review": u["needs_review"],
        }
        if u["row_id"]:
            config.sb_patch("agent_skills", u["row_id"], patch)
            patched += 1
        else:
            sb_retry("POST", "/rest/v1/agent_skills", body={
                "user_id": u["user_id"], "skill_key": u["skill_key"],
                "version": u["version"], "spec": None, **patch,
            }, query={})
            created += 1
        if u["needs_review"]:
            log(f"  GATE: {u['skill_key']} mastery {u['mastery_score']} < "
                f"{MASTERY_GATE} -> needs_review=true")
    log(f"skills: {patched} patched, {created} naye rows")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="sirf plan print karo (default)")
    ap.add_argument("--apply", action="store_true",
                    help="asal me DB me likho")
    args = ap.parse_args()
    do_apply = args.apply and not args.dry_run
    if args.apply and args.dry_run:
        log("dono --dry-run aur --apply diye — dry-run jeetega")
    log("DRY-RUN mode (kuch nahi likhega)" if not do_apply
        else "*** APPLY mode: DB me likhega ***")

    try:
        jobs = scan_jobs()
    except Exception as e:  # noqa: BLE001
        log(f"scan fail ({type(e).__name__}): {e} — kuch nahi badla")
        return 2
    run_results = latest_run_results([j.get("id") for j in jobs if j.get("id")])
    plan = build_plan(jobs, run_results)
    print_plan(plan)
    if not do_apply:
        log("dry-run khatm — --apply ke bina kuch nahi likha")
        return 0
    try:
        apply_plan(plan)
    except Exception as e:  # noqa: BLE001
        log(f"apply fail ({type(e).__name__}): {e}")
        return 3
    log("apply poora hua")
    return 0


if __name__ == "__main__":
    sys.exit(main())
