#!/usr/bin/env python3
"""
Whop email-OTP auto-login worker (narrow scope).

Picks up pending `whop_otp` interventions and completes them end to end:
  1. Headless Chromium (CDP) -> https://whop.com/login -> submit email
  2. Poll the user's CONNECTED Gmail (IMAP via gmail.py) for the fresh
     "Verify your Whop Sign-in" code email (never logged)
  3. Enter the code, wait for the logged-in state
  4. Capture whop.com session cookies -> POST /api/worker/connections
     (server encrypts; raw secrets never touch disk/logs)
  5. Mark the intervention resolved (or failed with a safe error message)

Security: the OTP code is used transiently in memory only. It is never
written to logs, files, the intervention row, or any API payload.
On CAPTCHA / challenge / action-block the run stops and the intervention
is marked failed with a human-readable reason.

Run: every 2 min via cron (flock-guarded). Only whop_otp interventions.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import config as cfg_mod          # noqa: E402
import cdp as cdp_mod             # noqa: E402
import gmail as gmail_mod         # noqa: E402

CHROME_PATH = os.environ.get("CLIPFLOW_CHROME_PATH", "/opt/meta-chromium/chrome")
WHOP_LOGIN_URL = "https://whop.com/login/"
CODE_WAIT_SECS = 240            # how long to wait for the Gmail code
CODE_POLL_SECS = 10
NAV_TIMEOUT = 45

_CODE_RE = re.compile(r"\b(\d{6})\b")


# -- small helpers ---------------------------------------------------------

def _log(msg: str) -> None:
    print(f"[whop_otp] {msg}", flush=True)


def _sb(path: str, method: str = "GET", body: object = None) -> object:
    url = cfg_mod.SUPABASE_URL + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", cfg_mod.SUPABASE_SERVICE_KEY)
    req.add_header("Authorization", f"Bearer {cfg_mod.SUPABASE_SERVICE_KEY}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=representation")
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode()
        return json.loads(raw) if raw else None


def _api(path: str, body: object, user_id: str) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(cfg_mod.CLIPFLOW_URL + path + f"?user_id={user_id}",
                                 data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    if cfg_mod.WORKER_SECRET:
        req.add_header("x-worker-secret", cfg_mod.WORKER_SECRET)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


def _pending() -> list[dict]:
    q = ("/rest/v1/interventions?kind=eq.whop_otp&status=eq.pending"
         "&order=created_at.asc&limit=5"
         "&select=id,user_id,question,detail,created_at")
    data = _sb(q)
    return data if isinstance(data, list) else []


def _set_step(inv_id: str, user_id: str, step: str, status: str = "in_progress",
              error: str | None = None) -> None:
    cur = _sb(f"/rest/v1/interventions?id=eq.{inv_id}&select=detail", )
    detail: dict = {}
    if isinstance(cur, list) and cur and isinstance(cur[0].get("detail"), dict):
        detail = dict(cur[0]["detail"])
    detail["step"] = step
    detail["error"] = error
    _sb(f"/rest/v1/interventions?id=eq.{inv_id}", "PATCH",
        {"status": status, "detail": detail,
         **({"resolved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            if status in ("resolved", "failed") else {})})


def _fail(inv_id: str, user_id: str, step: str, error: str) -> None:
    _log(f"attempt {inv_id[:8]} failed at {step}: {error}")
    _set_step(inv_id, user_id, step, status="failed", error=error)


def _extract_code(body: str) -> str | None:
    # Prefer a code near the word "code"; else the first 6-digit run that
    # is not part of a longer number.
    m = re.search(r"code[^0-9]{0,40}(\d{6})", body, re.IGNORECASE)
    if m:
        return m.group(1)
    m = _CODE_RE.search(body)
    return m.group(1) if m else None


# -- the login run ----------------------------------------------------------

def _run_attempt(inv: dict) -> None:
    inv_id = inv["id"]
    user_id = inv["user_id"]
    detail = inv.get("detail") or {}
    email = (detail.get("email") or "").strip().lower()
    if not email:
        _fail(inv_id, user_id, "queued", "No email on the OTP attempt.")
        return

    _log(f"attempt {inv_id[:8]} for {email[:2]}*** (user {user_id[:8]})")
    _set_step(inv_id, user_id, "opening_whop")
    # Scope all subsequent gmail/api calls to this attempt's user.
    cfg_mod.set_worker_user(user_id)

    # 1. Gmail must be connected — the code email has to land there.
    try:
        conns = cfg_mod.api(
            "GET",
            f"/api/worker/connections?service=gmail&user_id={user_id}")
    except Exception as e:
        _fail(inv_id, user_id, "opening_whop",
              f"Could not load Gmail connection: {e}")
        return
    if not (conns.get("connections")):
        _fail(inv_id, user_id, "opening_whop",
              "Gmail is not connected for this user — connect it first so the "
              "worker can read the Whop code email.")
        return

    browser = None
    try:
        browser = cdp_mod.CDP(CHROME_PATH,
                              tempfile.mkdtemp(prefix="clipflow-whop-otp-"))
        tab = browser.tab()
        tab.navigate(WHOP_LOGIN_URL, timeout=NAV_TIMEOUT)

        # Challenge screens -> stop, human needed.
        body = (tab.eval("document.body.innerText.slice(0,2000)") or "")
        low = body.lower()
        if any(w in low for w in ("captcha", "are you a robot", "verify you are human",
                                  "unusual traffic", "access denied")):
            _fail(inv_id, user_id, "opening_whop",
                  "Whop showed a CAPTCHA/challenge screen. Please sign in once "
                  "manually in your own browser, then retry.")
            return

        _set_step(inv_id, user_id, "submitting_email")
        filled = tab.eval("""(() => {
          const pick = (sels) => {
            for (const s of sels) { const el = document.querySelector(s); if (el) return el; }
            return null;
          };
          // 'Continue with email' chooser, if present
          const btns = Array.from(document.querySelectorAll('button'));
          const emailBtn = btns.find(b => /continue with email/i.test(b.innerText || ''));
          if (emailBtn) { emailBtn.click(); return 'chose-email'; }
          const em = pick(['input[type="email"]', 'input[name="email"]', 'input[inputmode="email"]', 'input[placeholder*="mail" i]']);
          if (!em) return 'no-email-field';
          em.focus(); document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, %s);
          em.dispatchEvent(new Event('input', {bubbles: true}));
          em.dispatchEvent(new Event('change', {bubbles: true}));
          const form = em.closest('form');
          const sub = (form && form.querySelector('button[type="submit"]')) || pick(['button[type="submit"]']);
          if (sub) { sub.click(); return 'submitted'; }
          em.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
          return 'enter-sent';
        })()""" % json.dumps(email))
        _log(f"email submit state: {filled}")
        if filled == "no-email-field":
            _fail(inv_id, user_id, "submitting_email",
                  "Whop login page did not show an email field (page layout changed).")
            return
        if filled == "chose-email":
            time.sleep(2)
            filled2 = tab.eval("""(() => {
              const em = document.querySelector('input[type="email"], input[name="email"]');
              if (!em) return 'no-email-field';
              em.focus(); document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, %s);
              em.dispatchEvent(new Event('input', {bubbles: true}));
              const sub = document.querySelector('button[type="submit"]');
              if (sub) { sub.click(); return 'submitted'; }
              return 'no-submit';
            })()""" % json.dumps(email))
            _log(f"email submit state (2nd): {filled2}")
            if filled2 in ("no-email-field", "no-submit"):
                _fail(inv_id, user_id, "submitting_email",
                      "Could not submit the email on Whop's login page.")
                return

        # 2. Wait for the OTP screen, then poll Gmail for the fresh code.
        _set_step(inv_id, user_id, "waiting_for_code")
        t0 = time.time()
        code_seen = tab.wait_for_text("code", timeout=25, case_sensitive=False)
        _log(f"otp screen visible: {code_seen}")
        deadline = t0 + CODE_WAIT_SECS
        code: str | None = None
        while time.time() < deadline and code is None:
            try:
                mail_body = gmail_mod.find_reply(t0, "whop")
            except Exception as e:
                _log(f"gmail poll error (retrying): {e}")
                mail_body = None
            if mail_body:
                code = _extract_code(mail_body)
                if code:
                    break
            time.sleep(CODE_POLL_SECS)
        if not code:
            _fail(inv_id, user_id, "waiting_for_code",
                  "No Whop code email arrived in the connected Gmail inbox within "
                  "4 minutes. Check the email address and that the inbox receives Whop mail.")
            return

        # 3. Enter the code (transient — never logged).
        _set_step(inv_id, user_id, "verifying_code")
        entered = tab.eval("""(() => {
          const boxes = Array.from(document.querySelectorAll('input')).filter(
            i => /code|otp|digit|token/i.test((i.name || '') + (i.placeholder || '') + (i.getAttribute('aria-label') || '')) || i.inputMode === 'numeric');
          const code = %s;
          if (boxes.length >= code.length) {
            boxes.slice(0, code.length).forEach((b, i) => {
              b.focus(); document.execCommand('selectAll', false, null);
              document.execCommand('insertText', false, code[i]);
              b.dispatchEvent(new Event('input', {bubbles: true}));
            });
            return 'boxes-filled';
          }
          const single = document.querySelector('input[type="text"], input:not([type])');
          if (single) {
            single.focus(); document.execCommand('selectAll', false, null);
            document.execCommand('insertText', false, code);
            single.dispatchEvent(new Event('input', {bubbles: true}));
            single.dispatchEvent(new Event('change', {bubbles: true}));
            const sub = document.querySelector('button[type="submit"]');
            if (sub) sub.click();
            return 'single-filled';
          }
          return 'no-code-field';
        })()""" % json.dumps(code))
        # code leaves Python scope right after this eval
        del code
        _log(f"code entry state: {entered}")
        if entered == "no-code-field":
            _fail(inv_id, user_id, "verifying_code",
                  "Whop did not show a code entry field (page layout changed).")
            return

        # 4. Wait for the logged-in state.
        logged_in = False
        for _ in range(30):
            time.sleep(2)
            try:
                logged_in = bool(tab.eval("""(() => {
                  const t = (document.body.innerText || '').slice(0, 3000);
                  return /dashboard|content rewards|log out|sign out/i.test(t) && !/verify/i.test(t.slice(0, 500));
                })()"""))
            except Exception:
                logged_in = False
            if logged_in:
                break
        # Fallback: session cookie presence is the real proof.
        cookies = tab.send("Network.getAllCookies", {}).get("cookies", [])
        whop_cookies = [c for c in cookies
                        if str(c.get("domain", "")).lstrip(".").endswith("whop.com")]
        session_names = {c.get("name") for c in whop_cookies}
        if not logged_in and not ({"__Secure-next-auth.session-token", "next-auth.session-token",
                                   "whop-session", "session"} & session_names):
            # check for an explicit error on the page
            err_text = (tab.eval("document.body.innerText.slice(0,1500)") or "").lower()
            if "invalid" in err_text or "expired" in err_text or "incorrect" in err_text:
                _fail(inv_id, user_id, "verifying_code",
                      "Whop rejected the code (invalid/expired). Please retry — a fresh code will be sent.")
            else:
                _fail(inv_id, user_id, "verifying_code",
                      "Whop login did not complete after entering the code.")
            return

        # 5. Save the session server-side (encrypted there).
        _set_step(inv_id, user_id, "saving_session")
        session = {
            "cookies": [
                {"name": c.get("name"), "value": c.get("value"),
                 "domain": c.get("domain"), "path": c.get("path", "/"),
                 "secure": bool(c.get("secure")), "httpOnly": bool(c.get("httpOnly")),
                 "expirationDate": c.get("expires", 0)}
                for c in whop_cookies
            ],
            "email": email,
            "obtained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "via": "otp_auto",
        }
        try:
            saved = _api("/api/worker/connections",
                         {"service": "whop", "method": "otp_auto",
                          "label": f"Whop OTP ({email})",
                          "secret": session, "status": "verified",
                          "meta": {"email": email, "via": "otp_auto"}},
                         user_id)
        except Exception as e:
            _fail(inv_id, user_id, "saving_session",
                  f"Login succeeded but saving the session failed: {e}")
            return
        finally:
            session["cookies"] = []  # drop raw values from memory ASAP

        if not saved.get("connection"):
            _fail(inv_id, user_id, "saving_session",
                  "Login succeeded but the session could not be saved.")
            return

        _set_step(inv_id, user_id, "connected", status="resolved")
        _log(f"attempt {inv_id[:8]} CONNECTED (whop session saved)")
    except cdp_mod.ChromeNotAvailable as e:
        _fail(inv_id, user_id, "opening_whop", f"Browser unavailable on worker: {e}")
    except Exception as e:
        _fail(inv_id, user_id, "saving_session", f"Unexpected error: {e}")
    finally:
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass


def main() -> int:
    if cfg_mod.MISSING_CORE:
        _log(f"config error: missing env: {', '.join(cfg_mod.MISSING_CORE)}")
        return 2
    items = _pending()
    if not items:
        _log("no pending whop_otp attempts")
        return 0
    _log(f"{len(items)} pending attempt(s)")
    for inv in items:
        try:
            _run_attempt(inv)
        except Exception as e:  # never let one attempt kill the batch
            _log(f"attempt {inv.get('id', '?')[:8]} crashed: {e}")
            try:
                _fail(inv["id"], inv["user_id"], "queued", f"Worker crash: {e}")
            except Exception:
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
