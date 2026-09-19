#!/usr/bin/env python3
"""
App-release publish ka FALLBACK (admin UI ke bina) — sirf tab chalao jab
coordinator signal de (p20 APK ready + tools/publish-apk.sh se APK upload ho chuki ho).

Kya karta hai:
  1. args: version_code version_name apk_url [--changelog TEXT] [--force]
  2. apk_url HEAD se verify (https, reachable, content-type/length sane).
  3. PostgREST upsert app_releases (onConflict=version_code) — service_role
     key ~/.config/clipflow/worker.env se (file 600, value kahin print nahi hoti).
  4. GET karke verify karta hai ki row live hai.

Admin UI wala rasta (preferred): /admin -> App Update card -> Publish.
Ye fallback uske barabar hai — dono app_releases me same row banate hain,
jise GET /api/app/version padhta hai.

Usage:
  python3 tools/publish-release-fallback.py 21 0.1.0-p20 \\
      https://clipflow-webbuilder1.vercel.app/app/autoclip-0.1.0-p20.apk \\
      --changelog "line1\nline2" [--force]
"""
import json
import os
import sys
import urllib.request
import urllib.error

ENV_PATH = os.path.expanduser("~/.config/clipflow/worker.env")


def load_env():
    vals = {}
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                vals[k.strip()] = v.strip()
    return vals


def check_apk_url(url):
    if not url.startswith("https://"):
        return "apk_url https:// se shuru hona chahiye"
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=60) as r:
            if r.status >= 400:
                return f"apk_url HEAD -> HTTP {r.status}"
            ln = r.headers.get("Content-Length")
            if ln and int(ln) < 1_000_000:
                return f"apk_url file bahut chhoti hai ({ln} bytes)"
    except Exception as e:
        return f"apk_url reachable nahi: {e}"
    return None


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    version_code = int(sys.argv[1])
    version_name = sys.argv[2]
    apk_url = sys.argv[3]
    changelog = ""
    force = False
    args = sys.argv[4:]
    i = 0
    while i < len(args):
        if args[i] == "--changelog" and i + 1 < len(args):
            changelog = args[i + 1]
            i += 2
        elif args[i] == "--force":
            force = True
            i += 1
        else:
            i += 1

    err = check_apk_url(apk_url)
    if err:
        print("APK URL CHECK FAIL:", err)
        sys.exit(2)

    env = load_env()
    sb_url = env["SUPABASE_URL"].rstrip("/")
    svc = env["SUPABASE_SERVICE_KEY"]
    body = {
        "version_code": version_code,
        "version_name": version_name,
        "apk_url": apk_url,
        "changelog": changelog,
        "force_update": force,
    }
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        sb_url + "/rest/v1/app_releases?on_conflict=version_code",
        data=data,
        method="POST",
    )
    req.add_header("apikey", svc)
    req.add_header("Authorization", f"Bearer {svc}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "resolution=merge-duplicates,return=representation")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.load(r)
    except urllib.error.HTTPError as e:
        print("UPSERT FAIL: HTTP", e.code, e.read().decode()[:300])
        sys.exit(3)
    print("upsert ok:", json.dumps(out)[:400])

    # verify: latest row padho (anon jaisa public read — version endpoint jaisa)
    req2 = urllib.request.Request(
        sb_url + "/rest/v1/app_releases?select=version_code,version_name,apk_url,force_update&order=version_code.desc&limit=1"
    )
    req2.add_header("apikey", svc)
    req2.add_header("Authorization", f"Bearer {svc}")
    with urllib.request.urlopen(req2, timeout=60) as r2:
        rows = json.load(r2)
    top = rows[0] if rows else {}
    if top.get("version_code") == version_code and top.get("apk_url") == apk_url:
        print("VERIFY OK — live row:", json.dumps(top))
    else:
        print("VERIFY MISMATCH:", json.dumps(top))
        sys.exit(4)


if __name__ == "__main__":
    main()
