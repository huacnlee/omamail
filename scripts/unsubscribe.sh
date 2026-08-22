#!/bin/sh
# Sends one RFC 8058 one-click unsubscribe POST, and reports what the list said.
#
# ## Why this is not an XMLHttpRequest
#
# It used to be one, and that was a hole. `Unsubscribe.isPostableUrl` judges the
# address the *sender wrote* — https, and not loopback, private, link-local or
# single-label. Qt's XMLHttpRequest then follows a 3xx by itself and re-sends
# the POST, body intact, to wherever that answer points; nothing re-asks the
# gate about the second address. Measured rather than assumed: a loopback target
# answering `302 Location: /landed` recorded the POST arriving at `/landed`.
#
# curl follows nothing unless it is told to, and it is not told to here.
# `--max-redirs 0` says the same thing a second time on purpose: the day
# somebody adds `--location` for an unrelated reason, that line is what refuses
# it rather than silently reopening this.
#
# A 3xx therefore comes back as a 3xx and the panel reports the list as *not*
# unsubscribed. That is the honest reading — a server answering a one-click
# request with "go and ask over there" has not done what its own header
# promised, and RFC 8058 says the answer to this POST is a 2xx.
#
# ## Everything crosses on stdin, base64-encoded
#
# One line, three fields:
#
#   <b64 url> <b64 content-type> <b64 body>
#
# The same rule the mail transport follows, for the same reasons: the URL comes
# out of a stranger's message and may hold quotes, spaces or backslashes; base64
# has none of those, so the field split is a plain `set --` and there is no
# escaping to get wrong on the way in. And the URL reaches curl through a config
# on curl's own stdin rather than as an argument — it carries the token that
# identifies this subscriber, and an argument would put that in the process
# table for anyone on the machine to read.
#
# ## And comes back as one line
#
#   <curl exit code> <http status>
#
# Neither is a document, so neither needs encoding — and the body is never read
# at all. It is written by whoever sent the mail, and the only question being
# asked of it is whether the address is off the list.
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

command -v curl >/dev/null 2>&1 || fail 'unsubscribe.sh: curl is not installed'

decode() {
  printf '%s' "$1" | base64 -d 2>/dev/null || fail 'unsubscribe.sh: bad base64 field'
}

# curl's config format quotes with "..." and escapes with a backslash. Only two
# characters need it, and a URL out of a mail header may carry either.
escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

IFS= read -r line || fail 'unsubscribe.sh: no request on stdin'
[ -n "$line" ] || fail 'unsubscribe.sh: empty request'

# The fields are base64, which contains no spaces, so splitting on them is safe
# and needs no quoting rules.
# shellcheck disable=SC2086
set -- $line
[ $# -eq 3 ] || fail 'unsubscribe.sh: usage: <b64 url> <b64 content-type> <b64 body>'

url=$(decode "$1")
content_type=$(decode "$2")
body=$(decode "$3")

# The gate that ran in `Unsubscribe.js`, run again down here where the request
# is actually made. Two checks of one rule is the point: this one cannot be
# skipped by a caller, and it is the last thing between a header a stranger
# wrote and a connection this machine opens.
case "$url" in
  https://*) ;;
  *) fail 'unsubscribe.sh: refusing a URL that is not https' ;;
esac

escaped_url=$(escape "$url")
escaped_type=$(escape "$content_type")
escaped_body=$(escape "$body")

build_config() {
  printf 'url = "%s"\n' "$escaped_url"
  printf 'request = "POST"\n'
  printf 'header = "Content-Type: %s"\n' "$escaped_type"
  printf 'data-binary = "%s"\n' "$escaped_body"
  # Not followed, said twice. `--proto` bounds the first request and
  # `--proto-redir` the ones that would follow it, so even a curl that was
  # somehow told to follow could not leave https.
  printf 'max-redirs = 0\n'
  printf 'proto = "=https"\n'
  printf 'proto-redir = "=https"\n'
  # The whole exchange, bounded. The XMLHttpRequest this replaces had no
  # timeout at all: a request that was accepted and then black-holed left the
  # button saying "unsubscribing" until the window was closed.
  printf 'max-time = 20\n'
  printf 'connect-timeout = 10\n'
  printf 'silent\n'
  printf 'show-error\n'
  printf 'output = "/dev/null"\n'
  printf 'write-out = "%%{http_code}"\n'
}

set +e
status=$(build_config | curl --config - 2>/dev/null)
code=$?
set -e

# curl writes `000` when it never got an answer at all — a refused connection, a
# TLS failure, a timeout. That is all digits, so it survives the check below;
# the floor is what turns it into the zero the panel reads as "not sent".
case "$status" in
  ''|*[!0-9]*) status=0 ;;
esac
[ "$status" -ge 100 ] 2>/dev/null || status=0

printf '%s %s\n' "$code" "$status"
