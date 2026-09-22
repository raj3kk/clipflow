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
import gzip
import http.client
import json
import os
import random
import socket
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
WORKER_USER_ID: str | None = None


def set_worker_user(uid: str | None) -> None:
    """Scope subsequent api() calls to one user's rows (?user_id=...)."""
    global WORKER_USER_ID
    WORKER_USER_ID = uid


def _user_path(path: str) -> str:
    """Append ?user_id= (or &user_id=) for per-user worker endpoints."""
    if not WORKER_USER_ID or path.startswith("/api/worker/users"):
        return path
    sep = "&" if "?" in path else "?"
    return f"{path}{sep}user_id={urllib.parse.quote(str(WORKER_USER_ID), safe='')}"


def api(method: str, path: str, body: dict | None = None,
        timeout: int = 60) -> dict:
    path = _user_path(path)
    data = json.dumps(body).encode() if body is not None else None
    last: Exception | None = None
    for attempt in range(3):
        req = urllib.request.Request(CLIPFLOW_URL + path, data=data,
                                     method=method)
        if data:
            req.add_header("Content-Type", "application/json")
        if WORKER_SECRET:
            req.add_header("x-worker-secret", WORKER_SECRET)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:400]
            raise RuntimeError(
                f"ClipFlow API {method} {path} -> {e.code}: {detail}") from e
        except Exception as e:  # noqa: BLE001 - transient network; retry
            last = e
            time.sleep(2 * (attempt + 1) + random.uniform(0, 1.5))
    raise RuntimeError(
        f"ClipFlow API {method} {path} network failed after 3 tries: {last}")


# --------------------------------------------------------------------------
# Service connections (decrypted locally; secrets never logged)
# --------------------------------------------------------------------------
def load_service_connections(service: str) -> list[dict]:
    """
    Fetch all saved connections for `service` for the current WORKER_USER_ID
    via the worker endpoint and decrypt each secret locally.

    Returns a list of dicts: the decrypted secret fields plus
    _id / _method / _status / _last_verified metadata.
    Raises RuntimeError when no usable connection is saved.
    """
    data = api("GET", f"/api/worker/connections?service={service}", timeout=30)
    rows = data.get("connections") or []
    out: list[dict] = []
    for row in rows:
        payload = row.get("secret_enc") or ""
        if not payload:
            continue
        try:
            secret = json.loads(decrypt_connection_secret(payload).decode("utf-8"))
        except ValueError as e:
            print(f"[worker] connection {row.get('id')} decrypt failed: {e}",
                  flush=True)
            continue
        if not isinstance(secret, dict):
            continue
        secret["_id"] = row.get("id")
        secret["_method"] = row.get("method")
        secret["_status"] = row.get("status")
        secret["_last_verified"] = row.get("last_verified")
        out.append(secret)
    if not out:
        raise RuntimeError(f"no usable {service} connection saved")
    return out


def pick_connection(conns: list[dict], prefer_kind: str | None = None) -> dict:
    """
    Pick the best connection from load_service_connections().
    Preferred kind first, then healthy status, keeping original order
    (newest first) as the final tiebreak.
    """
    def rank(c: dict) -> tuple[int, int]:
        kind_ok = 0 if (prefer_kind and c.get("kind") == prefer_kind) else 1
        status_ok = 0 if str(c.get("_status") or "").lower() in (
            "ok", "verified", "active", "connected") else 1
        return (kind_ok, status_ok)

    best = min(range(len(conns)), key=lambda i: rank(conns[i]))
    return conns[best]


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
#
# Egress proxy beech-beech me connection tod deta hai (RemoteDisconnected /
# IncompleteRead). urllib connection pool NAHI karta (har request fresh
# TCP connection), isliye "stale keep-alive" wala issue yahan nahi hai —
# fix = transient errors pe retry-with-backoff+jitter.
# --------------------------------------------------------------------------

class TransientError(RuntimeError):
    """Network blip jo retry se theek ho sakta hai (proxy drop, timeout, 5xx)."""


TRANSIENT_ERRORS = (
    http.client.RemoteDisconnected,
    http.client.IncompleteRead,
    socket.timeout,
    TimeoutError,
    ConnectionError,
    TransientError,  # 2026-09-20: junk-200-body bhi retry ke layak hai
)


def is_transient_error(e: BaseException) -> bool:
    """Ye error retry ke layak hai ya permanent?"""
    if isinstance(e, TRANSIENT_ERRORS):
        return True
    if isinstance(e, urllib.error.HTTPError):
        return 500 <= e.code < 600
    if isinstance(e, urllib.error.URLError):
        # Non-HTTP URLError = network level (DNS refused, proxy reset, ...).
        # reason me lipti hui socket/http-client error bhi transient hai.
        reason = getattr(e, "reason", None)
        if reason is None or isinstance(reason, TRANSIENT_ERRORS):
            return True
        return True
    return False


def _retry_wait(attempt: int) -> float:
    return min(2 ** attempt, 30) + random.uniform(0, 1.5)
def sb_headers(extra: dict | None = None) -> dict:
    h = {"apikey": SUPABASE_SERVICE_KEY,
         "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}"}
    if extra:
        h.update(extra)
    return h


def sb_request(method: str, path: str, body: dict | None = None,
               query: dict | None = None, timeout: int = 60,
               tries: int = 10, headers: dict | None = None) -> dict:
    """Supabase REST call — transient errors pe backoff+jitter ke saath retry.

    4xx = permanent (turant raise). Connection blips / timeouts / 5xx =
    transient (tries tak retry, phir TransientError).

    2026-09-20 CORE FIX: tries 6→10. Egress proxy se Supabase tak ka rasta
    chronic flaky hai (~20% per-query transient, bad bursts me ~70%).
    6 tries me p(all fail) ≈ 12% (bad burst) — planner FATAL ho jata tha.
    10 tries me ≈ 2.8% — bache hue case ke liye planner exit-code 3 deta hai
    (infra_unavailable) aur pipeline_watch attempt jalaye bina requeue karta
    hai.
    """
    url = SUPABASE_URL + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    data = json.dumps(body).encode() if body is not None else None
    last: BaseException | None = None
    for i in range(tries):
        req = urllib.request.Request(url, data=data, method=method)
        hdrs = {"Content-Type": "application/json"} if data else {}
        if headers:
            hdrs.update(headers)
        for k, v in sb_headers(hdrs).items():
            req.add_header(k, v)
        # 2026-09-21 CORE FIX: egress proxy mid-transfer connection kill
        # karta hai (IncompleteRead) — chhota transfer = kam exposure.
        # PostgREST gzip support karta hai; 15KB JSON ~2-3KB me simat jata
        # hai. urllib khud decompress NAHI karta — yahan haath se karo.
        req.add_header("Accept-Encoding", "gzip")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw_bytes = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw_bytes = gzip.decompress(raw_bytes)
                raw = raw_bytes.decode()
                if not raw:
                    return {}
                parsed = json.loads(raw)
                # 2026-09-20 CORE FIX: proxy kabhi 200 pe junk body bhejta hai
                # (JSON string/number/null) — ye valid API response nahi hai.
                # Transient maanke retry karo, warna aage "'str' object has no
                # attribute 'get'" jaisi cryptic crash hoti hai.
                if not isinstance(parsed, (dict, list)):
                    raise TransientError(
                        f"junk 200 body from {path}: {raw[:60]!r}")
                return parsed
        except urllib.error.HTTPError as e:
            if 500 <= e.code < 600 and i < tries - 1:
                wait = _retry_wait(i)
                print(f"[worker] sb {method} {path} -> {e.code} "
                      f"(retry {i + 1}/{tries}, {wait:.1f}s)", flush=True)
                time.sleep(wait)
                last = e
                continue
            detail_raw = e.read()
            # 2026-09-21: error bodies bhi gzip me aa sakte hain — warna
            # diagnostics me compressed binary dikhta hai.
            try:
                if e.headers and e.headers.get("Content-Encoding") == "gzip":
                    detail_raw = gzip.decompress(detail_raw)
            except Exception:
                pass
            detail = detail_raw.decode(errors="replace")[:400]
            raise RuntimeError(
                f"Supabase {method} {path} -> {e.code}: {detail}") from e
        except Exception as e:  # noqa: BLE001
            if not is_transient_error(e):
                raise
            last = e
            if i < tries - 1:
                wait = _retry_wait(i)
                print(f"[worker] sb {method} {path} transient "
                      f"({type(e).__name__}) "
                      f"(retry {i + 1}/{tries}, {wait:.1f}s)", flush=True)
                time.sleep(wait)
                continue
    assert last is not None
    raise TransientError(
        f"Supabase {method} {path} transient failed after {tries} tries: "
        f"{type(last).__name__}: {last}") from last


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
                   bucket: str = "clips", tries: int = 3) -> str:
    """Upload to a Supabase storage bucket; returns the public URL.

    x-upsert:true ki wajah se retry idempotent hai (same path overwrite).
    """
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{dest_name}"
    with open(local_path, "rb") as f:
        data = f.read()
    last: BaseException | None = None
    for i in range(tries):
        req = urllib.request.Request(url, data=data, method="POST")
        for k, v in sb_headers({"Content-Type": content_type,
                                "x-upsert": "true"}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                resp.read()
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:300]
            if 500 <= e.code < 600 and i < tries - 1:
                wait = _retry_wait(i)
                print(f"[worker] storage upload -> {e.code} "
                      f"(retry {i + 1}/{tries}, {wait:.1f}s)", flush=True)
                time.sleep(wait)
                last = e
                continue
            raise RuntimeError(
                f"storage upload -> {e.code}: {detail}") from e
        except Exception as e:  # noqa: BLE001
            if not is_transient_error(e):
                raise
            last = e
            if i < tries - 1:
                wait = _retry_wait(i)
                print(f"[worker] storage upload transient "
                      f"({type(e).__name__}) "
                      f"(retry {i + 1}/{tries}, {wait:.1f}s)", flush=True)
                time.sleep(wait)
                continue
    else:
        # loop bina break ke poora chala = sab tries transient me gire
        assert last is not None
        raise TransientError(
            f"storage upload transient failed after {tries} tries: "
            f"{type(last).__name__}: {last}") from last
    return f"{SUPABASE_URL}/storage/v1/object/public/{bucket}/{dest_name}"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")
