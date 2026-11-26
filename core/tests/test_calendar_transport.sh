#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d /tmp/omamail-calendar-test.XXXXXX)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin"
cat > "$work/bin/curl" <<'SH'
#!/bin/sh
config=$(cat)
printf '%s' "$config" > "$CALENDAR_CURL_CONFIG"
printf 'HTTP/1.1 207 Multi-Status\r\n' > "$CALENDAR_CURL_HEADERS"
printf '<d:multistatus/>'
exit 0
SH
chmod +x "$work/bin/curl"

b64() { printf '%s' "$1" | base64 -w0; }
export CALENDAR_CURL_CONFIG="$work/config"
export CALENDAR_CURL_HEADERS="$work/headers"
request="$(b64 'https://calendar.example/dav/me/') $(b64 'me:secret') $(b64 '<query/>')"
reply=$(printf '%s\n' "$request" | PATH="$work/bin:$PATH" "$project_dir/scripts/calendar-transport.sh")

grep -q 'url = "https://calendar.example/dav/me/"' "$work/config"
grep -q 'user = "me:secret"' "$work/config"
grep -q 'request = "REPORT"' "$work/config"
grep -q 'data = "<query/>"' "$work/config"
! grep -q 'location' "$work/config"
test "$(printf '%s\n' "$reply" | sed -n '1p')" = 0
test "$(printf '%s\n' "$reply" | sed -n '2p' | base64 -d)" = '<d:multistatus/>'

if printf '%s\n' "$(b64 'http://calendar.example/') $(b64 'me:secret') $(b64 '<query/>')" \
  | PATH="$work/bin:$PATH" "$project_dir/scripts/calendar-transport.sh" >/dev/null 2>&1; then
  echo 'plaintext calendar URL was accepted' >&2
  exit 1
fi

echo 'calendar-transport.sh ok'
