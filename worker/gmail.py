#!/usr/bin/env python3
"""
ClipFlow Gmail helper — IMAP read + SMTP send for the worker.

Auth styles (both come from the encrypted gmail connection secret stored
by the ClipFlow UI, never from this repo):
  - app_password: {"kind":"app_password","email":..., "app_password":...}
  - oauth:        {"kind":"oauth","email":..., "client_id":...,
                   "client_secret":..., "refresh_token":...}

Secrets are used transiently and never logged.

Public API:
  send_notification(to, subject, body) -> None
  find_reply(since_epoch, subject_hint) -> str | None  (latest matching body)
"""

from __future__ import annotations

import base64
import email
import email.header
import imaplib
import json
import os
import smtplib
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402

GMAIL_SCOPE_TOKEN_URL = "https://oauth2.googleapis.com/token"

# -- transient, process-local only -----------------------------------------
_oauth_access_cache: dict = {}  # email -> (access_token, expires_at)


def _load_connections() -> list[dict]:
    """
    Fetch + decrypt ALL gmail connections for the current worker user.
    Use _read_connection() for IMAP reads, _send_connection() for SMTP.
    """
    return config.load_service_connections("gmail")


def _read_connection() -> dict:
    """Prefer OAuth for reading (least privilege); fall back to app password."""
    return config.pick_connection(_load_connections(), prefer_kind="oauth")


def _send_connection() -> dict:
    """
    Prefer the app-password method for sending: the Google OAuth grant is
    read-only (gmail.readonly), so SMTP XOAUTH2 cannot send through it.
    """
    conns = _load_connections()
    for c in conns:
        if c.get("kind") == "app_password":
            return c
    raise RuntimeError(
        "gmail: sending email needs a Gmail app-password connection "
        "(Connections tab -> Gmail -> App password). The OAuth grant is "
        "read-only and cannot send mail."
    )


def _oauth_access_token(conn: dict) -> str:
    email_addr = conn["email"]
    cached = _oauth_access_cache.get(email_addr)
    if cached and cached[1] > time.time() + 60:
        return cached[0]
    body = urllib.parse.urlencode({
        "client_id": conn["client_id"],
        "client_secret": conn["client_secret"],
        "refresh_token": conn["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request(GMAIL_SCOPE_TOKEN_URL, data=body, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            tok = json.loads(resp.read().decode())
    except Exception as e:
        raise RuntimeError(f"gmail oauth token refresh failed: {e}") from e
    access = tok.get("access_token")
    if not access:
        raise RuntimeError(f"gmail oauth refresh returned no access_token: {tok}")
    _oauth_access_cache[email_addr] = (
        access, time.time() + int(tok.get("expires_in", 3600)))
    return access


def _xoauth2_string(user: str, access_token: str) -> str:
    return base64.b64encode(
        f"user={user}\x01auth=Bearer {access_token}\x01\x01".encode()).decode()


# -- IMAP ------------------------------------------------------------------
class _ImapSession:
    def __init__(self, conn: dict):
        self.conn = conn
        self.imap = imaplib.IMAP4_SSL("imap.gmail.com", 993)

    def __enter__(self) -> imaplib.IMAP4_SSL:
        kind = self.conn.get("kind")
        if kind == "app_password":
            self.imap.login(self.conn["email"], self.conn["app_password"])
        elif kind == "oauth":
            token = _oauth_access_token(self.conn)
            typ, data = self.imap.authenticate(
                "XOAUTH2", lambda _: _xoauth2_string(self.conn["email"], token))
            if typ != "OK":
                raise RuntimeError(f"gmail IMAP XOAUTH2 failed: {data}")
        else:
            raise RuntimeError(f"unknown gmail connection kind: {kind!r}")
        self.imap.select("INBOX")
        return self.imap

    def __exit__(self, *exc):
        try:
            self.imap.close()
        except Exception:
            pass
        try:
            self.imap.logout()
        except Exception:
            pass


def _decode_header(value) -> str:
    if not value:
        return ""
    parts = email.header.decode_header(value)
    out = []
    for text, charset in parts:
        if isinstance(text, bytes):
            out.append(text.decode(charset or "utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def find_reply(since_epoch: float, subject_hint: str) -> str | None:
    """
    Search INBOX for the newest message received after since_epoch whose
    Subject or In-Reply-To matches subject_hint. Returns the plain-text
    body (stripped), or None. Secrets never logged.
    """
    conn = _read_connection()
    hint = subject_hint.lower()
    with _ImapSession(conn) as imap:
        since_str = time.strftime("%d-%b-%Y", time.gmtime(since_epoch - 86400))
        typ, data = imap.search(None, f'(SINCE "{since_str}")')
        if typ != "OK":
            return None
        ids = data[0].split()
        for msg_id in reversed(ids[-30:]):  # newest first, bounded
            typ, fetched = imap.fetch(msg_id, "(RFC822)")
            if typ != "OK":
                continue
            msg = email.message_from_bytes(fetched[0][1])
            subj = _decode_header(msg.get("Subject", ""))
            if hint not in subj.lower():
                continue
            date_hdr = msg.get("Date", "")
            try:
                ts = email.utils.parsedate_to_datetime(date_hdr).timestamp()
            except Exception:
                ts = since_epoch
            if ts < since_epoch:
                continue
            # plain-text body
            body = ""
            if msg.is_multipart():
                for part in msg.walk():
                    if part.get_content_type() == "text/plain" and \
                            "attachment" not in str(part.get("Content-Disposition")):
                        body = part.get_payload(decode=True) or b""
                        body = body.decode(errors="replace")
                        break
            else:
                payload = msg.get_payload(decode=True) or b""
                body = payload.decode(errors="replace")
            return body.strip() or None
    return None


# -- SMTP ------------------------------------------------------------------
def send_notification(to: str, subject: str, body: str) -> None:
    """
    Send a plain-text email from the gmail connection. Used for
    intervention prompts, action-block alerts, and failure notices.
    """
    conn = _send_connection()
    msg = email.message.EmailMessage()
    msg["From"] = conn["email"]
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)

    smtp = smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=60)
    try:
        # _send_connection() guarantees kind == "app_password".
        smtp.login(conn["email"], conn["app_password"])
        smtp.send_message(msg)
    finally:
        try:
            smtp.quit()
        except Exception:
            pass
