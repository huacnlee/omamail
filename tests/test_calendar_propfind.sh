#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d /tmp/omamail-calendar-propfind-test.XXXXXX)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin"
# calendar-propfind.sh reads back its own --dump-header file rather than a
# side-channel env var, so the stub has to honor that real argument -- unlike
# calendar-transport.sh's stub, which never reads the header dump it names.
cat > "$work/bin/curl" <<'SH'
#!/bin/sh
config=$(cat)
printf '%s' "$config" > "$CALENDAR_CURL_CONFIG"
header_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dump-header) header_file=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$header_file" ] && printf 'HTTP/1.1 207 Multi-Status\r\n' > "$header_file"
printf '<d:multistatus/>'
exit 0
SH
chmod +x "$work/bin/curl"

b64() { printf '%s' "$1" | base64 -w0; }
export CALENDAR_CURL_CONFIG="$work/config"
request="$(b64 'https://calendar.example/') $(b64 'me:secret') $(b64 '0') $(b64 '<propfind/>')"
reply=$(printf '%s\n' "$request" | PATH="$work/bin:$PATH" "$project_dir/scripts/calendar-propfind.sh")

grep -q 'url = "https://calendar.example/"' "$work/config"
grep -q 'user = "me:secret"' "$work/config"
grep -q 'request = "PROPFIND"' "$work/config"
grep -q 'header = "Depth: 0"' "$work/config"
grep -q 'data = "<propfind/>"' "$work/config"
test "$(printf '%s\n' "$reply" | sed -n '1p')" = 0
test "$(printf '%s\n' "$reply" | sed -n '2p' | base64 -d)" = '<d:multistatus/>'
# The dumped response headers come back too, so the caller can read a
# redirect's Location without curl ever being told to follow it itself.
test "$(printf '%s\n' "$reply" | sed -n '4p' | base64 -d)" = "$(printf 'HTTP/1.1 207 Multi-Status\r\n')"

request_depth1="$(b64 'https://calendar.example/') $(b64 'me:secret') $(b64 '1') $(b64 '<propfind/>')"
printf '%s\n' "$request_depth1" | PATH="$work/bin:$PATH" "$project_dir/scripts/calendar-propfind.sh" >/dev/null
grep -q 'header = "Depth: 1"' "$work/config"

if printf '%s\n' "$(b64 'http://calendar.example/') $(b64 'me:secret') $(b64 '0') $(b64 '<propfind/>')" \
  | PATH="$work/bin:$PATH" "$project_dir/scripts/calendar-propfind.sh" >/dev/null 2>&1; then
  echo 'plaintext calendar URL was accepted' >&2
  exit 1
fi

if printf '%s\n' "$(b64 'https://calendar.example/') $(b64 'me:secret') $(b64 '2') $(b64 '<propfind/>')" \
  | PATH="$work/bin:$PATH" "$project_dir/scripts/calendar-propfind.sh" >/dev/null 2>&1; then
  echo 'a depth other than 0 or 1 was accepted' >&2
  exit 1
fi

# The well-known redirect Fastmail and others answer a bare server address
# with: curl is never told to follow it, so the redirect's own headers, not
# a followed response, must be what comes back.
cat > "$work/bin/curl" <<'SH'
#!/bin/sh
cat >/dev/null
header_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dump-header) header_file=$2; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$header_file" ] && printf 'HTTP/1.1 301 Moved Permanently\r\nLocation: https://calendar.example/dav/calendars\r\n' > "$header_file"
exit 0
SH
redirect_reply=$(printf '%s\n' \
  "$(b64 'https://calendar.example/.well-known/caldav') $(b64 'me:secret') $(b64 '0') $(b64 '<propfind/>')" \
  | PATH="$work/bin:$PATH" "$project_dir/scripts/calendar-propfind.sh")
test "$(printf '%s\n' "$redirect_reply" | sed -n '4p' | base64 -d)" \
  = "$(printf 'HTTP/1.1 301 Moved Permanently\r\nLocation: https://calendar.example/dav/calendars\r\n')"

echo 'calendar-propfind.sh ok'
