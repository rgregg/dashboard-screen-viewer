#!/usr/bin/env bash
# End-to-end check of a deployed gateway: health, token enforcement, then a sample publish that a
# display token can see. Publishes sample dashboards with --delete, replacing whatever was there,
# so use a test deployment or be ready to republish your real screenshots.
#
# Required: GATEWAY_URL, DEVICE_TOKEN_FILE, PUBLISHER_TOKEN_FILE. Needs Node.js 20+, curl, and
# Python 3 with Pillow (pip install pillow). Exits nonzero on the first failure.
set -euo pipefail

: "${GATEWAY_URL:?}" "${DEVICE_TOKEN_FILE:?}" "${PUBLISHER_TOKEN_FILE:?}"
gateway="${GATEWAY_URL%/}"
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; exit 1; }
status() { curl --silent --output /dev/null --write-out '%{http_code}' --max-time 60 "$@"; }

if [[ ! -f package.json || ! -f scripts/make-sample-dashboards.py ]]; then
  echo "Run this script from the repository root." >&2
  exit 1
fi
# Read the tokens once into curl config files, so they never appear on a command line.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
umask 077
printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '[:space:]' <"$DEVICE_TOKEN_FILE")" >"$work/display.curl"
printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '[:space:]' <"$PUBLISHER_TOKEN_FILE")" >"$work/publisher.curl"

echo "Checking $gateway"
[[ "$(curl --fail --silent --max-time 60 "$gateway/healthz")" == ok ]] && pass "health check" || fail "health check"
[[ "$(status "$gateway/v1/images")" == 401 ]] && pass "no token: 401" || fail "request without a token wasn't rejected"
[[ "$(status --config "$work/display.curl" -X PUT -H 'Content-Type: image/png' --data-binary x "$gateway/v1/images/smoke.png")" == 403 ]] \
  && pass "display token can't upload: 403" || fail "display token wasn't refused for upload"
[[ "$(status --config "$work/display.curl" "$gateway/v1/images")" == 200 ]] && pass "display token can list" || fail "display token can't list"

python3 scripts/make-sample-dashboards.py "$work/samples" >/dev/null
expected="$(cd "$work/samples" && ls *.png | sort)"
GATEWAY_URL="$gateway" npx --yes tsx scripts/publish.ts --source-dir="$work/samples" --token-file="$PUBLISHER_TOKEN_FILE" --delete >/dev/null \
  && pass "published $(echo "$expected" | wc -l | tr -d ' ') sample dashboards" || fail "publishing failed"

listed="$(curl --fail --silent --max-time 60 --config "$work/display.curl" "$gateway/v1/images" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).map((i) => i.name).sort().join("\n")));')"
[[ "$listed" == "$expected" ]] && pass "display token sees exactly the published set" || fail "listing didn't match: $listed"

first="$(echo "$expected" | head -1)"
etag="$(curl --fail --silent --max-time 60 --config "$work/display.curl" "$gateway/v1/images" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).find((i) => i.name === process.argv[1]).eTag));' "$first")"
[[ "$(status --config "$work/display.curl" -H "If-Match: $etag" "$gateway/v1/images/$first")" == 200 ]] \
  && pass "display token can download $first" || fail "download failed"

echo "Gateway works end to end. A display polling it shows the samples within about a minute."
