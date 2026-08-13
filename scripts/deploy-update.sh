#!/usr/bin/env bash
#
# Pull, rebuild, restart — for a machine that runs the hub but is not where you edit.
#
#   scripts/deploy-update.sh            # update if the remote moved
#   scripts/deploy-update.sh --force    # rebuild and restart even if it did not
#
# Safe to run on a timer. Two properties make that true:
#
#   - It does nothing when there is nothing to do, so a five-minute timer is not a
#     five-minute restart loop.
#   - It typechecks and builds BEFORE restarting, and leaves the running service
#     alone if either fails. A bad push then costs you a stale deployment rather
#     than a dead one — the wrong direction to fail is silently down.
#
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=$PWD
SERVICE=${CC_SERVICE:-claude-chat}
FORCE=${1:-}

# One at a time: a timer firing while a build runs would race on dist/.
exec 9>"${TMPDIR:-/tmp}/claude-chat-deploy.lock"
flock -n 9 || { echo "deploy-update: another run holds the lock, skipping"; exit 0; }

command -v git >/dev/null || { echo "deploy-update: git not found" >&2; exit 1; }
[ -d .git ] || { echo "deploy-update: $REPO is not a git clone" >&2; exit 1; }

before=$(git rev-parse HEAD)
git fetch --quiet origin
branch=$(git rev-parse --abbrev-ref HEAD)
target=$(git rev-parse "origin/$branch")

if [ "$before" = "$target" ] && [ "$FORCE" != "--force" ]; then
  exit 0
fi

echo "deploy-update: ${before:0:8} -> ${target:0:8} on $branch"
# --ff-only: a deployment box must never be asked to resolve a merge.
git merge --ff-only "origin/$branch"

# npm ci only when the lockfile actually moved — it is by far the slowest step.
if [ "$before" != "$target" ] && ! git diff --quiet "$before" "$target" -- package-lock.json; then
  echo "deploy-update: dependencies changed, running npm ci"
  npm ci
fi

# Typecheck first: tsc emits output even for a failing build unless told otherwise,
# so building straight into dist/ could leave a broken tree behind.
if ! npm run typecheck --silent; then
  echo "deploy-update: typecheck failed, leaving the running service untouched" >&2
  exit 1
fi
npm run build --silent

systemctl --user restart "$SERVICE"
sleep 2
if systemctl --user is-active --quiet "$SERVICE"; then
  echo "deploy-update: $SERVICE restarted on $(git rev-parse --short HEAD)"
else
  echo "deploy-update: $SERVICE failed to start" >&2
  systemctl --user status "$SERVICE" --no-pager -n 20 >&2 || true
  exit 1
fi
