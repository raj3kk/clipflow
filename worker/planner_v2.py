#!/usr/bin/env python3
"""
ClipFlow v2 zero-touch planner — campaign se ready clip package tak, bina user input.

    python3 planner_v2.py --once [--dry-run]

Pipeline (VM pe chalta hai):
  1. CAP GUARD: pichhle 24h me v1 posts + v2 device_jobs >= 4 → SILENT SKIP.
     (join_campaign jobs bhi isi cap me gine jate hain.)
  2. AUTO-JOIN (Round-7, 2026-09-19): Whop ka campaign-join public API nahi
     deta, lekin phone ka WebView Whop me LOGGED-IN hai (user ne app me Whop
     login kiya tha). Best-fit campaign agar joined nahi hai to clip pipeline
     ki jagah pehle `join_campaign` job enqueue hoti hai
     (POST /api/devices/<id>/join-campaign → outcome `join_requested:<slug>`).
     Phone campaign page kholke Join dabata hai; result pe server
     campaigns.joined / join_status update karta hai. Join safal hone ke baad
     agle tick me normal clip pipeline chalta hai.
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
             body: dict | None = None, tries: int = 6):
    return config.sb_request(method, path, body=body, query=query,
                             timeout=60, tries=tries)


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
    return res if isinstance(res, list) else [res]


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
def get_campaigns(uid: str) -> list[dict]:
    return sb_select_retry(
        "campaigns", {"user_id": uid, "active": True},
        select=("id,name,sponsor,payout_per_1k_usd,budget_remaining_usd,"
                "min_seconds,max_seconds,requirements,caption_template,"
                "hashtags,brief_url,campaign_url,joined,join_status,notes"),
        limit=30, extra={"order": "payout_per_1k_usd.desc"})


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


def rank_campaigns(campaigns: list[dict]) -> list[tuple[float, dict]]:
    scored: list[tuple[float, dict]] = []
    for c in campaigns:
        payout = float(c.get("payout_per_1k_usd") or 0)
        if payout <= 0:
            continue
        budget = c.get("budget_remaining_usd")
        try:
            budget_f = float(budget) if budget and float(budget) > 0 else 1000.0
        except (TypeError, ValueError):
            budget_f = 1000.0
        if not budget or not float(budget or 0) > 0:
            log(f"campaign {c.get('id')}: budget unknown → neutral 1000")
        fit = 1.0
        if c.get("joined"):
            fit *= 1.5
        if not c.get("brief_url"):
            fit *= 0.3
        if c.get("hashtags"):
            fit *= 1.2
        req = str(c.get("requirements") or "")
        if len(req) > 50:
            fit *= 1.1
        score = payout * budget_f * fit
        scored.append((score, c))
    scored.sort(key=lambda t: t[0], reverse=True)
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
        subprocess.run(["curl", "-L", "--fail", "--max-time", "570",
                        "--max-filesize", str(400 * 1024 * 1024),
                        "-o", out, url],
                       check=True, capture_output=True, timeout=900)
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


def render_clip(src: str, start: int, end: int, tmp: str,
                campaign: dict) -> str:
    """clip_factory v2 chalao. Returns rendered 1080x1920 mp4 path."""
    dur = end - start
    out = os.path.join(tmp, "clip.mp4")
    # yt-dlp section me 10s ka head margin hai; direct me 2s
    head = 10 if _is_youtube(campaign.get("brief_url") or "") else 2
    cmd = [VENV_PY, config.FACTORY, "--src", src,
           "--start", str(head), "--end", str(head + dur),
           "--out", out]
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
    caption = ((template.replace("{hook}", hook_text.strip())
                if "{hook}" in template
                else (hook_text.strip() + "\n" + template).strip())
               + "\n" + tag_str).strip()
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
            tag = f"{path} →"
            if e.code == 429:
                log(f"{tag} 429 cap reached (server-side guard) — skip")
                return {"ok": False, "capped": True}
            if e.code == 409:
                log(f"{tag} 409: {detail} — skip")
                return {"ok": False, "conflict": True}
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
    ({"ok":..., "deduped":..., "capped":..., "conflict":...})."""
    cid = campaign["id"]
    url = (campaign.get("campaign_url") or "").strip()
    if not url:
        raise RuntimeError("campaign_url nahi hai — join page ka pata nahi")
    res = _post_worker(
        f"/api/devices/{DEVICE_ID}/join-campaign",
        {"campaign_slug": cid, "campaign_url": url})
    if res.get("ok") and not res.get("deduped"):
        log(f"JOIN ENQUEUED: job {res.get('job_id')} "
            f"— phone Whop pe '{campaign.get('name')}' join karega")
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
    log(f"brain.pick_moments ({lo:.0f}-{hi:.0f}s, top-3) …")
    for bm in brain.pick_moments(brief_url, lo, hi,
                                 extract_keywords(campaign), top_n=3):
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


def plan_once(dry_run: bool) -> str:
    """Ek planning pass. Returns outcome string: enqueued|dryrun|skipped:*."""
    uid, dname = get_device_user()
    log(f"device {dname} ({DEVICE_ID[:8]}…) user {uid[:8]}…")
    set_stage("campaign_chun_rahe")
    # config.api() wali calls (agar bhavishya me hon) user-scoped rahen —
    # bina iske /api/activity jaise endpoints "user_id required" 400 dete hain.
    config.set_worker_user(uid)

    # 1. cap guard (dry-run me sirf check+log — enqueue hota hi nahi,
    #    isliye cap violate nahi ho sakta)
    n_used = cap_count(uid)
    if n_used >= CAP_MAX and not dry_run:
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
    campaigns = get_campaigns(uid)
    if not campaigns:
        log("SKIP: campaigns table khaali hai — Campaigns tab me campaign jodo")
        return "skipped:no_campaigns"
    ranked = rank_campaigns(campaigns)
    if not ranked:
        log("SKIP: koi campaign positive payout pe nahi")
        return "skipped:no_scored"
    verified = [(s, c) for s, c in ranked if is_fresh_verified(c)]
    if verified:
        log(f"fresh-verified campaigns: {len(verified)} — inhi me se choose "
            f"(server blind pick nahi karega)")
        ranked = verified
    else:
        log("koi fresh-verified campaign nahi — phone se Whop verification")
        if dry_run:
            log("DRY-RUN: propose-campaigns skip")
            return "dryrun"
        res = enqueue_verify(uid, ranked)
        if res.get("needs_app_update"):
            set_stage("ho_gaya")
            return "skipped:need_p23"
        if res.get("ok") and not res.get("deduped"):
            set_stage("ho_gaya")
            return f"verify_requested:{str(res.get('job_id'))[:8]}"
        if res.get("deduped"):
            log("verify already in flight — agle tick me dekhenge")
            return "skipped:verify_pending"
        log(f"verify enqueue fail: {res.get('error') or res} — purana "
            f"flow try karte hain")
        # fallback: purana join-then-clip flow (neeche loop)

    # har ranked campaign try karo jab tak ek safal na ho
    last_skip = "skipped:no_scored"
    for score, campaign in ranked:
        if is_joined(campaign):
            # Round-7 per-account campaign dedup (user rule): ye campaign
            # is account se haal me post ho chuki (7d cooldown) ya 24h me
            # 3+ baar fail hui (48h blacklist) → skip, agla campaign.
            usable, why = campaign_usable(uid, campaign["id"])
            if not usable:
                log(f"SKIP: {why}")
                last_skip = "skipped:" + why.split(":")[0]
                continue
            try:
                outcome = attempt_campaign(uid, campaign, score, dry_run)
            except Exception as e:  # noqa: BLE001
                # CalledProcessError ka str() sirf command dikhata hai —
                # asli wajah (stderr) download_section pehle hi log kar chuka hai.
                # Yahan cause chain bhi dikhao taaki root cause turant mile.
                cause = f" | cause: {e.__cause__}" if e.__cause__ else ""
                log(f"campaign {campaign.get('id')} error: "
                    f"{type(e).__name__}: {str(e)[:500]}{cause} — agla try")
                last_skip = "skipped:error"
                continue
            if outcome in ("enqueued", "dryrun"):
                return outcome
            last_skip = outcome
            continue

        # --- non-joined → auto-join flow (Round-7) ---
        cid = campaign["id"]
        js = campaign.get("join_status") or ""
        if js == "needs_user":
            # Pichhle join ko user ka action chahiye (Whop login expire /
            # extra verification). Dobara job bhejna cap jalayega — user
            # Campaigns tab me 'needs_user' dekhke action lega.
            log(f"SKIP join: '{campaign.get('name')}' needs_user — "
                f"user action pending, agla campaign")
            last_skip = "skipped:join_needs_user"
            continue
        if dry_run:
            log(f"DRY-RUN: join_campaign job skip (campaign {cid})")
            return "dryrun"
        log(f"campaign '{campaign.get('name')}' ({cid}) joined nahi — "
            f"auto-join try (score={score:.1f})")
        live = live_join_job(uid, cid)
        if live:
            log(f"join already in flight: job {live['id'][:8]}… "
                f"({live['status']}) — agla campaign")
            last_skip = "skipped:join_pending"
            continue
        try:
            res = enqueue_join(uid, campaign)
        except Exception as e:  # noqa: BLE001
            log(f"join enqueue error ({cid}): {type(e).__name__}: "
                f"{str(e)[:200]} — agla campaign")
            last_skip = "skipped:join_error"
            continue
        if res.get("ok") and not res.get("deduped"):
            return f"join_requested:{cid}"
        if res.get("deduped"):
            log("join deduped (live job already) — agla campaign")
            last_skip = "skipped:join_pending"
            continue
        if res.get("capped"):
            return "skipped:server_guard"
        # 409 conflict (pehle hi submit ho chuka / device issue)
        log(f"join conflict ({cid}) — agla campaign")
        last_skip = "skipped:join_conflict"
    return last_skip


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
        log(f"FATAL: {type(e).__name__}: {e}")
        try:
            activity(None, "planner_v2_error", str(e)[:300])
        except Exception:
            pass
        sys.exit(1)
    log(f"done: {outcome}")
    sys.exit(0)


if __name__ == "__main__":
    main()
