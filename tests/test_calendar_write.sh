#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d /tmp/omamail-calendar-write-test.XXXXXX)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat > "$work/bin/curl" <<'SH'
#!/bin/sh
config=$(cat)
printf '%s' "$config" > "$CALENDAR_WRITE_CONFIG"
event_file=$(printf '%s\n' "$config" | sed -n 's/^upload-file = "\(.*\)"$/\1/p')
cat "$event_file" > "$CALENDAR_WRITE_EVENT"
SH
chmod +x "$work/bin/curl"
b64() { printf '%s' "$1" | base64 -w0; }
export CALENDAR_WRITE_CONFIG="$work/config"
export CALENDAR_WRITE_EVENT="$work/event"
printf '%s %s %s\n' "$(b64 'https://calendar.example/dav/me/a.ics')" \
  "$(b64 'me:secret')" "$(b64 'BEGIN:VCALENDAR')" \
  | PATH="$work/bin:$PATH" "$project_dir/scripts/calendar-write.sh"
grep -q 'request = "PUT"' "$work/config"
test "$(cat "$work/event")" = 'BEGIN:VCALENDAR'
# A decoded field becomes one quoted line of the curl config, so an address
# carrying a line break is refused before curl is ever invoked.
if printf '%s %s %s\n' "$(printf 'https://calendar.example/a.ics\noutput = "/tmp/x"' | base64 -w0)" \
  "$(b64 'me:secret')" "$(b64 'BEGIN:VCALENDAR')" \
  | PATH="$work/bin:$PATH" "$project_dir/scripts/calendar-write.sh" 2>/dev/null; then
  echo 'calendar-write.sh: a URL that spans lines must be refused' >&2
  exit 1
fi
echo 'calendar-write.sh ok'
