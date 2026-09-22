#!/usr/bin/env python3
"""
Minimal Chrome DevTools Protocol client over websocket-client.

Purpose-built for the ClipFlow web_poster: open tabs, set cookies,
navigate, run JS, capture screenshots, wait for text. Small, timeout-safe,
stdlib-style. Requires the `websocket-client` package (pip installed into
the edit venv); raises a clear error if missing.

NOT a general automation framework — do not grow it without a reason.
"""

from __future__ import annotations

import base64
import json
import subprocess
import tempfile
import time
import urllib.request
import uuid

try:
    import websocket  # websocket-client
    _HAS_WS = True
except ImportError:  # graceful degradation for non-CDP paths
    _HAS_WS = False


class CDPError(RuntimeError):
    pass


class ChromeNotAvailable(CDPError):
    """Raised when CDP/Chrome cannot be started — caller must degrade."""


def _http_json(url: str, method: str = "GET", timeout: int = 10) -> object:
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


class CDP:
    """One browser connection; create tabs via .tab()."""

    def __init__(self, chrome_path: str, profile_dir: str,
                 extra_args: list[str] | None = None,
                 startup_timeout: int = 30):
        if not _HAS_WS:
            raise ChromeNotAvailable(
                "websocket-client is not installed; web poster unavailable")
        self._proc = subprocess.Popen(
            [chrome_path, "--headless=new", "--no-sandbox",
             "--disable-gpu", "--disable-dev-shm-usage",
             "--window-size=1280,900",
             f"--user-data-dir={profile_dir}",
             f"--remote-debugging-port=0",
             "about:blank",
             *(extra_args or [])],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self._profile_dir = profile_dir
        # Chrome prints the DevTools URL to stderr; we instead scan the
        # HTTP endpoint on the ephemeral port. The port is announced via
        # DevToolsActivePort in the user-data-dir.
        port_file = tempfile.gettempdir()
        deadline = time.time() + startup_timeout
        self.port: int | None = None
        while time.time() < deadline:
            try:
                with open(f"{profile_dir}/DevToolsActivePort") as f:
                    lines = f.read().strip().splitlines()
                self.port = int(lines[0])
                break
            except (OSError, ValueError, IndexError):
                if self._proc.poll() is not None:
                    raise ChromeNotAvailable(
                        f"chrome exited during startup (code {self._proc.returncode})")
                time.sleep(0.2)
        if self.port is None:
            self.close()
            raise ChromeNotAvailable("timed out waiting for DevTools port")

    def _endpoint(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def tab(self) -> "Tab":
        info = _http_json(self._endpoint() + "/json/new?about:blank")
        if not isinstance(info, dict) or "webSocketDebuggerUrl" not in info:
            raise CDPError(f"could not create tab: {info}")
        return Tab(info["webSocketDebuggerUrl"], info.get("id", ""))

    def close(self) -> None:
        try:
            self._proc.terminate()
            self._proc.wait(timeout=5)
        except Exception:
            pass


class Tab:
    """One CDP page session."""

    def __init__(self, ws_url: str, target_id: str = ""):
        self.ws_url = ws_url
        self.target_id = target_id
        self._seq = 0
        self._ws = websocket.create_connection(ws_url, timeout=30)
        # enable domains we need
        self.send("Page.enable")
        self.send("Runtime.enable")
        self.send("Network.enable")

    # -- low level -------------------------------------------------------
    def send(self, method: str, params: dict | None = None,
             timeout: int = 30) -> dict:
        self._seq += 1
        msg = {"id": self._seq, "method": method,
               "params": params or {}}
        self._ws.send(json.dumps(msg))
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise CDPError(f"CDP timeout waiting for {method}")
            self._ws.settimeout(remaining)
            try:
                raw = self._ws.recv()
            except Exception as e:
                raise CDPError(f"CDP recv failed for {method}: {e}") from e
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            if data.get("id") == self._seq:
                if "error" in data:
                    raise CDPError(f"CDP {method}: {data['error']}")
                return data.get("result", {})

    def close(self) -> None:
        try:
            self._ws.close()
        except Exception:
            pass

    # -- navigation / cookies --------------------------------------------
    def navigate(self, url: str, timeout: int = 45) -> None:
        self.send("Page.navigate", {"url": url})
        self.wait_for_load(timeout=timeout)

    def wait_for_load(self, timeout: int = 45) -> None:
        """Poll document.readyState until complete (or timeout)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            state = self.eval("document.readyState", timeout=10)
            if state == "complete":
                return
            time.sleep(0.5)
        # tolerate: page may stream (reels); don't hard-fail

    def set_cookie(self, name: str, value: str, domain: str,
                   path: str = "/", http_only: bool = False,
                   secure: bool = True, expires: int = 0) -> None:
        params: dict = {"name": name, "value": value, "domain": domain,
                        "path": path, "httpOnly": http_only, "secure": secure}
        if expires > 0:
            params["expires"] = expires
        self.send("Network.setCookie", params)

    def set_cookies(self, cookies: list[dict], default_domain: str = "") -> int:
        n = 0
        for c in cookies:
            dom = c.get("domain", default_domain).lstrip(".")
            if not dom:
                continue
            try:
                self.set_cookie(
                    c.get("name", ""), c.get("value", ""), dom,
                    c.get("path", "/"),
                    bool(c.get("httpOnly", False)),
                    bool(c.get("secure", True)),
                    int(c.get("expirationDate", 0) or 0))
                n += 1
            except CDPError:
                continue
        return n

    # -- js / dom ---------------------------------------------------------
    def eval(self, js: str, timeout: int = 30) -> object:
        res = self.send("Runtime.evaluate",
                        {"expression": js, "returnByValue": True,
                         "awaitPromise": True}, timeout=timeout)
        exc = res.get("exceptionDetails")
        if exc:
            raise CDPError(f"JS threw: {exc.get('text') or exc}")
        return res.get("result", {}).get("value")

    def wait_for_text(self, needle: str, timeout: int = 30,
                      case_sensitive: bool = False) -> bool:
        """Return True if needle appears in body text within timeout."""
        deadline = time.time() + timeout
        n = needle if case_sensitive else needle.lower()
        while time.time() < deadline:
            try:
                text = self.eval("document.body ? document.body.innerText : ''",
                                 timeout=10) or ""
                hay = text if case_sensitive else str(text).lower()
                if n in hay:
                    return True
            except CDPError:
                pass
            time.sleep(1.0)
        return False

    def body_text(self) -> str:
        try:
            return str(self.eval(
                "document.body ? document.body.innerText : ''", timeout=15))
        except CDPError:
            return ""

    # -- screenshots ------------------------------------------------------
    def screenshot(self, path: str, timeout: int = 30) -> str:
        res = self.send("Page.captureScreenshot",
                        {"format": "png", "captureBeyondViewport": False},
                        timeout=timeout)
        data = base64.b64decode(res["data"])
        with open(path, "wb") as f:
            f.write(data)
        return path

    def screenshot_element(self, js_selector_expr: str, path: str,
                           timeout: int = 30) -> str | None:
        """Capture a clip of the bounding box of document.querySelector(expr)."""
        box = self.eval(
            f"(() => {{ const el = document.querySelector({js_selector_expr!r});"
            " if (!el) return null; const r = el.getBoundingClientRect();"
            " return {x: r.x, y: r.y, width: r.width, height: r.height}; })()",
            timeout=timeout)
        if not box:
            return None
        res = self.send("Page.captureScreenshot",
                        {"format": "png", "clip": box,
                         "captureBeyondViewport": True}, timeout=timeout)
        with open(path, "wb") as f:
            f.write(base64.b64decode(res["data"]))
        return path


def launch(chrome_path: str, extra_args: list[str] | None = None) -> CDP:
    """Start headless Chrome with a fresh temp profile. Caller closes it."""
    profile_dir = tempfile.mkdtemp(prefix="clipflow_chrome_")
    return CDP(chrome_path, profile_dir, extra_args=extra_args)
