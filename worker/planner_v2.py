#!/usr/bin/env python3
"""
ClipFlow v2 zero-touch planner — campaign se ready clip package tak, bina user input.

    python3 planner_v2.py --once [--dry-run]

Pipeline (VM pe chalta hai):
  1. CAP GUARD: pichhle 24h me v1 posts + v2 device_jobs >= 4 → SILENT SKIP.
     (join_campaign jobs bhi isi cap me gine jate hain.)
  2. AUTO-JOIN (Round-7, 2026-09-19; verified 2026-09-20 via browser):
     Whop ka campaign-join public API nahi deta, lekin phone ka WebView Whop
     me LOGGED-IN hai (user ne app me Whop login kiya tha). Best-fit campaign
     agar joined nahi hai to clip pipeline ki jagah pehle `join_campaign` job
     enqueue hoti hai (POST /api/devices/<id>/join-campaign →
     outcome `join_requested:<slug>`). Phone campaign page kholke Join dabata
     hai; result pe server campaigns.joined / join_status update karta hai.
     JOIN FLOW (2026-09-20 verified): contentrewards.com preview page ka
     "Join Campaign" button Whop app me deep-link karta hai (koi terms dialog
     nahi). Pehle us brand ka WHOP (community) join karna padta hai —
     FundingPips ka whop FREE tha (koi payment nahi). Whop join ke baad
     campaign Whop app me accessible: "Accepting clips" + "Submit clip"
     button = joined. Public preview page ka Join button reliable indicator
     NAHI hai (hamesha dikhta hai). Join safal hone ke baad agle tick me
     normal clip pipeline chalta hai.
     - needs_user (Whop login expire / extra verification) → dobara join job
       NAHI banti (cap bachao); user Campaigns tab me 'needs_user' dekhega.
     - live join job already hai → dobara nahi banti (dedup).
  3. JOINED campaigns lao (campaigns table), rank karo:
     payout_per_1k_usd × budget_remaining_usd × requirement-fit.
  3. Top campaign ka brief padho (min/max sec, requirements, caption_template,
     hashtags, brief_url, campaign_url).
  4. Moment chuno: campaign notes me curated moment ho to wahi, nahi to
     brain.pick_moment (v1 autopilot jaisa).
  5. Compliance: duration bounds + brand keyword moment text me hona chahiye.
  6. Dedup (per-account, Round-7):
     - clips table me har enqueue ke baad row likhi jati hai (pehle write
       missing thi → moment_fresh dead tha); >40% overlap → skip.
     - same video_url dobara kabhi enqueue nahi (video hard dedup).
     - same campaign is account se 7 din me dobara nahi (success cooldown).
     - 24h me 3+ fail/timeout wali campaign 48h blacklist.
  7. Source section download (yt-dlp / curl — official footage only,
     campaign rules todna mana hai).
  8. clip_factory v2 (face-tracked) se 1080x1920 render + QA.
  9. Caption banao (template {hook} + hashtags).
 10. Supabase `clips` bucket me upload → public URL.
 11. POST /api/devices/<id>/plan-job → phone ke liye automation job enqueue.
     429 (cap) → graceful skip.

SAKHT NIYAM: IG post aur Whop submit PHONE karta hai — ye script kabhi
Instagram/Whop pe post ya submit nahi karta. Sirf clip package banata hai.
Secrets kabhi log nahi hote.

Env: ~/.config/clipflow/worker.env se aata hai (cron wrapper source karta hai).
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402
import brain  # noqa: E402
from ytgrab import grab_section  # noqa: E402

DEVICE_ID = os.environ.get(
    "PLANNER_DEVICE_ID", "0771e32a-ab9f-4f25-85b0-3899535c54cf")
VENV_PY = os.path.expanduser("~/workspace/whop-edit-env/bin/python")
CAP_MAX = 4
CAP_WINDOW_H = 24
# TESTING MODE (user-set 2026-09-20): "abhi check hoga, jb production ready
# sara kch ok hoga tb lagayenge sara kch limitation" — testing me 4/24h cap,
# 7-day campaign cooldown, aur 48h fail-blacklist SAB disabled. Production
# pe isko False karo — limitations wapas lag jayengi.
TESTING_NO_LIMITS = True
WHOP_DEFAULT_SUBMIT = "https://whop.com/content-rewards/"
YT_PATTERNS = ("youtube.com/watch", "youtu.be/",
               "youtube.com/shorts/", "youtube.com/live/")


def log(msg: str) -> None:
    print(f"[planner_v2] {msg}", flush=True)


def activity(uid: str | None, event: str, detail: str = "") -> None:
    """Best-effort activity_log row (direct Supabase write). Never raises."""
    try:
        sb_retry("POST", "/rest/v1/activity_log",
                 body={"user_id": uid, "actor": "worker",
                       "event": event, "detail": {"text": detail[:500]}})
    except Exception as e:  # noqa: BLE001
        log(f"activity log failed ({event}): {type(e).__name__}")


# --------------------------------------------------------------------------
# supabase with retry — config.sb_request ke andar hi transient retry +
# backoff + jitter hai (6 tries). Ye wrapper sirf signature compatibility
# ke liye hai.
# --------------------------------------------------------------------------
def sb_retry(method: str, path: str, query: dict | None = None,
             body: dict | None = None, tries: int = 10,
             headers: dict | None = None):
    # 2026-09-20 CORE FIX: tries 6→10 (config.sb_request ke saath sync).
    # Egress proxy chronic flaky hai; 6 tries bad burst me kaafi nahi the.
    return config.sb_request(method, path, body=body, query=query,
                             timeout=60, tries=tries, headers=headers)


def sb_select_retry(table: str, filters: dict | None = None,
                    select: str = "*", limit: int = 100,
                    extra: dict | None = None) -> list:
    q: dict = {"select": select, "limit": str(limit)}
    if filters:
        for k, v in filters.items():
            q[k] = f"eq.{v}"
    if extra:
        q.update(extra)
    res = sb_retry("GET", f"/rest/v1/{table}", query=q)
    # 2026-09-20 CORE FIX: proxy kabhi-kabhi 200 pe junk body (JSON string)
    # bhej deta hai — pehle [res] me lipti str aage jaake
    # "'str' object has no attribute 'get'" se crash karti thi. Sirf dicts rakho.
    if isinstance(res, list):
        return [r for r in res if isinstance(r, dict)]
    return [res] if isinstance(res, dict) else []


# --------------------------------------------------------------------------
# stage progress — website pe live dikhta hai ("Abhi: Clip ban raha hai…").
# PLANNER_REQUEST_ID env watcher deta hai. Best-effort, kabhi raise nahi.
# --------------------------------------------------------------------------
def set_stage(name: str) -> None:
    rid = os.environ.get("PLANNER_REQUEST_ID")
    if not rid:
        return
    try:
        sb_retry("PATCH", "/rest/v1/pipeline_requests",
                 query={"id": f"eq.{rid}"},
                 body={"stage": name,
                       "stage_at": datetime.now(timezone.utc).isoformat()})
    except Exception:  # noqa: BLE001
        pass


# --------------------------------------------------------------------------
# 1. cap guard — v1 posts + v2 jobs (terminal-failure excluded), rolling 24h
# --------------------------------------------------------------------------
def _terminal_failure(j: dict) -> bool:
    """Terminal failure job — cap me count NAHI hoti.

    Rule (user-set 2026-09-19): jo automation 3+ attempts me sahi se
    complete NA hui (terminal failed, max attempts exhausted, bina proper
    completion ke fail) wo rolling 24h cap me count NAHI hoti. TS twin:
    lib/device_jobs.ts :: isTerminalFailure.
    """
    # 'failed' phone ki report pe hi terminal hota hai (attempts bache hon
    # to wapas 'queued'); 'timeout' sirf attempts>=max_attempts pe lagta hai.
    # Dono terminal failure = cap me count NAHI. Abhi-dispatched/running
    # (attempts exhaust bhi ho to) GENUINE attempt hai — fail hote hi cap
    # se bahar. TS twin: lib/device_jobs.ts :: isTerminalFailure.
    return (j.get("status") or "") in ("failed", "timeout")


def cap_count(uid: str) -> int:
    since = (datetime.now(timezone.utc)
             - timedelta(hours=CAP_WINDOW_H)).isoformat()
    posts = sb_retry("GET", "/rest/v1/posts", query={
        "user_id": f"eq.{uid}", "posted_at": f"gte.{since}",
        "select": "id", "limit": "50"})
    jobs = sb_retry("GET", "/rest/v1/device_jobs", query={
        "user_id": f"eq.{uid}", "created_at": f"gte.{since}",
        "status": "in.(queued,dispatched,running,succeeded,failed,timeout)",
        "select": "id,status,attempts,max_attempts", "limit": "50"})
    n_posts = len(posts) if isinstance(posts, list) else 0
    jobs = jobs if isinstance(jobs, list) else []
    n_jobs = sum(1 for j in jobs if not _terminal_failure(j))
    log(f"cap: v1 posts(24h)={n_posts} + v2 jobs(24h)={n_jobs} (terminal-failed excluded)")
    return n_posts + n_jobs


def get_device_user() -> tuple[str, str]:
    rows = sb_select_retry("devices", {"id": DEVICE_ID},
                           select="id,user_id,status,device_name")
    if not rows:
        raise RuntimeError(f"device {DEVICE_ID} not found")
    d = rows[0]
    if d.get("status") != "active":
        raise RuntimeError(f"device not active (status={d.get('status')})")
    return d["user_id"], d.get("device_name") or "phone"


# --------------------------------------------------------------------------
# 2. campaigns + ranking
# --------------------------------------------------------------------------
# Main hub UUID (shared pool marker — worker/mainhub.py se sync)
MAIN_HUB_USER_ID = "00000000-0000-0000-0000-000000000000"


# 2026-09-20 CORE FIX (egress proxy IncompleteRead):
# `notes` me full_brief JSON hai (~250KB / 26 rows) — proxy har baar connection
# kaat deta tha, 6 retries bhi fail. Ab list query LIGHT hai (notes NAHI),
# aur sirf CHUNI HUI campaign ka full row (~10KB) alag se aata hai.
_LIGHT_COLS = ("id,name,sponsor,payout_per_1k_usd,budget_remaining_usd,"
               "min_seconds,max_seconds,requirements,caption_template,"
               "hashtags,brief_url,campaign_url,joined,join_status")


def get_campaign_ids() -> list[str]:
    """Sirf campaign IDs — TINIEST query (~1KB, proxy-safe).
    2026-09-20 CORE FIX: 15KB wali light-list bhi proxy pe 0/10 fail ho rahi
    thi. Sirf IDs (~23B/row) 7/8 success deti hai. Detail har candidate ke
    liye alag-alag lazy fetch hoti hai."""
    rows = sb_select_retry(
        "campaigns", {"user_id": MAIN_HUB_USER_ID, "active": True},
        select="id", limit=50, extra={"order": "created_at.desc"})
    return [r["id"] for r in rows
            if isinstance(r, dict) and r.get("id")]


def get_campaigns(uid: str) -> list[dict]:
    """Main hub (shared pool) se LIGHT campaign list — notes KE BINA
    (proxy-safe, ~13KB). uid legacy signature ke liye; pool hamesha MAIN_HUB.
    Poori detail chahiye to get_campaign_full(cid) use karo.
    2026-09-20: NAYA code get_campaign_ids() use kare; ye sirf legacy
    callers ke liye bacha hai."""
    rows = sb_select_retry(
        "campaigns", {"user_id": MAIN_HUB_USER_ID, "active": True},
        select=_LIGHT_COLS, limit=30, extra={"order": "created_at.desc"})
    return [r for r in rows if isinstance(r, dict)]


def get_campaign_full(cid: str) -> dict | None:
    """Single campaign ka FULL row (notes ke saath) — chhota response
    (~10KB), proxy-safe. Selection ke BAAD sirf picked campaign pe call karo."""
    rows = sb_select_retry("campaigns", {"id": cid}, select="*", limit=1)
    for r in rows:
        if isinstance(r, dict) and r.get("id") == cid:
            return r
    return None


def _is_eligible(campaign: dict) -> bool:
    """2026-09-20: notes.eligible=false wale campaigns planner pool se bahar.
    (jaise Nilo — official Drive asset URL missing + IG Roblox-fit unverified).
    Explicit flag hai, reversible; activity me reason logged."""
    n = campaign.get("notes")
    if isinstance(n, str):
        try:
            n = json.loads(n or "{}")
        except Exception:
            return True
    if not isinstance(n, dict):
        return True
    return n.get("eligible") is not False


def select_campaign_via_server(uid: str) -> tuple[dict | None, str]:
    """Vercel server-side selection (2026-09-20).

    VM se Supabase tak ka network flaky hai — selection Vercel pe hota hai
    (reliable network), VM ko sirf ~3KB ka normalized campaign milta hai.

    Returns (campaign_or_None, reason): ok response pe (campaign, "ok");
    server ne refuse kiya to (None, server reason e.g. 'no_clip_ready');
    3 try ke baad exception to (None, 'server_unreachable').

    FAIL-CLOSED (2026-09-20): caller local pick_random_campaign fallback
    use NAHI karega — server ka classification (clip_ready | join_only |
    needs_phone | ugc_unsupported) bypass hota tha wo local pick se.
    Server se no/refusal mila to run skip hota hai.
    """
    import urllib.request
    url = config.CLIPFLOW_URL.rstrip("/") + "/api/worker/select-campaign"
    body = json.dumps({"user_id": uid}).encode()
    for i in range(3):
        try:
            req = urllib.request.Request(url, data=body, method="POST")
            req.add_header("Content-Type", "application/json")
            if config.WORKER_SECRET:
                req.add_header("x-worker-secret", config.WORKER_SECRET)
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode())
            if data.get("ok") and data.get("campaign"):
                c = data["campaign"]
                log(f"SERVER PICK: '{c.get('name')}' ({c.get('id')}) "
                    f"${c.get('payout_per_1k_usd')}/1k "
                    f"(pool={data.get('pool_size')}, brief={data.get('with_brief')}, "
                    f"class={c.get('classification')})")
                # Planner ke purane format se compatible banao
                c["notes"] = json.dumps({
                    "eligible": c.pop("notes_eligible", True),
                    "classification": c.get("classification", "clip_ready"),
                    "classification_reasons": c.get("classification_reasons", []),
                })
                return c, "ok"
            log(f"server select: {data.get('reason')} — local fallback HATA DIYA, fail-closed skip")
            return None, str(data.get("reason") or "unknown")
        except Exception as e:  # noqa: BLE001
            log(f"server select try {i + 1}/3: {type(e).__name__}")
            time.sleep(2 * (i + 1))
    log("server select fail — local fallback HATA DIYA, fail-closed skip")
    return None, "server_unreachable"


def pick_random_campaign(uid: str, exclude_ids=None) -> dict | None:
    """LOCAL campaign fallback — PERMANENTLY DISABLED (2026-09-20, fail-closed).

    Kyun: ye fallback /api/worker/select-campaign ka classification bypass
    karta tha (clip_ready | join_only | needs_phone | ugc_unsupported) —
    local random pick non-compliant campaign pe clip bana deta tha. Server
    selection hi source of truth hai; server refuse/unreachable ho to planner
    run skip karta hai (select site pe fail-closed). Function signature sirf
    import-compatibility ke liye rakha hai — call mat karo.
    """
    raise RuntimeError(
        "local campaign fallback disabled — fail closed, server selection only")


def is_joined(campaign: dict) -> bool:
    """Whop pe campaign join ho rakha hai? join_status ('joined') naya
    field hai jo Campaigns UI se set hota hai; joined legacy boolean."""
    return (campaign.get("join_status") == "joined") or bool(
        campaign.get("joined"))


# --------------------------------------------------------------------------
# 2b. verification-first (Round-7b): server ke paas Whop login NAHI hai,
# isliye campaign ka FINAL chunav phone karta hai (verify_campaigns job).
# Sirf fresh-verified (7d) campaigns pe clip banta hai — blind pick nahi.
# --------------------------------------------------------------------------
VERIFY_FRESH_DAYS = 7


def _notes_json(campaign: dict) -> dict:
    try:
        nj = json.loads(campaign.get("notes") or "")
        return nj if isinstance(nj, dict) else {}
    except Exception:
        return {}


def is_fresh_verified(campaign: dict) -> bool:
    """Phone ne Whop pe is campaign ko haal me verify kiya (7d)?"""
    va = _notes_json(campaign).get("verified_at")
    if not va or not isinstance(va, str):
        return False
    try:
        dt = datetime.fromisoformat(va.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return False
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - dt < timedelta(days=VERIFY_FRESH_DAYS)


def verified_video_url(campaign: dict) -> str:
    """Phone ne Whop page se nikala official video/footage link (verify ke
    waqt). Download isi se hota hai — server blind brief_url pe nahi."""
    links = _notes_json(campaign).get("verified_video_links") or []
    for l in links:
        if isinstance(l, str) and l.strip().startswith("http"):
            return l.strip()
    return ""


def verified_requirements(campaign: dict) -> str:
    req = _notes_json(campaign).get("verified_requirements")
    return req if isinstance(req, str) else ""


# --------------------------------------------------------------------------
# 2c. discover-first (2026-09-20 rebuild): koi active campaign nahi to
# SERVER contentrewards.com/discover se campaigns nikalta hai (PUBLIC,
# sign-in nahi chahiye). Phone discovery HATA DIYA (user order 2026-09-20:
# "App se campaign find krne wala jo h remove kro... server p workflow bna dena").
# --------------------------------------------------------------------------
def enqueue_discover(uid: str) -> dict:
    """Server-side discovery — discover_server.py use karta hai.
    CAP-EXEMPT (discovery, post nahi)."""
    try:
        from discover_server import server_discover
        res = server_discover(uid)
        if res.get("ok"):
            log(f"SERVER DISCOVER OK: {res.get('saved')}/{res.get('total')} "
                f"campaigns saved")
        return res
    except Exception as e:
        log(f"SERVER DISCOVER FAIL: {e}")
        return {"ok": False, "error": str(e)}


def enqueue_verify(uid: str,
                   ranked: list[tuple[float, dict]]) -> dict:
    """POST /api/devices/<id>/propose-campaigns — phone Whop pe candidates
    check karke best-fit choose karega (+ join agar zaroori). CAP-EXEMPT."""
    cands = []
    for score, c in ranked[:3]:
        url = (c.get("campaign_url") or "").strip()
        if not url:
            continue
        cands.append({
            "campaign_id": c["id"],
            "name": (c.get("name") or c["id"])[:120],
            "campaign_url": url,
            "payout_per_1k_usd": c.get("payout_per_1k_usd"),
        })
    if not cands:
        return {"ok": False, "error": "no candidates with campaign_url"}
    res = _post_worker(f"/api/devices/{DEVICE_ID}/propose-campaigns",
                       {"candidates": cands})
    if res.get("needs_app_update"):
        log(f"APP UPDATE PENDING: {res.get('error')} — user ko p23 install "
            f"karna hoga, tab tak verify nahi hoga")
        activity(uid, "verify_blocked_app_update",
                        str(res.get("error"))[:160])
        return {"ok": False, "needs_app_update": True,
                "error": res.get("error")}
    if res.get("ok") and not res.get("deduped"):
        log(f"VERIFY ENQUEUED: job {res.get('job_id')} — phone Whop pe "
            f"{len(cands)} candidates check karke best-fit choose karega")
        activity(uid, "verify_requested",
                        f"{len(cands)} candidates job={res.get('job_id')}")
    return res


def rank_campaigns(campaigns: list[dict], uid: str = "",
                    date_seed: str = "") -> list[tuple[float, dict]]:
    """Campaign selection criteria (2026-09-20 rebuild — user: 'badhiya
    campaign ka criteria fir se banao').

    Score = payout_per_1k × budget_factor × fit

    Fit factors:
    - Official footage (brief_url ya verified video links): REQUIRED.
      Nahi hai to 0.1x (clip ban hi nahi sakta).
    - Instagram platform support: REQUIRED. Nahi hai to skip.
    - Payout per 1k: core — zyada = behtar.
    - Budget remaining: zyada = campaign zyada chalega.
    - Requirements detailed (>100 chars): 1.3x — clear brief = kam rejection.
    - Hashtags/caption template: 1.15x — posting instructions clear.
    - Joined: 1.25x — join step skip, tez. (Not-joined bhi OK, auto-join hai.)
    - Fresh (<24h discovered): 1.2x — kam saturated.

    Per-user randomization: top candidates ko uid+date seed se shuffle karo
    taaki alag-alag users alag-alag campaigns pe kaam karein (duplicate
    submission se bachao).
    """
    scored: list[tuple[float, dict]] = []
    for c in campaigns:
        payout = float(c.get("payout_per_1k_usd") or 0)
        if payout <= 0:
            continue
        # Instagram support required
        platforms = str(c.get("platforms") or "").lower()
        if platforms and "instagram" not in platforms and "ig" not in platforms:
            log(f"campaign {c.get('id')}: Instagram support nahi — skip")
            continue
        budget = c.get("budget_remaining_usd")
        try:
            budget_f = float(budget) if budget and float(budget) > 0 else 1000.0
        except (TypeError, ValueError):
            budget_f = 1000.0
        fit = 1.0
        # Official footage — sabse zaroori
        has_footage = bool(c.get("brief_url")) or bool(
            verified_video_url(c))
        if has_footage:
            fit *= 1.5
        else:
            fit *= 0.1
        # Requirements quality
        req = str(c.get("requirements") or "")
        vreq = verified_requirements(c)
        req_len = max(len(req), len(vreq))
        if req_len > 200:
            fit *= 1.3
        elif req_len > 50:
            fit *= 1.15
        # Posting instructions clear
        if c.get("hashtags"):
            fit *= 1.15
        # Joined = tez (lekin not-joined bhi chalega, auto-join hai)
        if c.get("joined"):
            fit *= 1.25
        # Fresh = kam saturated
        try:
            notes = c.get("notes") or ""
            import json as _json
            nd = _json.loads(notes) if isinstance(notes, str) and notes.startswith("{") else {}
            disc = nd.get("discovered_at", "")
            if disc:
                from datetime import datetime, timezone
                dt = datetime.fromisoformat(disc.replace("Z", "+00:00"))
                age_h = (datetime.now(timezone.utc) - dt).total_seconds() / 3600
                if age_h < 24:
                    fit *= 1.2
        except Exception:
            pass
        score = payout * budget_f * fit
        scored.append((score, c))
    scored.sort(key=lambda t: t[0], reverse=True)
    # Per-user shuffle: top-10 me se uid+date seed se order badlo taaki
    # har user alag campaign uthaye
    if uid and date_seed and len(scored) > 1:
        import random as _random
        rng = _random.Random(f"{uid}:{date_seed}")
        top = scored[:10]
        rest = scored[10:]
        rng.shuffle(top)
        scored = top + rest
        log(f"rank: {len(scored)} campaigns, top-10 user-shuffled ({uid[:8]}…)")
    return scored


def extract_keywords(campaign: dict) -> list[str]:
    tags = campaign.get("hashtags") or []
    if isinstance(tags, str):
        tags = [tags]
    bits = " ".join([
        str(campaign.get("requirements") or ""),
        str(campaign.get("caption_template") or ""),
        " ".join(str(t) for t in tags),
        str(campaign.get("name") or ""),
    ])
    seen: list[str] = []
    for w in re.findall(r"[a-z]{4,}", bits.lower()):
        if w not in seen:
            seen.append(w)
            if len(seen) >= 30:
                break
    return seen


# --------------------------------------------------------------------------
# 4. moment pick (curated ya brain) + 5. compliance
# --------------------------------------------------------------------------
def curated_moment(campaign: dict) -> dict | None:
    """Campaign notes me scout ka verified moment ho to wahi lo."""
    try:
        nj = json.loads(campaign.get("notes") or "")
    except Exception:
        return None
    m = (nj or {}).get("moment") if isinstance(nj, dict) else None
    if not m or m.get("start_sec") is None or m.get("end_sec") is None:
        return None
    return {
        "start_sec": int(m["start_sec"]),
        "end_sec": int(m["end_sec"]),
        "hook_text": str(m.get("hook_text") or ""),
        "text": str(m.get("hook_text") or ""),
        "score": 1.0,
        "curated": True,
    }


def brand_keyword(campaign: dict) -> str | None:
    """Hashtags se brand nikalo, jaise #PerplexityPartner → 'perplexity'."""
    tags = campaign.get("hashtags") or []
    if isinstance(tags, str):
        tags = [tags]
    for t in tags:
        low = str(t).lower().lstrip("#")
        if low.endswith("partner"):
            core = low[:-len("partner")]
            if len(core) >= 3:
                return core
    return None


def moment_compliant(moment: dict, campaign: dict) -> tuple[bool, str]:
    lo = float(campaign.get("min_seconds") or 15)
    hi = float(campaign.get("max_seconds") or 60)
    dur = float(moment["end_sec"]) - float(moment["start_sec"])
    if not (lo <= dur <= hi):
        return False, f"duration {dur:.0f}s bounds [{lo:.0f},{hi:.0f}] ke bahar"
    brand = brand_keyword(campaign)
    if brand:
        text = f"{moment.get('text') or ''} {moment.get('hook_text') or ''}".lower()
        if brand not in text:
            return False, (f"brand '{brand}' moment text me nahi — "
                           f"brief ke 'heard+seen' rule ka risk")
    if not (moment.get("hook_text") or "").strip():
        return False, "hook_text khaali hai"
    return True, "ok"


# --------------------------------------------------------------------------
# 6. dedup (clips table, read-only)
# --------------------------------------------------------------------------
def moment_fresh(uid: str, cid: str, source_url: str,
                 start: int, end: int) -> bool:
    clips = sb_select_retry(
        "clips", {"user_id": uid, "campaign_id": cid},
        select="source_url,start_sec,end_sec", limit=100)
    new_len = max(end - start, 1)
    for cl in clips:
        if (cl.get("source_url") or "") != source_url:
            continue
        try:
            cs, ce = float(cl["start_sec"]), float(cl["end_sec"])
        except (TypeError, ValueError):
            continue
        overlap = max(0.0, min(end, ce) - max(start, cs))
        if overlap / new_len > 0.4:
            log(f"dedup: moment overlaps >40% with existing clip "
                f"({cs:.0f}-{ce:.0f}s) — skip")
            return False
    return True


# --------------------------------------------------------------------------
# 6b. per-account campaign dedup + fail-blacklist (Round-7, user rule:
#     "same campaign ek account me repeat na ho").
# --------------------------------------------------------------------------
CAMPAIGN_COOLDOWN_DAYS = 7      # successful post ke baad itne din skip
FAIL_BLACKLIST_H = 48           # 24h me 3+ fail → itne ghante blacklist
FAIL_THRESHOLD = 3


def campaign_usable(uid: str, cid: str) -> tuple[bool, str]:
    """Is device pe ye campaign abhi try kar sakte hain?
    Returns (usable, reason)."""
    now = datetime.now(timezone.utc)
    # (a) success cooldown — is account se ye campaign haal me post ho chuki
    since_ok = (now - timedelta(days=CAMPAIGN_COOLDOWN_DAYS)).isoformat()
    ok_rows = sb_retry("GET", "/rest/v1/device_jobs", query={
        "user_id": f"eq.{uid}", "device_id": f"eq.{DEVICE_ID}",
        "status": "eq.succeeded", "payload->>campaign_slug": f"eq.{cid}",
        "created_at": f"gte.{since_ok}",
        "select": "id,created_at", "limit": "1",
    })
    if ok_rows:
        return (False, f"campaign_cooldown: is account se {cid} pichhle "
                       f"{CAMPAIGN_COOLDOWN_DAYS} din me post ho chuki")
    # (b) fail blacklist — 24h me 3+ fail/timeout → 48h ke liye block
    since_fail = (now - timedelta(hours=24)).isoformat()
    fail_rows = sb_retry("GET", "/rest/v1/device_jobs", query={
        "user_id": f"eq.{uid}", "device_id": f"eq.{DEVICE_ID}",
        "status": "in.(failed,timeout)",
        "payload->>campaign_slug": f"eq.{cid}",
        "created_at": f"gte.{since_fail}",
        "select": "id,created_at", "limit": "10",
    })
    fails = fail_rows if isinstance(fail_rows, list) else []
    if len(fails) >= FAIL_THRESHOLD:
        return (False, f"fail_blacklist: {cid} 24h me {len(fails)} baar "
                       f"fail — {FAIL_BLACKLIST_H}h ke liye block")
    return (True, "")


def video_already_sent(video_url: str) -> dict | None:
    """Ye exact video (video_url) is device pe pehle bheji ja chuki?
    (cancelled jobs ko ignore karo.)"""
    rows = sb_retry("GET", "/rest/v1/device_jobs", query={
        "device_id": f"eq.{DEVICE_ID}",
        "payload->>video_url": f"eq.{video_url}",
        "select": "id,status,created_at", "limit": "10",
    })
    rows = rows if isinstance(rows, list) else []
    live = [r for r in rows if (r.get("status") or "") != "cancelled"]
    return live[0] if live else None


def record_clip(uid: str, cid: str, source_url: str, start: int, end: int,
                hook_text: str, caption: str, video_url: str) -> None:
    """Enqueue safal hone ke baad clips row likho — taaki moment_fresh
    (overlap dedup) agle ticks me ASLI me kaam kare. Pehle ye write missing
    thi, isliye wahi moment baar-baar re-render ho jata tha."""
    try:
        sb_retry("POST", "/rest/v1/clips", body={
            "user_id": uid, "campaign_id": cid, "source_url": source_url,
            "start_sec": start, "end_sec": end,
            "hook_text": (hook_text or "")[:300],
            "caption": (caption or "")[:500],
            "status": "enqueued", "video_url": video_url,
        }, query={})
        log("clips row recorded (dedup ke liye)")
    except Exception as e:  # noqa: BLE001
        log(f"clips record warn: {type(e).__name__}: {str(e)[:120]}")


# --------------------------------------------------------------------------
# 7. source download (official footage only)
# --------------------------------------------------------------------------
def _is_youtube(url: str) -> bool:
    u = (url or "").lower()
    return any(p in u for p in YT_PATTERNS)


def _is_direct_media(url: str) -> bool:
    u = (url or "").strip().lower()
    path = u.split("?", 1)[0].split("#", 1)[0]
    return u.startswith(("http://", "https://")) and \
        any(path.endswith(e) for e in (".mp4", ".mov", ".webm"))


def _valid_video(path: str, min_bytes: int = 50 * 1024) -> tuple[bool, str]:
    """Downloaded file asli video hai ya khaali/toota? (ffprobe check)."""
    try:
        sz = os.path.getsize(path)
    except OSError:
        return False, "file missing"
    if sz < min_bytes:
        return False, f"too small ({sz} bytes)"
    try:
        p = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name,width",
             "-of", "csv=p=0", path],
            capture_output=True, timeout=30)
        info = (p.stdout or b"").decode(errors="replace").strip()
        if p.returncode == 0 and info:
            return True, f"{sz} bytes, {info}"
        return False, f"ffprobe fail ({sz} bytes)"
    except Exception as ex:  # noqa: BLE001
        return False, f"ffprobe error: {type(ex).__name__}"


def download_section(url: str, start: int, end: int, tmp: str) -> str:
    """Moment ke aas-paas ka section download karo. Returns video path.

    HARDENED (2026-09-19): YouTube datacenter IP ko throttle karta hai —
    --download-sections poora video pehle utarta hai (ghanto ka podcast =
    429/bot-block guaranteed). Isliye fast path: yt-dlp -g se direct
    googlevideo URL nikalo (player_client android→ios→web fallback),
    phir ffmpeg -ss/-t se sirf section HTTP range-seek karo. ffmpeg ko
    -tls_verify 0 chahiye (egress proxy MITM karta hai).
    Note: SABR experiment ke chalte android client se kabhi sirf 360p
    (itag 18) milta hai — soft quality, lekin fail hone se behtar.
    """
    out = os.path.join(tmp, "src.mp4")
    if _is_youtube(url):
        s, e = max(0, start - 10), end + 10
        grab_section(url, s, e, out, config.YTDLP, use_node=True, log=log)
    elif _is_direct_media(url):
        log("direct media download …")
        # 2026-09-20: robust_download (retry+resume) — pehle ek blip pe
        # poora attempt waste hota tha.
        brain.robust_download(url, out, log_fn=log)
        # section kaat lo (curated/brain moment ke hisab se)
        cut = os.path.join(tmp, "src_cut.mp4")
        subprocess.run(["ffmpeg", "-y", "-v", "error",
                        "-ss", str(max(0, start - 2)),
                        "-i", out, "-t", str(end - start + 4),
                        "-c", "copy", cut],
                       check=True, capture_output=True, timeout=300)
        out = cut
    else:
        raise RuntimeError(f"source URL type unsupported: {url[:80]}")
    if not os.path.exists(out) or os.path.getsize(out) < 50_000:
        raise RuntimeError("download hua lekin file khaali/too chhoti hai")
    log(f"downloaded: {os.path.getsize(out) // 1024} KB")
    return out


# --------------------------------------------------------------------------
# 8. render (clip_factory v2, face-tracked) + QA
# --------------------------------------------------------------------------
def ffprobe_info(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,duration",
         "-of", "json", path],
        capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["streams"][0]
    return {"width": int(s["width"]), "height": int(s["height"]),
            "duration": float(s.get("duration") or 0)}


def frame_is_blank(png_path: str, stddev_floor: float = 4.0) -> bool:
    from PIL import Image, ImageStat
    im = Image.open(png_path).convert("L").resize((135, 240))
    return ImageStat.Stat(im).stddev[0] < stddev_floor


def _build_overlay_profile(campaign: dict, tmp: str) -> str | None:
    """Brief ke required_overlay / required_logo se clip_factory profile banao.
    Returns profile JSON path, ya None agar koi overlay requirement nahi.
    Overlay safe zone: top 10%+ neeche (user locked rule)."""
    try:
        notes = json.loads(campaign.get("notes") or "{}")
    except Exception:
        notes = {}
    fb = notes.get("full_brief") or {}
    overlay_text = (fb.get("required_overlay") or "").strip()
    # Kuch briefs me overlay requirements do/dont me hote hain
    if not overlay_text:
        return None
    # Bahut lamba overlay text video pe kharab lagega — pehle 80 chars
    if len(overlay_text) > 80:
        overlay_text = overlay_text[:77] + "..."
    profile = {
        "text_overlays": [{
            "text": overlay_text,
            "font_size": 56,
            "color": "white",
            "position": "top-center",
            "start_sec": 0,
            "end_sec": None,
        }],
        "effects": {"punch_zoom": True, "ken_burns": True, "emphasis_pulse": True},
    }
    # Logo URL ho to profile me dalo (clip_factory download karke lagayega)
    logo_url = (fb.get("required_logo") or "").strip()
    if logo_url.startswith("http"):
        profile["logo"] = {"url": logo_url, "position": "top-right",
                           "scale": 0.15, "opacity": 0.9}
    path = os.path.join(tmp, "overlay_profile.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(profile, f)
    return path


def render_clip(src: str, start: int, end: int, tmp: str,
                campaign: dict) -> str:
    """clip_factory v2 chalao. Returns rendered 1080x1920 mp4 path.
    2026-09-20: brief ka required_overlay (in-video text/logo) ab video pe
    burn hota hai — pehle ye ignore ho raha tha."""
    dur = end - start
    out = os.path.join(tmp, "clip.mp4")
    # yt-dlp section me 10s ka head margin hai; direct me 2s
    head = 10 if _is_youtube(campaign.get("brief_url") or "") else 2
    cmd = [VENV_PY, config.FACTORY, "--src", src,
           "--start", str(head), "--end", str(head + dur),
           "--out", out]
    # Brief se overlay: required_overlay text ko video pe burn karo
    # (clip_factory ka --profile > text_overlays use hota hai)
    profile_path = _build_overlay_profile(campaign, tmp)
    if profile_path:
        cmd += ["--profile", profile_path]
        log("overlay profile lagaya (brief required_overlay)")
    log(f"clip_factory v2 render ({dur}s, face-tracked) …")
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if proc.returncode != 0:
        raise RuntimeError(
            "clip_factory failed: " + (proc.stderr or proc.stdout)[-600:])
    if not os.path.exists(out):
        raise RuntimeError("clip_factory ne output nahi banaya")

    # QA (SOP): exact 1080x1920, duration bounds, frames non-blank
    info = ffprobe_info(out)
    lo = float(campaign.get("min_seconds") or 15)
    hi = float(campaign.get("max_seconds") or 60)
    problems = []
    if not (info["width"] == 1080 and info["height"] == 1920):
        problems.append(f"resolution {info['width']}x{info['height']}")
    if not (lo <= info["duration"] <= hi + 2):
        problems.append(f"duration {info['duration']:.1f}s vs [{lo},{hi}]")
    for i, t in enumerate([1.0, dur * 0.33, dur * 0.66, dur * 0.9]):
        t = max(0.5, min(t, max(0.5, info["duration"] - 0.2)))
        png = os.path.join(tmp, f"q{i}.png")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.2f}",
                        "-i", out, "-frames:v", "1", png],
                       check=True, capture_output=True, timeout=60)
        if frame_is_blank(png):
            problems.append(f"frame_{i} blank (t={t:.1f}s)")
    if problems:
        raise RuntimeError("QA failed: " + "; ".join(problems))
    log(f"QA pass: 1080x1920, {info['duration']:.1f}s, frames ok")
    return out


# --------------------------------------------------------------------------
# 9. caption
# --------------------------------------------------------------------------
def build_caption(campaign: dict, hook_text: str) -> str:
    template = str(campaign.get("caption_template") or "")
    tags = campaign.get("hashtags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.replace(",", " ").split() if t.strip()]
    tag_str = " ".join(t if str(t).startswith("#") else f"#{t}" for t in tags)
    # 2026-09-20: brief ke required_tags (@mentions) bhi caption me — pehle
    # ye missing the (sirf hashtags judte the, @tags nahi)
    try:
        _notes = json.loads(campaign.get("notes") or "{}")
        _fb = _notes.get("full_brief") or {}
        _req_tags = _fb.get("required_tags") or []
    except Exception:
        _req_tags = []
    mention_str = " ".join(
        t if str(t).startswith("@") else f"@{t}"
        for t in _req_tags if str(t).strip())
    caption = ((template.replace("{hook}", hook_text.strip())
                if "{hook}" in template
                else (hook_text.strip() + "\n" + template).strip())
               + "\n" + tag_str).strip()
    if mention_str and mention_str.lower() not in caption.lower():
        caption = (caption + " " + mention_str).strip()
    # mandatory tags zaroor hon
    required = [str(t).lstrip("#").lower() for t in tags]
    missing = [t for t in required if t not in caption.lower()]
    if missing:
        raise RuntimeError(f"caption me mandatory tags missing: {missing}")
    return caption


# --------------------------------------------------------------------------
# 10. upload (deterministic path → plan-job dedup kaam kare)
# --------------------------------------------------------------------------
def upload_clip(local_mp4: str, cid: str, start: int, end: int) -> str:
    dest = f"planner_v2/{cid}/{start}-{end}.mp4"
    url = config.storage_upload(local_mp4, dest, "video/mp4", bucket="clips")
    log(f"uploaded → {url[:90]}…")
    return url


# --------------------------------------------------------------------------
# 11. enqueue — worker-authed POSTs (plan-job: IG post / Whop submit PHONE
#     karega; join-campaign: phone Whop pe campaign join karega)
# --------------------------------------------------------------------------
def _post_worker(path: str, payload: dict) -> dict:
    """Worker-secret POST with retry. Returns parsed JSON, ya
    {"ok": False, "capped": True} / {"ok": False, "conflict": True}."""
    url = config.CLIPFLOW_URL.rstrip("/") + path
    body = json.dumps(payload).encode()
    last: Exception | None = None
    tag = f"{path} →"
    for i in range(4):
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        if config.WORKER_SECRET:
            req.add_header("x-worker-secret", config.WORKER_SECRET)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            if e.code == 429:
                log(f"{tag} 429 cap reached (server-side guard) — skip")
                return {"ok": False, "capped": True}
            if e.code == 409:
                log(f"{tag} 409: {detail} — skip")
                try:
                    dj = json.loads(detail)
                except Exception:
                    dj = {}
                return {"ok": False, "conflict": True,
                        "needs_app_update": dj.get("needs_app_update", False),
                        "error": dj.get("error", detail)}
            if 500 <= e.code < 600 and i < 3:
                wait = min(2 ** i, 15) + random.uniform(0, 1.5)
                log(f"{tag} {e.code} (retry {i + 1}/4, {wait:.1f}s)")
                time.sleep(wait)
                last = e
                continue
            raise RuntimeError(f"{tag} {e.code}: {detail}") from e
        except Exception as e:  # noqa: BLE001
            last = e
            wait = 3 * (i + 1) + random.uniform(0, 1.5)
            log(f"{tag} retry {i + 1}/4: {type(e).__name__} ({wait:.1f}s)")
            time.sleep(wait)
    raise RuntimeError(f"{path} network failed: {last}")


def enqueue(video_url: str, caption: str, whop_submit_url: str,
            campaign_slug: str | None = None) -> dict:
    return _post_worker(
        f"/api/devices/{DEVICE_ID}/plan-job",
        {"video_url": video_url, "caption": caption,
         "whop_submit_url": whop_submit_url,
         "campaign_slug": campaign_slug})


# --------------------------------------------------------------------------
# 11b. auto-join enqueue (Round-7)
# --------------------------------------------------------------------------
def live_join_job(uid: str, cid: str) -> dict | None:
    """Is campaign ka join_campaign job abhi live hai?
    (dobara join job na bane — dedup)."""
    rows = sb_retry("GET", "/rest/v1/device_jobs", query={
        "user_id": f"eq.{uid}",
        "type": "eq.join_campaign",
        "status": "in.(queued,claimed,dispatched,running)",
        "payload->>campaign_slug": f"eq.{cid}",
        "select": "id,status",
        "order": "created_at.asc",
        "limit": "1",
    })
    return rows[0] if rows else None


def enqueue_join(uid: str, campaign: dict) -> dict:
    """POST /api/devices/<id>/join-campaign. Returns parsed JSON
    ({"ok":..., "deduped":..., "capped":..., "conflict":...}).
    2026-09-20: whop_url (brand community) bhi bhejo — phone pehle
    community join karega, phir campaign (FundingPips flow)."""
    cid = campaign["id"]
    url = (campaign.get("campaign_url") or "").strip()
    if not url:
        raise RuntimeError("campaign_url nahi hai — join page ka pata nahi")
    # notes.full_brief ya notes.whop_url se brand community URL nikalo
    whop_url = ""
    try:
        _n = json.loads(campaign.get("notes") or "{}")
        whop_url = (_n.get("whop_url") or "").strip()
        if not whop_url:
            _fb = _n.get("full_brief") or {}
            for src in (_fb.get("official_sources") or []):
                if isinstance(src, str) and "whop.com/" in src \
                        and "/discover/" not in src:
                    whop_url = src.strip()
                    break
    except Exception:
        pass
    res = _post_worker(
        f"/api/devices/{DEVICE_ID}/join-campaign",
        {"campaign_slug": cid, "campaign_url": url,
         "whop_url": whop_url})
    if res.get("needs_app_update"):
        log(f"JOIN BLOCKED: app update pending (p33+) — {res.get('error')}")
        activity(uid, "join_blocked_app_update",
                 str(res.get("error"))[:160])
        return {"ok": False, "needs_app_update": True,
                "error": res.get("error")}
    if res.get("ok") and not res.get("deduped"):
        log(f"JOIN ENQUEUED: job {res.get('job_id')} "
            f"— phone Whop pe '{campaign.get('name')}' join karega"
            + (f" (community: {whop_url[:50]}…)" if whop_url else ""))
        activity(uid, "join_requested",
                        f"{cid} job={res.get('job_id')}")
    return res


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def attempt_campaign(uid: str, campaign: dict, score: float,
                     dry_run: bool) -> str:
    """Ek campaign pe poora try. Returns outcome; 'skipped:*' = agla try karo."""
    cid = campaign["id"]
    log(f"campaign: '{campaign.get('name')}' ({cid}) score={score:.1f} "
        f"payout=${campaign.get('payout_per_1k_usd')}/1k "
        f"join_status={campaign.get('join_status')}/joined={campaign.get('joined')}")

    # Download source: phone-verified video link pehle (Whop campaign page se
    # nikla hua official footage link — app ne server ko diya), warna brief_url.
    verified_src = verified_video_url(campaign)
    brief_url = verified_src or (campaign.get("brief_url") or "").strip()
    if verified_src:
        log(f"source: phone-verified video link ({verified_src[:70]}…)")
    vreq = verified_requirements(campaign)
    if vreq:
        log(f"verified requirements ({len(vreq)} chars) — isi ke hisaab se clip")
    if not brief_url:
        log("SKIP: campaign me brief_url nahi")
        return "skipped:no_brief"

    # 2026-09-20 BIO LINK SAFETY: kuch campaigns (jaise FundingPips) IG bio me
    # specific link mangte hain. Bio link IG app me manually set hota hai —
    # bina uske submission reject ho sakta hai. Isliye bio-link-required
    # campaign ko skip karo aur activity me warn karo (fail-safe).
    try:
        _bn = json.loads(campaign.get("notes") or "{}")
        _bfb = _bn.get("full_brief") or {}
        _bio = str(_bfb.get("required_bio_link") or "").strip()
        if _bio and _bio != "brief_unavailable" and _bio.startswith("http"):
            log(f"SKIP: bio link required ({_bio[:50]}…) — IG bio me manually "
                f"set karna padega, bina uske reject hoga")
            activity(uid, "planner_bio_link_skip",
                     f"'{campaign.get('name')}' skip — bio link chahiye: {_bio[:80]}")
            return "skipped:bio_link_required"
    except Exception:
        pass

    # moment candidates: curated pehle (agar uski video pehle nahi bheji),
    # phir brain ke top-3 DISTINCT moments. Pehla candidate jo compliance +
    # dedup + video-dup teeno pass kare, wahi use hota hai.
    candidates: list[dict] = []
    cm = curated_moment(campaign)
    if cm:
        cs, ce = int(cm["start_sec"]), int(cm["end_sec"])
        _exp = (f"{config.SUPABASE_URL}/storage/v1/object/public/clips/"
                f"planner_v2/{cid}/{cs}-{ce}.mp4")
        if video_already_sent(_exp):
            log(f"curated moment {cs}-{ce}s ki video pehle bhej chuke — "
                f"brain se naya moment")
        else:
            log(f"curated moment: {cs}-{ce}s (scout-verified)")
            candidates.append(cm)
    lo = float(campaign.get("min_seconds") or 15)
    hi = float(campaign.get("max_seconds") or 60)
    log(f"brain.pick_moments ({lo:.0f}-{hi:.0f}s, top-10) …")
    brain_moments = brain.pick_moments(brief_url, lo, hi,
                                       extract_keywords(campaign), top_n=10)
    # Per-user randomization (2026-09-20 — user: "har user ka alag alag
    # random video official asset se, unique edit, duplicate reject na ho").
    # Top-10 me se uid+date seed se weighted-shuffle: har user alag moment
    # pehle try karega, lekin acche moments ko zyada chance milega.
    if brain_moments and uid:
        from datetime import date as _date
        rng = random.Random(f"{uid}:{_date.today().isoformat()}:{cid}")
        # Weighted shuffle: score ke hisaab se order, thoda randomness
        weighted = []
        for bm in brain_moments:
            w = float(bm.get("score") or 0.1) * rng.uniform(0.5, 1.5)
            weighted.append((w, bm))
        weighted.sort(key=lambda t: t[0], reverse=True)
        brain_moments = [bm for _, bm in weighted]
        log(f"moments user-shuffled ({uid[:8]}…) — pehla: "
            f"{brain_moments[0]['start_sec']}-{brain_moments[0]['end_sec']}s")
    for bm in brain_moments:
        if not any(bm["start_sec"] == c.get("start_sec")
                   and bm["end_sec"] == c.get("end_sec") for c in candidates):
            candidates.append(bm)
    if not candidates:
        log("SKIP: koi usable moment nahi mila")
        return "skipped:no_moment"

    moment = None
    last_skip = "skipped:no_moment"
    for cand in candidates:
        start, end = int(cand["start_sec"]), int(cand["end_sec"])
        ok, why = moment_compliant(cand, campaign)
        if not ok:
            log(f"candidate {start}-{end}s: compliance fail — {why}")
            last_skip = "skipped:compliance"
            continue
        if not moment_fresh(uid, cid, brief_url, start, end):
            last_skip = "skipped:dedup"
            continue
        _exp = (f"{config.SUPABASE_URL}/storage/v1/object/public/clips/"
                f"planner_v2/{cid}/{start}-{end}.mp4")
        dup = video_already_sent(_exp)
        if dup:
            log(f"candidate {start}-{end}s: video pehle bhej chuke "
                f"(job {dup['id'][:8]}…) — agla candidate")
            last_skip = "skipped:dedup_video"
            continue
        moment = cand
        break
    if not moment:
        log(f"SKIP: koi candidate pass nahi hua ({last_skip})")
        return last_skip
    start, end = int(moment["start_sec"]), int(moment["end_sec"])
    # Per-user trim jitter (2026-09-20): uid seed se ±2s shift taaki do
    # users ka same moment bhi alag-alag trim ho — duplicate reject se
    # bachao. Compliance range (min/max seconds) ke andar rehta hai.
    if uid:
        jrng = random.Random(f"trim:{uid}:{cid}:{start}:{end}")
        shift = jrng.randint(-2, 2)
        if shift:
            dur = end - start
            start = max(0, start + shift)
            end = start + dur
            log(f"trim jitter: {shift:+d}s (user-unique)")
    log(f"moment: {start}-{end}s hook='{moment.get('hook_text','')[:60]}'")

    # download → render → caption → upload
    tmp = tempfile.mkdtemp(prefix="planner_v2_")
    try:
        set_stage("video_download")
        src = download_section(brief_url, start, end, tmp)
        set_stage("clip_ban_raha")
        clip = render_clip(src, start, end, tmp, campaign)
        caption = build_caption(campaign, moment.get("hook_text") or "")
        log(f"caption ({len(caption)} chars): {caption[:90]}…")
        set_stage("upload_ho_raha")
        video_url = upload_clip(clip, cid, start, end)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    whop_submit_url = (campaign.get("campaign_url") or "").strip() \
        or WHOP_DEFAULT_SUBMIT

    if dry_run:
        log("DRY-RUN: enqueue skip — package ready hai")
        log(f"  video_url: {video_url}")
        log(f"  whop_submit_url: {whop_submit_url}")
        activity(uid, "planner_v2_dryrun",
                        f"{cid} {start}-{end}s {video_url[:60]}")
        return "dryrun"

    set_stage("phone_ko_bhej_rahe")
    res = enqueue(video_url, caption, whop_submit_url, campaign_slug=cid)
    if res.get("needs_app_update"):
        # 2026-09-20: p33+ chahiye (wait_js). Purane app pe job fail hogi,
        # isliye enqueue hi mat karo — user app update karega.
        log(f"APP UPDATE PENDING: {res.get('error')} — p33 install hone tak "
            f"koi job enqueue nahi hogi")
        activity(uid, "enqueue_blocked_app_update",
                 str(res.get("error"))[:160])
        set_stage("app_update_pending")
        return "skipped:need_p33"
    if res.get("ok"):
        log(f"ENQUEUED job {res.get('job_id')} "
            f"(deduped={res.get('deduped')}) — phone poll pe uthayega")
        activity(uid, "planner_v2_enqueued",
                        f"{cid} {start}-{end}s job={res.get('job_id')}")
        # clips row likho taaki moment_fresh (overlap dedup) agle ticks
        # me ASLI me kaam kare — pehle ye write missing thi.
        record_clip(uid, cid, brief_url, start, end,
                    moment.get("hook_text") or "", caption, video_url)
        set_stage("ho_gaya")
        return "enqueued"
    if res.get("capped") or res.get("conflict"):
        return "skipped:server_guard"
    raise RuntimeError(f"enqueue failed: {res}")


# --------------------------------------------------------------------------
# AGENT CAMPAIGN MONITORING (2026-09-20, user demand: "campaign dekhna agent
# karega, admin ko nahi karna"). Har planner tick pe active campaigns ka
# health check — dead campaign (budget khatam / band ho gaya) ko agent khud
# deactivate karta hai. Admin sirf Activity log dekhta hai, haath nahi lagata.
# --------------------------------------------------------------------------
DEAD_SIGNALS = (
    "submissions closed", "campaign ended", "campaign paused",
    "no longer accepting", "budget exhausted", "payout paused",
)


def health_check_campaigns(uid: str, dry_run: bool = False) -> int:
    """Active campaigns me dead signals dhoondho, auto-deactivate karo.
    Returns: kitni deactivate hui.
    2026-09-20 CORE FIX:
    - Pehle device-user pool check karta tha — MAIN_HUB pool kabhi scan hi
      nahi hota tha. Ab MAIN_HUB_USER_ID.
    - notes wali bulk query (~250KB) proxy pe IncompleteRead deti thi.
      Ab budget check LIGHT query se, dead-signal scan per-campaign
      (~8KB each) + circuit breaker."""
    rows = sb_select_retry(
        "campaigns",
        {"user_id": MAIN_HUB_USER_ID, "active": True},
        select="id,budget_remaining_usd,name",
    ) or []
    dead = 0
    deactivated_ids = set()

    def _deactivate(cid, name, reason):
        nonlocal dead
        if dry_run:
            log(f"DRY-RUN: campaign {cid} dead hoti ({reason})")
        else:
            sb_retry("PATCH", "/rest/v1/campaigns",
                     query={"id": f"eq.{cid}"},
                     body={"active": False})
            activity(uid, "campaign_auto_deactivated",
                     f"Agent ne '{name or cid}' deactivate ki — {reason}.")
        log(f"campaign {cid} auto-deactivated — {reason}")
        dead += 1
        deactivated_ids.add(cid)

    # Pass 1 (light): budget khatam
    for c in rows:
        cid = c.get("id")
        try:
            budget = c.get("budget_remaining_usd")
            if budget is not None and float(budget) <= 0:
                _deactivate(cid, c.get("name"),
                            "budget khatam (%.2f)" % float(budget))
        except (TypeError, ValueError):
            pass

    # Pass 2: dead signals — per-campaign notes fetch (proxy-safe),
    # consecutive 3 fail pe circuit breaker (non-fatal, agle tick me phir).
    consec_fail = 0
    for c in rows:
        cid = c.get("id")
        if cid in deactivated_ids:
            continue
        try:
            full = get_campaign_full(cid)
        except Exception:  # noqa: BLE001
            consec_fail += 1
            if consec_fail >= 3:
                log("health check: lagatar 3 notes fetch fail — scan roka (agle tick)")
                break
            continue
        consec_fail = 0
        if not full:
            continue
        notes = full.get("notes") or {}
        if isinstance(notes, str):
            try:
                notes = json.loads(notes)
            except Exception:
                notes = {}
        if not isinstance(notes, dict):
            continue
        blob = json.dumps(notes).lower()
        req = str(notes.get("verified_requirements") or "").lower()
        for sig in DEAD_SIGNALS:
            if sig in blob or sig in req:
                _deactivate(cid, full.get("name"),
                            "Whop pe band ka signal: '%s'" % sig)
                break
    if not dead:
        log(f"campaign health: {len(rows)} active, sab zinda")
    return dead


def daily_discover_refresh(uid: str, dry_run: bool = False) -> str:
    """Daily 15-campaign refresh (2026-09-20 — user: '24h me 15 campaign
    find, 24h baad list refresh + purana media delete, har user ko alag
    campaign, ek user ek campaign ek baar hi submit karega').

    - Last discover se 24h+ ho gaye to purani discovered (not-joined,
      kaam na hui) campaigns deactivate karo aur fresh discover enqueue karo.
    - Joined ya already-worked campaigns ko haath nahi lagate.
    Returns: 'refreshed' | 'not_due' | 'skipped:*'
    """
    # Last discover kab hua tha?
    logs = sb_select_retry(
        "activity_log",
        {"user_id": uid, "event": "campaigns_discovered"},
        select="ts", limit=1,
    ) or []
    # activity_log me user_id column hai ya nahi — fallback: sabse recent
    if not logs:
        logs = sb_retry("GET", "/rest/v1/activity_log",
                        query={"event": "eq.campaigns_discovered",
                               "select": "ts",
                               "order": "ts.desc", "limit": "1"}) or []
    last_ts = ""
    if logs:
        last_ts = str(logs[0].get("ts") or "")
    due = True
    if last_ts:
        try:
            from datetime import datetime, timezone
            dt = datetime.fromisoformat(last_ts.replace("Z", "+00:00"))
            age_h = (datetime.now(timezone.utc) - dt).total_seconds() / 3600
            due = age_h >= 24
            if not due:
                log(f"daily refresh not due (last discover {age_h:.1f}h pehle)")
                return "not_due"
        except Exception:
            pass
    log("daily refresh DUE — purani discovered list saaf karke nayi layenge")
    if dry_run:
        return "dryrun"
    # Purani discovered campaigns deactivate (joined/worked ko chhodo)
    # 2026-09-20 CORE FIX: sirf zaroori JSON fields (via, discovered_at) —
    # poora notes (full_brief) proxy pe IncompleteRead deta tha.
    rows = sb_select_retry(
        "campaigns",
        {"user_id": uid, "active": True},
        select="id,joined,notes->via,notes->discovered_at",
    ) or []
    cleaned = 0
    for c in rows:
        if c.get("joined"):
            continue
        via = str(c.get("via") or "")
        disc = str(c.get("discovered_at") or "")
        if via != "phone" or not disc:
            continue
        try:
            from datetime import datetime, timezone
            dt = datetime.fromisoformat(disc.replace("Z", "+00:00"))
            age_h = (datetime.now(timezone.utc) - dt).total_seconds() / 3600
        except Exception:
            continue
        if age_h >= 24:
            sb_retry("PATCH", "/rest/v1/campaigns",
                     query={"id": f"eq.{c['id']}"},
                     body={"active": False})
            cleaned += 1
    if cleaned:
        activity(uid, "campaigns_refreshed",
                 f"🗑️ {cleaned} purani (24h+) discovered campaigns hatayi — "
                 f"fresh list aa rahi hai.")
        log(f"daily refresh: {cleaned} stale campaigns deactivated")
    # Fresh discover enqueue
    res = enqueue_discover(uid)
    if res.get("ok") and not res.get("deduped"):
        log(f"daily refresh: discover enqueued ({str(res.get('job_id'))[:8]}…)")
        return "refreshed"
    return f"skipped:{res.get('error') or 'deduped'}"


def plan_once(dry_run: bool) -> str:
    """Ek planning pass. Returns outcome string: enqueued|dryrun|skipped:*."""
    uid, dname = get_device_user()
    log(f"device {dname} ({DEVICE_ID[:8]}…) user {uid[:8]}…")
    set_stage("campaign_chun_rahe")
    # config.api() wali calls (agar bhavishya me hon) user-scoped rahen —
    # bina iske /api/activity jaise endpoints "user_id required" 400 dete hain.
    config.set_worker_user(uid)

    # 0. AGENT CAMPAIGN MONITORING (2026-09-20): admin ko campaign dekhne ki
    # zaroorat nahi — agent har tick pe dead campaigns (budget khatam / band)
    # khud deactivate karta hai. Nayi campaigns discover-first se aati hain.
    try:
        health_check_campaigns(uid, dry_run=dry_run)
    except Exception as e:  # noqa: BLE001
        log(f"campaign health check me dikkat (non-fatal): {e}")

    # 0b. DAILY DISCOVER REFRESH (2026-09-20): 24h me ek baar fresh
    # 15-campaign list — purani discovered saaf + media delete, nayi discover.
    # Har user ka alag list (user_id scoped), koi daily manual kaam nahi.
    # Run time pe (Run Now/schedule) pehle se mili campaigns se pick hota hai.
    try:
        refresh_res = daily_discover_refresh(uid, dry_run=dry_run)
        if refresh_res == "refreshed":
            set_stage("ho_gaya")
            return "discover_requested:daily_refresh"
    except Exception as e:  # noqa: BLE001
        log(f"daily refresh me dikkat (non-fatal): {e}")

    # 1. cap guard (dry-run me sirf check+log — enqueue hota hi nahi,
    #    isliye cap violate nahi ho sakta)
    #    TESTING MODE (2026-09-20): cap disabled — production pe wapas lagao.
    n_used = 0 if TESTING_NO_LIMITS else cap_count(uid)
    if not TESTING_NO_LIMITS and n_used >= CAP_MAX and not dry_run:
        log(f"SKIP: cap full ({CAP_MAX}/{CAP_WINDOW_H}h) — silent")
        return "skipped:cap"
    if dry_run and n_used >= CAP_MAX:
        log(f"dry-run: cap full hota ({n_used}/{CAP_MAX}) lekin dry-run "
            f"enqueue nahi karta — aage badho")

    # 2. campaigns + rank — joined-only filter HATA diya (Round-7):
    # best-fit campaign agar joined nahi hai to pehle phone se auto-join
    # (join_campaign job), phir agle tick me clip pipeline. Non-joined pe
    # seedha clip banana bekaar hai — Whop "join first" bolega.
    #
    # 2b. VERIFICATION-FIRST (Round-7b): server ke paas Whop login nahi hai,
    # isliye FINAL chunav phone karta hai. Sirf fresh-verified (7d) campaigns
    # eligible hain; warna phone se verification mangwao, blind clip nahi.
    # 2026-09-20 CORE FIX: sirf IDs check karo (~1KB) — 15KB wali
    # get_campaigns() proxy pe marr jati thi. Detail pick_random_campaign
    # me lazy fetch hoti hai.
    campaign_ids = get_campaign_ids()
    if not campaign_ids:
        # DISCOVER-FIRST (2026-09-20): koi active campaign nahi — SERVER
        # contentrewards.com se naye campaigns nikalega (public, no login).
        log("koi active campaign nahi — server se discovery")
        if dry_run:
            log("DRY-RUN: server-discover skip")
            return "dryrun"
        res = enqueue_discover(uid)
        if res.get("needs_app_update"):
            set_stage("ho_gaya")
            return "skipped:need_p24"
        if res.get("ok") and not res.get("deduped"):
            set_stage("ho_gaya")
            return f"discover_requested:{str(res.get('job_id'))[:8]}"
        if res.get("deduped"):
            log("discover already in flight — agle tick me dekhenge")
            return "skipped:discover_pending"
        log(f"discover enqueue fail: {res.get('error') or res}")
        return "skipped:discover_error"
    from datetime import date as _date
    # 2026-09-20: RANDOM selection (user requirement) — ranking nahi.
    # 25 me se random ek, jo pehle submit nahi hua.
    # PERMANENT RULE (user-locked): same account kabhi same campaign me
    # dobara submit nahi karega — ye TESTING_NO_LIMITS se independent hai.
    submitted_ids = set()
    # 2026-09-20 FIX: submissions table me campaign_id column NAHI hai
    # (42703 crash tha). submissions.post_id → posts.campaign_id se nikalo.
    sub_rows = sb_retry("GET", "/rest/v1/submissions", query={
        "select": "post_id", "user_id": f"eq.{uid}", "limit": "100"})
    _pids = [r["post_id"] for r in sub_rows if r.get("post_id")]
    if _pids:
        _prows = sb_retry("GET", "/rest/v1/posts", query={
            "select": "campaign_id",
            "id": f"in.({','.join(_pids)})", "limit": "100"})
        submitted_ids = {r["campaign_id"] for r in _prows if r.get("campaign_id")}
    if submitted_ids:
        log(f"permanent exclusion: {len(submitted_ids)} campaigns pehle submit ho chuke")

    # 2026-09-20: SERVER-SIDE SELECTION hi source of truth (Vercel endpoint).
    # VM ka Supabase network flaky hai — Vercel reliable hai. Server se
    # ~3KB me normalized campaign aata hai. Server classification
    # (clip_ready | join_only | needs_phone | ugc_unsupported) karta hai.
    # (Server khud submitted/eligible filter karta hai.)
    # 2026-09-20 FAIL-CLOSED: local pick_random_campaign fallback PERMANENTLY
    # HATA DIYA — wo server ka classification bypass karta tha. Server se
    # campaign nahi mila (refuse ya unreachable) to run SKIP, blind pick nahi.
    picked, server_reason = select_campaign_via_server(uid)
    if not picked:
        log(f"SKIP: server-side selection ne campaign nahi diya "
            f"(reason={server_reason}) — local fallback permanently removed, "
            f"fail-closed skip")
        activity(uid, "select_refused",
                 f"server_reason={server_reason}; local fallback disabled")
        set_stage("ho_gaya")
        return f"skipped:server_select:{server_reason}"

    # JOIN CHECK (2026-09-20): agar joined nahi to pehle join karo
    if not is_joined(picked):
        js = picked.get("join_status") or ""
        if js == "needs_user":
            log(f"SKIP join: '{picked.get('name')}' needs_user — user action pending")
            return "skipped:join_needs_user"
        if dry_run:
            log(f"DRY-RUN: join_campaign job skip (campaign {picked['id']})")
            return "dryrun"
        log(f"RANDOM PICK '{picked.get('name')}' joined nahi — auto-join")
        live = live_join_job(uid, picked["id"])
        if live:
            log(f"join already in flight: job {live['id'][:8]}…")
            return "skipped:join_pending"
        try:
            res = enqueue_join(uid, picked)
            if res.get("ok") and not res.get("deduped"):
                set_stage("ho_gaya")
                return f"join_requested:{picked['id']}"
            if res.get("needs_app_update"):
                log(f"SKIP join: app update pending — {res.get('error')}")
                return "skipped:join_needs_app_update"
            if res.get("deduped") or res.get("conflict"):
                # Server ke paas join job pehle se live hai — ye fail
                # nahi, pending hai. (2026-09-20 fix: pehle ye galat
                # tareeke se join_failed me girta tha aur 3 attempt
                # bekaar me jal jate the.)
                log(f"join already live server-side "
                    f"(deduped={res.get('deduped')}, "
                    f"conflict={res.get('conflict')}) — join_pending")
                return "skipped:join_pending"
            # Non-ok aur wajah unknown — response body log karo taaki
            # agli baar andaza na lagana pade (2026-09-20 obs fix).
            log(f"join enqueue non-ok: {str(res)[:300]}")
        except Exception as e:
            log(f"join enqueue error: {type(e).__name__}: {str(e)[:200]}")
            # Network blip me response kho sakta hai jabki server ne
            # job bana diya ho — pehle reconcile karo, seedha
            # join_failed mat kaho. (2026-09-20 fix: da57be3d me job
            # 7d1cfa7f ban gaya tha phir bhi request mar gayi thi.)
            try:
                live = live_join_job(uid, picked["id"])
            except Exception as e2:  # noqa: BLE001
                live = None
                log(f"join reconcile check failed: {type(e2).__name__}")
            if live:
                log(f"join job server pe mil gaya "
                    f"({live['id'][:8]}…) — join_pending")
                return "skipped:join_pending"
            return "skipped:join_error"
        return "skipped:join_failed"

    # Joined hai → clip pipeline
    log(f"RANDOM PICK '{picked.get('name')}' joined hai — clip pipeline")
    try:
        outcome = attempt_campaign(uid, picked, 1.0, dry_run)
    except Exception as e:
        cause = f" | cause: {e.__cause__}" if e.__cause__ else ""
        log(f"campaign {picked.get('id')} error: {type(e).__name__}: {str(e)[:500]}{cause}")
        return "skipped:error"
    return outcome


def main() -> None:
    ap = argparse.ArgumentParser(description="ClipFlow v2 zero-touch planner")
    ap.add_argument("--once", action="store_true",
                    help="single planning pass (cron)")
    ap.add_argument("--dry-run", action="store_true",
                    help="render+upload tak karo, enqueue mat karo")
    args = ap.parse_args()
    if not args.once:
        ap.print_help()
        return
    if config.MISSING_CORE:
        log(f"FATAL: env missing: {config.MISSING_CORE}")
        sys.exit(2)
    try:
        outcome = plan_once(dry_run=args.dry_run)
    except Exception as e:  # noqa: BLE001
        # 2026-09-20 CORE FIX: Supabase unreachable (saare retries ke baad bhi)
        # = INFRASTRUCTURE failure, campaign/planner logic ka fault nahi.
        # Exit code 3 → pipeline_watch attempt jalaye BINA requeue karega.
        # Pehle ye exit 1 (FATAL) hota tha → watcher stderr me transient marker
        # nahi dhundh pata tha → attempt jal jata tha → 3 me request marr jati.
        is_infra = isinstance(e, config.TransientError)
        if not is_infra:
            low = f"{type(e).__name__} {e}".lower()
            is_infra = any(m in low for m in (
                "remotedisconnected", "incompleteread", "connection reset",
                "connection aborted", "timed out", "temporary failure",
                "bad gateway", "service unavailable", "gateway timeout"))
        log(f"FATAL: {type(e).__name__}: {e}")
        try:
            activity(None, "planner_v2_error", str(e)[:300])
        except Exception:
            pass
        if is_infra:
            log("done: infra_unavailable")
            sys.exit(3)
        sys.exit(1)
    log(f"done: {outcome}")
    sys.exit(0)


if __name__ == "__main__":
    main()
