#!/bin/sh
# What jmap-transport.sh would actually hand to curl.
#
# curl is replaced by a stub that reads the config it was given and hands it
# back as the response body, so these assert on the exact bytes that would have
# reached the server — which is the only way to check that a secret crosses on
# stdin, that a download has its ceiling, and that nothing follows a redirect,
# without having a JMAP server to try it against.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/scripts/jmap-transport.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-jmap-transport-test.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM HUP

mkdir -p "$work/bin"
# A small, faithful curl. It reads the config from stdin, writes the "body"
# wherever `output` names it — or to stdout when nothing does, which is the
# stream — and renders `write-out` to stdout once the transfer has ended, which
# is where the four-line reply's status and the stream's trailer both come
# from. The body it writes is the config itself, so line 3 of the reply is what
# curl was told to do.
cat > "$work/bin/curl" <<'STUB'
#!/bin/sh
set -eu
[ -z "${CURL_STUB_ARGV:-}" ] || printf '%s\n' "$*" > "$CURL_STUB_ARGV"
[ -z "${CURL_STUB_COUNT:-}" ] || printf 'x\n' >> "$CURL_STUB_COUNT"

config=$(cat)

exit_code=${CURL_STUB_EXIT:-0}
# "fails twice, then succeeds": the stub reads the same invocation count the
# test asserts on, so the retry can be watched rather than inferred.
if [ -n "${CURL_STUB_FAIL_TIMES:-}" ] && [ -n "${CURL_STUB_COUNT:-}" ]; then
  attempts=$(wc -l < "$CURL_STUB_COUNT" | tr -d ' ')
  [ "$attempts" -le "$CURL_STUB_FAIL_TIMES" ] || exit_code=0
fi

output=$(printf '%s\n' "$config" | sed -n 's/^output = "\(.*\)"$/\1/p' | tail -n 1)
if [ -n "$output" ]; then
  printf '%s\n' "$config" > "$output"
else
  printf '%s\n' "$config"
fi

writeout=$(printf '%s\n' "$config" | sed -n 's/^write-out = "\(.*\)"$/\1/p' | tail -n 1)
if [ -n "$writeout" ]; then
  rendered=$(printf '%s' "$writeout" \
    | sed -e "s/%{http_code}/${CURL_STUB_STATUS:-200}/g" \
          -e "s|%{redirect_url}|${CURL_STUB_REDIRECT:-}|g")
  case "$rendered" in
    # curl's config format spells a newline `\n`; the two characters are
    # dropped and a real one printed in their place.
    *'\n') printf '%s\n' "${rendered%??}" ;;
    *) printf '%s' "$rendered" ;;
  esac
fi
exit "$exit_code"
STUB
chmod +x "$work/bin/curl"

failures=0

b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

run() {
  printf '%s\n' "$1" | PATH="$work/bin:$PATH" sh "$script"
}

# The four request verbs answer in four lines: exit, status, base64 body,
# base64 stderr. The stub returns the config as the body, so decoding line 3 is
# the config.
config_for() {
  run "$1" | sed -n '3p' | base64 -d
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

# grep -F reads an embedded newline as a pattern separator, so "not this whole
# line" is asked for as a line-exact match rather than as a needle with a
# newline in front of it.
check_absent_line() {
  description=$1
  haystack=$2
  needle=$3
  if printf '%s\n' "$haystack" | grep -qxF -- "$needle"; then
    printf '  FAIL %s\n' "$description"
    printf '       did not expect the line: %s\n' "$needle"
    failures=$(( failures + 1 ))
  else
    printf '  ok   %s\n' "$description"
  fi
}

equals() {
  description=$1
  actual=$2
  expected=$3
  if [ "$actual" = "$expected" ]; then
    printf '  ok   %s\n' "$description"
  else
    printf '  FAIL %s: expected "%s", got "%s"\n' "$description" "$expected" "$actual"
    failures=$(( failures + 1 ))
  fi
}

printf 'jmap-transport.sh\n'

SESSION_URL='https://mail.example.org/jmap/session'
API_URL='https://api.example.org/jmap'
SECRET='hunter2 "quoted" \ slashed'

# -------------------------------------------------------------- session, basic

request="session $(b64 "$SESSION_URL") $(b64 basic) $(b64 'jane@example.org') $(b64 "$SECRET")"
config=$(config_for "$request")
check "the session URL reaches curl" "$config" "url = \"$SESSION_URL\""
check "basic builds user from the username and the secret" "$config" \
  'user = "jane@example.org:hunter2 \"quoted\" \\ slashed"'
check "a session GET asks for JSON" "$config" 'header = "Accept: application/json"'
check "the session connect deadline" "$config" 'connect-timeout = 20'
check "the session transfer deadline" "$config" 'max-time = 60'
check "a session reply has the 20 MB ceiling every read answer has" "$config" 'max-filesize = 20971520'
check "JMAP bypasses desktop HTTP/SOCKS proxies" "$config" 'noproxy = "*"'
check "the first request is bounded to https" "$config" 'proto = "=https"'
check "a redirect could not leave https either" "$config" 'proto-redir = "=https"'
check "nothing is followed" "$config" 'max-redirs = 0'
check_absent "curl is never told to follow a redirect" "$config" 'location'
check_absent_line "no --fail on a request verb: a problem body has to survive" "$config" 'fail'
check "the status and the redirect URL are asked for" "$config" \
  'write-out = "%{http_code} %{redirect_url}"'

# The secret reaches curl on stdin, which is what keeps it out of the process
# table. The stub records its own argv, and the whole of it is the config on
# stdin, with `-q` so no user config is read and `--globoff` so no URL is
# expanded.
argv="$work/argv"
CURL_STUB_ARGV="$argv" run "$request" >/dev/null
equals "curl is invoked with a config on stdin and nothing else — no user config, no URL globbing" "$(cat "$argv")" '-q --globoff --config -'
check_absent "the secret is not on curl's command line" "$(cat "$argv")" 'hunter2'

# ------------------------------------------------------------- session, bearer

config=$(config_for "session $(b64 "$SESSION_URL") $(b64 bearer) $(b64 'jane@example.org') $(b64 'tok-123')")
check "bearer builds the Authorization header itself" "$config" \
  'header = "Authorization: Bearer tok-123"'
check_absent "bearer does not also send a Basic credential" "$config" 'user = '

# --------------------------------------------------------------- session, none
#
# Discovery's well-known GET is on a URL the user did not type, so it carries
# no credential at all. The empty username and secret cross as `-`, because
# base64 of the empty string is the empty string and a space-separated line
# cannot carry one.

config=$(config_for "session $(b64 'https://example.org/.well-known/jmap') $(b64 none) - -")
check "an unauthenticated GET still reaches curl" "$config" \
  'url = "https://example.org/.well-known/jmap"'
check_absent "the none scheme sends no Authorization header" "$config" 'Authorization'
check_absent "the none scheme sends no Basic credential" "$config" 'user = '

# ------------------------------------------------------------------------ call

json='{"using":["urn:ietf:params:jmap:core"],"methodCalls":[["Email/get",{"ids":["a"]},"c0"]]}'
config=$(config_for "call $(b64 "$API_URL") $(b64 basic) $(b64 jane) $(b64 pw) $(b64 "$json")")
check "a call is a POST" "$config" 'request = "POST"'
check "a call declares the JMAP content type" "$config" \
  'header = "Content-Type: application/json; charset=utf-8"'
escaped_json=$(printf '%s' "$json" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
check "the request document reaches curl intact, escaped for its config" "$config" \
  "data-binary = \"$escaped_json\""
check "the call connect deadline" "$config" 'connect-timeout = 20'
check "the call transfer deadline" "$config" 'max-time = 60'
check "a method reply has the same ceiling" "$config" 'max-filesize = 20971520'

# -------------------------------------------------------------------- download

config=$(config_for "download $(b64 "$API_URL/download/t/blob/name") $(b64 basic) $(b64 jane) $(b64 pw)")
check "a blob download has the 20 MB ceiling" "$config" 'max-filesize = 20971520'
check "a download keeps its connect deadline" "$config" 'connect-timeout = 20'
check "a stalled download is given up on" "$config" 'speed-limit = 1024'
check "a stalled download is given up on after 30 s" "$config" 'speed-time = 30'
check "a download gets the long transfer deadline" "$config" 'max-time = 600'
check_absent "a download is not a POST" "$config" 'request = "POST"'

# ---------------------------------------------------------------------- upload

raw='Subject: hi

body'
config=$(config_for "upload $(b64 "$API_URL/upload/t/") $(b64 basic) $(b64 jane) $(b64 pw) $(b64 "$raw")")
check "an upload is a POST rather than the PUT upload-file implies" "$config" 'request = "POST"'
check "an upload declares the raw message content type" "$config" \
  'header = "Content-Type: message/rfc822"'
check "the message is uploaded from a file, not passed as an argument" "$config" 'upload-file = "'
check_absent "the message body is not inlined into the config" "$config" 'Subject: hi'
check "an upload gets the long transfer deadline" "$config" 'max-time = 600'
check "an upload's answer has the same ceiling" "$config" 'max-filesize = 20971520'

# ---------------------------------------------------------------------- stream
#
# The stream answers in raw lines rather than the four-line reply, so its
# output is curl's own — here the config, then the trailer curl prints once the
# transfer has ended.

stream_request="stream $(b64 "$API_URL/eventsource") $(b64 basic) $(b64 jane) $(b64 pw)"
out=$(run "$stream_request")
check "the stream asks for an event stream" "$out" 'header = "Accept: text/event-stream"'
check "the stream is unbuffered, or a line arrives when the next one does" "$out" 'no-buffer'
check "the stream fails on a rejected credential rather than reading a body" "$out" 'fail'
check "an idle stream is kept alive" "$out" 'keepalive-time = 60'
check "the stream rotates rather than living forever" "$out" 'max-time = 3600'
check "the stream asks for the status as a trailer" "$out" 'write-out = "http %{http_code}\n"'
check_absent "the stream follows nothing either" "$out" 'location'
check_absent "the stream is not base64: it is read line by line" "$out" 'output = '
check_absent "the stream is bounded by its rotation, not by a size" "$out" 'max-filesize'
equals "the stream ends with the http trailer" "$(printf '%s\n' "$out" | tail -n 1)" 'http 200'

# The trailer is what splits a --fail exit 22 into a rejected credential and a
# connection that failed.
out=$(printf '%s\n' "$stream_request" \
  | CURL_STUB_STATUS=401 CURL_STUB_EXIT=22 PATH="$work/bin:$PATH" sh "$script" || true)
equals "a refused stream reports its status in the trailer" \
  "$(printf '%s\n' "$out" | tail -n 1)" 'http 401'
set +e
printf '%s\n' "$stream_request" \
  | CURL_STUB_STATUS=401 CURL_STUB_EXIT=22 PATH="$work/bin:$PATH" sh "$script" >/dev/null 2>&1
stream_status=$?
set -e
equals "the stream exits with curl's own code" "$stream_status" 22

# Stopping the stream stops curl.
#
# The owner stops a stream by stopping the process it started, which is this
# shell — and a pipeline puts curl on the far side of a pipe from it. Without
# the trap the shell dies, curl is reparented to init and holds an
# authenticated connection open until its own `max-time` an hour later. This is
# the assertion that the signal actually crosses the pipe: a curl that ignores
# it and lives is the bug.
cat > "$work/bin/curl-slow" <<'SLOW'
#!/bin/sh
cat >/dev/null
printf '%s\n' "$$" > "$CURL_STUB_PIDFILE"
sleep 30
SLOW
chmod +x "$work/bin/curl-slow"
mkdir -p "$work/slow"
cp "$work/bin/curl-slow" "$work/slow/curl"

pidfile="$work/curl.pid"
rm -f "$pidfile"
printf '%s\n' "$stream_request" \
  | CURL_STUB_PIDFILE="$pidfile" PATH="$work/slow:$PATH" sh "$script" >/dev/null 2>&1 &
script_pid=$!
waited=0
while [ ! -s "$pidfile" ] && [ "$waited" -lt 50 ]; do
  sleep 0.1
  waited=$((waited + 1))
done
curl_pid=$(cat "$pidfile" 2>/dev/null || printf '')
kill -TERM "$script_pid" 2>/dev/null || true
wait "$script_pid" 2>/dev/null || true
sleep 0.3
if [ -n "$curl_pid" ] && kill -0 "$curl_pid" 2>/dev/null; then
  kill -KILL "$curl_pid" 2>/dev/null || true
  printf '  FAIL %s\n' "stopping the stream leaves curl running"
  failures=$((failures + 1))
else
  printf '  ok   %s\n' "stopping the stream takes curl down with it"
fi

# Stopping a request stops curl, for every verb and not only the stream.
#
# The client cancels a request by stopping this shell. With curl in the
# foreground of the pipeline the shell's TERM trap waited for curl to finish,
# which for a download or an upload was `max-time` — ten minutes — and an
# aborted upload held its slot in the client's queue for as long as the curl it
# had abandoned kept running. The four request verbs take the same background
# and trap shape as the stream, and this is the assertion for each of them.
for verb in session call download upload; do
  case "$verb" in
    call) stop_request="call $(b64 "$API_URL") $(b64 basic) $(b64 jane) $(b64 pw) $(b64 "$json")" ;;
    upload) stop_request="upload $(b64 "$API_URL/upload/t/") $(b64 basic) $(b64 jane) $(b64 pw) $(b64 "$raw")" ;;
    *) stop_request="$verb $(b64 "$SESSION_URL") $(b64 basic) $(b64 jane) $(b64 pw)" ;;
  esac
  rm -f "$pidfile"
  started=$(date +%s)
  printf '%s\n' "$stop_request" \
    | CURL_STUB_PIDFILE="$pidfile" PATH="$work/slow:$PATH" sh "$script" >/dev/null 2>&1 &
  script_pid=$!
  waited=0
  while [ ! -s "$pidfile" ] && [ "$waited" -lt 50 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
  curl_pid=$(cat "$pidfile" 2>/dev/null || printf '')
  kill -TERM "$script_pid" 2>/dev/null || true
  wait "$script_pid" 2>/dev/null || true
  sleep 0.3
  ended=$(date +%s)
  if [ -n "$curl_pid" ] && kill -0 "$curl_pid" 2>/dev/null; then
    kill -KILL "$curl_pid" 2>/dev/null || true
    printf '  FAIL %s\n' "stopping a $verb leaves curl running"
    failures=$((failures + 1))
  elif [ $((ended - started)) -ge 5 ]; then
    printf '  FAIL %s\n' "stopping a $verb waited for curl instead of stopping it"
    failures=$((failures + 1))
  else
    printf '  ok   %s\n' "stopping a $verb takes curl down with it"
  fi
done

# ----------------------------------------------------------------- scheme gate
#
# The second gate. The client validated the URL; this is what stops a
# hand-edited accounts.json from sending an account password somewhere else.

refuses() {
  set +e
  printf '%s\n' "$2" | PATH="$work/bin:$PATH" sh "$script" >/dev/null 2>&1
  code=$?
  set -e
  if [ "$code" = "2" ]; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s: expected exit 2, got %s\n' "$1" "$code"
    failures=$(( failures + 1 ))
  fi
}

for bad in 'http://mail.example.org/jmap' 'file:///etc/passwd' 'ftp://example.com/'; do
  refuses "$bad is refused with exit 2" \
    "session $(b64 "$bad") $(b64 basic) $(b64 jane) $(b64 pw)"
done

refuses "an unknown auth scheme is refused before curl runs" \
  "session $(b64 "$SESSION_URL") $(b64 digest) $(b64 jane) $(b64 pw)"
refuses "an unknown verb is refused" \
  "delete $(b64 "$SESSION_URL") $(b64 basic) $(b64 jane) $(b64 pw)"
refuses "a call without its body is refused" \
  "call $(b64 "$API_URL") $(b64 basic) $(b64 jane) $(b64 pw)"
refuses "a malformed request is refused rather than guessed at" 'not-base64-at-all'
refuses "a URL that spans lines is refused" \
  "session $(b64 'https://mail.example.org/jmap
noproxy = ""') $(b64 basic) $(b64 jane) $(b64 pw)"
refuses "a secret carrying a tab is refused: a control character is a config line ending" \
  "session $(b64 "$SESSION_URL") $(b64 basic) $(b64 jane) $(b64 "$(printf 'pw\tnext')")"
refuses "a call body that spans lines is refused" \
  "call $(b64 "$API_URL") $(b64 basic) $(b64 jane) $(b64 pw) $(b64 '{"a":1}
url = "https://elsewhere"')"
refuses "a field that is not canonical base64 is refused" \
  "session $(b64 "$SESSION_URL") $(b64 basic) $(b64 jane) c2Vlbh=="

# ------------------------------------------------------------------ the framing

# Counted straight out of the script: a command substitution strips the
# trailing newline, and the fourth line is empty whenever curl said nothing on
# stderr.
lines=$(printf '%s\n' "$request" \
  | CURL_STUB_STATUS=301 CURL_STUB_REDIRECT='https://elsewhere.example.org/jmap' \
    PATH="$work/bin:$PATH" sh "$script" | wc -l | tr -d ' ')
out=$(printf '%s\n' "$request" \
  | CURL_STUB_STATUS=301 CURL_STUB_REDIRECT='https://elsewhere.example.org/jmap' \
    PATH="$work/bin:$PATH" sh "$script")
equals "four lines out: exit, status, body, stderr" "$lines" 4
equals "curl's exit code is the first line" "$(printf '%s\n' "$out" | sed -n '1p')" 0
equals "the redirect URL follows the status on line two" \
  "$(printf '%s\n' "$out" | sed -n '2p')" '301 https://elsewhere.example.org/jmap'

# curl writes the body it received before giving up on the ceiling; the stub
# writes one too. Past the ceiling nobody reads it, and 28 MB of base64 is not
# something to hand the shell process for an error line.
out=$(printf '%s\n' "$request" | CURL_STUB_EXIT=63 PATH="$work/bin:$PATH" sh "$script")
equals "a reply past the ceiling reports curl's exit" "$(printf '%s\n' "$out" | sed -n '1p')" 63
equals "and carries no body, whatever curl wrote before it stopped" \
  "$(printf '%s\n' "$out" | sed -n '3p')" ""

out=$(printf '%s\n' "$request" | CURL_STUB_EXIT=28 PATH="$work/bin:$PATH" sh "$script")
equals "a timeout reports curl's exit rather than failing the script" \
  "$(printf '%s\n' "$out" | sed -n '1p')" 28
equals "a status with no redirect is the code alone" \
  "$(printf '%s\n' "$out" | sed -n '2p')" 200

# ------------------------------------------------------------- the work dir
#
# A SIGKILL runs no trap, so a request whose owner was destroyed while it ran
# leaves its directory behind with the reply or the message inside. The next
# request sweeps such directories an hour after they were last written, and
# only those: one written just now belongs to a request still running.

stale_home="$work/tmp"
mkdir -p "$stale_home/omamail-jmap.stale" "$stale_home/omamail-jmap.fresh" "$stale_home/omamail-other.stale"
touch -t 202001010000 "$stale_home/omamail-jmap.stale" "$stale_home/omamail-other.stale"
printf '%s\n' "$request" | TMPDIR="$stale_home" PATH="$work/bin:$PATH" sh "$script" >/dev/null
if [ -d "$stale_home/omamail-jmap.stale" ]; then
  printf '  FAIL %s\n' "a work directory left an hour ago is swept"
  failures=$((failures + 1))
else
  printf '  ok   %s\n' "a work directory left an hour ago is swept"
fi
if [ -d "$stale_home/omamail-jmap.fresh" ] && [ -d "$stale_home/omamail-other.stale" ]; then
  printf '  ok   %s\n' "a fresh one, and anything not ours, is left alone"
else
  printf '  FAIL %s\n' "a fresh one, and anything not ours, is left alone"
  failures=$((failures + 1))
fi
equals "the request's own directory is gone with the request" \
  "$(find "$stale_home" -maxdepth 1 -name 'omamail-jmap.*' | wc -l | tr -d ' ')" 1

# Under the runtime directory when there is one — the user's own, cleared when
# the session ends — and TMPDIR still wins when somebody set it.
mkdir -p "$work/run"
upload_request="upload $(b64 "$API_URL/upload/t/") $(b64 basic) $(b64 jane) $(b64 pw) $(b64 "$raw")"
config=$(printf '%s\n' "$upload_request" \
  | env -u TMPDIR XDG_RUNTIME_DIR="$work/run" PATH="$work/bin:$PATH" sh "$script" \
  | sed -n '3p' | base64 -d)
check "the work directory is under the runtime directory" "$config" "upload-file = \"$work/run/omamail-jmap."
config=$(printf '%s\n' "$upload_request" \
  | TMPDIR="$work/tmp" XDG_RUNTIME_DIR="$work/run" PATH="$work/bin:$PATH" sh "$script" \
  | sed -n '3p' | base64 -d)
check "unless TMPDIR says otherwise" "$config" "upload-file = \"$work/tmp/omamail-jmap."

# --------------------------------------------------------------------- retrying
#
# Retrying is safe only before anything has been sent: 6, 7 and 35 all mean the
# request never reached the server, so an Email/set cannot double-apply.

attempts_for() {
  count="$work/attempts"
  rm -f "$count"
  printf '%s\n' "$1" \
    | CURL_STUB_COUNT="$count" CURL_STUB_EXIT="$2" CURL_STUB_FAIL_TIMES="${3:-}" \
      PATH="$work/bin:$PATH" sh "$script" >/dev/null 2>&1
  if [ -f "$count" ]; then wc -l < "$count" | tr -d ' '; else printf '0'; fi
}

expect_attempts() {
  got=$(attempts_for "$2" "$3" "${5:-}")
  if [ "$got" = "$4" ]; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s: expected %s attempt(s), got %s\n' "$1" "$4" "$got"
    failures=$(( failures + 1 ))
  fi
}

expect_attempts "a name that does not resolve is tried again" "$request" 6 3
expect_attempts "a socket that never connected is tried again" "$request" 7 3
expect_attempts "a dropped TLS handshake is tried again" "$request" 35 3
expect_attempts "two failures then an answer stops after three" "$request" 35 3 2
expect_attempts "a rejected credential is not tried again" "$request" 22 1
expect_attempts "a timeout is not tried again: the server may have taken it" "$request" 28 1
call_request="call $(b64 "$API_URL") $(b64 basic) $(b64 jane) $(b64 pw) $(b64 "$json")"
expect_attempts "a call that failed mid-transfer is not repeated" "$call_request" 56 1

# The stub answers on the third attempt, and the reply carries that answer
# rather than the failure before it.
count="$work/attempts"
rm -f "$count"
out=$(printf '%s\n' "$request" \
  | CURL_STUB_COUNT="$count" CURL_STUB_EXIT=7 CURL_STUB_FAIL_TIMES=2 \
    PATH="$work/bin:$PATH" sh "$script")
equals "the answer after two failures is the one reported" \
  "$(printf '%s\n' "$out" | sed -n '1p')" 0

if [ "$failures" -ne 0 ]; then
  printf '\n%s check(s) failed\n' "$failures"
  exit 1
fi
printf 'jmap-transport.sh ok\n'
