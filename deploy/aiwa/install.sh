#!/usr/bin/env bash
# install.sh: idempotent provisioning for the AIWA SEO LXC (seo-prod, Debian 12).
# Run as root inside the container, after the repo is cloned to /opt/seo (deploy ref = tag seo-aiwa-rc1).
#
# What it does NOT do (each is a Carter-approved step, see docs/cutover/RUNBOOK-AIWA.md):
#   - write /opt/seo/.env (render-env.sh validates a PC-built file; decision D2)
#   - enable or start any timer, service or pm2 app
#   - copy photo, state or ledger data
# The one exception is opt-in: `install.sh --pm2-startup` installs and enables the pm2-seo
# systemd unit (boot persistence for the pm2 apps, F7). It is the Carter-approved step in
# RUNBOOK section 8 (F3) and is skipped without the flag.
set -euo pipefail

PM2_STARTUP=0
for arg in "$@"; do
  case "$arg" in
    --pm2-startup) PM2_STARTUP=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

APP_ROOT=/opt/seo
SRV_ROOT=/srv/seo
SEO_USER=seo
TZ_NAME=America/Chicago
NODE_MAJOR="${SEO_NODE_MAJOR:-22}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '[install] %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# 1. apt base packages (idempotent by nature)
log "apt: base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ffmpeg fonts-dejavu-core rclone unzip xz-utils

# 2. Node.js (NodeSource major ${NODE_MAJOR}); skipped when a new enough node is present
node_ok() {
  command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MAJOR" ]
}
if node_ok; then
  log "node: already $(node -v)"
else
  log "node: installing NodeSource ${NODE_MAJOR}.x"
  install -d -m 0755 /etc/apt/keyrings
  # Idempotent (F9): a re-run must not fail on an existing keyring (gpg -o refuses to overwrite).
  if [ -s /etc/apt/keyrings/nodesource.gpg ]; then
    log "node: apt keyring already present"
  else
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  fi
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' "$NODE_MAJOR" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
  node_ok || { echo "node ${NODE_MAJOR} not active after install" >&2; exit 1; }
fi

# 3. uv (Python 3.12 is fetched by uv: Debian 12 ships 3.11). Pinned to the version the
# lock file was produced with on the PC (F9); override with SEO_UV_VERSION.
UV_VERSION="${SEO_UV_VERSION:-0.12.7}"
if command -v uv >/dev/null 2>&1; then
  log "uv: already $(uv --version)"
else
  log "uv: installing ${UV_VERSION} to /usr/local/bin"
  curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_INSTALL_DIR=/usr/local/bin INSTALLER_NO_MODIFY_PATH=1 sh
fi

# 4. pm2 (global, for the long-running apps)
if command -v pm2 >/dev/null 2>&1; then
  log "pm2: already $(pm2 -v)"
else
  log "pm2: npm install -g"
  npm install -g pm2
fi

# 5. service user and directories
if ! id -u "$SEO_USER" >/dev/null 2>&1; then
  log "user: creating $SEO_USER"
  useradd --system --home-dir "$APP_ROOT" --shell /usr/sbin/nologin "$SEO_USER"
fi
install -d -o "$SEO_USER" -g "$SEO_USER" -m 0755 \
  "$APP_ROOT" "$APP_ROOT/logs" "$APP_ROOT/state" "$APP_ROOT/outputs" \
  "$SRV_ROOT" "$SRV_ROOT/photos" "$SRV_ROOT/photos-inbox" "$SRV_ROOT/gbp" "$SRV_ROOT/gbp-archive"
# The rclone inbox lives OUTSIDE the photo cache (/srv/seo/photos): an inbox inside it
# made every synced photo discoverable twice (F8, the 9/25 duplicate-photo incident).
install -d -o "$SEO_USER" -g "$SEO_USER" -m 0700 "$APP_ROOT/secrets"
# The repo tree is copied to /opt/seo as root before this runs (RUNBOOK 1); npm ci / uv sync
# run as seo and need to own it (F9). Secrets keep 0700 (install -d above, chown does not change modes).
chown -R "$SEO_USER:$SEO_USER" "$APP_ROOT" "$SRV_ROOT"

# 6. timezone: systemd timers use the host clock, so the host must be on Chicago time.
current_tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
if [ "$current_tz" != "$TZ_NAME" ]; then
  log "timezone: $current_tz -> $TZ_NAME"
  if ! timedatectl set-timezone "$TZ_NAME" 2>/dev/null; then
    ln -sf "/usr/share/zoneinfo/$TZ_NAME" /etc/localtime
    echo "$TZ_NAME" > /etc/timezone
  fi
else
  log "timezone: already $TZ_NAME"
fi

# 7. app dependencies, only when the repo is present. Playwright browsers are not needed (GBP is API mode).
# runuser inherits the caller's cwd (/root, 0700): npm and uv fail with EACCES on getcwd as seo,
# so every runuser call is made from $APP_ROOT (F9).
if [ -f "$APP_ROOT/package-lock.json" ]; then
  log "npm: ci as $SEO_USER (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1)"
  (cd "$APP_ROOT" && runuser -u "$SEO_USER" -- env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix "$APP_ROOT")
fi
if [ -f "$APP_ROOT/uv.lock" ]; then
  log "uv: sync --locked as $SEO_USER"
  (cd "$APP_ROOT" && runuser -u "$SEO_USER" -- env UV_PROJECT_ENVIRONMENT="$APP_ROOT/.venv" uv sync --locked --project "$APP_ROOT")
fi

# 8. systemd units: copy and reload. Nothing is enabled.
if [ -d "$SCRIPT_DIR/systemd" ]; then
  log "systemd: installing units from $SCRIPT_DIR/systemd"
  install -m 0644 -t /etc/systemd/system/ "$SCRIPT_DIR"/systemd/*.service "$SCRIPT_DIR"/systemd/*.timer
  systemctl daemon-reload
fi

# 9. pm2 boot persistence (F7): without it an LXC reboot leaves mav-bridge / gbp-worker /
# fb-comment-agent down (Days 2-7 never post). `pm2 startup systemd -u seo --hp /opt/seo`
# installs and enables pm2-seo.service, which resurrects the dump written by `pm2 save`
# (run as seo after `pm2 start`, RUNBOOK 8 F3). Opt-in: Carter-approved, --pm2-startup only.
if [ "$PM2_STARTUP" -eq 1 ]; then
  if systemctl is-enabled pm2-seo.service >/dev/null 2>&1; then
    log "pm2 startup: pm2-seo.service already enabled"
  else
    log "pm2 startup: installing pm2-seo.service (user $SEO_USER, home $APP_ROOT)"
    pm2 startup systemd -u "$SEO_USER" --hp "$APP_ROOT"
    systemctl is-enabled pm2-seo.service >/dev/null 2>&1 || { echo "pm2-seo.service not enabled after pm2 startup" >&2; exit 1; }
  fi
  log "pm2 startup: remember 'runuser -u $SEO_USER -- pm2 save' after 'pm2 start' so the unit has a dump to resurrect"
else
  log "pm2 startup: skipped (opt-in: install.sh --pm2-startup, RUNBOOK 8 F3, Carter approval)"
fi

log "done. Next: render and check .env (render-env.sh), then the RUNBOOK data and enable steps (Carter approval)."
