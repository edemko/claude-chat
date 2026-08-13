#!/usr/bin/env bash
# Publish the latest Android build to the MEGA-synced drop folder.
#
# Keeps exactly two files, so the phone only ever sees two versions:
#   claude-sessions-new.apk  the build just made
#   claude-sessions-old.apk  the build before it
#
# Each run rotates: new -> old (replacing the previous old), then the fresh build
# becomes new.
#
# The rotation, the version record and the phone-readable BUILDS.md all live in
# `apk-publish` (~/.local/bin), because that drop folder is shared with other repos
# and stable filenames alone say nothing about what a file contains.
#
# Prefer scripts/build-apk.sh, which stamps the version into the APK first.
#
# Usage: scripts/publish-apk.sh [abi]      (default arm64-v8a)
set -euo pipefail

ABI="${1:-arm64-v8a}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/flutter_client/build/app/outputs/flutter-apk/app-$ABI-release.apk"
DROP="${CC_APK_DROP:-$HOME/Dev/apk-builds}"

[ -f "$SRC" ] || { echo "no build at $SRC — run: scripts/build-apk.sh" >&2; exit 1; }
command -v apk-publish >/dev/null || {
  echo "publish-apk: apk-publish not on PATH (expected ~/.local/bin/apk-publish)" >&2
  exit 1
}

apk-publish \
  --name claude-sessions \
  --apk "$SRC" \
  --repo "$REPO" \
  --pubspec "$REPO/flutter_client/pubspec.yaml" \
  --versioned \
  --drop "$DROP"

# Clear out names used by earlier schemes.
rm -f "$DROP/claude-sessions-arm64.apk" \
      "$DROP/claude-sessions-latest.apk" \
      "$DROP/claude-sessions-curr.apk"
