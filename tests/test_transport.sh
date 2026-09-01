#!/bin/sh
# What mail-transport.sh would actually hand to curl.
#
# curl is replaced by a stub that prints the config it was given, so these
# assert on the exact bytes that would have reached the server — which is the
# only way to check the escaping of a password without having a server to try
# it against.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/scripts/mail-transport.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-transport-test.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM HUP

mkdir -p "$work/bin"
cat > "$work/bin/curl" <<'STUB'
#!/bin/sh
[ -z "${CURL_STUB_COUNT:-}" ] || printf 'x\n' >> "$CURL_STUB_COUNT"
header_file=
saw_fail_early=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dump-header)
      header_file=$2
      shift 2
      ;;
    --fail-early)
      saw_fail_early=1
      shift
      ;;
    *)
      shift
      ;;
  esac
done
if [ "${CURL_STUB_REQUIRE_FAIL_EARLY:-0}" = "1" ] && [ "$saw_fail_early" != "1" ]; then
  cat >/dev/null
  exit 99
fi
if [ -n "${CURL_STUB_STDOUT:-}" ]; then
  cat >/dev/null
  printf '%s' "$CURL_STUB_STDOUT"
elif [ -n "${CURL_STUB_HEADER:-}" ] && [ -n "$header_file" ]; then
  printf '%s' "$CURL_STUB_HEADER" > "$header_file"
  cat >/dev/null
  printf '%s' "${CURL_STUB_BODY:-}"
else
  cat
fi
exit "${CURL_STUB_EXIT:-0}"
STUB
chmod +x "$work/bin/curl"

failures=0

b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

# The script answers with three lines: the exit code, base64 stdout, base64
# stderr. The stub echoes the config, so decoding line 2 is the config.
config_for() {
  printf '%s\n' "$1" | PATH="$work/bin:$PATH" sh "$script" | sed -n '2p' | base64 -d
}

check() {
  description=$1
  haystack=$2
  needle=$3
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf '  ok   %s\n' "$description"
  else
    printf '  FAIL %s\n' "$description"
    printf '       expected to find: %s\n' "$needle"
    printf '       in:\n%s\n' "$haystack"
    failures=$(( failures + 1 ))
  fi
}

check_absent() {
  description=$1
  haystack=$2
  needle=$3
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf '  FAIL %s\n' "$description"
    printf '       did not expect: %s\n' "$needle"
    failures=$(( failures + 1 ))
  else
    printf '  ok   %s\n' "$description"
  fi
}

printf 'mail-transport.sh\n'

# ---------------------------------------------------------------- IMAP mode

request="imap $(b64 'imaps://imap.example.org:993/INBOX') $(b64 'jane@example.org:hunter2') $(b64 'UID SEARCH UNSEEN')"
config=$(config_for "$request")
check "the URL reaches curl" "$config" 'url = "imaps://imap.example.org:993/INBOX"'
check "the credentials reach curl" "$config" 'user = "jane@example.org:hunter2"'
check "the command reaches curl" "$config" 'request = "UID SEARCH UNSEEN"'
check "mail transport bypasses desktop HTTP/SOCKS proxies" "$config" 'noproxy = "*"'

# libcurl puts a custom multi-UID FETCH in its protocol-header callback rather
# than stdout. The transport returns that channel when present, or the client
# sees a successful request with an empty message list.
header_reply='* 1 FETCH (UID 7 FLAGS ())'
out=$(printf '%s\n' "$request" \
  | CURL_STUB_HEADER="$header_reply" \
    PATH="$work/bin:$PATH" sh "$script")
decoded=$(printf '%s\n' "$out" | sed -n '2p' | base64 -d)
if [ "$decoded" = "$header_reply" ]; then
  printf '  ok   IMAP protocol headers are returned when curl puts FETCH there\n'
else
  printf '  FAIL IMAP protocol headers did not replace curl stdout\n'
  failures=$(( failures + 1 ))
fi

# A single BODY FETCH is recognised by libcurl: its complete RFC822 resource
# is stdout while the protocol-header callback holds only a partial preamble.
body_reply='* 1 FETCH (UID 7 BODY[] {4}
mail'
out=$(printf '%s\n' "$request" \
  | CURL_STUB_HEADER='partial protocol preamble' CURL_STUB_BODY="$body_reply" \
    PATH="$work/bin:$PATH" sh "$script")
decoded=$(printf '%s\n' "$out" | sed -n '2p' | base64 -d)
if [ "$decoded" = "$body_reply" ]; then
  printf '  ok   IMAP stdout wins when curl returns a complete BODY FETCH there\n'
else
  printf '  FAIL IMAP stdout did not replace the partial protocol header\n'
  failures=$(( failures + 1 ))
fi

# Several commands share one connection, which is what makes a list load one
# TLS handshake rather than one per message.
multi="imap $(b64 'imaps://imap.example.org:993/INBOX') $(b64 'jane:pw') $(b64 'UID SEARCH UNSEEN') $(b64 'UID FETCH 1,2 (FLAGS)')"
config=$(config_for "$multi")
check "a second command is a --next section" "$config" 'next'
check "the second command is there" "$config" 'request = "UID FETCH 1,2 (FLAGS)"'
sections=$(printf '%s' "$config" | grep -c '^url = ' || true)
if [ "$sections" = "2" ]; then
  printf '  ok   each section repeats the URL, because --next resets it\n'
else
  printf '  FAIL expected 2 url lines, found %s\n' "$sections"
  failures=$(( failures + 1 ))
fi
max_times=$(printf '%s' "$config" | grep -c '^max-time = 60$' || true)
connect_timeouts=$(printf '%s' "$config" | grep -c '^connect-timeout = 20$' || true)
if [ "$max_times" = "$sections" ] && [ "$connect_timeouts" = "$sections" ]; then
  printf '  ok   every command section has its own deadlines\n'
else
  printf '  FAIL expected deadlines in all %s sections, found max-time=%s connect-timeout=%s\n' \
    "$sections" "$max_times" "$connect_timeouts"
  failures=$(( failures + 1 ))
fi

# curl otherwise reports only the final transfer's status after --next. A
# failed earlier SEARCH window must stop the run instead of returning a short,
# apparently successful result assembled from the remaining windows.
partial_reply='* SEARCH 1 2 3'
out=$(printf '%s\n' "$multi" \
  | CURL_STUB_REQUIRE_FAIL_EARLY=1 CURL_STUB_STDOUT="$partial_reply" CURL_STUB_EXIT=21 \
    PATH="$work/bin:$PATH" sh "$script")
first=$(printf '%s\n' "$out" | sed -n '1p')
decoded=$(printf '%s\n' "$out" | sed -n '2p' | base64 -d)
if [ "$first" = "21" ] && [ "$decoded" = "$partial_reply" ]; then
  printf '  ok   an earlier failed section cannot be hidden by a later success\n'
else
  printf '  FAIL expected fail-early status 21 with the partial SEARCH response\n'
  failures=$(( failures + 1 ))
fi

# --------------------------------------------------------------- escaping
#
# The reason the fields cross as base64 and the config is escaped on the way
# out. A password is whatever the user's provider let them choose.

awkward='he said "hi" \ and left'
config=$(config_for "imap $(b64 'imaps://imap.example.org:993/INBOX') $(b64 "jane:$awkward") $(b64 'NOOP')")
check "a quote in a password is escaped for curl's config parser" "$config" 'he said \"hi\"'
check "a backslash is escaped too" "$config" '\\ and left'
check_absent "the raw unescaped quote does not survive" "$config" 'said "hi" \ and'

# A folder with a space in it is the everyday case — Sent Items, All Mail.
config=$(config_for "imap $(b64 'imaps://imap.example.org:993/INBOX') $(b64 'jane:pw') $(b64 'UID COPY 4 "Sent Items"')")
check "a quoted folder name survives into the command" "$config" 'UID COPY 4 \"Sent Items\"'

# ------------------------------------------------------------ scheme guard
#
# The second gate. Imap.js validated the host; this is what stops a
# hand-edited accounts.json from aiming an authenticated client somewhere else.

for bad in 'file:///etc/passwd' 'https://evil.example.com/' 'ftp://example.com/'; do
  if printf '%s\n' "imap $(b64 "$bad") $(b64 'jane:pw') $(b64 'NOOP')" \
    | PATH="$work/bin:$PATH" sh "$script" >/dev/null 2>&1; then
    printf '  FAIL %s was accepted\n' "$bad"
    failures=$(( failures + 1 ))
  else
    printf '  ok   %s is refused\n' "$bad"
  fi
done

for good in 'imaps://a.example.org/INBOX' 'imap://127.0.0.1:1143/INBOX' 'smtps://a.example.org'; do
  if printf '%s\n' "imap $(b64 "$good") $(b64 'jane:pw') $(b64 'NOOP')" \
    | PATH="$work/bin:$PATH" sh "$script" >/dev/null 2>&1; then
    printf '  ok   %s is accepted\n' "$good"
  else
    printf '  FAIL %s was refused\n' "$good"
    failures=$(( failures + 1 ))
  fi
done

# ---------------------------------------------------------------- SMTP mode

send="smtp $(b64 'smtps://smtp.example.org:465') $(b64 'jane:pw') $(b64 'jane@example.org') $(b64 'Subject: hi

body') $(b64 'friend@example.com') $(b64 'other@example.com')"
config=$(config_for "$send")
check "the sender is set" "$config" 'mail-from = "jane@example.org"'
check "the first recipient is set" "$config" 'mail-rcpt = "friend@example.com"'
check "every recipient is set" "$config" 'mail-rcpt = "other@example.com"'
check "the body is uploaded from a file, not passed as an argument" "$config" 'upload-file = "'
check_absent "SMTP does not emit --next sections" "$config" 'next'
check "SMTP keeps its transfer deadline" "$config" 'max-time = 60'
check "SMTP keeps its connection deadline" "$config" 'connect-timeout = 20'

# --------------------------------------------------------- IMAP draft upload

append="imap-append $(b64 'imaps://imap.example.org:993/Drafts') $(b64 'jane:pw') $(b64 'Subject: saved draft

body')"
config=$(config_for "$append")
check "a draft is appended to its resolved mailbox" "$config" 'url = "imaps://imap.example.org:993/Drafts"'
check "a draft upload uses the RFC 5322 message file" "$config" 'upload-file = "'
check "an IMAP upload carries the draft flag" "$config" 'upload-flags = "draft"'
check_absent "an IMAP draft is not sent as a custom request" "$config" 'request = '

# ------------------------------------------------------------- the framing

# The exit code is curl's own, so a transport failure is distinguishable from
# a server that answered with NO.
out=$(printf '%s\n' "imap $(b64 'imaps://a.example.org/INBOX') $(b64 'j:p') $(b64 'NOOP')" \
  | CURL_STUB_EXIT=7 PATH="$work/bin:$PATH" sh "$script")
first=$(printf '%s' "$out" | sed -n '1p')
if [ "$first" = "7" ]; then
  printf "  ok   curl's exit code is the first line\n"
else
  printf '  FAIL expected exit code 7 on line 1, got "%s"\n' "$first"
  failures=$(( failures + 1 ))
fi

lines=$(printf '%s\n' "imap $(b64 'imaps://a.example.org/INBOX') $(b64 'j:p') $(b64 'NOOP')" \
  | PATH="$work/bin:$PATH" sh "$script" | wc -l | tr -d ' ')
if [ "$lines" = "3" ]; then
  printf '  ok   three lines out: code, stdout, stderr\n'
else
  printf '  FAIL expected 3 lines of output, got %s\n' "$lines"
  failures=$(( failures + 1 ))
fi

# ------------------------------------------------------------- retrying

# Retrying is safe only before anything has been sent. curl's own --retry-all-
# errors cannot tell a handshake that never opened a session from a transfer
# the server already took, so an SMTP send it retried would deliver the message
# twice. The retry is the script's own, on the pre-transfer exit codes.
attempts_for() {
  count="$work/attempts"
  rm -f "$count"
  printf '%s\n' "$1" \
    | CURL_STUB_COUNT="$count" CURL_STUB_EXIT="$2" PATH="$work/bin:$PATH" sh "$script" \
      >/dev/null 2>&1
  if [ -f "$count" ]; then wc -l < "$count" | tr -d ' '; else printf '0'; fi
}

send_request="smtp $(b64 'smtp://smtp.example.org:587') $(b64 'j:p') $(b64 'j@example.org') $(b64 'Subject: x

body') $(b64 'her@example.org')"
read_request="imap $(b64 'imaps://a.example.org/INBOX') $(b64 'j:p') $(b64 'NOOP')"

expect_attempts() {
  got=$(attempts_for "$2" "$3")
  if [ "$got" = "$4" ]; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s: expected %s attempt(s), got %s\n' "$1" "$4" "$got"
    failures=$(( failures + 1 ))
  fi
}

expect_attempts "a dropped TLS handshake is tried again" "$read_request" 35 3
expect_attempts "a name that does not resolve is tried again" "$read_request" 6 3
expect_attempts "a rejected password is not tried again" "$read_request" 67 1
# The one that matters: 56 is a receive error, which happens after the message
# has been handed over. Sending it a second time is a second copy delivered.
expect_attempts "a send that failed mid-transfer is not repeated" "$send_request" 56 1
expect_attempts "a send that timed out is not repeated" "$send_request" 28 1
expect_attempts "a send is still retried before it has left" "$send_request" 7 3

# A malformed request must fail rather than run curl with something guessed.
if printf 'not-base64-at-all\n' | PATH="$work/bin:$PATH" sh "$script" >/dev/null 2>&1; then
  printf '  FAIL a malformed request was accepted\n'
  failures=$(( failures + 1 ))
else
  printf '  ok   a malformed request is refused\n'
fi

if [ "$failures" -ne 0 ]; then
  printf '\n%s check(s) failed\n' "$failures"
  exit 1
fi
printf 'mail-transport.sh ok\n'
