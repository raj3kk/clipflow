#!/bin/bash
# Manual APK build (Gradle daemon flaky hai is VM pe) — aapt2 + kotlinc + d8 + apksigner
#
# 2026-09-22 REBUILD (p71/code 72):
#  - APP path fix: pehle app/app/src/main (double) tha → ab sahi app/src/main
#  - VERSION_CODE/VERSION_NAME hi source of truth (BuildConfig.java auto-sync)
#  - d8: purane kotlin-stdlib jars bahar, kotlinc ka bundled 1.9+ stdlib dex
#    (EnumEntriesKt NoClassDefFoundError fix, 2026-09-21)
#  - Tink (tink-android-1.8.0) dex me — EncryptedSharedPreferences ke liye
#  - SAARI classes*.dex package hoti hain (sirf classes.dex/classes2.dex nahi)
#  - Naya signing key (purana key kho gaya) — ~/.config/clipflow/ me, 600
set -e
# Script apni location se paths nikalta hai — phone-agent/ web repo ke andar hai.
TOOLS="$(cd "$(dirname "$0")" && pwd -P)"
# web repo root = phone-agent/tools se 2 level upar
WEBROOT="$(readlink -f "$TOOLS/../..")"
APP="$TOOLS/../app/src/main"
APP="$(readlink -f "$APP")"
SDK=$TOOLS/android-sdk
BT=$SDK/build-tools/34.0.0
OUT=$TOOLS/apk-build
rm -rf "$OUT" && mkdir -p "$OUT"/{aar,classes,dex,res}

export JAVA_HOME=$TOOLS/jdk-17
export PATH=$JAVA_HOME/bin:$PATH
APPID="com.clipflow.agent"
VERSION_CODE=72
VERSION_NAME="0.1.0-p71"
APK_NAME="autoclip-$VERSION_NAME.apk"

# BuildConfig.java sync (manual build me Gradle nahi hai)
sed -i -e "s/VERSION_NAME = \"[^\"]*\"/VERSION_NAME = \"$VERSION_NAME\"/" \
       -e "s/VERSION_CODE = [0-9]*/VERSION_CODE = $VERSION_CODE/" \
  "$APP/java/com/clipflow/agent/BuildConfig.java"

echo "== 1. AARs extract =="
CP="$SDK/platforms/android-34/android.jar"
JARS=()
while IFS='=' read -r coord dest; do
  case "$dest" in
    *.aar)
      n=$(basename "$dest" .aar)
      mkdir -p "$OUT/aar/$n" && unzip -q -o "$dest" -d "$OUT/aar/$n"
      if [ -f "$OUT/aar/$n/classes.jar" ]; then JARS+=("$OUT/aar/$n/classes.jar"); fi
      ;;
    *.jar) JARS+=("$dest") ;;
  esac
done < "$TOOLS/deps/artifacts.txt"
for j in "${JARS[@]}"; do CP="$CP:$j"; done
echo "jars: ${#JARS[@]}"

echo "== 2. aapt2 compile+link =="
sed -e "s/\${applicationId}/$APPID/g" -e "s|<manifest |<manifest package=\"$APPID\" |" "$APP/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"
"$BT/aapt2" compile --dir "$APP/res" -o "$OUT/res.zip"
# AAR resources bhi compile karo (nahi to library ke R$bool jaise resources missing)
AAR_RES_ARGS=()
for d in "$OUT"/aar/*/; do
  if [ -d "$d/res" ]; then
    n=$(basename "$d")
    if "$BT/aapt2" compile --dir "$d/res" -o "$OUT/aar-res-$n.zip" 2>/dev/null; then
      AAR_RES_ARGS+=("-R" "$OUT/aar-res-$n.zip")
    fi
  fi
done
echo "aar res zips: $((${#AAR_RES_ARGS[@]} / 2))"
"$BT/aapt2" link -o "$OUT/base.apk" \
  -I "$SDK/platforms/android-34/android.jar" \
  --manifest "$OUT/AndroidManifest.xml" \
  --min-sdk-version 26 --target-sdk-version 34 \
  --version-code $VERSION_CODE --version-name "$VERSION_NAME" \
  --rename-manifest-package "$APPID" \
  --auto-add-overlay \
  --java "$OUT/gen" \
  "${AAR_RES_ARGS[@]}" \
  "$OUT/res.zip"
# R.java bani ya nahi — nahi bani to aage badhne ka matlab nahi
test -f "$OUT/gen/com/clipflow/agent/R.java"

echo "== 3. kotlinc =="
find "$APP/java" -name "*.kt" -o -name "*.java" > "$OUT/sources.txt"
wc -l "$OUT/sources.txt"
"$TOOLS/kotlinc/bin/kotlinc" -jvm-target 17 -no-reflect \
  -cp "$CP" -d "$OUT/classes" @"$OUT/sources.txt" 2>&1 | grep -v "^warning:"; test ${PIPESTATUS[0]} -eq 0

echo "== 3b. library R classes =="
# Manual build me library R classes (androidx.work.R$bool etc.) generate nahi hoti —
# aapt2 sirf app package ki R.java banata hai. Lekin merged resource table single hai
# (sab IDs 0x7f...), to har AAR package ke liye app R.java ki copy hi sahi R class hai.
R_JAVA=$OUT/gen/com/clipflow/agent/R.java
mkdir -p "$OUT/gen2"
for aar in $(find "$TOOLS/deps" -name "*.aar"); do
  pkg=$(unzip -p "$aar" AndroidManifest.xml 2>/dev/null | grep -o 'package="[^"]*"' | head -1 | cut -d'"' -f2)
  if [ -n "$pkg" ] && [ "$pkg" != "$APPID" ]; then
    dstdir=$OUT/gen2/$(echo "$pkg" | tr . /)
    if [ ! -f "$dstdir/R.java" ]; then
      mkdir -p "$dstdir"
      sed "s/^package com\.clipflow\.agent;/package $pkg;/" "$R_JAVA" > "$dstdir/R.java"
    fi
  fi
done
echo "library R packages: $(find "$OUT/gen2" -name 'R.java' | wc -l)"
javac -d "$OUT/classes" $(find "$OUT/gen2" -name "R.java") 2>&1 | head -5; test ${PIPESTATUS[0]} -eq 0

echo "== 4. d8 =="
# 2026-09-21 CORE FIX (NoClassDefFoundError: Lkotlin/enums/EnumEntriesKt):
# deps/ me kotlin-stdlib 1.7.10 + jdk7/jdk8 1.6.21 the — inme EnumEntriesKt
# (Kotlin 1.9+ ka enum `entries`) NAHI HAI. Code kotlinc 1.9 se compile hota
# hai to dex me 1.9 stdlib hona chahiye. Purane stdlib jars ko d8 input se
# bahar karo (duplicate-class error aayega warna) aur compiler ka bundled
# kotlin-stdlib.jar (1.9+, merged: stdlib+jdk7+jdk8+common) dex karo.
#
# Tink (tink-android-1.8.0.jar) EXACTLY EK BAAR dex hota hai — artifacts.txt
# ke jars: entry se aata hai; dobara add karne pe "defined multiple times".
DEX_JARS=()
for j in "${JARS[@]}"; do
  case "$j" in *kotlin-stdlib*) continue;; *) DEX_JARS+=("$j");; esac
done
echo "dex jars: ${#DEX_JARS[@]} (stdlib filtered) + kotlinc stdlib"
"$BT/d8" --min-api 26 --lib "$SDK/platforms/android-34/android.jar" \
  --output "$OUT/dex" $(find "$OUT/classes" -name "*.class") "${DEX_JARS[@]}" \
  "$TOOLS/kotlinc/lib/kotlin-stdlib.jar" 2>&1 | tail -5
echo "dex files: $(ls "$OUT"/dex/classes*.dex | wc -l)"

echo "== 4b. assets =="
# p39-knowledge: bundled agent_knowledge.json (koi code change ke bina
# knowledge updates memory-sync se aate hain; ye sirf bootstrap snapshot hai)
if [ -d "$APP/assets" ]; then
  (cd "$APP" && zip -q -r "$OUT/base.apk" assets)
  echo "assets: $(find "$APP/assets" -type f | wc -l) files, $(du -h "$APP/assets/agent_knowledge.json" 2>/dev/null | cut -f1)"
fi

echo "== 5. package + sign =="
cd "$OUT"
# SAARI classes*.dex lo (multidex — sirf classes.dex/classes2.dex nahi)
cp "$OUT"/dex/classes*.dex ./
DEX_LIST=$(ls classes*.dex | tr '\n' ' ')
echo "packaging dex: $DEX_LIST"
zip -q -j base.apk $DEX_LIST
"$BT/zipalign" -f 4 base.apk aligned.apk

# Naya release key (purana kho gaya — 2026-09-22 rebuild).
# Passwords ~/.config/clipflow/keystore.env me (600), kabhi print/commit nahi.
KEYSTORE="$HOME/.config/clipflow/autoclip-release.keystore"
KEYENV="$HOME/.config/clipflow/keystore.env"
mkdir -p "$HOME/.config/clipflow" && chmod 700 "$HOME/.config/clipflow"
if [ ! -f "$KEYSTORE" ]; then
  STOREPASS="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
  {
    echo "KEYSTORE_ALIAS=autoclip"
    echo "KEYSTORE_STOREPASS=$STOREPASS"
    echo "KEYSTORE_KEYPASS=$STOREPASS"
  } > "$KEYENV"
  chmod 600 "$KEYENV"
  keytool -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 \
    -storepass "$STOREPASS" -keypass "$STOREPASS" -alias autoclip \
    -keyalg RSA -keysize 2048 -validity 9125 \
    -dname "CN=AutoClip,O=AutoClip,C=IN" 2>/dev/null
  chmod 600 "$KEYSTORE"
  echo "new keystore created at $KEYSTORE"
fi
# shellcheck disable=SC1090
set +e; . "$KEYENV"; set -e
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_STOREPASS" \
  --key-pass "pass:$KEYSTORE_KEYPASS" --out "$OUT/signed.apk" aligned.apk
"$BT/apksigner" verify --print-certs "$OUT/signed.apk" | head -3

# Final APK → web repo public/app/ (releases.ts ka apk_url yahi point karta hai)
mkdir -p "$WEBROOT/public/app"
cp "$OUT/signed.apk" "$WEBROOT/public/app/$APK_NAME"
ls -lh "$WEBROOT/public/app/$APK_NAME"
echo "APK-OK: $WEBROOT/public/app/$APK_NAME"
