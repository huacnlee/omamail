#!/bin/sh
# Runs one IMAP conversation, or sends one message over SMTP, and hands the
# result back to the panel.
#
# curl is the client. It owns TLS, LOGIN, the tagged command it wraps each
# request in, and the literals in the reply; `Imap.js` owns every string that
# goes in and every decision about what comes back. Nothing in between needs a
# library the plugin would have to carry.
#
# ## Everything crosses on stdin, base64-encoded
#
# One line, fields separated by spaces:
#
#   imap <b64 url> <b64 user:password> <b64 command> [<b64 command> ...]
#   imap-append <b64 url> <b64 user:password> <b64 message>
#   smtp <b64 url> <b64 user:password> <b64 from> <b64 message> <b64 rcpt> ...
#
# base64 rather than the values themselves, for three reasons that each bite
# once during this script's life:
#
#   - a password never reaches the process table, which is the same rule
#     keyring-store.sh follows for the refresh token
#   - a password, a folder name and an IMAP command may all contain quotes,
#     backslashes and spaces; base64 has none of those, so the field split is a
#     plain `set --` and there is no escaping to get wrong
#   - the fields arrive on one line, because Quickshell's Process.write() never
#     closes stdin and anything reading to EOF would hang forever
#
# ## And comes back base64-encoded
#
#   <curl exit code>
#   <b64 stdout>
#   <b64 stderr>
#
# The response is base64 for a different reason: IMAP measures a literal in
# octets, so the parser has to count octets. Base64 keeps the byte count exact
# across a pipe the shell would otherwise read as text, keeps binary attachment
# data intact, and guarantees no newline inside a response can be mistaken for
# the end of one.
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 2
}

decode() {
  printf '%s' "$1" | base64 -d 2>/dev/null || fail 'mail-transport.sh: bad base64 field'
}

# curl's config format quotes with "..." and escapes with a backslash. Only two
# characters need it, and both turn up in real passwords.
escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# One line, never wrapped and with no trailing newline of its own — the caller
# adds exactly one, so the reply is always three lines however long a message
# was. `-w 0` is not portable and both implementations wrap by default, so the
# newlines are stripped rather than suppressed.
encode() {
  base64 < "$1" | tr -d '\n'
}

IFS= read -r line || fail 'mail-transport.sh: no request on stdin'
[ -n "$line" ] || fail 'mail-transport.sh: empty request'

# The fields are base64, which contains no spaces, so splitting on them is safe
# and needs no quoting rules.
# shellcheck disable=SC2086
set -- $line
[ $# -ge 4 ] || fail 'mail-transport.sh: usage: <mode> <url> <credentials> <arg>...'

mode=$1
url=$(decode "$2")
credentials=$(decode "$3")
shift 3

case "$mode" in
  imap|imap-append|smtp) ;;
  *) fail 'mail-transport.sh: mode must be imap, imap-append or smtp' ;;
esac

# The URL is built and validated by Imap.js, which has already refused anything
# carrying userinfo, a port inside the host, or characters that could end the
# path. This is the second gate rather than the first: the scheme check is what
# stops a hand-edited accounts.json from pointing an authenticated client at
# file:// or at an ordinary web server.
case "$url" in
  imaps://*|imap://*|smtps://*|smtp://*) ;;
  *) fail 'mail-transport.sh: refusing a URL that is not imap(s) or smtp(s)' ;;
esac

escaped_url=$(escape "$url")
escaped_credentials=$(escape "$credentials")

umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail.XXXXXX") || fail 'mail-transport.sh: no temporary directory'
trap 'rm -rf "$work"' EXIT INT TERM HUP

# The config is written to curl's own stdin rather than to a file: it carries
# the password, and a file holding one would be on disk for as long as curl
# took to read it. `build_config` prints it; the pipeline below is what feeds
# it in without it ever being written down.
build_config() {
if [ "$mode" = "smtp" ]; then
  [ $# -ge 3 ] || fail 'mail-transport.sh: smtp needs a sender, a message and a recipient'
  sender=$(decode "$1")
  shift 2

  printf 'url = "%s"\n' "$escaped_url"
  printf 'noproxy = "*"\n'
  printf 'user = "%s"\n' "$escaped_credentials"
  printf 'max-time = 60\n'
  printf 'connect-timeout = 20\n'
  case "$url" in
    smtp://127.0.0.1:*|smtp://localhost:*) ;;
    smtp://*) printf 'ssl-reqd\n' ;;
  esac
  printf 'mail-from = "%s"\n' "$(escape "$sender")"
  for recipient in "$@"; do
    printf 'mail-rcpt = "%s"\n' "$(escape "$(decode "$recipient")")"
  done
  # The message is the one value too large to be an argument, and curl uploads
  # from a file rather than from a string — stdin is already carrying this
  # config. It lands in the 0700 directory the trap removes on any exit.
  printf 'upload-file = "%s"\n' "$(escape "$work/message")"
elif [ "$mode" = "imap-append" ]; then
  printf 'url = "%s"\n' "$escaped_url"
  printf 'noproxy = "*"\n'
  printf 'user = "%s"\n' "$escaped_credentials"
  printf 'max-time = 60\n'
  printf 'connect-timeout = 20\n'
  case "$url" in
    imap://127.0.0.1:*|imap://localhost:*) ;;
    imap://*) printf 'ssl-reqd\n' ;;
  esac
  printf 'upload-file = "%s"\n' "$(escape "$work/message")"
  printf 'upload-flags = "draft"\n'
else
  # IMAP: one section per command, so a sequence — search a folder, then fetch
  # what came back — runs on a single connection. curl reuses the connection
  # across sections to the same host, so the TLS handshake and the LOGIN are
  # paid for once rather than once per command. `--next` resets almost every
  # option, which is why the URL and the credentials are repeated in each
  # section rather than set once at the top.
  first=1
  for argument in "$@"; do
    [ "$first" = "1" ] || printf 'next\n'
    first=0
    printf 'url = "%s"\n' "$escaped_url"
    # Desktop HTTP/SOCKS proxy settings are for web traffic. In particular,
    # Omarchy's local SOCKS proxy accepts the IMAPS socket and then drops its
    # TLS handshake, which curl reports as error 35. Direct mail transport also
    # keeps account credentials from being offered through an unrelated proxy.
    # Repeated because `next` resets this curl option with the rest.
    printf 'noproxy = "*"\n'
    printf 'user = "%s"\n' "$escaped_credentials"
    # These are per-transfer options too. Keeping them in every section makes
    # every command give up eventually, rather than only the final one.
    printf 'max-time = 60\n'
    printf 'connect-timeout = 20\n'
    case "$url" in
      imap://127.0.0.1:*|imap://localhost:*) ;;
      imap://*) printf 'ssl-reqd\n' ;;
    esac
    printf 'request = "%s"\n' "$(escape "$(decode "$argument")")"
  done
fi
}

# The SMTP body has to be on disk before curl starts, because the config it is
# named in is what stdin is carrying.
if [ "$mode" = "smtp" ]; then
  [ $# -ge 3 ] || fail 'mail-transport.sh: smtp needs a sender, a message and a recipient'
  decode "$2" > "$work/message"
elif [ "$mode" = "imap-append" ]; then
  [ $# -eq 1 ] || fail 'mail-transport.sh: imap-append needs one message'
  decode "$1" > "$work/message"
fi

# curl is the last stage, so `$?` is curl's own exit code rather than the
# config builder's.
attempt_curl() {
  build_config "$@" | curl \
    --fail-early \
    --config - \
    --silent \
    --show-error \
    --dump-header "$work/headers" \
    > "$work/out" 2> "$work/err"
}

# A dropped TLS handshake is worth a second go; a delivered message is not.
#
# curl's own `--retry` covers neither on its own: its idea of a transient error
# is a timeout or an HTTP status, so a handshake that died mid-negotiation is
# not retried without `--retry-all-errors`. That flag then retries everything —
# including a transfer that failed *after* the server took it, which for SMTP
# is the message delivered twice and for APPEND a second copy in the folder.
# curl cannot tell those apart because by then it has already sent them.
#
# So the retry is here, on the three exit codes that mean the command never
# reached the server at all: the name did not resolve (6), the socket never
# connected (7), and TLS failed before the session existed (35). Every one of
# those is safe to repeat whatever the mode is. A rejected password (67) is
# not retried, because three LOGIN attempts per operation is what iCloud and
# Gmail lock an app password for.
attempt=0
while :; do
  set +e
  attempt_curl "$@"
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
if [ "$mode" = "imap" ] && [ ! -s "$work/out" ] && [ -s "$work/headers" ]; then
  # libcurl recognises only a single numeric UID as a BODY FETCH. A legal IMAP
  # sequence-set is treated as a generic custom request, whose response is
  # delivered through curl's protocol-header callback instead of stdout.
  # A single UID BODY FETCH is recognised by libcurl and its complete response
  # stays on stdout; prefer that whenever it exists because the header channel
  # then contains only a partial protocol preamble.
  encode "$work/headers"
else
  encode "$work/out"
fi
printf '\n'
encode "$work/err"
printf '\n'
