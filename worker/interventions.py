#!/usr/bin/env python3
"""
ClipFlow interventions — the worker's way of asking the owner for input.

Flow:
  raise InterventionNeeded(kind, question, detail)
  -> POST /api/interventions {kind, clip_id, question, detail}
  -> Gmail email "ClipFlow input needed: <question-short>" to
     settings.notify_email from the gmail connection
  -> wait: poll Gmail IMAP for a reply with matching subject
     OR poll GET /api/interventions?status=resolved for this id
  -> GET /api/interventions/[id]/consume -> value (transient, never logged)
  -> resume.

Timeout 30 min -> mark expired -> raise InterventionExpired (the pipeline
catches it and fails the job gracefully).
"""

from __future__ import annotations

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config  # noqa: E402
import gmail  # noqa: E402

INTERVENTION_TIMEOUT_SECONDS = 30 * 60


class InterventionNeeded(Exception):
    """Raised inside the pipeline when human input is required."""

    def __init__(self, kind: str, question: str, detail: str = "",
                 short: str = ""):
        super().__init__(question)
        self.kind = kind            # e.g. 'otp', 'user_choice', 'captcha'
        self.question = question
        self.detail = detail
        self.short = short or question[:60]


class InterventionExpired(Exception):
    """No owner reply within the timeout window."""


def _notify_email() -> str | None:
    try:
        settings = config.api("GET", "/api/settings", timeout=30)
        return settings.get("notify_email")
    except Exception as e:  # noqa: BLE001
        print(f"[worker] could not read settings.notify_email: {e}", flush=True)
        return None


def request_intervention(kind: str, question: str, detail: str = "",
                         clip_id: str | None = None,
                         timeout: int = INTERVENTION_TIMEOUT_SECONDS) -> str:
    """
    Full blocking intervention: create the record, email the owner, wait
    for a reply, consume the value. Returns the value (transient).
    Raises InterventionExpired on timeout.
    """
    short = (question[:60] + "…") if len(question) > 60 else question

    # 1. create the intervention record
    body: dict = {"kind": kind, "question": question,
                  "detail": detail, "short": short}
    if clip_id:
        body["clip_id"] = clip_id
    record = config.api("POST", "/api/interventions", body, timeout=30)
    iv_id = record.get("id") or record.get("intervention", {}).get("id")
    if not iv_id:
        raise RuntimeError(f"intervention POST returned no id: {record}")
    config.activity("intervention_opened",
                    f"[{kind}] {short} (id {iv_id})", clip_id)

    # 2. email the owner
    to = _notify_email()
    if to:
        try:
            gmail.send_notification(
                to,
                f"ClipFlow input needed: {short}",
                f"ClipFlow needs your input to continue.\n\n"
                f"Question: {question}\n\n"
                f"{detail}\n\n"
                f"Reply to this email with your answer (or resolve it in "
                f"the ClipFlow dashboard). The worker checks every "
                f"{config.GMAIL_POLL_SECONDS}s and continues automatically "
                f"for up to 30 minutes.\n")
            config.activity("intervention_emailed",
                            f"email sent to {to}", clip_id)
        except Exception as e:  # noqa: BLE001
            config.activity("intervention_email_failed", str(e)[:300], clip_id)
    else:
        config.activity("intervention_no_notify_email",
                        "settings.notify_email empty — owner must check dashboard",
                        clip_id)

    # 3. wait for a reply (IMAP) or dashboard resolution
    sent_at = time.time()
    subject_hint = f"ClipFlow input needed: {short}"
    while time.time() - sent_at < timeout:
        # a) dashboard resolution
        try:
            resolved = config.api(
                "GET", f"/api/interventions?status=resolved", timeout=30)
            items = resolved.get("interventions", resolved if isinstance(
                resolved, list) else [])
            if any(str(i.get("id")) == str(iv_id) for i in (items or [])):
                break
        except Exception:
            pass
        # b) email reply
        try:
            reply = gmail.find_reply(sent_at, subject_hint)
            if reply:
                # record it so the dashboard shows answered
                try:
                    config.api("PATCH", f"/api/interventions/{iv_id}",
                               {"status": "resolved"}, timeout=30)
                except Exception:
                    pass
                break
        except Exception as e:  # noqa: BLE001
            print(f"[worker] intervention poll email error: {e}", flush=True)
        time.sleep(config.GMAIL_POLL_SECONDS)
    else:
        try:
            config.api("PATCH", f"/api/interventions/{iv_id}",
                       {"status": "expired"}, timeout=30)
        except Exception:
            pass
        config.activity("intervention_expired",
                        f"no reply within {timeout // 60} min (id {iv_id})",
                        clip_id)
        raise InterventionExpired(f"no owner reply for: {question}")

    # 4. consume the value — transient, never logged
    try:
        consumed = config.api("GET", f"/api/interventions/{iv_id}/consume",
                              timeout=30)
    except Exception as e:
        raise RuntimeError(f"intervention consume failed: {e}") from e
    value = consumed.get("value") or consumed.get("answer") or ""
    if not value:
        raise RuntimeError("intervention resolved but no value returned")
    config.activity("intervention_answered",
                    f"[{kind}] answered (id {iv_id})", clip_id)
    return str(value)
