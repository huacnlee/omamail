#!/bin/sh
set -eu

fail() { printf '%s\n' "$1" >&2; exit 2; }
decode() { printf '%s' "$1" | base64 -d 2>/dev/null || fail 'calendar-transport.sh: bad base64 field'; }
escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
encode() { base64 < "$1" | tr -d '\n'; }

. "$(dirname "$0")/curl-config.sh"

IFS= read -r line || fail 'calendar-transport.sh: no request on stdin'
# The three fields are base64 and therefore contain no spaces.
# shellcheck disable=SC2086
set -- $line
# Three fields are a REPORT, the calendar query. A fourth names another
# method — `propfind-0` or `propfind-1`, the steps of finding a server's
# calendars — and nothing else: the method is one of three words, never a
# field curl is handed.
[ $# -eq 3 ] || [ $# -eq 4 ] || fail 'calendar-transport.sh: expected URL, credentials, a body and an optional method'
validate_config_fields "$@"

url=$(decode "$1")
credentials=$(decode "$2")
report=$(decode "$3")
method=report
[ $# -eq 3 ] || method=$(decode "$4")
case "$method" in
  report|propfind-0|propfind-1) ;;
  *) fail 'calendar-transport.sh: method must be report, propfind-0 or propfind-1' ;;
esac
case "$url" in https://*) ;; *) fail 'calendar-transport.sh: CalDAV requires HTTPS' ;; esac

umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-calendar.XXXXXX") \
  || fail 'calendar-transport.sh: no temporary directory'
trap 'rm -rf "$work"' EXIT INT TERM HUP

build_config() {
  printf 'url = "%s"\n' "$(escape "$url")"
  printf 'noproxy = "*"\n'
  printf 'user = "%s"\n' "$(escape "$credentials")"
  case "$method" in
    report) printf 'request = "REPORT"\n'; printf 'header = "Depth: 1"\n' ;;
    propfind-0) printf 'request = "PROPFIND"\n'; printf 'header = "Depth: 0"\n' ;;
    propfind-1) printf 'request = "PROPFIND"\n'; printf 'header = "Depth: 1"\n' ;;
  esac
  printf 'header = "Content-Type: application/xml; charset=utf-8"\n'
  printf 'data = "%s"\n' "$(escape "$report")"
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
