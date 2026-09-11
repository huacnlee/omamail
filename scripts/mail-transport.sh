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
#   imap-id <b64 root url> <b64 url> <b64 user:password> <b64 preamble> <b64 command> ...
#   imap-append <b64 url> <b64 user:password> <b64 message> <b64 flags>
#   smtp <b64 url> <b64 user:password> <b64 from> <b64 message> <b64 rcpt> ...
#   *-oauth uses <b64 username> <b64 bearer token> in place of <b64 user:password>
#   graph-send <b64 url> <b64 token> <b64 message>
#
# graph-send is Microsoft Graph's sendMail for a Microsoft 365 tenant that has
# authenticated SMTP switched off: the same message, POSTed as base64 MIME
# with a bearer token of Graph's own audience. Graph files the sent copy.
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

# Controls are refused before decoding; quotes and backslashes are escaped.
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

. "$(dirname "$0")/curl-config.sh"

IFS= read -r line || fail 'mail-transport.sh: no request on stdin'
[ -n "$line" ] || fail 'mail-transport.sh: empty request'

# The fields are base64, which contains no spaces, so splitting on them is safe
# and needs no quoting rules.
# shellcheck disable=SC2086
set -- $line
[ $# -ge 4 ] || fail 'mail-transport.sh: usage: <mode> <url> <credentials> <arg>...'

mode=$1
case "$mode" in
  imap-oauth) [ $# -ge 5 ] || fail 'mail-transport.sh: imap-oauth needs a URL, a username, a bearer token and a command' ;;
  imap-id-oauth) [ $# -ge 7 ] || fail 'mail-transport.sh: imap-id-oauth needs two URLs, a username, a bearer token, a preamble and a command' ;;
  imap-append-oauth) [ $# -eq 6 ] || fail 'mail-transport.sh: imap-append-oauth needs a URL, a username, a bearer token, a message and flags' ;;
  smtp-oauth) [ $# -ge 7 ] || fail 'mail-transport.sh: smtp-oauth needs a URL, a username, a bearer token, a sender, a message and a recipient' ;;
  graph-send) [ $# -eq 4 ] || fail 'mail-transport.sh: graph-send needs a url, a token and a message' ;;
esac
# Validate ALL config fields before curl can see even the first command. Only
# message bodies bypass this check: they are uploaded as files, never config.
# APPEND flags remain protected, just like URLs and credentials.
field_number=0
for field in "$@"; do
  field_number=$((field_number + 1))
  case "$mode:$field_number" in
    *:1|smtp:5|imap-append:4|smtp-oauth:6|imap-append-oauth:5|graph-send:4) continue ;;
  esac
  validate_config_fields "$field"
done
# `imap-id` carries two URLs. The first section has to reach the server without
# naming a mailbox: curl opens a URL's path before the first command it was
# given, so a path there is a SELECT that nothing can be placed in front of,
# and some servers refuse SELECT until the client has sent RFC 2971's ID. The
# connection is reused across the sections, so a command sent by the first one
# still applies to the mailbox the next one opens.
case "$mode" in
  imap-oauth|imap-id-oauth|imap-append-oauth|smtp-oauth) oauth=1 ;;
  *) oauth=0 ;;
esac

case "$mode" in
  imap-id|imap-id-oauth) identified=1 ;;
  *) identified=0 ;;
esac

if [ "$identified" = 1 ]; then
  [ $# -ge 6 ] || fail 'mail-transport.sh: imap-id needs a root url, a url, credentials, a preamble and a command'
  root_url=$(decode "$2")
  url=$(decode "$3")
  if [ "$oauth" = 1 ]; then
    [ $# -ge 7 ] || fail 'mail-transport.sh: imap-id-oauth needs a root url, a url, a username, a bearer token, a preamble and a command'
    username=$(decode "$4")
    bearer=$(decode "$5")
    shift 5
  else
    credentials=$(decode "$4")
    shift 4
  fi
  case "$root_url" in
    imaps://*|imap://*) ;;
    *) fail 'mail-transport.sh: refusing a root URL that is not imap(s)' ;;
  esac
  escaped_root_url=$(escape "$root_url")
else
  url=$(decode "$2")
  if [ "$oauth" = 1 ]; then
    username=$(decode "$3")
    bearer=$(decode "$4")
    shift 4
  else
    credentials=$(decode "$3")
    shift 3
  fi
fi

case "$mode" in
  imap|imap-id|imap-append|smtp|imap-oauth|imap-id-oauth|imap-append-oauth|smtp-oauth|graph-send) ;;
  *) fail 'mail-transport.sh: unsupported mode' ;;
esac

# The URL is built and validated by Imap.js, which has already refused anything
# carrying userinfo, a port inside the host, or characters that could end the
# path. This is the second gate rather than the first: the scheme check is what
# stops a hand-edited accounts.json from pointing an authenticated client at
# file:// or at an ordinary web server.
case "$url" in
  # Graph has one address, fixed here rather than taken from the caller, so
  # a hand-edited accounts.json cannot point a bearer token at another host.
  https://graph.microsoft.com/v1.0/me/sendMail) [ "$mode" = "graph-send" ] || fail 'mail-transport.sh: refusing a URL that is not imap(s) or smtp(s)' ;;
  imaps://*|imap://*|smtps://*|smtp://*) [ "$mode" != "graph-send" ] || fail 'mail-transport.sh: graph-send goes to Graph alone' ;;
  *) fail 'mail-transport.sh: refusing a URL that is not imap(s) or smtp(s)' ;;
esac

escaped_url=$(escape "$url")
if [ "$oauth" = 1 ]; then
  escaped_username=$(escape "$username")
  escaped_bearer=$(escape "$bearer")
else
  escaped_credentials=$(escape "$credentials")
fi

umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail.XXXXXX") || fail 'mail-transport.sh: no temporary directory'
trap 'rm -rf "$work"' EXIT INT TERM HUP

case "$mode" in smtp|smtp-oauth) sending=1 ;; *) sending=0 ;; esac
case "$mode" in imap-append|imap-append-oauth) appending=1 ;; *) appending=0 ;; esac

# The config is written to curl's own stdin rather than to a file: it carries
# the password, and a file holding one would be on disk for as long as curl
# took to read it. `build_config` prints it; the pipeline below is what feeds
# it in without it ever being written down.
build_config() {
if [ "$mode" = "graph-send" ]; then
  printf 'url = "%s"\n' "$escaped_url"
  printf 'noproxy = "*"\n'
  printf 'request = "POST"\n'
  printf 'header = "%s"\n' "$(escape "Authorization: Bearer $graph_token")"
  printf 'header = "Content-Type: text/plain"\n'
  printf 'max-time = 60\n'
  printf 'connect-timeout = 20\n'
  printf 'data-binary = "@%s"\n' "$(escape "$work/message")"
elif [ "$sending" = 1 ]; then
  [ $# -ge 3 ] || fail 'mail-transport.sh: smtp needs a sender, a message and a recipient'
  sender=$(decode "$1")
  shift 2

  printf 'url = "%s"\n' "$escaped_url"
  printf 'noproxy = "*"\n'
  print_authentication
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
elif [ "$appending" = 1 ]; then
  printf 'url = "%s"\n' "$escaped_url"
  printf 'noproxy = "*"\n'
  print_authentication
  printf 'max-time = 60\n'
  printf 'connect-timeout = 20\n'
  case "$url" in
    imap://127.0.0.1:*|imap://localhost:*) ;;
    imap://*) printf 'ssl-reqd\n' ;;
  esac
  printf 'upload-file = "%s"\n' "$(escape "$work/message")"
  # Which flags the copy arrives under is the caller's decision — `Imap.js`
  # spells them in curl's dialect, one word per flag — because a draft and a
  # sent copy want different ones and this script is not the place a message
  # becomes either.
  printf 'upload-flags = "%s"\n' "$(escape "$(decode "$2")")"
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
    # globoff is per-transfer too: next would otherwise expand later URLs.
    printf 'globoff\n'
    # In imap-id the opening command runs against the server rather than a
    # mailbox, so that it lands in front of the SELECT curl derives from the
    # path. Every later section names the mailbox as usual.
    if [ "$identified" = 1 ] && [ "$first" = "1" ]; then
      printf 'url = "%s"\n' "$escaped_root_url"
      # The opening command's own reply is of no interest, and leaving it on
      # stdout would be worse than useless: the test below reads a non-empty
      # stdout as "the answer is here", and a single-UID BODY FETCH is the one
      # request whose answer really does arrive there. One stray line from this
      # section is enough to make a message body look like an empty one.
      # `output` is per-section, so only this reply is discarded.
      printf 'output = "%s"\n' "/dev/null"
    else
      printf 'url = "%s"\n' "$escaped_url"
    fi
    first=0
    # Desktop HTTP/SOCKS proxy settings are for web traffic. In particular,
    # Omarchy's local SOCKS proxy accepts the IMAPS socket and then drops its
    # TLS handshake, which curl reports as error 35. Direct mail transport also
    # keeps account credentials from being offered through an unrelated proxy.
    # Repeated because `next` resets this curl option with the rest.
    printf 'noproxy = "*"\n'
    print_authentication
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

print_authentication() {
  if [ "$oauth" = 1 ]; then
    printf 'user = "%s"\n' "$escaped_username"
    printf 'oauth2-bearer = "%s"\n' "$escaped_bearer"
  else
    printf 'user = "%s"\n' "$escaped_credentials"
  fi
}

# The SMTP body has to be on disk before curl starts, because the config it is
# named in is what stdin is carrying.
if [ "$mode" = "graph-send" ]; then
  [ $# -eq 1 ] || fail 'mail-transport.sh: graph-send needs a url, a token and a message'
  # The token arrived in the credentials field, like a password would.
  graph_token=$credentials
  # Graph takes the MIME base64-encoded, as the body of a text/plain POST.
  decode "$1" | base64 | tr -d '\n' > "$work/message"
elif [ "$sending" = 1 ]; then
  [ $# -ge 3 ] || fail 'mail-transport.sh: smtp needs a sender, a message and a recipient'
  decode "$2" > "$work/message"
elif [ "$appending" = 1 ]; then
  [ $# -eq 2 ] || fail 'mail-transport.sh: imap-append needs one message and its flags'
  decode "$1" > "$work/message"
fi

# curl is the last stage, so `$?` is curl's own exit code rather than the
# config builder's.
attempt_curl() {
  build_config "$@" | curl -q --globoff \
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

# Graph answers with a status, not with a curl error: 202 is sent, anything
# else is the body's own explanation, and no status line at all is a failure.
if [ "$mode" = "graph-send" ] && [ "$status" -eq 0 ]; then
  http=$(sed -n 's/^HTTP\/[0-9.]* \([0-9]*\).*/\1/p' "$work/headers" 2>/dev/null | tail -1)
  case "$http" in
    2[0-9][0-9]) ;;
    "") status=22; printf 'Graph gave no HTTP status' > "$work/err" ;;
    *) status=22; printf 'Graph answered %s: %s' "$http" "$(tr -d '\r' < "$work/out" | head -c 400)" > "$work/err" ;;
  esac
fi

printf '%s\n' "$status"
if { [ "$mode" = "imap" ] || [ "$mode" = "imap-id" ] \
  || [ "$mode" = "imap-oauth" ] || [ "$mode" = "imap-id-oauth" ]; } \
  && [ ! -s "$work/out" ] && [ -s "$work/headers" ]; then
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
