#!/usr/bin/env bash
# One-time setup for a Hetzner box that will host preview environments.
# Run as root on a fresh Ubuntu 24.04 server:
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/service-a/main/infra/scripts/bootstrap-server.sh | bash -s -- <deploy-public-key>
#
# Creates an unprivileged `preview` user, installs Docker, starts Traefik and
# installs the deploy/destroy/reap scripts plus a local reaper timer.

set -euo pipefail

DEPLOY_KEY="${1:?usage: bootstrap-server.sh '<ssh public key>'}"
PREVIEW_ROOT=/opt/preview
PREVIEW_USER=preview
# Where to fetch the infra files from. Override when testing a fork.
INFRA_REPO="${INFRA_REPO:?set INFRA_REPO=<owner>/service-a}"
INFRA_REF="${INFRA_REF:-main}"
RAW_BASE="https://raw.githubusercontent.com/$INFRA_REPO/$INFRA_REF/infra"

echo "==> installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg jq apache2-utils ufw rsync

if ! command -v docker >/dev/null; then
  echo "==> installing docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

echo "==> capping docker log growth"
cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
JSON
systemctl restart docker

echo "==> creating $PREVIEW_USER user"
id -u "$PREVIEW_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$PREVIEW_USER"
usermod -aG docker "$PREVIEW_USER"
install -d -m 700 -o "$PREVIEW_USER" -g "$PREVIEW_USER" "/home/$PREVIEW_USER/.ssh"
echo "$DEPLOY_KEY" > "/home/$PREVIEW_USER/.ssh/authorized_keys"
chown "$PREVIEW_USER:$PREVIEW_USER" "/home/$PREVIEW_USER/.ssh/authorized_keys"
chmod 600 "/home/$PREVIEW_USER/.ssh/authorized_keys"

echo "==> creating $PREVIEW_ROOT"
install -d -m 755 -o "$PREVIEW_USER" -g "$PREVIEW_USER" \
  "$PREVIEW_ROOT" "$PREVIEW_ROOT/bin" "$PREVIEW_ROOT/stacks" "$PREVIEW_ROOT/traefik"

# Allow the preview user to take locks in /var/lock.
chmod 1777 /var/lock

echo "==> firewall"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

PUBLIC_IP="$(curl -fsS https://ipv4.icanhazip.com | tr -d '\n')"
# Dashed sslip.io notation, not dotted. With dots, a hostname like
# a-pr-10.203.0.113.7.sslip.io resolves to 10.203.0.113 because sslip.io reads
# the PR number as the first octet. Dashes remove the ambiguity.
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
DASHBOARD_PASS="$(openssl rand -hex 12)"
# No $-doubling here: escaping is only needed for literals written inside a
# compose file. Values coming from .env are substituted verbatim, so doubling
# would corrupt the bcrypt hash and make the dashboard reject every password.
DASHBOARD_AUTH="$(htpasswd -nbB admin "$DASHBOARD_PASS")"

echo "==> fetching infra files"
for script in deploy.sh destroy.sh reap.sh capacity.sh list-stacks.sh; do
  curl -fsSL "$RAW_BASE/scripts/$script" -o "$PREVIEW_ROOT/bin/$script"
  chmod 755 "$PREVIEW_ROOT/bin/$script"
  chown "$PREVIEW_USER:$PREVIEW_USER" "$PREVIEW_ROOT/bin/$script"
done
curl -fsSL "$RAW_BASE/compose/traefik.yml" -o "$PREVIEW_ROOT/traefik/docker-compose.yml"
chown "$PREVIEW_USER:$PREVIEW_USER" "$PREVIEW_ROOT/traefik/docker-compose.yml"

cat > "$PREVIEW_ROOT/traefik/.env" <<EOF
PREVIEW_DOMAIN=$PREVIEW_DOMAIN
TRAEFIK_DASHBOARD_AUTH=$DASHBOARD_AUTH
EOF
chown "$PREVIEW_USER:$PREVIEW_USER" "$PREVIEW_ROOT/traefik/.env"
chmod 600 "$PREVIEW_ROOT/traefik/.env"

echo "==> starting traefik"
cd "$PREVIEW_ROOT/traefik"
sudo -u "$PREVIEW_USER" docker compose -p traefik -f docker-compose.yml up -d

echo "==> installing local reaper timer (runs even if GitHub is unreachable)"
cat > /etc/systemd/system/preview-reap.service <<EOF
[Unit]
Description=Destroy stale preview environments
[Service]
Type=oneshot
User=$PREVIEW_USER
Environment=ALLOW_EMPTY=false
Environment=MAX_AGE_HOURS=72
# No desired list available locally, so only the age rule applies here.
ExecStart=/bin/bash -c '$PREVIEW_ROOT/bin/reap.sh "\$($PREVIEW_ROOT/bin/list-stacks.sh)"'
EOF

cat > /etc/systemd/system/preview-reap.timer <<'EOF'
[Unit]
Description=Hourly stale preview sweep
[Timer]
OnCalendar=hourly
Persistent=true
[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now preview-reap.timer

cat <<EOF

==============================================================
 Preview host is ready.

 PREVIEW_DOMAIN   $PREVIEW_DOMAIN
 Traefik dash     http://traefik.$PREVIEW_DOMAIN  (admin / $DASHBOARD_PASS)
 Deploy user      $PREVIEW_USER

 Add to each GitHub repo:
   variable  PREVIEW_DOMAIN   = $PREVIEW_DOMAIN
   secret    HETZNER_HOST     = $PUBLIC_IP
   secret    HETZNER_SSH_KEY  = <private half of the key you passed in>
==============================================================
EOF
