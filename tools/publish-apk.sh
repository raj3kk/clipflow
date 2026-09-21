#!/bin/bash
# AutoClip APK publish: APK ko raj3kk/clipflow repo me public/app/ ke neeche
# upload karta hai (GitHub contents API) aur download URL print karta hai.
#
# Flow: ./tools/build-apk.sh && ./tools/publish-apk.sh
#   -> printed URL ko /admin (App Update section) me paste karke Publish dabao.
#
# NOTE (imaandaar limit): GitHub Releases me asset-upload ke liye
# uploads.github.com chahiye, jo is VM ke credential flow me allowed nahi hai
# (sirf api.github.com). Isliye APK repo me hi rehta hai aur Vercel usko
# https://clipflow-webbuilder1.vercel.app/app/<file>.apk pe serve karta hai —
# app ke liye download URL ka kaam bilkul same hai.
#
# Usage: ./tools/publish-apk.sh [path/to/app.apk]
set -e
TOOLS=~/workspace/phone-agent/tools
APK="${1:-$TOOLS/phone-agent.apk}"
BT=$TOOLS/android-sdk/build-tools/34.0.0

if [ ! -f "$APK" ]; then
  echo "APK nahi mili: $APK" >&2
  echo "Pehle ./tools/build-apk.sh chalao." >&2
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
SIZE=$(stat -c%s "$APK")

echo "APK: $APK (${SIZE} bytes)"
echo "versionName=$VNAME versionCode=$VCODE"
echo "repo path: $DEST"
echo "upload ho raha hai..."

python3 - "$APK" "$DEST" <<'PYEOF'
import base64, json, os, sys, urllib.request, urllib.error
sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

CRED = "custom.github"
HOSTS = ["api.github.com"]
API = "https://api.github.com"
REPO = "raj3kk/clipflow"

apk_path, dest = sys.argv[1], sys.argv[2]

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
        return e.code, {}

with open(os.path.expanduser(apk_path), "rb") as f:
    content = base64.b64encode(f.read()).decode()

payload = {
    "message": f"AutoClip APK {dest.split('/')[-1]} (app release asset)",
    "content": content,
}
# file pehle se hai to update ke liye sha chahiye
st, existing = req("GET", f"/repos/{REPO}/contents/{dest}")
if st == 200 and existing.get("sha"):
    payload["sha"] = existing["sha"]
st, out = req("PUT", f"/repos/{REPO}/contents/{dest}", payload)
if st not in (200, 201):
    raise SystemExit(f"upload fail: HTTP {st}")
print(json.dumps({"path": dest, "sha": out.get("content", {}).get("sha")}))
PYEOF

echo ""
echo "=== APK UPLOAD HO GAYI ==="
echo "Download URL:"
echo "$URL"
echo ""
echo "Agla step:"
echo "  1. Vercel deploy ka READY hona wait karo (push pe auto-deploy chalta hai)."
echo "  2. https://clipflow-webbuilder1.vercel.app/admin kholo -> App Update section"
echo "  3. version_code=$VCODE, version_name=$VNAME, upar wali URL paste karo, changelog likho -> Publish"
