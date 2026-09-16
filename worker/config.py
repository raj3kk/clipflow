#!/usr/bin/env python3
"""
ClipFlow pipeline worker — shared config.

Env vars, the no_proxy/httpx bracket fix, AES-256-GCM decryption of
connection secrets (mirrors the documented Next.js lib/crypto format:
base64 JSON {"iv","tag","data"}, 32-byte key from hex in
CONNECTIONS_ENCRYPT_KEY), and small Supabase REST + storage helpers
over stdlib urllib (no heavy deps).

Security: never log or print decrypted secret values.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# --------------------------------------------------------------------------
# no_proxy bracket fix (httpx/huggingface_hub choke on "[::1]" style entries)
# --------------------------------------------------------------------------
for _var in ("no_proxy", "NO_PROXY"):
    _val = os.environ.get(_var)
    if _val:
        os.environ[_var] = ",".join(p for p in _val.split(",") if "[" not in p)


# --------------------------------------------------------------------------
# env
# --------------------------------------------------------------------------
def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


CLIPFLOW_URL: str = env("CLIPFLOW_URL").rstrip("/")
SUPABASE_URL: str = env("SUPABASE_URL").rstrip("/")
SUPABASE_SERVICE_KEY: str = env("SUPABASE_SERVICE_KEY")
WORKER_SECRET: str = env("WORKER_SECRET")
CONNECTIONS_ENCRYPT_KEY: str = env("CONNECTIONS_ENCRYPT_KEY")  # 64-char hex
CLIPFLOW_LIVE: bool = env("CLIPFLOW_LIVE", "0") == "1"  # dry-run unless "1"
POLL_SECONDS: int = int(env("POLL_SECONDS", "60") or 60)
GMAIL_POLL_SECONDS: int = int(env("GMAIL_POLL_SECONDS", "120") or 120)

FACTORY = os.path.expanduser("~/workspace/whop-clipping/clip_factory.py")
YTDLP = os.path.expanduser("~/workspace/whop-edit-env/bin/yt-dlp")
CHROME = "/opt/meta-chromium/chrome"

MISSING_CORE = [
    k for k, v in {
        "CLIPFLOW_URL": CLIPFLOW_URL,
        "SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_SERVICE_KEY": SUPABASE_SERVICE_KEY,
    }.items() if not v
]

_LIVE_WARNING_PRINTED = False


def check_live_dryrun() -> None:
    """Print a loud banner once so nobody mistakes dry-run for live."""
    global _LIVE_WARNING_PRINTED
    if not _LIVE_WARNING_PRINTED:
        _LIVE_WARNING_PRINTED = True
        if CLIPFLOW_LIVE:
            print("[worker] *** LIVE MODE: real publish/submit clicks ENABLED ***",
                  flush=True)
        else:
            print("[worker] DRY-RUN mode (CLIPFLOW_LIVE != 1): no real IG "
                  "publish or Whop submit will happen.", flush=True)


# --------------------------------------------------------------------------
# AES-256-GCM decryption (mirror of the documented Next.js lib/crypto)
#
# Ciphertext format: base64(JSON({"iv": b64, "tag": b64, "data": b64}))
# Key: CONNECTIONS_ENCRYPT_KEY, 64 hex chars -> 32 bytes.
# --------------------------------------------------------------------------
def decrypt_connection_secret(payload_b64: str) -> bytes:
    """
    Decrypt an AES-256-GCM connection secret. Raises ValueError on any
    failure (bad key, tampered payload). Never logs the secret value.
    """
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as e:  # pragma: no cover
        raise RuntimeError(
            "cryptography package required to decrypt connection secrets; "
            "install it into the edit venv (pip install cryptography)"
        ) from e

    key_hex = (CONNECTIONS_ENCRYPT_KEY or "").strip()
    if len(key_hex) != 64:
        raise ValueError(
            "CONNECTIONS_ENCRYPT_KEY must be 64 hex chars (32 bytes); "
            f"got length {len(key_hex)}"
        )
    try:
        key = bytes.fromhex(key_hex)
    except ValueError as e:
        raise ValueError("CONNECTIONS_ENCRYPT_KEY is not valid hex") from e

    try:
        envelope = json.loads(base64.b64decode(payload_b64).decode("utf-8"))
        iv = base64.b64decode(envelope["iv"])
        tag = base64.b64decode(envelope["tag"])
        data = base64.b64decode(envelope["data"])
    except Exception as e:
        raise ValueError(f"malformed encrypted payload: {e}") from e

    try:
        return AESGCM(key).decrypt(iv, data + tag, None)
    except Exception as e:  # authentication failure included
        raise ValueError(f"secret decryption failed (bad key or tampered): {e}") from e


def encrypt_connection_secret(plaintext: bytes) -> str:
    """Test/utility helper: encrypt with the same envelope format."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = bytes.fromhex((CONNECTIONS_ENCRYPT_KEY or "").strip())
    if len(key) != 32:
        raise ValueError("CONNECTIONS_ENCRYPT_KEY must be 64 hex chars")
    iv = os.urandom(12)
    ct = AESGCM(key).encrypt(iv, plaintext, None)
    data, tag = ct[:-16], ct[-16:]
    envelope = {
        "iv": base64.b64encode(iv).decode(),
        "tag": base64.b64encode(tag).decode(),
        "data": base64.b64encode(data).decode(),
    }
    return base64.b64encode(json.dumps(envelope).encode()).decode()


# --------------------------------------------------------------------------
# ClipFlow API (x-worker-secret header)
# --------------------------------------------------------------------------
def api(method: str, path: str, body: dict | None = None,
        timeout: int = 60) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(CLIPFLOW_URL + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    if WORKER_SECRET:
        req.add_header("x-worker-secret", WORKER_SECRET)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        raise RuntimeError(f"ClipFlow API {method} {path} -> {e.code}: {detail}") from e


def activity(event: str, detail: str = "", clip_id: str | None = None) -> None:
    """Best-effort activity_log entry. Never raises."""
    try:
        body = {"actor": "worker", "event": event, "detail": detail}
        if clip_id:
            body["clip_id"] = clip_id
        api("POST", "/api/activity", body, timeout=30)
    except Exception as e:  # noqa: BLE001
        print(f"[worker] activity log failed ({event}): {e}", flush=True)


# --------------------------------------------------------------------------
# Supabase REST (service_role) + storage
# --------------------------------------------------------------------------
def sb_headers(extra: dict | None = None) -> dict:
    h = {"apikey": SUPABASE_SERVICE_KEY,
         "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}"}
    if extra:
        h.update(extra)
    return h


def sb_request(method: str, path: str, body: dict | None = None,
               query: dict | None = None, timeout: int = 60) -> dict:
    url = SUPABASE_URL + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    for k, v in sb_headers(
            {"Content-Type": "application/json"} if data else {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        raise RuntimeError(f"Supabase {method} {path} -> {e.code}: {detail}") from e


def sb_select(table: str, filters: dict | None = None,
              select: str = "*", limit: int = 100) -> list:
    q: dict = {"select": select, "limit": str(limit)}
    if filters:
        for k, v in filters.items():
            q[k] = f"eq.{v}"
    res = sb_request("GET", f"/rest/v1/{table}", query=q)
    return res if isinstance(res, list) else [res]


def sb_insert(table: str, row: dict) -> dict:
    res = sb_request("POST", f"/rest/v1/{table}", body=row,
                     query={"select": "representation"})
    if isinstance(res, list) and res:
        return res[0]
    return res if isinstance(res, dict) else {}


def sb_patch(table: str, row_id: str, patch: dict) -> dict:
    res = sb_request("PATCH", f"/rest/v1/{table}",
                     body=patch, query={"id": f"eq.{row_id}"})
    if isinstance(res, list) and res:
        return res[0]
    return res if isinstance(res, dict) else {}


def storage_upload(local_path: str, dest_name: str, content_type: str,
                   bucket: str = "clips") -> str:
    """Upload to a Supabase storage bucket; returns the public URL."""
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{dest_name}"
    with open(local_path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(url, data=data, method="POST")
    for k, v in sb_headers({"Content-Type": content_type,
                            "x-upsert": "true"}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:300]
        raise RuntimeError(f"storage upload -> {e.code}: {detail}") from e
    return f"{SUPABASE_URL}/storage/v1/object/public/{bucket}/{dest_name}"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")
