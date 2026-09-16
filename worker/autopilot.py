#!/usr/bin/env python3
"""
ClipFlow autopilot — fully automated per-user clipping agent.

One pass:  python3 autopilot.py --once     (meant for cron)

Per user (discovered via GET /api/worker/users, scoped with
config.set_worker_user):
  1. Guard checks (autopilot enabled, IG + Whop connected, daily target not
     reached, spacing respected, no open intervention, pipeline not full).
  2. Pick the best active campaign (payout x remaining budget).
  3. brain.pick_moment() finds the best clip window in the brief source.
  4. Dedup against existing clips (>40% overlap on same campaign+source).
  5. POST /api/clips -> render via pipeline_worker.render_step ->
     optional auto-approve -> pipeline_worker.process_approved
     (schedule -> post -> live verify -> Whop submit).

Never claims success without API confirmation. Never retries on
action-block: process_approved already stops, and the open-intervention
guard prevents pile-up. Never logs secrets.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402
import brain  # noqa: E402


def _log(msg: str) -> None:
    print(f"[autopilot] {msg}", flush=True)


def _skip(reason: str) -> None:
    """Record a skip and stop this user's pass."""
    config.activity("autopilot_skip", reason)
    _log(f"skip: {reason}")


def _parse_ts(value) -> float | None:
    if not value:
        return None
    try:
        s = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return None


def _has_service(connections: list, service: str) -> bool:
    return any((c or {}).get("service") == service for c in connections)


def autopilot_pass() -> None:
    uid = config.WORKER_USER_ID
    _log(f"user {uid}: pass start")

    # ---- guard 1: autopilot enabled ------------------------------------
    settings = config.api("GET", "/api/settings", timeout=30).get(
        "settings", {}) or {}
    if settings.get("autopilot_enabled", True) is False:
        _skip("autopilot disabled in settings")
        return

    # ---- guard 2/3: connections ----------------------------------------
    # (worker per-service routes don't exist; the list endpoint is the
    #  real source of truth for connected services)
    conns = config.api("GET", "/api/connections", timeout=30).get(
        "connections", []) or []
    if not _has_service(conns, "instagram"):
        _skip("no instagram connection saved")
        return
    if not _has_service(conns, "whop"):
        _skip("no whop connection saved")
        return

    # ---- guard 4: daily target ------------------------------------------
    stats = config.api("GET", "/api/stats", timeout=30).get("stats", {}) or {}
    if (stats.get("posted") or 0) >= (stats.get("target") or 4):
        _skip(f"daily target reached ({stats.get('posted')}/{stats.get('target')})")
        return

    # ---- guard 5: spacing ------------------------------------------------
    posts = config.api("GET", "/api/posts", timeout=30).get("posts", []) or []
    latest: float | None = None
    for p in posts:
        ts = _parse_ts(p.get("posted_at")) or _parse_ts(p.get("scheduled_for"))
        if ts and (latest is None or ts > latest):
            latest = ts
    spacing_h = float(settings.get("spacing_hours") or 4)
    if latest and (time.time() - latest) < spacing_h * 3600:
        _skip(f"spacing: last post < {spacing_h}h ago")
        return

    # ---- guard 6: open intervention -------------------------------------
    # real worker status is 'pending' (there is no 'open' status)
    pending = config.api(
        "GET", "/api/interventions?status=pending", timeout=30).get(
        "interventions", []) or []
    if pending:
        _skip(f"{len(pending)} pending intervention(s) — owner input needed")
        return

    # ---- guard 7: pipeline capacity --------------------------------------
    if (stats.get("in_pipeline") or 0) >= 2:
        _skip(f"pipeline full ({stats.get('in_pipeline')} in flight)")
        return

    # ---- campaign pick ----------------------------------------------------
    campaigns = config.api("GET", "/api/campaigns", timeout=30).get(
        "campaigns", []) or []
    scored = []
    for c in campaigns:
        if not c.get("active", True) or not c.get("brief_url"):
            continue
        score = float(c.get("payout_per_1k_usd") or 0) * \
            float(c.get("budget_remaining_usd") or 0)
        if score > 0:
            scored.append((score, c))
    if not scored:
        _skip("no active campaign with brief_url and positive payout*budget")
        return
    scored.sort(key=lambda t: t[0], reverse=True)
    campaign = scored[0][1]
    cid = campaign["id"]
    brief_url = campaign["brief_url"]
    lo = float(campaign.get("min_duration_sec") or 15)
    hi = float(campaign.get("max_duration_sec") or 50)
    _log(f"user {uid}: campaign '{campaign.get('name')}' ({cid}) "
         f"score={scored[0][0]:.1f}")

    # ---- keywords from campaign copy --------------------------------------
    _tags = campaign.get("hashtags") or []
    if isinstance(_tags, str):
        _tags = [t.strip() for t in _tags.replace(",", " ").split() if t.strip()]
    text_bits = " ".join([
        str(campaign.get("requirements") or ""),
        str(campaign.get("caption_template") or ""),
        " ".join(_tags),
    ])
    seen_kw: list[str] = []
    for w in re.findall(r"[a-z]{4,}", text_bits.lower()):
        if w not in seen_kw:
            seen_kw.append(w)
            if len(seen_kw) >= 30:
                break

    # ---- brain: pick the moment -------------------------------------------
    moment = brain.pick_moment(brief_url, lo, hi, seen_kw)
    if not moment:
        _skip(f"brain found no usable moment in {brief_url[:80]}")
        return
    start, end = int(moment["start_sec"]), int(moment["end_sec"])
    _log(f"user {uid}: moment {start}-{end}s hook='{moment['hook_text'][:60]}'")

    # ---- dedup: >40% overlap with an existing clip -------------------------
    clips = config.api("GET", "/api/clips", timeout=30).get("clips", []) or []
    new_len = max(end - start, 1)
    for cl in clips:
        if str(cl.get("campaign_id")) != str(cid):
            continue
        if (cl.get("source_url") or "") != brief_url:
            continue
        try:
            cs, ce = int(cl.get("start_sec")), int(cl.get("end_sec"))
        except (TypeError, ValueError):
            continue
        overlap = max(0, min(end, ce) - max(start, cs))
        if overlap / new_len > 0.4:
            _skip(f"moment overlaps >40% with existing clip {cl.get('id')}")
            return

    # ---- caption -----------------------------------------------------------
    caption = (str(campaign.get("caption_template") or "")
               .replace("{hook}", moment["hook_text"])
               + "\n" + " ".join(_tags)).strip()

    # ---- create the clip job ------------------------------------------------
    created = config.api("POST", "/api/clips", {
        "campaign_id": cid,
        "source_url": brief_url,
        "start_sec": start,
        "end_sec": end,
        "hook_text": moment["hook_text"],
        "caption": caption,
    }, timeout=60)
    clip = created.get("clip") or created
    jid = clip.get("id")
    if not jid:
        raise RuntimeError(f"POST /api/clips returned no id: {created}")
    _log(f"user {uid}: clip job created ({jid})")
    config.activity("autopilot_clip_created",
                    f"campaign {cid} moment {start}-{end}s", jid)

    # ---- render --------------------------------------------------------------
    import pipeline_worker  # noqa: E402  (has __main__ guard; safe to import)

    job = {"id": jid, "source_url": brief_url, "start_sec": start,
           "end_sec": end, "campaign_id": cid}
    pipeline_worker.render_step(job)

    # ---- refresh; optional auto-approve --------------------------------------
    job = _refresh_job(jid)
    _log(f"user {uid}: after render status={job.get('status')}")
    if job.get("status") == "preview" and \
            settings.get("auto_approve", True) is not False:
        approved = config.api("POST", f"/api/clips/{jid}/approve",
                              timeout=60)
        job = approved.get("clip") or _refresh_job(jid)
        _log(f"user {uid}: auto-approved, status={job.get('status')}")
        config.activity("autopilot_auto_approved", "", jid)

    # ---- post pipeline ---------------------------------------------------------
    if job.get("status") == "approved":
        pipeline_worker.process_approved(job)
        _log(f"user {uid}: process_approved finished for {jid}")
    else:
        _log(f"user {uid}: job {jid} left at status={job.get('status')} "
             f"(not approved — will not post)")


def _refresh_job(jid: str) -> dict:
    """GET /api/jobs/{jid} -> job dict. Raises if the API disagrees."""
    data = config.api("GET", f"/api/jobs/{jid}", timeout=30)
    job = data.get("job")
    if not isinstance(job, dict) or not job.get("id"):
        raise RuntimeError(f"GET /api/jobs/{jid} returned no job: {data}")
    return job


def main() -> None:
    parser = argparse.ArgumentParser(description="ClipFlow autopilot agent")
    parser.add_argument("--once", action="store_true",
                        help="run a single pass over all users (for cron)")
    args = parser.parse_args()
    if not args.once:
        parser.print_help()
        return

    config.check_live_dryrun()
    users = config.api("GET", "/api/worker/users", timeout=30).get(
        "users", []) or []
    if not users:
        _log("no users with connections — nothing to do")
        return
    for u in users:
        uid = (u or {}).get("user_id")
        if not uid:
            continue
        try:
            config.set_worker_user(uid)
            autopilot_pass()
        except Exception as e:  # noqa: BLE001  per-user catch-all
            _log(f"user {uid}: pass failed: {e}")
            try:
                config.activity("autopilot_error", str(e)[:300])
            except Exception:
                pass
        finally:
            config.set_worker_user(None)
    _log("pass complete")


if __name__ == "__main__":
    main()
