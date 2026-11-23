#!/usr/bin/env bash
# Kiosk session for the Debian display: a feh slideshow of the viewer's cached screenshots.
set -euo pipefail

app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
data_dir=/var/lib/dashboard-viewer
slides="$data_dir/slides.txt"
placeholder="$app_dir/public/placeholder.png"
rotation=15
# shellcheck disable=SC1091
[[ -r /etc/default/dashboard-kiosk ]] && . /etc/default/dashboard-kiosk
rotation="${ROTATION_SECONDS:-$rotation}"

viewer_pid=""
cleanup() {
  if [[ -n "$viewer_pid" ]]; then
    kill "$viewer_pid" 2>/dev/null || true
    wait "$viewer_pid" 2>/dev/null || true
  fi
}

# Wi-Fi setup window: opens after WIFI_SETUP_AFTER seconds offline; if someone closes it while
# still offline it returns after WIFI_SETUP_SNOOZE seconds. An administrator can open it on
# demand with: sudo touch /run/dashboard-wifi-setup
wifi_setup_after="${WIFI_SETUP_AFTER:-60}"
wifi_setup_snooze="${WIFI_SETUP_SNOOZE:-300}"
offline_since=""
setup_pid=""
setup_forced=0
snooze_until=0
handled_request=$(stat -c %Y /run/dashboard-wifi-setup 2>/dev/null || echo 0)

check_wifi_setup() {
  local now request rc
  now=$(date +%s)
  if [[ -n "$setup_pid" ]] && ! kill -0 "$setup_pid" 2>/dev/null; then
    rc=0
    wait "$setup_pid" || rc=$?
    setup_pid=""
    (( rc == 0 )) || snooze_until=$(( now + wifi_setup_snooze ))
  fi
  request=$(stat -c %Y /run/dashboard-wifi-setup 2>/dev/null || echo 0)
  if (( request > handled_request )); then
    handled_request=$request
    if [[ -z "$setup_pid" ]]; then
      python3 "$app_dir/scripts/wifi-setup.py" & setup_pid=$!
      setup_forced=1
    fi
  fi
  if "$app_dir/scripts/kiosk-status.sh" --check; then
    offline_since=""
    snooze_until=0
    # The network came back on its own: close a window that opened because it was offline.
    if [[ -n "$setup_pid" ]] && (( ! setup_forced )); then
      kill "$setup_pid" 2>/dev/null || true
    fi
    return
  fi
  [[ -n "$offline_since" ]] || offline_since=$now
  if [[ -z "$setup_pid" ]] && (( now - offline_since >= wifi_setup_after && now >= snooze_until )); then
    python3 "$app_dir/scripts/wifi-setup.py" & setup_pid=$!
    setup_forced=0
  fi
}

stop_all() {
  cleanup
  if [[ -n "$setup_pid" ]]; then kill "$setup_pid" 2>/dev/null || true; fi
}
trap stop_all EXIT
trap 'exit 0' INT TERM

xset s off || true
xset -dpms || true
xset s noblank || true

has_slides() { [[ -s "$slides" ]]; }

# feh reads its locked-down key and button bindings from $XDG_CONFIG_HOME/feh (root-owned).
export XDG_CONFIG_HOME="$app_dir/deploy"

feh_common=(
  --no-menus --fullscreen --borderless --hide-pointer --auto-zoom --image-bg black --quiet
  --fontpath /usr/share/fonts/truetype/dejavu --font DejaVuSans-Bold/36 --draw-tinted
  --info "$app_dir/scripts/kiosk-status.sh"
)

while true; do
  if has_slides; then
    mode=slides
    feh "${feh_common[@]}" --slideshow-delay "$rotation" --reload 30 --filelist "$slides" &
  else
    mode=placeholder
    # Reloading the single placeholder redraws the overlay, so network changes show promptly.
    feh "${feh_common[@]}" --reload 10 "$placeholder" &
  fi
  viewer_pid=$!
  while kill -0 "$viewer_pid" 2>/dev/null; do
    sleep 5
    check_wifi_setup
    if [[ "$mode" == placeholder ]] && has_slides; then break; fi
    if [[ "$mode" == slides ]] && ! has_slides; then break; fi
  done
  cleanup
  viewer_pid=""
  sleep 1
done
