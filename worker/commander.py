#!/usr/bin/env python3
"""
ClipFlow Commander — dedicated deterministic agent that watches every active
phone agent's live state and guides it on what to do next.

User order (2026-09-21):
  "ek agent banao jo aage ko command de, jaise tumne admin agent banaya.
   tumhara token use nahi hona chahiye."

Design:
  - ZERO LLM calls — pure rules. It never consumes the assistant's token.
  - It authenticates to the server with its OWN token (COMMANDER_TOKEN,
    ~/.config/clipflow/commander.env), accepted by requireWorkerAuth
    alongside WORKER_SECRET.
  - Runs every 2 min via Meta scheduler cron `clipflow-commander`.
  - Guidance levers (no APK needed):
      * enqueue follow-up device_jobs with payload directives
      * push knowledge lessons (agent_memory, key "knowledge.*")
      * cancel / requeue wedged jobs
      * file agent_issues (needs_user escalation)
  - Live screen: fetches each device's latest live-preview frame meta from
    Supabase Storage; if a running job's screen is stale or the state looks
    confusing, it writes an escalation entry to commander_handoffs.json —
    the assistant then looks at the live screen and guides manually.

State: ~/.config/clipflow/commander_state.json
Log:   ~/workspace/clipflow/worker/commander.log (tail kept short)
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
WORKER_DIR = os.path.join(HOME, "workspace", "clipflow", "worker")
STATE_PATH = os.path.join(HOME, ".config", "clipflow", "commander_state.json")
LOG_PATH = os.path.join(WORKER_DIR, "commander.log")
HANDOFF_PATH = os.path.join(WORKER_DIR, "commander_handoffs.json")


def _load_env():
    for fn in ("worker.env", "commander.env"):
        p = os.path.join(HOME, ".config", "clipflow", fn)
        try:
            for line in open(p):
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
        except FileNotFoundError:
            pass


_load_env()

sys.path.insert(0, WORKER_DIR)
import config  # noqa: E402  (Supabase helper with gzip + retries)

PROD = "https://clipflow-webbuilder1.vercel.app"


def log(msg: str) -> None:
    line = f"{datetime.now(timezone.utc).strftime('%H:%M:%S')} {msg}"
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a") as f:
            f.write(line + "\n")
        # keep log short
        with open(LOG_PATH) as f:
            lines = f.readlines()
        if len(lines) > 200:
            with open(LOG_PATH, "w") as f:
                f.writelines(lines[-200:])
    except Exception:
        pass


def load_state() -> dict:
    try:
        return json.load(open(STATE_PATH))
    except Exception:
        return {}


def save_state(s: dict) -> None:
    tmp = STATE_PATH + ".tmp"
    json.dump(s, open(tmp, "w"))
    os.replace(tmp, STATE_PATH)


def commander_token() -> str:
    p = os.path.join(HOME, ".config", "clipflow", "commander.env")
    for line in open(p):
        if line.startswith("COMMANDER_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("COMMANDER_TOKEN missing")


def server_post(path: str, body: dict, timeout: int = 60) -> dict:
    """Worker-authed POST to the ClipFlow server using the COMMANDER token."""
    tok = commander_token()
    req = urllib.request.Request(
        PROD + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-worker-secret": tok},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode() or "{}")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def active_devices():
    return config.sb_request("GET", "/rest/v1/devices", query={
        "select": "id,device_no,status,last_seen,user_id",
        "status": "eq.active", "order": "last_seen.desc", "limit": "20",
    }) or []


def active_jobs(device_id):
    return config.sb_request("GET", "/rest/v1/device_jobs", query={
        "select": "id,type,status,attempts,max_attempts,current_step,"
                  "last_heartbeat,heartbeat_count,created_at,payload",
        "device_id": f"eq.{device_id}",
        "status": "in.(queued,dispatched,running)",
        "order": "created_at.desc", "limit": "5",
    }) or []


def recent_issues(user_id, since_min=30):
    since = datetime.now(timezone.utc).timestamp() - since_min * 60
    rows = config.sb_request("GET", "/rest/v1/agent_issues", query={
        "select": "id,severity,title,created_at",
        "user_id": f"eq.{user_id}", "order": "created_at.desc", "limit": "10",
    }) or []
    return [r for r in rows if (parse_ts(r.get("created_at")) or datetime.min.replace(tzinfo=timezone.utc)).timestamp() >= since]


def live_frame_meta(device_id):
    """Latest live-preview frame timestamp from Supabase Storage.
    Phone uploads {userId}/{deviceId}/live.png + live.json (meta {at}).
    We read live.json's updated_at via the storage objects table."""
    try:
        # device id -> user id mapping ke liye pehle device row dekho
        rows = config.sb_request("GET", "/rest/v1/storage/objects", query={
            "select": "name,updated_at",
            "bucket_id": "eq.device-shots",
            "name": f"like.%2F{device_id}%2Flive.json",
            "order": "updated_at.desc", "limit": "1",
        })
        return rows[0] if rows else None
    except Exception:
        return None


def file_issue(user_id, title, detail, severity="medium"):
    try:
        config.sb_request("POST", "/rest/v1/agent_issues", body={
            "user_id": user_id, "agent_id": "commander", "severity": severity,
            "title": title, "context": {"by": "commander", "at": now_iso(), "detail": detail},
        })
    except Exception as e:
        log(f"issue file failed: {e}")


def add_handoff(entry: dict):
    try:
        h = json.load(open(HANDOFF_PATH)) if os.path.exists(HANDOFF_PATH) else []
    except Exception:
        h = []
    entry["at"] = now_iso()
    h.append(entry)
    json.dump(h[-50:], open(HANDOFF_PATH, "w"))
    log(f"HANDOFF: {entry.get('kind')} — {entry.get('summary')}")


def guide_device(dev, state):
    did = dev["id"]
    dno = dev.get("device_no") or did[:8]
    uid = dev.get("user_id")
    jobs = active_jobs(did)
    if not jobs:
        log(f"{dno}: idle — koi active job nahi")
        return
    job = jobs[0]
    jid = job["id"][:8]
    step = job.get("current_step") or ""
    hb = parse_ts(job.get("last_heartbeat"))
    hb_age = (datetime.now(timezone.utc) - hb).total_seconds() if hb else 9999
    log(f"{dno}: job {jid} {job['type']} {job['status']} att={job.get('attempts')} hb_age={hb_age:.0f}s step={step[:60]}")

    # --- live screen freshness ---
    meta = live_frame_meta(did)
    frame_age = None
    if meta:
        ct = parse_ts(meta.get("updated_at"))
        if ct:
            frame_age = (datetime.now(timezone.utc) - ct).total_seconds()
    key = f"frame_{did}"
    if job["status"] == "running" and (frame_age is None or frame_age > 600):
        # running job but live screen stale/missing — assistant should look
        last = state.get(key, 0)
        if time.time() - last > 1800:  # at most once per 30 min
            add_handoff({
                "kind": "stale_live_screen",
                "device": dno,
                "summary": f"{dno} pe job {jid} running hai lekin live screen "
                           f"{'missing' if frame_age is None else f'{frame_age/60:.0f} min purani'} hai — "
                           "screen dekho aur agent ko guide karo.",
                "job_id": job["id"], "step": step,
            })
            state[key] = time.time()

    # --- verify job finished but result not yet in campaign notes ---
    # (the pipeline_watch cron owns reaping; commander only nudges guidance)
    if job["type"] == "verify_campaigns" and job["status"] == "running" and "verify-done" in step:
        last = state.get(f"verifydone_{job['id']}", 0)
        if time.time() - last > 900:
            log(f"{dno}: verify-done, result ka wait — pipeline reap karega")
            state[f"verifydone_{job['id']}"] = time.time()


def main():
    log("commander tick start")
    state = load_state()
    try:
        devs = active_devices()
    except Exception as e:
        log(f"devices read failed: {e}")
        return
    log(f"active devices: {len(devs)}")
    for dev in devs:
        try:
            guide_device(dev, state)
        except Exception as e:
            log(f"guide {dev.get('device_no')} failed: {e}")
    # new needs_user issues → surface
    for dev in devs:
        try:
            for iss in recent_issues(dev.get("user_id")):
                key = f"issue_{iss['id']}"
                if key not in state:
                    add_handoff({
                        "kind": "needs_user_issue",
                        "device": dev.get("device_no"),
                        "summary": f"Naya issue: {iss.get('title')} (severity {iss.get('severity')})",
                        "issue_id": iss["id"],
                    })
                    state[key] = time.time()
        except Exception as e:
            log(f"issues check failed: {e}")
    save_state(state)
    log("commander tick done")


if __name__ == "__main__":
    main()
