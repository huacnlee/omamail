#!/bin/sh
# The CalDAV delete verb, kept apart from calendar-write.sh the way that one is
# kept apart from calendar-transport.sh: one script, one method. Fields cross
# base64-encoded on one line of stdin, so a password never reaches the process
# table, and the config goes to curl's own stdin rather than to a file on disk.
set -eu

fail() { printf '%s\n' "$1" >&2; exit 2; }
decode() { printf '%s' "$1" | base64 -d 2>/dev/null || fail 'calendar-delete.sh: bad base64 field'; }
escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

IFS= read -r line || fail 'calendar-delete.sh: no request on stdin'
# shellcheck disable=SC2086
set -- $line
[ $# -eq 2 ] || fail 'calendar-delete.sh: expected URL and credentials'
url=$(decode "$1")
credentials=$(decode "$2")
# Each decoded field becomes one quoted line of the curl config; a line break
# in one would smuggle in more options, so it is refused before curl runs.
# (The newline is a literal: command substitution would strip it.)
nl='
'
cr=$(printf '\r')
case $url in *"$nl"* | *"$cr"*) fail 'calendar-delete.sh: URL may not span lines' ;; esac
case $credentials in *"$nl"* | *"$cr"*) fail 'calendar-delete.sh: credentials may not span lines' ;; esac
case "$url" in https://*) ;; *) fail 'calendar-delete.sh: CalDAV requires HTTPS' ;; esac

build_config() {
  printf 'url = "%s"\n' "$(escape "$url")"
  printf 'noproxy = "*"\n'
  printf 'user = "%s"\n' "$(escape "$credentials")"
  printf 'request = "DELETE"\n'
  printf 'proto = "=https"\n'
  printf 'proto-redir = "=https"\n'
}

build_config | curl --config - --silent --show-error --fail-with-body \
  --max-time 60 --connect-timeout 20 >/dev/null
