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
# The event stream is framed by jmap-stream.py into bounded LF-separated
# events while it is open. Its output ends with curl's trailer
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

. "$(dirname "$0")/curl-config.sh"

IFS= read -r line || fail 'jmap-transport.sh: no request on stdin'
[ -n "$line" ] || fail 'jmap-transport.sh: empty request'

# The fields are base64, which contains no spaces, so splitting on them is safe
# and needs no quoting rules.
# shellcheck disable=SC2086
set -- $line
[ $# -ge 5 ] \
  || fail 'jmap-transport.sh: usage: <verb> <b64 url> <b64 scheme> <b64 user> <b64 secret> [<b64 field>]'

verb=$1
case "$verb" in
  session|download|stream)
    [ $# -eq 5 ] || fail 'jmap-transport.sh: this verb takes no extra field' ;;
  call|upload)
    [ $# -eq 6 ] || fail 'jmap-transport.sh: this verb needs exactly one extra field' ;;
  *)
    fail 'jmap-transport.sh: verb must be session, call, download, upload or stream' ;;
esac

# Every field that lands in curl's config is judged before it is decoded, and
# before curl runs: a control character ends the `url = "..."` line and turns
# whatever follows it into another curl option. A download URL is filled from
# a blob id and a filename the *server* chose, so this is not a theoretical
# value — `Jmap.downloadUrl` percent-encodes each of them and this is the
# second gate. The shared check is the one every curl transport here runs; the
# `-` sentinel is skipped because it is not base64 at all, and the uploaded
# message is exempt because it goes to a file rather than into the config.
field_number=0
for field in "$@"; do
  field_number=$((field_number + 1))
  case "$verb:$field_number" in
    *:1|upload:6) continue ;;
  esac
  [ "$field" != "-" ] || continue
  validate_config_fields "$field"
done

url=$(decode "$2")
scheme=$(decode "$3")
username=$(decode "$4")
secret=$(decode "$5")
shift 5

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
#
# The directory lives under the runtime directory when there is one: it is
# the user's own, and the session's end clears it. A request that was
# SIGKILLed — the owner destroyed while it ran — never reached its trap, and
# what it left behind is a 0700 directory holding a reply or an outgoing
# message. Those are swept here, an hour after they were last written: no
# request lives that long, `max-time` being ten minutes at most.
work=""
if [ "$verb" != "stream" ]; then
  umask 077
  base=${TMPDIR:-${XDG_RUNTIME_DIR:-/tmp}}
  find "$base" -maxdepth 1 -type d -name 'omamail-jmap.*' -user "$(id -un)" \
    -mmin +60 -exec rm -rf {} + 2>/dev/null || true
  work=$(mktemp -d "$base/omamail-jmap.XXXXXX") \
    || fail 'jmap-transport.sh: no temporary directory'
  trap 'rm -rf "$work"' EXIT INT TERM HUP
fi

escaped_url=$(escape "$url")

if [ "$verb" = "call" ]; then
  body=$(decode "$1")
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
    # Every answer but the stream's is read whole and handed over as one
    # base64 line, so every one of them has the same ceiling: a blob's, which
    # is `Jmap.MAX_BLOB_BYTES` and the figure attachment.sh sends up to. A
    # session object or a method reply near it is not one this client could
    # use, and exceeding it is curl exit 63 rather than the process that draws
    # the desktop holding 20 MB of base64. The stream has a per-event byte
    # ceiling in jmap-stream.py rather than a lifetime transfer ceiling.
    printf 'max-filesize = 20971520\n'
    printf 'output = "%s"\n' "$(escape "$work/out")"
    printf 'write-out = "%%{http_code} %%{redirect_url}"\n'
  fi
}

if [ "$verb" = "stream" ]; then
  # The helper owns curl and forwards only bounded, normalized SSE events.
  # Stopping this shell stops the helper, which terminates and reaps curl;
  # refusing an oversized event closes the connection in the same way.
  set +e
  build_config | python3 "$(dirname "$0")/jmap-stream.py" &
  streaming=$!
  trap 'kill -TERM "$streaming" 2>/dev/null; exit 143' TERM INT HUP
  wait "$streaming"
  status=$?
  set -e
  exit "$status"
fi

# curl is the last stage, so `wait` answers with curl's own exit code rather
# than the config builder's. `output` in the config carries the body, which
# leaves curl's stdout free for `--write-out`.
#
# In the background, with a trap, for the reason the stream is: the client
# cancels a request by stopping this shell, and a curl in the foreground of a
# pipeline is not stopped with it — the TERM waits until curl has finished,
# which for a download or an upload is `max-time`, ten minutes away. Measured
# on the stream first; the four request verbs had the same shape and the same
# leak, and an aborted upload held its slot in the client's queue for as long
# as the curl it had abandoned kept running.
running=""
trap 'kill -TERM "$running" 2>/dev/null; exit 143' TERM INT HUP
attempt_curl() {
  : > "$work/out"
  : > "$work/err"
  : > "$work/status"
  build_config | curl -q --globoff --config - > "$work/status" 2> "$work/err" &
  running=$!
  wait "$running"
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

# curl writes what it receives to `output` as it goes and gives up on the
# ceiling only once it has been crossed, so on exit 63 the file holds the
# whole 20 MB that arrived before it stopped — measured on a chunked body with
# no Content-Length, which is the one shape the pre-transfer check cannot
# refuse. Nobody reads a reply that failed for size, and encoding it would
# hand 28 MB of base64 to the process that draws the desktop for the sake of
# an error line.
if [ "$status" = 63 ]; then
  : > "$work/out"
fi

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
