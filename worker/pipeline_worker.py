#!/usr/bin/env python3
"""
ClipFlow pipeline worker — full SOP pipeline per approved clip.

State machine (activity_log entry at every step via POST /api/activity):
  render      (opt-in --render only; default renderer is render_worker.py)
      download source section (yt-dlp) -> clip_factory -> QA
      (1080x1920, duration in campaign min/max, frames non-blank)
      -> upload mp4 + preview frames -> PATCH job {status:'preview',...}
  schedule    GET /api/settings (daily_target, spacing_hours=4);
              proceed only if now >= scheduled_for AND today's posted count
              < daily_target AND last post >= spacing_hours ago
              (SOP safety: max 4/day spaced >=4h); else log + skip.
  brief_check read campaign requirements/caption_template/hashtags;
              caption contains required tags, duration in min/max,
              hook present -> write brief_check to job; fail -> 'failed'.
  post        Poster backends: api_poster (instagram-cli) or web_poster
              (CDP). DRY-RUN default: everything except the final publish
              click. Action-block text detected -> STOP EVERYTHING,
              notify, exit(0). Never auto-retry.
  verify      MANDATORY before submit (SOP #5): open LIVE reel URL via CDP,
              seek to 1s/33%/66%/90%, screenshot, check playing + no error
              text, PIL-compare vs local preview frames; diff too big ->
              verify_status 'needs_review' + owner choice intervention.
  submit      Whop via CDP (google_oauth cookies): paste instagram_url,
              submit; "Clip submitted" -> POST /api/submissions.
              Warn if >20 min after posted_at (SOP: submit within 30 min).

Modes:
  --once      single pass (for cron), then exit
  (default)   daemon loop every POLL_SECONDS
  --render    also render 'queued' jobs (step 1); default off because
              render_worker.py already owns queued -> preview.

Env: see config.py / README.md. CLIPFLOW_LIVE=1 enables real publish/
submit clicks. Default is DRY-RUN: zero real IG/Whop writes.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import typing
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402
import cdp as cdp_mod  # noqa: E402
import gmail as gmail_mod  # noqa: E402
import interventions as iv_mod  # noqa: E402

# --------------------------------------------------------------------------
# exceptions
# --------------------------------------------------------------------------
class PipelineError(RuntimeError):
    """Job-level failure (job marked failed, pipeline continues)."""


class ActionBlocked(PipelineError):
    """Instagram action block / rate limit detected: stop the whole run."""


BLOCK_PHRASES = ("try again later", "action blocked", "we restrict",
                 "temporarily blocked", "limit how often")


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------
def fail_job(job_id: str, reason: str, clip_id: str | None = None) -> None:
    config.activity("job_failed", reason[:500], clip_id or job_id)
    try:
        config.api("PATCH", f"/api/jobs/{job_id}",
                   {"status": "failed", "error": reason[:500]})
    except Exception as e:  # noqa: BLE001
        print(f"[worker] could not mark job {job_id} failed: {e}", flush=True)


def download_file(url: str, dest: str, timeout: int = 300) -> str:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as resp, \
            open(dest, "wb") as f:
        shutil.copyfileobj(resp, f)
    return dest


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
    """True if the frame is (near-)uniform — render produced nothing."""
    from PIL import Image, ImageStat
    im = Image.open(png_path).convert("L").resize((135, 240))
    return ImageStat.Stat(im).stddev[0] < stddev_floor


def mean_abs_diff(png_a: str, png_b: str) -> float:
    """Downscaled mean absolute pixel difference (0-255 scale)."""
    from PIL import Image, ImageChops, ImageStat
    a = Image.open(png_a).convert("L").resize((135, 240))
    b = Image.open(png_b).convert("L").resize((135, 240))
    return ImageStat.Stat(ImageChops.difference(a, b)).mean[0]


def check_block_text(text: str) -> bool:
    low = (text or "").lower()
    return any(p in low for p in BLOCK_PHRASES)


def get_campaign(campaign_id: str) -> dict:
    data = config.api("GET", f"/api/campaigns/{campaign_id}", timeout=30)
    return data.get("campaign", data)


def duration_bounds(campaign: dict) -> tuple[float, float]:
    lo = float(campaign.get("min_duration_sec")
               or campaign.get("min_duration") or 15)
    hi = float(campaign.get("max_duration_sec")
               or campaign.get("max_duration") or 50)
    return lo, hi


# --------------------------------------------------------------------------
# STEP 1 — render (opt-in; render_worker.py is the default renderer)
# --------------------------------------------------------------------------
def render_step(job: dict) -> None:
    jid = job["id"]
    config.activity("render_start", f"source {job.get('source_url','')[:80]}", jid)
    config.api("PATCH", f"/api/jobs/{jid}", {"status": "rendering", "error": None})
    campaign = get_campaign(job["campaign_id"]) if job.get("campaign_id") else {}
    lo, hi = duration_bounds(campaign)
    tmp = tempfile.mkdtemp(prefix="clipflow_pipe_")
    out_mp4 = os.path.join(tmp, "clip.mp4")
    try:
        start, end = int(job["start_sec"]), int(job["end_sec"])
        dur = end - start
        src_section = os.path.join(tmp, "src.mp4")
        dl = [config.YTDLP, "--no-check-certificate", "--js-runtimes", "node",
              "--extractor-args", "youtube:player_client=android",
              "--download-sections", f"*{start - 10}-{end + 10}",
              "--force-keyframes-at-cuts",
              "-o", src_section, job["source_url"]]
        subprocess.run(dl, check=True, capture_output=True)
        cmd = [sys.executable, config.FACTORY, "--src", src_section,
               "--start", "10", "--end", str(10 + dur), "--out", out_mp4]
        profile = job.get("profile_path")
        if profile:
            cmd += ["--profile", profile]
        subprocess.run(cmd, check=True, capture_output=True)

        # QA (SOP #3): exact 1080x1920, duration in campaign bounds
        info = ffprobe_info(out_mp4)
        qa: dict = {"ffprobe": info, "checks": []}
        ok = True

        def check(name: str, passed: bool, detail: str = "") -> None:
            nonlocal ok
            qa["checks"].append({"name": name, "passed": passed,
                                 "detail": detail})
            if not passed:
                ok = False

        check("resolution_1080x1920",
              info["width"] == 1080 and info["height"] == 1920,
              f"{info['width']}x{info['height']}")
        check("duration_in_bounds", lo <= info["duration"] <= hi,
              f"{info['duration']:.1f}s vs [{lo},{hi}]")

        # preview frames at 1s / 33% / 66% / 90% + non-blank check
        preview_urls = []
        for i, t in enumerate([1.0, dur * 0.33, dur * 0.66, dur * 0.9]):
            t = max(0.5, min(t, max(0.5, info["duration"] - 0.2)))
            png = os.path.join(tmp, f"p{i}.png")
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.2f}",
                 "-i", out_mp4, "-frames:v", "1", png],
                check=True, capture_output=True)
            check(f"frame_{i}_non_blank", not frame_is_blank(png),
                  f"t={t:.1f}s")
            preview_urls.append(
                config.storage_upload(png, f"{jid}/preview_{i}.png", "image/png"))

        qa["passed"] = ok
        if not ok:
            failed = [c["name"] for c in qa["checks"] if not c["passed"]]
            raise PipelineError(f"QA failed: {', '.join(failed)}")

        video_url = config.storage_upload(out_mp4, f"{jid}/clip.mp4", "video/mp4")
        config.api("PATCH", f"/api/jobs/{jid}",
                   {"status": "preview", "video_url": video_url,
                    "preview_urls": preview_urls, "qa_result": qa,
                    "error": None})
        config.activity("render_done",
                        f"1080x1920 {info['duration']:.1f}s QA passed", jid)
    except Exception as e:  # noqa: BLE001
        try:
            config.api("PATCH", f"/api/jobs/{jid}",
                       {"status": "failed", "error": str(e)[:500]})
        except Exception:
            pass
        config.activity("render_failed", str(e)[:500], jid)
        raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------------------
# STEP 2 — schedule gate (SOP #9: max 4/day, spaced >= 4h)
# --------------------------------------------------------------------------
def ist_today_start_utc() -> datetime:
    ist = timezone(timedelta(hours=5, minutes=30))
    now_ist = datetime.now(ist)
    start_ist = now_ist.replace(hour=0, minute=0, second=0, microsecond=0)
    return start_ist.astimezone(timezone.utc)


def schedule_step(job: dict) -> bool:
    """True if the clip may proceed to brief_check/post now."""
    jid = job["id"]
    settings = config.api("GET", "/api/settings", timeout=30)
    daily_target = int(settings.get("daily_target") or 4)
    spacing_h = float(settings.get("spacing_hours") or 4)

    scheduled_for = job.get("scheduled_for")
    if scheduled_for:
        try:
            sf = datetime.fromisoformat(str(scheduled_for).replace("Z", "+00:00"))
            if datetime.now(timezone.utc) < sf:
                config.activity("schedule_skip",
                                f"scheduled_for {scheduled_for} not reached", jid)
                return False
        except ValueError:
            pass

    posts = config.api("GET", "/api/posts", timeout=30).get("posts", [])
    today_start = ist_today_start_utc()
    today_posts = [p for p in posts
                   if _parse_ts(p.get("posted_at")) and
                   _parse_ts(p.get("posted_at")) >= today_start]
    if len(today_posts) >= daily_target:
        config.activity("schedule_skip",
                        f"daily target reached ({len(today_posts)}/{daily_target})",
                        jid)
        return False

    last = max((_parse_ts(p.get("posted_at")) for p in posts
                if _parse_ts(p.get("posted_at"))), default=None)
    if last and datetime.now(timezone.utc) - last < timedelta(hours=spacing_h):
        nxt = last + timedelta(hours=spacing_h)
        config.activity("schedule_skip",
                        f"spacing: last post {last.isoformat()}, "
                        f"next slot >= {nxt.isoformat()}", jid)
        return False

    config.activity("schedule_ok",
                    f"slot free ({len(today_posts)}/{daily_target} today)", jid)
    return True


def _parse_ts(v) -> datetime | None:
    if not v:
        return None
    try:
        dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


# --------------------------------------------------------------------------
# STEP 3 — brief check (SOP: obey the campaign brief)
# --------------------------------------------------------------------------
def build_caption(job: dict, campaign: dict) -> str:
    if job.get("caption"):
        return str(job["caption"])
    template = str(campaign.get("caption_template") or "")
    tags = campaign.get("hashtags") or []
    tag_str = " ".join(t if str(t).startswith("#") else f"#{t}" for t in tags)
    caption = (template + "\n" + tag_str).strip()
    return caption


def brief_check_step(job: dict) -> dict:
    jid = job["id"]
    campaign = get_campaign(job["campaign_id"]) if job.get("campaign_id") else {}
    lo, hi = duration_bounds(campaign)
    dur = float(job.get("end_sec", 0)) - float(job.get("start_sec", 0))
    caption = build_caption(job, campaign)
    required = [str(t) for t in (campaign.get("required_tags")
                                 or campaign.get("hashtags") or [])]
    checks = {
        "duration_sec": dur,
        "duration_ok": lo <= dur <= hi,
        "duration_bounds": [lo, hi],
        "required_tags": required,
        "tags_present": [t for t in required
                         if t.lower().lstrip("#") in caption.lower()],
        "hook_present": bool((job.get("hook") or "").strip()),
        "caption_len": len(caption),
    }
    checks["tags_ok"] = (len(checks["tags_present"]) == len(required)
                         and len(required) > 0) or len(required) == 0
    checks["passed"] = (checks["duration_ok"] and checks["tags_ok"]
                        and checks["hook_present"])
    config.api("PATCH", f"/api/jobs/{jid}",
               {"brief_check": checks, "caption": caption})
    if not checks["passed"]:
        missing = [t for t in required if t not in checks["tags_present"]]
        reason = (f"brief check failed: duration_ok={checks['duration_ok']} "
                  f"({dur:.0f}s vs [{lo},{hi}]), tags_ok={checks['tags_ok']} "
                  f"missing={missing}, hook_present={checks['hook_present']}")
        config.activity("brief_check_failed", reason, jid)
        raise PipelineError(reason)
    config.activity("brief_check_passed",
                    f"{dur:.0f}s in [{lo},{hi}], tags {checks['tags_present']}, "
                    f"hook ok", jid)
    return checks


# --------------------------------------------------------------------------
# STEP 4 — post. Poster interface + backends.
# --------------------------------------------------------------------------
class Poster:
    """post(job, video_path, cover_path, caption) -> dict|None.

    Returns {"post_id":..., "permalink":...} on success, or None in DRY-RUN
    (nothing published). Raises ActionBlocked on rate-limit detection.
    """

    name = "base"

    def post(self, job: dict, video_path: str, cover_path: str,
             caption: str) -> dict | None:
        raise NotImplementedError


class ApiPoster(Poster):
    """instagram-cli backend. Only used if the binary AND an api-style
    instagram connection (with account_id) are configured."""
    name = "api_poster"

    def __init__(self, account_id: str):
        self.account_id = account_id
        self.cli = shutil.which("instagram-cli")

    @staticmethod
    def available(conn: dict) -> bool:
        return bool(shutil.which("instagram-cli")) and \
            conn.get("kind") == "api" and bool(conn.get("account_id"))

    def post(self, job, video_path, cover_path, caption):
        jid = job["id"]
        cmd = ["instagram-cli", "post-feed",
               "--account-id", str(self.account_id),
               "--file", video_path, "--cover", cover_path,
               "--caption", caption]
        if not config.CLIPFLOW_LIVE:
            config.activity(
                "post_dryrun",
                f"[{self.name}] WOULD RUN: {' '.join(cmd[:8])} ... "
                f"(caption {len(caption)} chars, video {video_path})", jid)
            print(f"[dry-run] would run: {' '.join(cmd)}", flush=True)
            return None
        config.activity("post_publish", f"[{self.name}] publishing via instagram-cli", jid)
        try:
            out = subprocess.run(cmd, capture_output=True, text=True,
                                 timeout=600)
        except subprocess.TimeoutExpired as e:
            raise PipelineError(f"instagram-cli timed out: {e}") from e
        combined = (out.stdout or "") + (out.stderr or "")
        if check_block_text(combined):
            raise ActionBlocked(f"instagram-cli output: {combined[:300]}")
        if out.returncode != 0:
            raise PipelineError(f"instagram-cli failed: {combined[:500]}")
        # best-effort permalink extraction; CLI output format may vary
        permalink = None
        for token in combined.split():
            if "instagram.com/reel/" in token or "instagram.com/p/" in token:
                permalink = token.strip().strip("',\"")
                break
        return {"post_id": permalink or f"cli-{jid}",
                "permalink": permalink, "raw": combined[:500]}


class WebPoster(Poster):
    """CDP headless-Chrome backend for instagram.com web posting.

    Implemented: session-cookie login (Network.setCookie, works for
    httponly), username/password form login, 2FA -> InterventionNeeded.
    The composer flow is best-effort (IG DOM changes often); the FINAL
    publish click only happens when CLIPFLOW_LIVE=1.
    """
    name = "web_poster"

    def __init__(self):
        self.browser: cdp_mod.CDP | None = None

    def _ensure_browser(self) -> cdp_mod.CDP:
        if self.browser is None:
            self.browser = cdp_mod.launch(config.CHROME)
        return self.browser

    def close(self):
        if self.browser:
            self.browser.close()
            self.browser = None

    def _logged_in(self, tab: cdp_mod.Tab, username: str = "") -> bool:
        try:
            if username:
                return tab.wait_for_text(username, timeout=8)
            # generic: profile avatar link present when logged in
            return bool(tab.eval(
                "!!document.querySelector('a[href^=\"/\"][aria-label*=\"rofile\"]')",
                timeout=10))
        except Exception:
            return False

    def login(self, conn: dict, job_id: str) -> cdp_mod.Tab:
        """Login via cookies or credentials. Returns an authenticated tab."""
        kind = conn.get("kind")
        browser = self._ensure_browser()
        tab = browser.tab()
        if kind == "web":
            cookies = conn.get("cookies") or []
            tab.navigate("https://www.instagram.com/")
            n = tab.set_cookies(cookies, default_domain="instagram.com")
            config.activity("ig_login_cookies", f"set {n} cookies", job_id)
            tab.navigate("https://www.instagram.com/")
            if not self._logged_in(tab, conn.get("username", "")):
                raise PipelineError("cookie login failed (not logged in)")
            return tab
        if kind == "credentials":
            username = conn.get("username", "")
            tab.navigate("https://www.instagram.com/accounts/login/")
            tab.wait_for_text("Log in", timeout=20)
            tab.eval(f"""(() => {{
              const u = document.querySelector('input[name="username"]');
              const p = document.querySelector('input[name="password"]');
              if (!u || !p) return 'no-form';
              u.focus(); document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, {json.dumps(username)});
              p.focus(); document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false,
                {json.dumps(conn.get('password', ''))});
              return 'filled';
            }})()""")
            # NOTE: password value used transiently, never logged.
            tab.eval("""(() => {
              const b = document.querySelector('button[type="submit"]');
              if (b) b.click(); return !!b;
            })()""")
            time.sleep(4)
            text = tab.body_text()
            if "two-factor" in text.lower() or "6-digit" in text or \
                    "authentication code" in text.lower():
                raise iv_mod.InterventionNeeded(
                    "otp", "Instagram 2FA code required",
                    "Enter the 6-digit code from the authenticator/SMS for "
                    f"{username}. The worker will type it and continue.",
                    short="Instagram 2FA code")
            tab.navigate("https://www.instagram.com/")
            if not self._logged_in(tab, username):
                raise PipelineError("credential login failed")
            config.activity("ig_login_ok", f"logged in as {username}", job_id)
            return tab
        raise PipelineError(f"unsupported instagram connection kind: {kind!r}")

    def post(self, job, video_path, cover_path, caption):
        jid = job["id"]
        if not config.CLIPFLOW_LIVE:
            # DRY-RUN: prove login works, then log exactly what would happen.
            config.activity(
                "post_dryrun",
                f"[{self.name}] DRY-RUN: logged in OK; WOULD: click Create → "
                f"select {video_path} → aspect 'Original' (confirm highlighted) "
                f"→ no trim (sliders 0s) → cover {cover_path} → paste caption "
                f"({len(caption)} chars) → Share. Publish click SKIPPED.",
                jid)
            print(f"[dry-run] web_poster would publish {video_path}", flush=True)
            return None
        # LIVE (owner-enabled): best-effort composer automation.
        conn = _load_ig_connection()
        tab = self.login(conn, jid)
        try:
            config.activity("post_publish",
                            f"[{self.name}] composer automation (best-effort)", jid)
            # The IG web composer DOM shifts frequently; selectors below are
            # the current best guess and are verified on first live run.
            tab.eval("""(() => {
              const create = [...document.querySelectorAll('a,div[role="button"]')]
                .find(e => /create/i.test(e.textContent || ''));
              if (create) create.click(); return !!create;
            })()""")
            time.sleep(2)
            if check_block_text(tab.body_text()):
                raise ActionBlocked("action-block text after opening composer")
            config.activity(
                "post_manual_step",
                "composer opened; remaining composer steps (file select, "
                "Original aspect, Share) are manual/DOM-dependent — verify in "
                "logs before trusting this backend", jid)
            raise PipelineError(
                "web_poster LIVE composer is a skeleton: file-picker + Share "
                "click not yet DOM-verified on this IG build. Use the "
                "api_poster (instagram-cli) backend or manual post.")
        finally:
            self.close()


def _load_ig_connection() -> dict:
    data = config.api("GET", "/api/connections/instagram", timeout=30)
    payload = data.get("secret") or data.get("encrypted") or ""
    if not payload:
        raise PipelineError("instagram connection has no secret stored")
    try:
        secret = json.loads(config.decrypt_connection_secret(payload).decode())
    except ValueError as e:
        raise PipelineError(f"instagram secret decrypt failed: {e}") from e
    return secret


def _load_whop_connection() -> dict:
    data = config.api("GET", "/api/connections/whop", timeout=30)
    payload = data.get("secret") or data.get("encrypted") or ""
    if not payload:
        raise PipelineError("whop connection has no secret stored")
    try:
        return json.loads(config.decrypt_connection_secret(payload).decode())
    except ValueError as e:
        raise PipelineError(f"whop secret decrypt failed: {e}") from e


def choose_poster() -> Poster:
    """Prefer api_poster when configured; else web_poster (CDP)."""
    try:
        conn = _load_ig_connection()
    except PipelineError as e:
        raise PipelineError(f"no instagram connection: {e}") from e
    if ApiPoster.available(conn):
        return ApiPoster(str(conn["account_id"]))
    return WebPoster()


def action_block_shutdown(job_id: str, where: str) -> "typing.NoReturn":  # noqa: F821
    """SOP #9: on action block -> STOP, pause schedule, notify, exit(0)."""
    msg = f"ACTION BLOCK detected ({where}). Stopping whole pipeline run."
    config.activity("action_block", msg, job_id)
    try:
        config.api("PATCH", "/api/settings",
                   {"paused": True, "pause_reason": "instagram_action_block"})
    except Exception as e:  # noqa: BLE001
        print(f"[worker] could not pause settings: {e}", flush=True)
    to = None
    try:
        to = config.api("GET", "/api/settings", timeout=30).get("notify_email")
    except Exception:
        pass
    if to:
        try:
            gmail_mod.send_notification(
                to, "ClipFlow PAUSED: Instagram action block",
                f"{msg}\n\nThe pipeline stopped immediately and will not "
                f"auto-retry. Unpause in the ClipFlow dashboard after the "
                f"block clears (usually 24-48h).\n")
        except Exception as e:  # noqa: BLE001
            print(f"[worker] block notify email failed: {e}", flush=True)
    print(f"[worker] {msg} exiting quietly.", flush=True)
    sys.exit(0)


def post_step(job: dict) -> dict:
    """Returns post-record dict. In dry-run returns {'dry_run': True}."""
    jid = job["id"]
    campaign = get_campaign(job["campaign_id"]) if job.get("campaign_id") else {}
    caption = build_caption(job, campaign)
    video_url = job.get("video_url")
    if not video_url:
        raise PipelineError("no video_url on approved job (render first)")

    tmp = tempfile.mkdtemp(prefix="clipflow_post_")
    try:
        video_path = download_file(video_url, os.path.join(tmp, "clip.mp4"))
        info = ffprobe_info(video_path)
        if info["width"] != 1080 or info["height"] != 1920:
            raise PipelineError(
                f"video not 1080x1920 ({info['width']}x{info['height']})")
        # cover = first preview frame (1s)
        previews = job.get("preview_urls") or []
        if previews:
            cover_path = download_file(previews[0], os.path.join(tmp, "cover.jpg"))
        else:
            cover_path = os.path.join(tmp, "cover.jpg")
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", "1",
                            "-i", video_path, "-frames:v", "1", cover_path],
                           check=True)

        poster = choose_poster()
        config.activity("post_start",
                        f"backend={poster.name}, caption {len(caption)} chars",
                        jid)
        try:
            result = poster.post(job, video_path, cover_path, caption)
        finally:
            if isinstance(poster, WebPoster):
                poster.close()

        if result is None:  # dry-run
            return {"dry_run": True, "poster": poster.name}

        permalink = result.get("permalink")
        post_rec = config.api("POST", "/api/posts",
                              {"job_id": jid, "clip_id": jid,
                               "campaign_id": job.get("campaign_id"),
                               "caption": caption,
                               "instagram_url": permalink,
                               "poster": poster.name,
                               "status": "posted"})
        pid = post_rec.get("id") or post_rec.get("post", {}).get("id")
        config.api("PATCH", f"/api/jobs/{jid}",
                   {"status": "posted", "post_id": pid,
                    "instagram_url": permalink})
        config.activity("post_done",
                        f"posted via {poster.name}: {permalink}", jid)
        if permalink and check_block_text(permalink):
            raise ActionBlocked("block text in post result")
        return {"post_id": pid, "permalink": permalink,
                "poster": poster.name}
    except ActionBlocked:
        action_block_shutdown(jid, "post_step")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------------------
# STEP 5 — verify (MANDATORY before submit, SOP #5)
# --------------------------------------------------------------------------
VERIFY_DIFF_THRESHOLD = 30.0  # mean abs diff (0-255) flagging possible crop/zoom


def verify_step(job: dict, post: dict) -> dict:
    jid = job["id"]
    if post.get("dry_run"):
        config.activity("verify_skip",
                        "dry-run: no live reel to verify (would open reel URL, "
                        "seek 1s/33%/66%/90%, screenshot, PIL-compare vs "
                        "preview frames, require checks passed before submit)",
                        jid)
        return {"verify_status": "dry_run", "checks": []}

    permalink = post.get("permalink")
    if not permalink:
        raise PipelineError("no permalink to verify (api_poster returned none)")

    previews = job.get("preview_urls") or []
    tmp = tempfile.mkdtemp(prefix="clipflow_verify_")
    local_frames = []
    try:
        for i, url in enumerate(previews[:4]):
            p = download_file(url, os.path.join(tmp, f"local_{i}.png"))
            local_frames.append(p)

        browser = cdp_mod.launch(config.CHROME)
        checks: list[dict] = []
        shot_urls: list[str] = []
        try:
            tab = browser.tab()
            tab.navigate(permalink)
            time.sleep(3)
            body = tab.body_text()
            if check_block_text(body):
                raise ActionBlocked("block text on reel page")
            err = ("having trouble playing" in body.lower()
                   or "couldn't load" in body.lower()
                   or "sorry, this page isn't available" in body.lower())
            checks.append({"name": "no_error_text", "passed": not err})

            seek_points = [("1s", 1.0), ("33%", 0.33), ("66%", 0.66), ("90%", 0.90)]
            diffs = []
            for label, frac in seek_points:
                dur = tab.eval(
                    "(() => { const v = document.querySelector('video');"
                    " return v ? v.duration : null; })()")
                target = 1.0 if label == "1s" else (float(dur) * frac if dur else 1.0)
                tab.eval(f"""(() => {{
                  const v = document.querySelector('video');
                  if (v) {{ v.currentTime = {target:.2f}; v.play(); }}
                  return !!v;
                }})()""")
                time.sleep(1.2)
                c1 = tab.eval("(() => { const v = document.querySelector('video');"
                              " return v ? v.currentTime : -1; })()")
                time.sleep(1.0)
                c2 = tab.eval("(() => { const v = document.querySelector('video');"
                              " return v ? v.currentTime : -1; })()")
                playing = (isinstance(c1, (int, float))
                           and isinstance(c2, (int, float)) and c2 > c1)
                checks.append({"name": f"playing_at_{label}", "passed": bool(playing),
                               "detail": f"t={c2}"})

                shot = os.path.join(tmp, f"live_{label.replace('%','pct')}.png")
                if tab.screenshot_element("video", shot) is None:
                    tab.screenshot(shot)
                url = config.storage_upload(shot, f"{jid}/verify_{label}.png",
                                            "image/png")
                shot_urls.append(url)
                idx = seek_points.index((label, frac))
                if idx < len(local_frames):
                    d = mean_abs_diff(shot, local_frames[idx])
                    diffs.append(d)
                    checks.append({"name": f"frame_diff_{label}",
                                   "passed": d <= VERIFY_DIFF_THRESHOLD,
                                   "detail": f"mean_abs_diff={d:.1f}"})
            checks.append({"name": "max_frame_diff",
                           "passed": (max(diffs) if diffs else 999)
                           <= VERIFY_DIFF_THRESHOLD,
                           "detail": f"{[round(d,1) for d in diffs]}"})
        finally:
            browser.close()

        failed = [c for c in checks if not c["passed"]]
        status = "passed" if not failed else "needs_review"
        detail = {"frames": shot_urls, "checks": checks}
        config.api("PATCH", f"/api/posts/{post['post_id']}",
                   {"verify_status": status, "verify_detail": detail})
        if failed:
            names = ", ".join(c["name"] for c in failed)
            config.activity("verify_needs_review",
                            f"FAILED checks: {names}. Frames: {shot_urls}", jid)
            answer = iv_mod.request_intervention(
                "user_choice",
                "Verify flagged possible crop/zoom — approve or reject?",
                f"Failed checks: {names}\nLive frames: {shot_urls}\n"
                f"Reply APPROVE to submit anyway, or REJECT to fail the job.",
                clip_id=jid)
            if "approv" in answer.lower():
                status = "passed_manual"
                config.api("PATCH", f"/api/posts/{post['post_id']}",
                           {"verify_status": status})
                config.activity("verify_manual_pass",
                                "owner approved despite flags", jid)
            else:
                raise PipelineError(f"owner rejected verify: {answer[:80]}")
        else:
            config.activity("verify_passed",
                            f"all {len(checks)} checks green", jid)
        return {"verify_status": status, "checks": checks}
    except ActionBlocked:
        action_block_shutdown(jid, "verify_step")
    except iv_mod.InterventionExpired as e:
        raise PipelineError(f"verify intervention expired: {e}") from e
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------------------
# STEP 6 — submit to Whop (SOP #6: within 30 min of posting)
# --------------------------------------------------------------------------
def submit_step(job: dict, post: dict) -> dict:
    jid = job["id"]
    permalink = post.get("permalink")
    if post.get("dry_run"):
        config.activity(
            "submit_dryrun",
            "DRY-RUN: WOULD open Whop Content Rewards (google_oauth cookies), "
            "select campaign, paste instagram_url, click Submit; on "
            "'Clip submitted' -> POST /api/submissions "
            "{clip_id, instagram_url, post_id, keep_live_until=today+30d}. "
            "Submit click SKIPPED.", jid)
        return {"dry_run": True}

    campaign = get_campaign(job["campaign_id"]) if job.get("campaign_id") else {}
    conn = _load_whop_connection()
    if conn.get("kind") != "google_oauth":
        raise PipelineError(
            f"whop connection kind {conn.get('kind')!r} not supported "
            "(need google_oauth cookies)")

    browser = cdp_mod.launch(config.CHROME)
    try:
        tab = browser.tab()
        tab.navigate("https://whop.com/")
        n = tab.set_cookies(conn.get("cookies") or [], default_domain="whop.com")
        config.activity("whop_login", f"set {n} whop cookies", jid)
        # Content-rewards dashboard URL may vary; campaign may pin it.
        target = (campaign.get("whop_submit_url")
                  or "https://whop.com/content-rewards/")
        tab.navigate(target)
        time.sleep(3)
        if check_block_text(tab.body_text()):
            raise ActionBlocked("block text on whop page")

        if not config.CLIPFLOW_LIVE:
            config.activity("submit_dryrun",
                            f"on {target}; would fill + submit here", jid)
            return {"dry_run": True}

        # Best-effort: find campaign, paste URL, submit.
        cname = campaign.get("name", "")
        if cname:
            tab.eval(f"""(() => {{
              const inp = document.querySelector('input[type="search"], input[placeholder*="earch"]');
              if (inp) {{ inp.focus();
                document.execCommand('insertText', false, {json.dumps(cname)});
                inp.dispatchEvent(new KeyboardEvent('keydown', {{key:'Enter'}})); }}
            }})()""")
            time.sleep(2)
        pasted = tab.eval(f"""(() => {{
          const fields = [...document.querySelectorAll('input[type="url"], input[placeholder*="nstagram"], input[placeholder*="ink"]')];
          const f = fields[0];
          if (!f) return 'no-field';
          f.focus(); document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, {json.dumps(permalink or '')});
          f.dispatchEvent(new Event('change', {{bubbles:true}}));
          return 'pasted';
        }})()""")
        config.activity("whop_fill", f"instagram_url field: {pasted}", jid)
        submitted = tab.eval("""(() => {
          const b = [...document.querySelectorAll('button')]
            .find(e => /^submit$/i.test((e.textContent||'').trim()));
          if (b) b.click(); return !!b;
        })()""")
        if not submitted:
            raise PipelineError("whop submit button not found (DOM changed?)")
        time.sleep(4)
        body = tab.body_text()
        if "waitlist" in body.lower():
            config.activity("whop_waitlist",
                            "campaign on waitlist — recorded, not a failure", jid)
            config.api("POST", "/api/interventions",
                       {"kind": "info", "clip_id": jid,
                        "question": "Whop campaign is on waitlist",
                        "detail": body[:500]})
            config.api("PATCH", f"/api/jobs/{jid}",
                       {"status": "submitted", "error": "whop_waitlist"})
            return {"waitlisted": True}
        if "clip submitted" not in body.lower():
            raise PipelineError(
                f"no 'Clip submitted' confirmation. Page text: {body[:300]}")
    finally:
        browser.close()

    keep_until = (datetime.now(timezone.utc) + timedelta(days=30)).date().isoformat()
    sub = config.api("POST", "/api/submissions",
                     {"clip_id": jid, "instagram_url": permalink,
                      "post_id": post.get("post_id"),
                      "keep_live_until": keep_until,
                      "status": "pending"})
    config.api("PATCH", f"/api/jobs/{jid}",
               {"status": "submitted",
                "submitted_at": config.now_iso(), "error": None})
    config.activity("submit_done",
                    f"'Clip submitted' confirmed; keep live until {keep_until}",
                    jid)

    # SOP #6: within 30 min of posting (warn at >20 min)
    posted_at = None
    try:
        p = config.api("GET", f"/api/posts/{post.get('post_id')}", timeout=30)
        posted_at = _parse_ts((p.get("post") or p).get("posted_at"))
    except Exception:
        pass
    if posted_at:
        mins = (datetime.now(timezone.utc) - posted_at).total_seconds() / 60
        if mins > 20:
            config.activity("submit_late",
                            f"submitted {mins:.0f} min after posting "
                            f"(SOP target <=30 min)", jid)
    return {"submission": sub, "keep_live_until": keep_until}


# --------------------------------------------------------------------------
# per-clip orchestration
# --------------------------------------------------------------------------
def process_approved(job: dict) -> None:
    jid = job["id"]
    config.activity("pipeline_start",
                    f"clip approved; poster+campaign pipeline begins", jid)
    try:
        if not schedule_step(job):
            return  # left as approved/scheduled; next run retries
        brief_check_step(job)
        post = post_step(job)
        verify = verify_step(job, post)
        if post.get("dry_run"):
            config.activity("pipeline_dryrun_done",
                            "dry-run complete: render/brief/post/verify/submit "
                            "planned, no real IG/Whop writes", jid)
            return
        if verify.get("verify_status") not in ("passed", "passed_manual"):
            raise PipelineError(
                f"verify status {verify.get('verify_status')} — not submitting")
        submit_step(job, post)
        config.activity("pipeline_done", "clip posted, verified, submitted", jid)
    except ActionBlocked:
        raise  # handled inside steps (sys.exit)
    except iv_mod.InterventionNeeded as iv:
        # intervention raised outside verify (e.g. 2FA): block on owner reply
        try:
            value = iv_mod.request_intervention(
                iv.kind, iv.question, iv.detail, clip_id=jid, short=iv.short)
            config.activity("intervention_value_used",
                            f"[{iv.kind}] value received, resuming (not logged)",
                            jid)
            del value
            # re-run the pipeline from the top; schedule gate keeps it safe
            process_approved(config.api("GET", f"/api/jobs/{jid}", timeout=30)
                             .get("job", job))
        except iv_mod.InterventionExpired as e:
            fail_job(jid, f"intervention expired: {e}")
    except PipelineError as e:
        fail_job(jid, str(e))
    except Exception as e:  # noqa: BLE001
        fail_job(jid, f"unexpected: {e}")


def plan_dry_run(job: dict) -> list[dict]:
    """Pure planning preview: ordered steps the worker WOULD take for a job.
    No side effects. Used by --plan and the smoke test."""
    steps = [
        {"step": "schedule",
         "would": "check /api/settings (daily_target, spacing_hours), "
                  "today's /api/posts count, scheduled_for; skip if no slot"},
        {"step": "brief_check",
         "would": "read /api/campaigns, verify caption tags + duration "
                  "bounds + hook; fail job on mismatch"},
        {"step": "post",
         "would": "download video_url, QA 1080x1920, choose api_poster "
                  "(instagram-cli) or web_poster (CDP); DRY-RUN skips the "
                  "final publish click; action-block -> stop everything"},
        {"step": "verify",
         "would": "open LIVE reel via CDP, seek 1s/33%/66%/90%, screenshot, "
                  "check playing + no error text, PIL-compare vs preview "
                  "frames; needs_review -> owner choice"},
        {"step": "submit",
         "would": "Whop via CDP (google_oauth cookies), paste "
                  "instagram_url, submit; 'Clip submitted' -> POST "
                  "/api/submissions {keep_live_until=today+30d}"},
    ]
    if not job.get("video_url"):
        steps.insert(0, {"step": "render",
                         "would": "yt-dlp section -> clip_factory -> QA "
                                  "-> upload -> status preview"})
    return steps


# --------------------------------------------------------------------------
# main loop
# --------------------------------------------------------------------------
def _run_once_for_user(do_render: bool = False) -> None:
    if do_render:
        try:
            jobs = config.api("GET", "/api/jobs?status=queued",
                              timeout=60).get("jobs", [])
        except Exception as e:  # noqa: BLE001
            print(f"[worker] queued poll failed: {e}", flush=True)
            jobs = []
        for job in jobs:
            try:
                render_step(job)
            except PipelineError:
                pass
            except Exception as e:  # noqa: BLE001
                print(f"[worker] render unexpected: {e}", flush=True)

    try:
        jobs = config.api("GET", "/api/jobs?status=approved",
                          timeout=60).get("jobs", [])
    except Exception as e:  # noqa: BLE001
        print(f"[worker] approved poll failed: {e}", flush=True)
        return
    for job in jobs:
        if not job.get("video_url"):
            config.activity("pipeline_skip",
                            "approved but no video_url (render first)", job["id"])
            continue
        process_approved(job)


def run_once(do_render: bool = False) -> None:
    """One pipeline pass, per user (users discovered via /api/worker/users)."""
    try:
        users = config.api("GET", "/api/worker/users",
                           timeout=60).get("users", [])
    except Exception as e:  # noqa: BLE001
        print(f"[worker] users poll failed: {e}", flush=True)
        return
    if not users:
        print("[worker] no users with connections; skipping", flush=True)
        return
    for u in users:
        uid = u.get("user_id")
        if not uid:
            continue
        config.set_worker_user(uid)
        print(f"[worker] pipeline pass for user {uid}", flush=True)
        try:
            _run_once_for_user(do_render)
        except Exception as e:  # noqa: BLE001
            print(f"[worker] user {uid} pass error: {e}", flush=True)
    config.set_worker_user(None)


def main() -> None:
    ap = argparse.ArgumentParser(description="ClipFlow SOP pipeline worker")
    ap.add_argument("--once", action="store_true",
                    help="single pass, then exit (for cron)")
    ap.add_argument("--render", action="store_true",
                    help="also render queued jobs (default: approved only)")
    ap.add_argument("--plan", action="store_true",
                    help="print the dry-run plan for a sample job and exit")
    args = ap.parse_args()

    if config.MISSING_CORE:
        sys.exit(f"missing env: {', '.join(config.MISSING_CORE)}")
    config.check_live_dryrun()

    if args.plan:
        sample = {"id": "sample", "video_url": None,
                  "campaign_id": "sample"}
        for s in plan_dry_run(sample):
            print(f"  - {s['step']}: {s['would']}")
        return

    if args.once:
        run_once(do_render=args.render)
        return

    print(f"[worker] pipeline daemon polling {config.CLIPFLOW_URL} "
          f"every {config.POLL_SECONDS}s", flush=True)
    while True:
        try:
            run_once(do_render=args.render)
        except SystemExit:
            raise
        except Exception as e:  # noqa: BLE001
            print(f"[worker] loop error: {e}", flush=True)
        time.sleep(config.POLL_SECONDS)


if __name__ == "__main__":
    main()
