#!/bin/sh
# The CalDAV discovery verb, kept apart from calendar-transport.sh the way
# that one's REPORT is kept apart from calendar-write.sh's PUT: one script,
# one method. Fields cross base64-encoded on one line of stdin, so a password
# never reaches the process table, and the config goes to curl's own stdin
# rather than to a file on disk.
#
# curl is never told to follow a redirect (no --location): the response
# headers go back to the caller instead, so calendar/Calendar.js can decide
# whether a 3xx's Location is worth one more hop on the same rule it holds
# every other discovered address to — the account's own origin, nothing
# named by a server left to speak for itself.
set -eu

fail() { printf '%s\n' "$1" >&2; exit 2; }
decode() { printf '%s' "$1" | base64 -d 2>/dev/null || fail 'calendar-propfind.sh: bad base64 field'; }
escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
encode() { base64 < "$1" | tr -d '\n'; }

. "$(dirname "$0")/curl-config.sh"

IFS= read -r line || fail 'calendar-propfind.sh: no request on stdin'
# The four fields are base64 and therefore contain no spaces.
# shellcheck disable=SC2086
set -- $line
[ $# -eq 4 ] || fail 'calendar-propfind.sh: expected URL, credentials, depth and body'
validate_config_fields "$@"

url=$(decode "$1")
credentials=$(decode "$2")
depth=$(decode "$3")
body=$(decode "$4")
case "$url" in https://*) ;; *) fail 'calendar-propfind.sh: CalDAV requires HTTPS' ;; esac
case "$depth" in 0|1) ;; *) fail 'calendar-propfind.sh: depth must be 0 or 1' ;; esac

umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-calendar-propfind.XXXXXX") \
  || fail 'calendar-propfind.sh: no temporary directory'
trap 'rm -rf "$work"' EXIT INT TERM HUP

build_config() {
  printf 'url = "%s"\n' "$(escape "$url")"
  printf 'noproxy = "*"\n'
  printf 'user = "%s"\n' "$(escape "$credentials")"
  printf 'request = "PROPFIND"\n'
  printf 'header = "Depth: %s"\n' "$depth"
  printf 'header = "Content-Type: application/xml; charset=utf-8"\n'
  printf 'data = "%s"\n' "$(escape "$body")"
  printf 'proto = "=https"\n'
  printf 'proto-redir = "=https"\n'
}

set +e
build_config | curl -q --globoff --config - --silent --show-error \
  --dump-header "$work/headers" --max-time 60 --connect-timeout 20 \
  > "$work/out" 2> "$work/err"
status=$?
set -e

printf '%s\n' "$status"
encode "$work/out"
printf '\n'
encode "$work/err"
printf '\n'
encode "$work/headers"
printf '\n'
