#!/usr/bin/env python3
"""
ClipFlow render worker — runs on the VM that has the free edit stack
(ffmpeg + faster-whisper + clip_factory.py).

Loop:
  1. Poll  CLIPFLOW_URL/api/jobs?status=queued
  2. For each job: mark rendering -> run clip_factory -> upload mp4 + preview
     frames to Supabase storage -> mark preview (or failed).

Env:
  CLIPFLOW_URL            e.g. https://clipflow-xxx.vercel.app
  SUPABASE_URL            Supabase project URL
  SUPABASE_SERVICE_KEY    service_role key (server-side only)
  WORKER_SECRET           shared secret, sent as x-worker-secret header
  POLL_SECONDS            default 60
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

CLIPFLOW_URL = os.environ.get("CLIPFLOW_URL", "").rstrip("/")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
WORKER_SECRET = os.environ.get("WORKER_SECRET", "")
POLL = int(os.environ.get("POLL_SECONDS", "60"))

FACTORY = os.path.expanduser("~/workspace/whop-clipping/clip_factory.py")
VENV_PY = os.path.expanduser("~/workspace/whop-edit-env/bin/python")
PROFILE = os.path.expanduser("~/workspace/whop-clipping/perplexity_profile.json")

# httpx/no_proxy workaround (same as clip_factory)
for _v in ("no_proxy", "NO_PROXY"):
    _val = os.environ.get(_v)
    if _val:
        os.environ[_v] = ",".join(p for p in _val.split(",") if "[" not in p)


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(CLIPFLOW_URL + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if WORKER_SECRET:
        req.add_header("x-worker-secret", WORKER_SECRET)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def storage_upload(local_path, dest_name, content_type):
    url = f"{SUPABASE_URL}/storage/v1/object/clips/{dest_name}"
    with open(local_path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("apikey", SERVICE_KEY)
    req.add_header("Authorization", f"Bearer {SERVICE_KEY}")
    req.add_header("Content-Type", content_type)
    req.add_header("x-upsert", "true")
    with urllib.request.urlopen(req, timeout=300) as resp:
        resp.read()
    return f"{SUPABASE_URL}/storage/v1/object/public/clips/{dest_name}"


def render_job(job):
    jid = job["id"]
    print(f"[worker] rendering job {jid}", flush=True)
    api("PATCH", f"/api/jobs/{jid}", {"status": "rendering"})
    tmp = tempfile.mkdtemp(prefix="clipflow_")
    out_mp4 = os.path.join(tmp, "clip.mp4")
    try:
        # 1. download the requested source section
        src_section = os.path.join(tmp, "src.mp4")
        dl = [
            os.path.expanduser("~/workspace/whop-edit-env/bin/yt-dlp"),
            "--no-check-certificate", "--js-runtimes", "node",
            "--extractor-args", "youtube:player_client=android",
            "--download-sections", f"*{int(job['start_sec'])-10}-{int(job['end_sec'])+10}",
            "--force-keyframes-at-cuts",
            "-o", src_section, job["source_url"],
        ]
        subprocess.run(dl, check=True, capture_output=True)
        # 2. render 9:16 clip
        cmd = [
            VENV_PY, FACTORY,
            "--src", src_section,
            "--start", "10", "--end", str(10 + (job["end_sec"] - job["start_sec"])),
            "--out", out_mp4,
            "--profile", PROFILE,
        ]
        subprocess.run(cmd, check=True, capture_output=True)
        # 3. preview frames at 1s / 33% / 66% / 90%
        dur = job["end_sec"] - job["start_sec"]
        preview_urls = []
        for i, frac in enumerate([0.03, 0.33, 0.66, 0.9]):
            t = max(0.5, dur * frac)
            png = os.path.join(tmp, f"p{i}.png")
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-ss", str(t), "-i", out_mp4,
                 "-frames:v", "1", png],
                check=True, capture_output=True,
            )
            preview_urls.append(
                storage_upload(png, f"{jid}/preview_{i}.png", "image/png")
            )
        video_url = storage_upload(out_mp4, f"{jid}/clip.mp4", "video/mp4")
        api("PATCH", f"/api/jobs/{jid}",
            {"status": "preview", "video_url": video_url,
             "preview_urls": preview_urls, "error": None})
        print(f"[worker] job {jid} -> preview", flush=True)
    except subprocess.CalledProcessError as e:
        err = (e.stderr or b"")[-500:].decode(errors="replace") if isinstance(e.stderr, bytes) else str(e)
        api("PATCH", f"/api/jobs/{jid}", {"status": "failed", "error": err})
        print(f"[worker] job {jid} FAILED: {err}", flush=True)
    except Exception as e:  # noqa: BLE001
        api("PATCH", f"/api/jobs/{jid}", {"status": "failed", "error": str(e)[:500]})
        print(f"[worker] job {jid} FAILED: {e}", flush=True)


def main():
    missing = [k for k, v in {
        "CLIPFLOW_URL": CLIPFLOW_URL, "SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_SERVICE_KEY": SERVICE_KEY}.items() if not v]
    if missing:
        sys.exit(f"missing env: {', '.join(missing)}")
    print(f"[worker] polling {CLIPFLOW_URL} every {POLL}s", flush=True)
    while True:
        try:
            jobs = api("GET", "/api/jobs?status=queued").get("jobs", [])
            for job in jobs:
                render_job(job)
        except Exception as e:  # noqa: BLE001
            print(f"[worker] poll error: {e}", flush=True)
        time.sleep(POLL)


if __name__ == "__main__":
    main()
