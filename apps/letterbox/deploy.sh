#!/usr/bin/env bash
# Deploys Letterbox to the droplet: /opt/marobotic-letterbox, pm2 "letterbox" on 127.0.0.1:8970, served by
# nginx at marobotic.dev/letterbox/. Backs the old copy up to /opt/marobotic-letterbox.bak-<epoch> first.
# Zoho client config: /etc/marobotic/letterbox-zoho-app.json; account store/key: /var/lib/marobotic-letterbox and /etc/marobotic/letterbox.key. The carry-over Self Client config is /etc/marobotic/letterbox-zoho.json (never in this repo).
set -euo pipefail
cd "$(dirname "$0")"
KEY="${DROPLET_KEY:-$HOME/Documents/Droplets/id_ed25519_claude}"
HOST="${DROPLET:-root@157.245.131.195}"
ssh_() { ssh -i "$KEY" -o IdentitiesOnly=yes "$HOST" "$@"; }
node build.mjs
tar -czf - server dist package.json | ssh_ 'set -e
  D=/opt/marobotic-letterbox
  if [ -d $D ]; then cp -a $D $D.bak-$(date +%s); fi
  mkdir -p $D.new && tar -xzf - -C $D.new
  rm -rf $D && mv $D.new $D
  if pm2 describe letterbox >/dev/null 2>&1; then pm2 restart letterbox --update-env >/dev/null
  else
    LETTERBOX_ZOHO_APP=/etc/marobotic/letterbox-zoho-app.json LETTERBOX_DATA=/var/lib/marobotic-letterbox LETTERBOX_KEY=/etc/marobotic/letterbox.key \
    LETTERBOX_ZOHO=/etc/marobotic/letterbox-zoho.json LETTERBOX_CARRY_OVER=mi@marobotic.dev LETTERBOX_PORT=8970 \
    LETTERBOX_COOKIE_PATH=/letterbox/ MARO_ACCOUNT_URL=http://127.0.0.1:8900 \
    pm2 start /opt/node22/bin/node --name letterbox --cwd $D -- --experimental-strip-types --no-warnings $D/server/server.ts >/dev/null
    pm2 save >/dev/null
  fi
  for i in 1 2 3 4 5 6 7 8 9 10; do curl -sf http://127.0.0.1:8970/health >/dev/null && break; sleep 1; done
  curl -sf http://127.0.0.1:8970/health && echo " letterbox is up"'
