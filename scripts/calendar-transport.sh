#!/bin/sh
set -eu

fail() { printf '%s\n' "$1" >&2; exit 2; }
decode() { printf '%s' "$1" | base64 -d 2>/dev/null || fail 'calendar-transport.sh: bad base64 field'; }
escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
encode() { base64 < "$1" | tr -d '\n'; }

IFS= read -r line || fail 'calendar-transport.sh: no request on stdin'
# The three fields are base64 and therefore contain no spaces.
# shellcheck disable=SC2086
set -- $line
[ $# -eq 3 ] || fail 'calendar-transport.sh: expected URL, credentials and report'

url=$(decode "$1")
credentials=$(decode "$2")
report=$(decode "$3")
case "$url" in https://*) ;; *) fail 'calendar-transport.sh: CalDAV requires HTTPS' ;; esac

umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-calendar.XXXXXX") \
  || fail 'calendar-transport.sh: no temporary directory'
trap 'rm -rf "$work"' EXIT INT TERM HUP

build_config() {
  printf 'url = "%s"\n' "$(escape "$url")"
  printf 'noproxy = "*"\n'
  printf 'user = "%s"\n' "$(escape "$credentials")"
  printf 'request = "REPORT"\n'
  printf 'header = "Depth: 1"\n'
  printf 'header = "Content-Type: application/xml; charset=utf-8"\n'
  printf 'data = "%s"\n' "$(escape "$report")"
  printf 'proto = "=https"\n'
  printf 'proto-redir = "=https"\n'
}

set +e
build_config | curl --config - --silent --show-error \
  --dump-header "$work/headers" --max-time 60 --connect-timeout 20 \
  > "$work/out" 2> "$work/err"
status=$?
set -e

printf '%s\n' "$status"
encode "$work/out"
printf '\n'
encode "$work/err"
printf '\n'
