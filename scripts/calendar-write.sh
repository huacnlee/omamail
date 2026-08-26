#!/bin/sh
set -eu

fail() { printf '%s\n' "$1" >&2; exit 2; }
decode() { printf '%s' "$1" | base64 -d 2>/dev/null || fail 'calendar-write.sh: bad base64 field'; }
escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

IFS= read -r line || fail 'calendar-write.sh: no request on stdin'
# shellcheck disable=SC2086
set -- $line
[ $# -eq 3 ] || fail 'calendar-write.sh: expected URL, credentials and event'
url=$(decode "$1")
credentials=$(decode "$2")
event=$(decode "$3")
# Each decoded field becomes one quoted line of the curl config; a line break
# in one would smuggle in more options, so it is refused before curl runs.
# (The newline is a literal: command substitution would strip it.)
nl='
'
cr=$(printf '\r')
case $url in *"$nl"* | *"$cr"*) fail 'calendar-write.sh: URL may not span lines' ;; esac
case $credentials in *"$nl"* | *"$cr"*) fail 'calendar-write.sh: credentials may not span lines' ;; esac
case "$url" in https://*) ;; *) fail 'calendar-write.sh: CalDAV requires HTTPS' ;; esac

umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-calendar-write.XXXXXX") \
  || fail 'calendar-write.sh: no temporary directory'
trap 'rm -rf "$work"' EXIT INT TERM HUP
printf '%s' "$event" > "$work/event.ics"

build_config() {
  printf 'url = "%s"\n' "$(escape "$url")"
  printf 'noproxy = "*"\n'
  printf 'user = "%s"\n' "$(escape "$credentials")"
  printf 'request = "PUT"\n'
  printf 'header = "Content-Type: text/calendar; charset=utf-8"\n'
  printf 'upload-file = "%s"\n' "$(escape "$work/event.ics")"
  printf 'proto = "=https"\n'
  printf 'proto-redir = "=https"\n'
}

build_config | curl --config - --silent --show-error --fail-with-body \
  --max-time 60 --connect-timeout 20 >/dev/null
