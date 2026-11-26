#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d /tmp/omamail-calendar-delete-test.XXXXXX)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/curl" <<'SH'
#!/bin/sh
config=$(cat)
printf '%s' "$config" > "$CALENDAR_DELETE_CONFIG"
SH
chmod +x "$work/bin/curl"
b64() { printf '%s' "$1" | base64 -w0; }
export CALENDAR_DELETE_CONFIG="$work/config"
printf '%s %s\n' "$(b64 'https://calendar.example/dav/me/a.ics')" \
  "$(b64 'me:secret')" \
  | PATH="$work/bin:$PATH" "$project_dir/scripts/calendar-delete.sh"
grep -q 'request = "DELETE"' "$work/config"
grep -q 'url = "https://calendar.example/dav/me/a.ics"' "$work/config"
grep -q 'user = "me:secret"' "$work/config"
if grep -q 'upload-file' "$work/config"; then
  echo 'calendar-delete.sh: a delete carries no body' >&2
  exit 1
fi
# A non-HTTPS address is refused before curl is ever invoked.
if printf '%s %s\n' "$(b64 'http://calendar.example/a.ics')" "$(b64 'me:secret')" \
  | PATH="$work/bin:$PATH" "$project_dir/scripts/calendar-delete.sh" 2>/dev/null; then
  echo 'calendar-delete.sh: plain HTTP must be refused' >&2
  exit 1
fi
# A decoded field becomes one quoted line of the curl config, so an address
# carrying a line break is refused before curl is ever invoked.
if printf '%s %s\n' "$(printf 'https://calendar.example/a.ics\noutput = "/tmp/x"' | base64 -w0)" \
  "$(b64 'me:secret')" \
  | PATH="$work/bin:$PATH" "$project_dir/scripts/calendar-delete.sh" 2>/dev/null; then
  echo 'calendar-delete.sh: a URL that spans lines must be refused' >&2
  exit 1
fi
echo 'calendar-delete.sh ok'
