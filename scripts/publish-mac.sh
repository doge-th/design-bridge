#!/bin/bash
# Publish this repo to GitHub over SSH.
#
# One-time setup (skip if the repo already exists on GitHub):
#   1. Create an EMPTY repo named "design-bridge" at:
#      https://github.com/new  (no README, no license — this commit has both)
#   2. Run this script. It pushes over your existing SSH key.
set -euo pipefail

REMOTE_NAME="origin"
SSH_URL="git@github.com:doge-th/design-bridge.git"
BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo main)"

cd "$(dirname "$0")/.."

if ! git remote get-url "$REMOTE_NAME" >/dev/null 2>&1; then
  git remote add "$REMOTE_NAME" "$SSH_URL"
  echo "==> remote added: $SSH_URL"
fi

echo "==> pushing $BRANCH to $REMOTE_NAME"
git push -u "$REMOTE_NAME" "$BRANCH"
echo "==> done: $(git remote get-url "$REMOTE_NAME")"
