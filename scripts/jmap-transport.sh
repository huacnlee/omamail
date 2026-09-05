#!/bin/sh
# Carries one JMAP request, whichever of the five shapes it is.
#
# curl is the client. It owns TLS, the deadlines, the size ceiling and the
# credential; `JmapProtocol.js` owns every URL that goes in and every decision
# about what came back. QML's XMLHttpRequest is not used for this provider: it
# has no timeout, and it follows a 3xx by itself re-sending the Authorization
# header — which here is the account's own password.
#
# ## Everything crosses on stdin, base64-encoded
#
# One line, fields separated by spaces:
#
#   session  <b64 url> <b64 scheme> <b64 user> <b64 secret>
#   call     <b64 url> <b64 scheme> <b64 user> <b64 secret> <b64 json body>
#   download <b64 url> <b64 scheme> <b64 user> <b64 secret>
#   upload   <b64 url> <b64 scheme> <b64 user> <b64 secret> <b64 raw message>
#   stream   <b64 url> <b64 scheme> <b64 user> <b64 secret>
#
# base64 rather than the values themselves, for the three reasons the IMAP
# transport gives:
#
#   - a secret never reaches the process table, which is the same rule
#     keyring-store.sh follows for a refresh token
#   - a password, a URL and a JSON body may all contain quotes, backslashes and
#     spaces; base64 has none of those, so the field split is a plain `set --`
#     and there is no escaping to get wrong
#   - the fields arrive on one line, because Quickshell's Process.write() never
#     closes stdin and anything reading to EOF would hang forever
#
# An empty value crosses as `-`. base64 of the empty string is the empty
# string, which a space-separated line cannot carry; `-` is not in the base64
# alphabet, so it can never be a real field. The `none` scheme is what needs
# it: discovery's well-known GET has no username and no secret.
#
# The script builds the credential and refuses any scheme but these three. QML
# never assembles an Authorization value:
#
#   basic   user = "<user>:<secret>"
#   bearer  header = "Authorization: Bearer <secret>"
#   none    no Authorization header at all
#
# ## The four request verbs answer in four lines
#
#   <curl exit code>
#   <http status> <redirect url>
#   <b64 body>
#   <b64 stderr>
#
# No `--fail` on those four, on purpose: a JMAP failure is an
# `application/problem+json` document with the status, and `--fail` would throw
# it away and leave only an exit code. The status therefore comes from
# `--write-out` rather than from curl's exit, and curl's `%{redirect_url}`
# follows it so the client can decide about one hop itself — the script follows
# nothing.
#
# The body is base64 for the same reason the IMAP transport's is: a download is
# arbitrary bytes, and base64 guarantees no newline inside a response can be
# mistaken for the end of one.
#
# ## `stream` answers in raw lines
#
# The event stream is read line by line while it is open, so it cannot be
# encoded or buffered. Its output is curl's own stdout followed by a trailer
# line `http <code>` that `--write-out` prints once the transfer has ended —
# read after curl exits, it is what splits a `--fail` exit 22 into "the
# credential was rejected" (401) and "the connection failed" (anything else).
# `stream` exits with curl's own exit code, because that is what its reconnect
# table is written against.
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

command -v curl >/dev/null 2>&1 || fail 'jmap-transport.sh: curl is not installed'

decode() {
  [ "$1" != "-" ] || return 0
  printf '%s' "$1" | base64 -d 2>/dev/null || fail 'jmap-transport.sh: bad base64 field'
}

# curl's config format quotes with "..." and escapes with a backslash. Only two
# characters need it, and both turn up in real passwords.
escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# One line, never wrapped and with no trailing newline of its own — the caller
# adds exactly one, so the reply is always four lines however large a download
# was. `-w 0` is not portable and both implementations wrap by default, so the
# newlines are stripped rather than suppressed.
encode() {
  base64 < "$1" | tr -d '\n'
}

IFS= read -r line || fail 'jmap-transport.sh: no request on stdin'
[ -n "$line" ] || fail 'jmap-transport.sh: empty request'

# The fields are base64, which contains no spaces, so splitting on them is safe
# and needs no quoting rules.
# shellcheck disable=SC2086
set -- $line
[ $# -ge 5 ] \
  || fail 'jmap-transport.sh: usage: <verb> <b64 url> <b64 scheme> <b64 user> <b64 secret> [<b64 field>]'

verb=$1
url=$(decode "$2")
scheme=$(decode "$3")
username=$(decode "$4")
secret=$(decode "$5")
shift 5

case "$verb" in
  session|download|stream)
    [ $# -eq 0 ] || fail 'jmap-transport.sh: this verb takes no extra field' ;;
  call|upload)
    [ $# -eq 1 ] || fail 'jmap-transport.sh: this verb needs exactly one extra field' ;;
  *)
    fail 'jmap-transport.sh: verb must be session, call, download, upload or stream' ;;
esac

# A CR or LF ends the `url = "..."` line and turns whatever follows it into
# another curl option. A download URL is filled from a blob id and a filename
# the *server* chose, so this is not a theoretical value: `Jmap.downloadUrl`
# percent-encodes each of them and this is the second gate, the way
# image-fetch.sh refuses a line break in an address a stranger wrote. The
# uploaded message is exempt because it goes to a file rather than into the
# config.
nl='
'
cr=$(printf '\r')
for field in "$url" "$scheme" "$username" "$secret"; do
  case "$field" in
    *"$nl"* | *"$cr"*) fail 'jmap-transport.sh: a request field may not span lines' ;;
  esac
done

# The scheme gate runs before curl does, so an account carrying something else
# never reaches a connection at all.
case "$scheme" in
  basic|bearer|none) ;;
  *) fail 'jmap-transport.sh: auth scheme must be basic, bearer or none' ;;
esac

# Every JMAP URL this client speaks to came out of a session object it fetched
# over HTTPS, or is the one URL the user typed. This is the second gate rather
# than the first: it is what stops a hand-edited accounts.json from sending an
# account password to an ordinary web server.
case "$url" in
  https://*) ;;
  *) fail 'jmap-transport.sh: refusing a URL that is not https' ;;
esac

# The stream gets no work directory. It is the one verb whose process is
# routinely destroyed rather than stopped — SIGKILL runs no trap — and it needs
# neither a body file nor an output file, so a directory here would be one left
# in /tmp per reconnect for the life of the session.
work=""
if [ "$verb" != "stream" ]; then
  umask 077
  work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-jmap.XXXXXX") \
    || fail 'jmap-transport.sh: no temporary directory'
  trap 'rm -rf "$work"' EXIT INT TERM HUP
fi

escaped_url=$(escape "$url")

if [ "$verb" = "call" ]; then
  body=$(decode "$1")
  case "$body" in
    *"$nl"* | *"$cr"*) fail 'jmap-transport.sh: a JSON body may not span lines' ;;
  esac
  escaped_body=$(escape "$body")
elif [ "$verb" = "upload" ]; then
  # The message is the one value too large to be an argument, and curl uploads
  # from a file rather than from a string — stdin is already carrying the
  # config. It lands in the 0700 directory the trap removes on any exit.
  decode "$1" > "$work/message"
fi

# The config is written to curl's own stdin rather than to a file: it carries
# the secret, and a file holding one would be on disk for as long as curl took
# to read it. `build_config` prints it; the pipeline below is what feeds it in
# without it ever being written down.
build_config() {
  printf 'url = "%s"\n' "$escaped_url"
  # Desktop HTTP/SOCKS proxy settings are for web traffic, and Omarchy's local
  # SOCKS proxy drops a TLS handshake it accepted. Direct transport also keeps
  # an account credential from being offered through an unrelated proxy.
  printf 'noproxy = "*"\n'
  # Not followed, said three times. `proto` bounds the first request,
  # `proto-redir` the ones that would follow it, and `max-redirs = 0` refuses
  # the day somebody adds `--location` for an unrelated reason. A redirect is
  # reported to the client as a redirect rather than chased with the password
  # attached.
  printf 'proto = "=https"\n'
  printf 'proto-redir = "=https"\n'
  printf 'max-redirs = 0\n'
  printf 'silent\n'
  printf 'show-error\n'

  case "$scheme" in
    basic) printf 'user = "%s:%s"\n' "$(escape "$username")" "$(escape "$secret")" ;;
    bearer) printf 'header = "Authorization: Bearer %s"\n' "$(escape "$secret")" ;;
    none) ;;
  esac

  case "$verb" in
    session)
      printf 'header = "Accept: application/json"\n'
      printf 'connect-timeout = 20\n'
      printf 'max-time = 60\n'
      ;;
    call)
      printf 'request = "POST"\n'
      printf 'header = "Content-Type: application/json; charset=utf-8"\n'
      printf 'header = "Accept: application/json"\n'
      printf 'data-binary = "%s"\n' "$escaped_body"
      printf 'connect-timeout = 20\n'
      printf 'max-time = 60\n'
      ;;
    download)
      # A blob is the one answer that can be arbitrarily large. The ceiling is
      # `Jmap.MAX_BLOB_BYTES`, the same figure attachment.sh sends up to, and
      # exceeding it is curl exit 63 rather than a 20 MB base64 line.
      printf 'max-filesize = 20971520\n'
      printf 'connect-timeout = 20\n'
      printf 'speed-limit = 1024\n'
      printf 'speed-time = 30\n'
      printf 'max-time = 600\n'
      ;;
    upload)
      # `upload-file` alone is a PUT; the JMAP upload endpoint takes a POST.
      printf 'request = "POST"\n'
      printf 'header = "Content-Type: message/rfc822"\n'
      printf 'header = "Accept: application/json"\n'
      printf 'upload-file = "%s"\n' "$(escape "$work/message")"
      printf 'connect-timeout = 20\n'
      printf 'speed-limit = 1024\n'
      printf 'speed-time = 30\n'
      printf 'max-time = 600\n'
      ;;
    stream)
      printf 'header = "Accept: text/event-stream"\n'
      # An event stream is read while it is open, so curl may not hold a
      # buffer, and `--fail` is what turns a rejected credential into an exit
      # rather than a body nothing reads. `max-time` is the planned rotation
      # and `keepalive-time` keeps a NAT from forgetting an idle connection.
      printf 'no-buffer\n'
      printf 'fail\n'
      printf 'connect-timeout = 20\n'
      printf 'keepalive-time = 60\n'
      printf 'max-time = 3600\n'
      ;;
  esac

  if [ "$verb" = "stream" ]; then
    # Printed by curl once the transfer has ended, so it is the last line of
    # the stream's own output rather than a channel of its own.
    printf 'write-out = "http %%{http_code}\\n"\n'
  else
    printf 'output = "%s"\n' "$(escape "$work/out")"
    printf 'write-out = "%%{http_code} %%{redirect_url}"\n'
  fi
}

if [ "$verb" = "stream" ]; then
  set +e
  build_config | curl --config -
  status=$?
  set -e
  exit "$status"
fi

# curl is the last stage, so `$?` is curl's own exit code rather than the
# config builder's. `output` in the config carries the body, which leaves
# curl's stdout free for `--write-out`.
attempt_curl() {
  : > "$work/out"
  : > "$work/err"
  : > "$work/status"
  build_config | curl --config - > "$work/status" 2> "$work/err"
}

# A dropped TLS handshake is worth a second go; a delivered request is not.
#
# The three exit codes retried here are the ones that mean the request never
# reached the server at all: the name did not resolve (6), the socket never
# connected (7), and TLS failed before the session existed (35). curl's own
# `--retry-all-errors` cannot tell those from a transfer the server already
# took, and an `Email/set` retried after the server took it applies twice. A
# 401 is not retried either: re-sending a Basic password is what locks an app
# password on Stalwart.
attempt=0
while :; do
  set +e
  attempt_curl
  status=$?
  set -e
  case "$status" in
    6|7|35) ;;
    *) break ;;
  esac
  attempt=$((attempt + 1))
  [ "$attempt" -le 2 ] || break
  sleep 1
done

printf '%s\n' "$status"
# The redirect URL is written by the server. Stripping the line breaks is what
# keeps it one line of the reply rather than a `Location:` that could forge the
# base64 body line beneath it.
tr -d '\r\n' < "$work/status" | sed -e 's/[[:space:]]*$//'
printf '\n'
encode "$work/out"
printf '\n'
encode "$work/err"
printf '\n'
