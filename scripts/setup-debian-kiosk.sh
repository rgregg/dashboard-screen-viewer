#!/usr/bin/env bash
# Run once as root on a dedicated Debian 13 display appliance.
set -euo pipefail

if [[ "$(id -u)" != 0 ]]; then
  echo "Run with sudo on the display appliance." >&2
  exit 1
fi
. /etc/os-release
if [[ "$ID" != debian || "$VERSION_ID" != 13 ]]; then
  echo "This installer targets Debian 13." >&2
  exit 1
fi

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_dir=/opt/dashboard-screen-viewer
if [[ "$source_dir" == "$app_dir" ]]; then
  echo "Run from a separate staging checkout, not /opt/dashboard-screen-viewer." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --yes --no-install-recommends \
  nodejs npm feh lightdm lightdm-gtk-greeter openbox xserver-xorg \
  x11-xserver-utils dbus-x11 fonts-dejavu-core iproute2 curl ca-certificates \
  network-manager polkitd python3-gi gir1.2-gtk-3.0 gir1.2-nm-1.0
# Earlier versions of this installer used a Chromium kiosk; feh replaced it.
if dpkg-query -W -f='${Status}' chromium 2>/dev/null | grep -q installed; then
  apt-get purge --yes chromium chromium-common chromium-sandbox
fi

if ! id dashboard >/dev/null 2>&1; then
  adduser --disabled-password --gecos "Dashboard display" dashboard
fi
if id -nG dashboard | grep -qw sudo; then
  echo "The dashboard account must not have sudo privileges." >&2
  exit 1
fi
for group in video render audio; do
  if getent group "$group" >/dev/null; then usermod -aG "$group" dashboard; fi
done
dashboard_home="$(getent passwd dashboard | cut -d: -f6)"

rm -rf "$app_dir"
install -d -o dashboard -g dashboard "$app_dir" /var/lib/dashboard-viewer
for directory in src public scripts deploy; do
  cp -a "$source_dir/$directory" "$app_dir/"
done
cp "$source_dir/package.json" "$source_dir/package-lock.json" "$source_dir/tsconfig.json" "$app_dir/"
chown -R dashboard:dashboard "$app_dir"
runuser -u dashboard -- bash -s -- "$app_dir" <<'BUILD'
set -euo pipefail
cd "$1"
npm ci --no-audit --no-fund
npm run build
mkdir -p dist/public
cp -a public/. dist/public/
npm prune --omit=dev --no-audit --no-fund
BUILD
chown -R root:root "$app_dir"
chmod 755 "$app_dir/scripts/nuc-kiosk.sh" "$app_dir/scripts/kiosk-status.sh" "$app_dir/scripts/wifi-setup.py"
# Lets the kiosk account pick and save Wi-Fi networks from the on-screen setup window, and nothing more.
install -m 644 -o root -g root "$app_dir/deploy/polkit/50-dashboard-wifi.rules" /etc/polkit-1/rules.d/50-dashboard-wifi.rules
if [[ ! -f /etc/default/dashboard-kiosk ]]; then
  printf "# Seconds each screenshot stays on screen.\nROTATION_SECONDS=15\n" >/etc/default/dashboard-kiosk
fi

install -d -m 755 /etc/lightdm/lightdm.conf.d
cat >/etc/lightdm/lightdm.conf.d/60-dashboard.conf <<'LIGHTDM'
[Seat:*]
autologin-user=dashboard
autologin-user-timeout=0
user-session=openbox
autologin-session=openbox
greeter-session=lightdm-gtk-greeter
LIGHTDM
install -d -m 700 -o dashboard -g dashboard "$dashboard_home/.config"
# Root-owned, read-only session config: no desktop menu, shortcuts or exit for the kiosk account.
rm -rf "$dashboard_home/.config/openbox"
install -d -m 755 -o root -g root "$dashboard_home/.config/openbox"
install -m 644 -o root -g root "$app_dir/deploy/openbox/rc.xml" "$app_dir/deploy/openbox/menu.xml" \
  "$app_dir/deploy/openbox/autostart" "$dashboard_home/.config/openbox/"

cat >/etc/systemd/system/dashboard-viewer.service <<'SERVICE'
[Unit]
Description=Dashboard Screen Viewer
After=network-online.target
Wants=network-online.target
ConditionPathExists=/etc/dashboard-viewer.env

[Service]
User=dashboard
Group=dashboard
WorkingDirectory=/opt/dashboard-screen-viewer
Environment=NODE_ENV=production
Environment=DATA_DIR=/var/lib/dashboard-viewer
EnvironmentFile=/etc/dashboard-viewer.env
ExecStart=/usr/bin/node /opt/dashboard-screen-viewer/dist/src/main.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/dashboard-viewer

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable dashboard-viewer.service lightdm.service
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
systemctl set-default graphical.target
systemctl restart dashboard-viewer.service
systemctl restart lightdm.service
echo "Kiosk installed. Until /etc/dashboard-viewer.env is configured, the display shows a placeholder."
