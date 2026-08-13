#!/usr/bin/env bash
#
# Build the release APK with its version stamped in, then publish it.
#
# The stamp exists because the APK is delivered by file sync rather than a store:
# nothing prompts to update and nothing announces a version, so "is the new build
# actually installed?" has to be answerable from inside the app. It is passed with
# --dart-define, which means a build that skips this script silently produces an
# APK labelled "dev build" — visible, rather than a stale-but-plausible version.
#
#   scripts/build-apk.sh            # build, then rotate into the MEGA drop folder
#   scripts/build-apk.sh --no-publish
#
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
CLIENT=$ROOT/flutter_client

VERSION=$(sed -n 's/^version: *\([0-9.]*\).*/\1/p' "$CLIENT/pubspec.yaml")
[ -n "$VERSION" ] || { echo "build-apk: no version in pubspec.yaml" >&2; exit 1; }
STAMP=$(date -u '+%Y-%m-%d %H:%M')

echo "building claude-sessions v$VERSION ($STAMP UTC)"

cd "$CLIENT"
flutter test
flutter build apk --release --split-per-abi \
  --dart-define=CC_VERSION="$VERSION" \
  --dart-define=CC_BUILD="$STAMP"

APK=build/app/outputs/flutter-apk/app-arm64-v8a-release.apk
# Prove the stamp really made it in: --dart-define values are compiled into the
# Dart snapshot, so a typo in the flag would otherwise ship as a silent "dev
# build". Read the snapshot out of the APK rather than grepping the zip, whose
# entries may be compressed.
#
# Extracted to a file rather than piped into grep: `grep -q` exits on the first
# match, unzip dies of SIGPIPE, and `set -o pipefail` then fails the check even
# though it passed.
SNAP=$(mktemp)
trap 'rm -f "$SNAP"' EXIT
unzip -p "$APK" 'lib/arm64-v8a/libapp.so' > "$SNAP"
if grep -qaF "$STAMP" "$SNAP"; then
  echo "  stamp verified in the APK: v$VERSION · $STAMP UTC"
else
  echo "build-apk: stamp '$STAMP' is NOT in $APK — refusing to publish" >&2
  exit 1
fi

if [ "${1:-}" != "--no-publish" ]; then
  "$ROOT/scripts/publish-apk.sh"
fi
