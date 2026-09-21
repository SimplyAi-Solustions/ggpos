#!/usr/bin/env bash
# GG Vault - pull the deploy branch and redeploy when it has moved.
#
# Installed on the server by deploy/bootstrap.sh as a cron line, so a
# push to the deploy branch (recorded in /etc/ggvault/deploy-branch) is
# live within ten minutes without any secret leaving GitHub. Runs under
# flock, so two runs never overlap. Nothing happens when the branch has
# not moved.
set -euo pipefail
DEST="${GG_PATH:-/opt/ggpos}"
BRANCH="$(cat /etc/ggvault/deploy-branch 2>/dev/null || echo main)"
export PATH="/opt/ggvault-node/bin:$PATH"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
cd "$DEST"
git fetch -q origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [ "$LOCAL" = "$REMOTE" ]; then exit 0; fi
echo "== $(date -u +'%Y-%m-%dT%H:%M:%SZ') updating $BRANCH ${LOCAL:0:7} -> ${REMOTE:0:7}"
git reset -q --hard "origin/$BRANCH"
pnpm install --frozen-lockfile
pnpm --filter web build
rm -rf pb/pb_public && mkdir -p pb/pb_public && cp -r apps/web/dist/. pb/pb_public/
cd deploy && docker compose up -d --build
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8091/api/health >/dev/null 2>&1; then echo "healthy after update"; exit 0; fi
  sleep 2
done
echo "PocketBase did not answer after the update" >&2
docker compose ps >&2
exit 1
