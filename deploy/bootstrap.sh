#!/usr/bin/env bash
# GG Vault - server-side bootstrap for a Debian or Ubuntu VPS.
#
# Does the runbook's first-time steps (deploy/README.md sections 2 to 7)
# on the server itself, as root, without touching anything that is not
# ours: Docker is installed from Docker's own apt repository only if it is
# missing, Node is a private copy under /opt/ggvault-node used for the
# build alone, and the only edit to an existing Caddy configuration is one
# appended site block, validated before the reload and put back if
# validation fails. Safe to run again: an existing deploy/.env is never
# overwritten, a present Caddy block is not duplicated, and every service
# is brought up idempotently.
#
# Usage (as root):
#   GG_ADMIN_PASSWORD='temporary password' \
#   GG_SITE_HOST=ggpos.ggentertainment.co.uk \
#   GG_ADMIN_EMAIL=accounts@ggentertainment.co.uk \
#   GG_DEPLOY_BRANCH=main \
#   bash deploy/bootstrap.sh
#
# Optional: GG_PATH (default /opt/ggpos), GG_REPO_URL, GG_SHOP_IP (the
# shop's public IP for the /_/ dashboard; blank keeps it unreachable),
# GG_DEPLOY_PUBKEY (an SSH public key to append to root's authorized_keys
# so .github/workflows/deploy.yml can reach this server later).
#
# Output goes to the terminal and to /var/log/ggvault-bootstrap.log.
set -euo pipefail

LOG=/var/log/ggvault-bootstrap.log
touch "$LOG"; chmod 600 "$LOG"
exec > >(tee -a "$LOG") 2>&1
echo "== GG Vault bootstrap started $(date -u +'%Y-%m-%dT%H:%M:%SZ')"

SITE_HOST="${GG_SITE_HOST:-ggpos.ggentertainment.co.uk}"
ADMIN_EMAIL="${GG_ADMIN_EMAIL:-accounts@ggentertainment.co.uk}"
ADMIN_PASSWORD="${GG_ADMIN_PASSWORD:?GG_ADMIN_PASSWORD is required}"
BRANCH="${GG_DEPLOY_BRANCH:-main}"
REPO_URL="${GG_REPO_URL:-https://github.com/SimplyAi-Solustions/ggpos.git}"
DEST="${GG_PATH:-/opt/ggpos}"
SHOP_IP="${GG_SHOP_IP:-}"
DEPLOY_PUBKEY="${GG_DEPLOY_PUBKEY:-}"
NODE_VERSION="${GG_NODE_VERSION:-22.22.2}"
NODE_HOME=/opt/ggvault-node
export DEBIAN_FRONTEND=noninteractive

if [ "$(id -u)" != "0" ]; then echo "Run this as root." >&2; exit 1; fi
case "$ADMIN_PASSWORD" in
  *[\ \$\`\"\'\<\>]*) echo "GG_ADMIN_PASSWORD must not contain a space, quote, dollar sign, backtick or angle bracket (deploy/.env is read by two parsers)." >&2; exit 1 ;;
esac

# --- 0. The deploy key, if one was given -------------------------------
if [ -n "$DEPLOY_PUBKEY" ]; then
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
  if ! grep -qF "$DEPLOY_PUBKEY" /root/.ssh/authorized_keys; then
    printf '%s\n' "$DEPLOY_PUBKEY" >> /root/.ssh/authorized_keys
    echo "Deploy public key added to root's authorized_keys"
  fi
fi

# --- 1. Packages ---------------------------------------------------------
apt-get update -qq
apt-get install -y -qq git curl ca-certificates rsync xz-utils gnupg >/dev/null
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed; installing it from Docker's apt repository"
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
if ! docker compose version >/dev/null 2>&1; then
  apt-get install -y -qq docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker --version; docker compose version

# A private Node for the web build only: nothing else on this server is
# touched by it, and it is not on anyone's PATH.
if [ ! -x "$NODE_HOME/bin/node" ] || [ "$("$NODE_HOME/bin/node" --version)" != "v$NODE_VERSION" ]; then
  ARCH="$(uname -m)"; case "$ARCH" in x86_64) NARCH=x64 ;; aarch64) NARCH=arm64 ;; *) echo "Unsupported architecture $ARCH" >&2; exit 1 ;; esac
  rm -rf "$NODE_HOME"; mkdir -p "$NODE_HOME"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NARCH.tar.xz" | tar -xJ -C "$NODE_HOME" --strip-components=1
fi
export PATH="$NODE_HOME/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack enable --install-directory "$NODE_HOME/bin" >/dev/null 2>&1 || true
node --version

# --- 2. The checkout ------------------------------------------------------
mkdir -p "$(dirname "$DEST")"
if [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch -q origin "$BRANCH"
  git -C "$DEST" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO_URL" "$DEST"
fi
mkdir -p /etc/ggvault
printf '%s\n' "$BRANCH" > /etc/ggvault/deploy-branch
cd "$DEST"
echo "Checked out $BRANCH at $(git rev-parse --short HEAD)"

# --- 3. Build the web app into pb_public ----------------------------------
PNPM_VERSION="$(node -p "(require('./package.json').packageManager || 'pnpm@10').split('@')[1]")"
corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null 2>&1 || npm install -g "pnpm@$PNPM_VERSION" >/dev/null 2>&1
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
pnpm install --frozen-lockfile
pnpm --filter web build
rm -rf pb/pb_public && mkdir -p pb/pb_public && cp -r apps/web/dist/. pb/pb_public/
echo "Web app built"

# --- 4. deploy/.env, written once -----------------------------------------
cd "$DEST/deploy"
mkdir -p data logs
if [ -f .env ]; then
  echo "deploy/.env already exists; leaving it exactly as it is"
else
  umask 077
  {
    echo "PB_VERSION=0.40.4"
    echo "GG_ID_PHOTO_KEY=$(openssl rand -hex 32)"
    echo "GG_ADMIN_EMAIL=$ADMIN_EMAIL"
    echo "GG_ADMIN_PASSWORD=$ADMIN_PASSWORD"
    echo "PB_SUPERUSER_EMAIL=pricesync@ggentertainment.co.uk"
    echo "PB_SUPERUSER_PASSWORD=$(openssl rand -hex 24)"
    echo "GG_VAPID_PUBLIC_KEY="
    echo "GG_VAPID_PRIVATE_KEY="
    echo "GG_VAPID_SUBJECT=mailto:$ADMIN_EMAIL"
    echo "RESTIC_REPOSITORY="
    echo "RESTIC_PASSWORD="
    echo "AWS_ACCESS_KEY_ID="
    echo "AWS_SECRET_ACCESS_KEY="
    echo "AWS_DEFAULT_REGION=auto"
  } > .env
  umask 022
  # VAPID keys for Web Push, generated with the same library the notify
  # service uses; the public half also goes into settings.push later.
  VAPID_JSON="$(cd "$DEST/services/notify" && npx --yes web-push@3.6.7 generate-vapid-keys --json 2>/dev/null || true)"
  if [ -n "$VAPID_JSON" ]; then
    VPUB="$(printf '%s' "$VAPID_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).publicKey))')"
    VPRIV="$(printf '%s' "$VAPID_JSON" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).privateKey))')"
    sed -i "s|^GG_VAPID_PUBLIC_KEY=.*|GG_VAPID_PUBLIC_KEY=$VPUB|; s|^GG_VAPID_PRIVATE_KEY=.*|GG_VAPID_PRIVATE_KEY=$VPRIV|" .env
  fi
  chmod 600 .env
  echo "deploy/.env written. Keep a copy of GG_ID_PHOTO_KEY in the password manager: without it every stored ID photo is unreadable."
fi

# --- 5. Port check and the stack --------------------------------------------
if ss -ltn 2>/dev/null | grep -q '127.0.0.1:8091 ' && ! docker ps --format '{{.Names}}' | grep -q '^ggvault-pocketbase$'; then
  echo "Something other than GG Vault is already listening on 127.0.0.1:8091; change the port mapping in docker-compose.yml and the Caddy snippet, then run this again." >&2
  exit 1
fi
docker compose up -d --build
for i in $(seq 1 45); do
  if curl -fsS http://127.0.0.1:8091/api/health >/dev/null 2>&1; then echo "PocketBase is answering on 127.0.0.1:8091"; break; fi
  sleep 2
  if [ "$i" = "45" ]; then echo "PocketBase did not answer within 90 seconds" >&2; docker compose ps >&2; docker compose logs --tail=50 pocketbase >&2; exit 1; fi
done

# --- 6. Superusers, the application URL ---------------------------------------
set -a; . ./.env; set +a
docker compose exec -T pocketbase /pb/pocketbase superuser upsert "$GG_ADMIN_EMAIL" "$GG_ADMIN_PASSWORD" --dir /pb/pb_data >/dev/null
docker compose exec -T pocketbase /pb/pocketbase superuser upsert "$PB_SUPERUSER_EMAIL" "$PB_SUPERUSER_PASSWORD" --dir /pb/pb_data >/dev/null
echo "Superusers in place"
TOKEN="$(curl -fsS -X POST http://127.0.0.1:8091/api/collections/_superusers/auth-with-password \
  -H 'Content-Type: application/json' \
  --data-binary "$(printf '{"identity":"%s","password":"%s"}' "$GG_ADMIN_EMAIL" "$GG_ADMIN_PASSWORD")" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
if [ -n "$TOKEN" ]; then
  curl -fsS -o /dev/null -X PATCH http://127.0.0.1:8091/api/settings \
    -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
    --data-binary "$(printf '{"meta":{"appName":"GG Vault","appURL":"https://%s"}}' "$SITE_HOST")"
  echo "Application URL set to https://$SITE_HOST"
else
  echo "Could not sign in as the admin superuser to set the application URL; set it under Settings in /_/ later" >&2
fi

# --- 7. Caddy ----------------------------------------------------------------
CADDYFILE=/etc/caddy/Caddyfile
if [ -f "$CADDYFILE" ] && systemctl is-active --quiet caddy; then
  if grep -q "^$SITE_HOST {" "$CADDYFILE"; then
    echo "The Caddy site block for $SITE_HOST is already present"
  else
    TMP="$(mktemp)"
    sed "s/ggpos\.ggentertainment\.co\.uk/$SITE_HOST/g" "$DEST/deploy/Caddyfile.snippet" > "$TMP"
    if [ -n "$SHOP_IP" ]; then sed -i "s/203\.0\.113\.10/$SHOP_IP/g" "$TMP"; fi
    BACKUP="$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"
    cp "$CADDYFILE" "$BACKUP"
    { echo; cat "$TMP"; } >> "$CADDYFILE"
    rm -f "$TMP"
    if caddy validate --config "$CADDYFILE" >/dev/null 2>&1; then
      systemctl reload caddy
      echo "Appended the $SITE_HOST site block to $CADDYFILE and reloaded Caddy (the previous file is at $BACKUP)"
    else
      cp "$BACKUP" "$CADDYFILE"
      echo "The new Caddyfile did not validate; the previous one is back in place and Caddy was not reloaded. Output:" >&2
      caddy validate --config "$CADDYFILE" >&2 || true
      exit 1
    fi
  fi
elif command -v caddy >/dev/null 2>&1 || docker ps --format '{{.Image}}' | grep -qi caddy; then
  echo "Caddy is present but not as a systemd service with $CADDYFILE; add the block from $DEST/deploy/Caddyfile.snippet to its configuration by hand. The app is up on 127.0.0.1:8091." >&2
  exit 1
else
  echo "No Caddy on this server; installing it from the official repository"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  sed "s/ggpos\.ggentertainment\.co\.uk/$SITE_HOST/g" "$DEST/deploy/Caddyfile.snippet" > "$CADDYFILE"
  if [ -n "$SHOP_IP" ]; then sed -i "s/203\.0\.113\.10/$SHOP_IP/g" "$CADDYFILE"; fi
  caddy validate --config "$CADDYFILE"
  systemctl enable --now caddy
  systemctl reload caddy || true
  echo "Caddy installed with the $SITE_HOST site block"
fi

# --- 8. Cron: price sync and self-update ----------------------------------------
chmod +x "$DEST/deploy/self-update.sh" "$DEST/deploy/backup.sh" 2>/dev/null || true
CRON_FILE="$(mktemp)"
(crontab -l 2>/dev/null | grep -v 'GG Vault' | grep -v "$DEST/deploy/" || true) > "$CRON_FILE"
{
  echo "# GG Vault: nightly price sync, 04:00"
  echo "0 4 * * * mkdir -p $DEST/deploy/logs && cd $DEST/deploy && docker compose run --rm pricesync >> $DEST/deploy/logs/pricesync.log 2>&1"
  echo "# GG Vault: pull and redeploy when the deploy branch moves, every 10 minutes"
  echo "*/10 * * * * flock -n /run/ggvault-update.lock $DEST/deploy/self-update.sh >> $DEST/deploy/logs/self-update.log 2>&1"
} >> "$CRON_FILE"
if [ -n "${RESTIC_REPOSITORY:-}" ] && [ -n "${RESTIC_PASSWORD:-}" ]; then
  { echo "# GG Vault: nightly backup, 03:00"; echo "0 3 * * * $DEST/deploy/backup.sh"; } >> "$CRON_FILE"
else
  echo "No restic bucket in deploy/.env yet, so the backup cron line is not installed: fill RESTIC_REPOSITORY, RESTIC_PASSWORD and the AWS_* keys, run restic init once, and run this again."
fi
crontab "$CRON_FILE"; rm -f "$CRON_FILE"

mkdir -p /var/lib/ggvault && date -u +'%Y-%m-%dT%H:%M:%SZ' > /var/lib/ggvault/bootstrapped
echo "== GG Vault bootstrap finished $(date -u +'%Y-%m-%dT%H:%M:%SZ'): https://$SITE_HOST"
