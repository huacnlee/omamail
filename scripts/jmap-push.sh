#!/bin/sh
# Holds a JMAP event-source connection open and writes each line it receives to
# stdout, for a caller reading them one at a time.
#
# The URL and the token arrive base64 on stdin, and the token reaches curl in a
# config on *its* stdin — never on the command line, where /proc would show it
# to every process on the machine for as long as the stream is open. That is a
# longer window than any other script here has, which is why it matters more.
#
# This exits whenever the stream ends, for any reason. Reconnecting is the
# caller's business: it is the one that knows how many times it has already
# tried and how long it should now wait.
set -u

fail() { printf '%s\n' "$1" >&2; exit 2; }
decode() { printf '%s' "$1" | base64 -d 2>/dev/null || fail 'jmap-push.sh: bad base64 field'; }
escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

. "$(dirname "$0")/curl-config.sh"

IFS= read -r line || fail 'jmap-push.sh: no request on stdin'
# The two fields are base64 and therefore contain no spaces.
# shellcheck disable=SC2086
set -- $line
[ $# -eq 2 ] || fail 'jmap-push.sh: expected URL and token'
validate_config_fields "$@"

url=$(decode "$1")
token=$(decode "$2")
case "$url" in https://*) ;; *) fail 'jmap-push.sh: the event source must be HTTPS' ;; esac

build_config() {
  printf 'url = "%s"\n' "$(escape "$url")"
  printf 'noproxy = "*"\n'
  printf 'header = "Authorization: Bearer %s"\n' "$(escape "$token")"
  printf 'header = "Accept: text/event-stream"\n'
  printf 'proto = "=https"\n'
  printf 'proto-redir = "=https"\n'
}

# --no-buffer is the whole point: without it curl holds output in a block buffer
# and an event that arrived a second ago is not written until enough of them
# have. No --max-time, because the connection is meant to last; the server's own
# ping is what proves it is still there.
build_config | exec curl -q --globoff --config - --silent --show-error \
  --no-buffer --connect-timeout 20
