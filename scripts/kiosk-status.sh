#!/usr/bin/env bash
# Prints the one-line overlay for the feh kiosk: a local network problem first, else the viewer's status.
# With --check, prints nothing and exits 0 when online, 1 when offline.
set -uo pipefail

status_file=/var/lib/dashboard-viewer/status.txt
state_dir="${XDG_RUNTIME_DIR:-/tmp}"
since_file="$state_dir/dashboard-network-down-since"

# Online means some interface (Wi-Fi or Ethernet) is up with an IPv4 default route.
network_ok() {
  local dev
  for dev in $(ip -4 route show default | awk '{for (i = 1; i < NF; i++) if ($i == "dev") print $(i + 1)}'); do
    [[ "$(cat "/sys/class/net/$dev/operstate" 2>/dev/null)" =~ ^(up|unknown)$ ]] && return 0
  done
  return 1
}

has_wifi() { compgen -G "/sys/class/net/*/wireless" >/dev/null; }

if [[ "${1:-}" == --check ]]; then
  network_ok
  exit
fi

if network_ok; then
  rm -f "$since_file"
  [[ -r "$status_file" ]] && head -n 1 "$status_file"
else
  [[ -s "$since_file" ]] || date +"%-I:%M %p" > "$since_file"
  if has_wifi; then
    echo "Wi-Fi disconnected since $(cat "$since_file") - check the network"
  else
    echo "Network disconnected since $(cat "$since_file") - check the cable"
  fi
fi
exit 0
