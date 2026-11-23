#!/usr/bin/env bash
# Opens the viewer full screen in a kiosk browser. Usage: scripts/kiosk.sh [port]
set -euo pipefail
URL="http://127.0.0.1:${1:-8080}"

# After a power cycle the browser can start before the service; wait so it never lands on an error page.
until curl -fs "$URL" >/dev/null; do sleep 1; done

if [ "$(uname)" = "Darwin" ]; then
  exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --kiosk --noerrdialogs --disable-infobars --incognito "$URL"
fi

# Linux (Raspberry Pi OS / NUC): keep the screen awake, hide the cursor, then launch Chromium.
xset s off || true
xset -dpms || true
xset s noblank || true
command -v unclutter >/dev/null && (unclutter -idle 1 -root &) || true
BROWSER=$(command -v chromium-browser || command -v chromium || command -v google-chrome)
exec "$BROWSER" --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble --incognito --check-for-update-interval=31536000 "$URL"
