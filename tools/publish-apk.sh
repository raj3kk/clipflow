#!/bin/bash
# AutoClip APK publish — raj3kk/clipflow.
#
#   tools/publish-apk.sh [path/to/app.apk] [tag]
#
# Kya karta hai:
#   1. APK ka versionCode/versionName aapt se verify karta hai (+ size sanity).
#   2. GitHub release banata hai (tag, default autoclip-v0.1.0-p19) —
#      pehle se ho to reuse.
#   3. APK ko public/app/autoclip-<version>.apk me contents API se upload
#      karta hai (same-name file ho to update) — Vercel isko
#      https://clipflow-webbuilder1.vercel.app/app/<file>.apk pe serve karta hai.
#   4. Release body me public download URL likhta hai.
#   5. Public download URL print karta hai — yahi URL app_releases.apk_url
#      me jata hai (phone app isi se auto-update kheenchta hai).
#
# NOTE (credential scope): is VM ka custom.github credential sirf api.github.com
# pe kaam karta hai — uploads.github.com pe GitHub "Bad credentials" (401)
# deta hai, isliye native release-asset upload possible nahi. Upar wala flow
# "release asset ki tarah" hi kaam karta hai: versioned public URL + release page.
#
# Auth: custom.github credential (dynamic_credentials surrogate) — sirf
# api.github.com pe bheja jata hai. Koi raw key file me nahi likhi jati.
set -e
APK="$(readlink -f "${1:-$HOME/workspace/your_files/phone-agent.apk}")"
TAG="${2:-autoclip-v0.1.0-p19}"
REPO="raj3kk/clipflow"
BT="$HOME/workspace/phone-agent/tools/android-sdk/build-tools/34.0.0"

if [ ! -f "$APK" ]; then
  echo "APK nahi mili: $APK" >&2; exit 1
fi
SIZE=$(stat -L -c%s "$APK")
if [ "$SIZE" -lt 1000000 ]; then
  echo "APK bahut chhoti hai (${SIZE} bytes) — galat file lag rahi hai." >&2
  exit 1
fi
VNAME=$($BT/aapt dump badging "$APK" 2>/dev/null | grep -o "versionName='[^']*'" | cut -d"'" -f2)
VCODE=$($BT/aapt dump badging "$APK" 2>/dev/null | grep -o "versionCode='[^']*'" | cut -d"'" -f2)
if [ -z "$VNAME" ] || [ -z "$VCODE" ]; then
  echo "aapt se version nahi padh paya — APK corrupt ho sakti hai." >&2
  exit 1
fi
DEST="public/app/autoclip-${VNAME}.apk"
URL="https://clipflow-webbuilder1.vercel.app/app/autoclip-${VNAME}.apk"
echo "APK: $APK (${SIZE} bytes) versionCode=$VCODE versionName=$VNAME"
echo "tag: $TAG  repo path: $DEST"
echo "upload ho raha hai..."

python3 - "$APK" "$TAG" "$DEST" "$URL" "$REPO" <<'PYEOF'
import base64, json, os, sys, urllib.request, urllib.error
sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

CRED = "custom.github"
HOSTS = ["api.github.com"]
API = "https://api.github.com"

apk_path, tag, dest, url, repo = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]

def req(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data, method=method)
    r.add_header("Accept", "application/vnd.github+json")
    r.add_header("X-GitHub-Api-Version", "2022-11-28")
    r.add_header("User-Agent", "muse-github-skill")
    if data:
        r.add_header("Content-Type", "application/json")
    add_surrogate_to_request(r, CRED, allowed_hosts=HOSTS)
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return resp.status, read_json_response(resp)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode()[:300]
        except Exception:
            detail = ""
        return e.code, {"_error": detail}

# 1. release: tag se dhoondo, nahi to banao
st, rel = req("GET", f"/repos/{repo}/releases/tags/{tag}")
if st == 404:
    st, rel = req("POST", f"/repos/{repo}/releases", {
        "tag_name": tag,
        "name": f"AutoClip {dest.split('/')[-1].replace('autoclip-', '').replace('.apk', '')}",
        "body": "",
        "draft": False,
        "prerelease": False,
    })
    if st not in (200, 201):
        raise SystemExit(f"release create fail: HTTP {st} {rel.get('_error', '')}")
    print(f"release banayi: {rel.get('html_url')}")
elif st != 200:
    raise SystemExit(f"release fetch fail: HTTP {st}")
else:
    print(f"release mili: {rel.get('html_url')}")
    if rel.get("draft"):
        st2, _ = req("PATCH", f"/repos/{repo}/releases/{rel['id']}", {"draft": False})
        print(f"draft publish: HTTP {st2}")

# 2. APK → repo file (contents API; dobara chalane pe update)
with open(os.path.expanduser(apk_path), "rb") as f:
    content = base64.b64encode(f.read()).decode()
payload = {
    "message": f"AutoClip APK {dest.split('/')[-1]} (public app download)",
    "content": content,
}
st, existing = req("GET", f"/repos/{repo}/contents/{dest}")
if st == 200 and existing.get("sha"):
    payload["sha"] = existing["sha"]
st, out = req("PUT", f"/repos/{repo}/contents/{dest}", payload)
if st not in (200, 201):
    raise SystemExit(f"APK upload fail: HTTP {st} {out.get('_error', '')}")
print(f"APK uploaded: {dest} (sha {out.get('content', {}).get('sha', '')[:8]})")

# 3. release body me download URL
body = (f"AutoClip Android app — phone app isi URL se auto-update kheenchta hai.\n\n"
        f"**Download:** {url}\n")
st, _ = req("PATCH", f"/repos/{repo}/releases/{rel['id']}", {"body": body})
print(f"release body update: HTTP {st}")

print("")
print("=== APK PUBLISH HO GAYA ===")
print("release: " + rel.get("html_url", ""))
print("public download URL:")
print(url)
PYEOF
