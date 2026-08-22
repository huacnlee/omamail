#!/bin/sh
# What unsubscribe.sh does with a one-click POST, against a server that is
# really there.
#
# Two halves, and both are needed. A curl stub can assert the invocation, which
# is what the mail transport's test does — but the bug this script exists for
# was not in the arguments, it was in a client that chased a `302` on its own.
# So the second half stands a loopback server up and asks it afterwards whether
# the redirect was followed. That is the only witness that cannot be fooled by
# reading the same config that was written.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/scripts/unsubscribe.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-unsub-test.XXXXXX")
trap 'rm -rf "$work"; [ -n "${server_pid:-}" ] && kill "$server_pid" 2>/dev/null; exit' EXIT INT TERM HUP

failures=0
server_pid=

b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

ok() {
  printf '  ok   %s\n' "$1"
}

bad() {
  printf '  FAIL %s\n' "$1"
  failures=$((failures + 1))
}

check() {
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1"
    printf '         expected: %s\n' "$3"
    printf '         actual:   %s\n' "$2"
  fi
}

contains() {
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"; else
    bad "$1"
    printf '         looked for: %s\n' "$3"
  fi
}

missing() {
  if printf '%s' "$2" | grep -qF -- "$3"; then
    bad "$1"
    printf '         found what must not be there: %s\n' "$3"
  else ok "$1"; fi
}

# ------------------------------------------------------- the config it writes

mkdir -p "$work/bin"
cat > "$work/bin/curl" <<'STUB'
#!/bin/sh
# Keeps the config it was handed, so the assertions below are about the exact
# bytes that would have reached the network. The script reads curl's stdout as
# the status, so the config cannot come back that way.
cat > "${CURL_STUB_DUMP:-/dev/null}"
printf '200'
STUB
chmod +x "$work/bin/curl"

wrote() {
  CURL_STUB_DUMP="$work/config" PATH="$work/bin:$PATH" sh "$script" >/dev/null
  cat "$work/config"
}

config=$(printf '%s %s %s\n' \
  "$(b64 'https://lists.example.com/u/abc?token=x%20y')" \
  "$(b64 'application/x-www-form-urlencoded')" \
  "$(b64 'List-Unsubscribe=One-Click')" \
  | wrote)

printf 'unsubscribe.sh — the config\n'
contains "the URL is sent as config, not as an argument" "$config" 'url = "https://lists.example.com/u/abc?token=x%20y"'
contains "it is a POST" "$config" 'request = "POST"'
contains "the one-click body is sent" "$config" 'data-binary = "List-Unsubscribe=One-Click"'
contains "redirects are refused" "$config" 'max-redirs = 0'
contains "https only, for the request" "$config" 'proto = "=https"'
contains "and for anything it might follow" "$config" 'proto-redir = "=https"'
contains "the exchange is bounded" "$config" 'max-time = 20'
missing  "nothing tells curl to follow a redirect" "$config" 'location'

# A quote in a URL must not end the config value it sits in.
quoted=$(printf '%s %s %s\n' \
  "$(b64 'https://x.example.com/a"b\c')" "$(b64 'text/plain')" "$(b64 'x=1')" \
  | wrote)
contains "a quote and a backslash in the URL are escaped" "$quoted" 'url = "https://x.example.com/a\"b\\c"'

# ------------------------------------------------------------- what it refuses

set +e
plain=$(printf '%s %s %s\n' "$(b64 'http://lists.example.com/u/abc')" "$(b64 'text/plain')" "$(b64 'x=1')" \
  | PATH="$work/bin:$PATH" sh "$script" 2>&1)
plain_code=$?
set -e
check "a plain http address is refused" "$plain_code" "2"
contains "and says why" "$plain" "not https"

set +e
short=$(printf '%s\n' "$(b64 'https://x.example.com/')" | PATH="$work/bin:$PATH" sh "$script" 2>&1)
short_code=$?
set -e
check "a malformed request is refused" "$short_code" "2"

# ------------------------------------------- and what a real server sees

if ! command -v python3 >/dev/null 2>&1; then
  printf '\n  python3 is not installed, so the live half did not run.\n'
  [ "$failures" -eq 0 ] || exit 1
  exit 0
fi

port=9942
cat > "$work/target.py" <<'PY'
import http.server, sys, threading
followed = False

class Target(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        global followed
        if self.path == "/bounce":
            self.send_response(302)
            self.send_header("Location", "/landed")
            self.end_headers()
        elif self.path == "/landed":
            followed = True
            self.send_response(204)
            self.end_headers()
        elif self.path == "/plain":
            self.send_response(200)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def do_GET(self):
        if self.path == "/verdict":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"FOLLOWED" if followed else b"NOT-FOLLOWED")
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass

http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Target).serve_forever()
PY

python3 "$work/target.py" "$port" &
server_pid=$!
# The server needs a moment, and a port that is already busy is worth saying.
tries=0
while ! curl -s -o /dev/null "http://127.0.0.1:$port/verdict"; do
  tries=$((tries + 1))
  if [ "$tries" -gt 40 ]; then
    printf '\n  the loopback target never came up on %s, so the live half did not run.\n' "$port"
    [ "$failures" -eq 0 ] || exit 1
    exit 0
  fi
  sleep 0.1
done

printf '\nunsubscribe.sh — against a server that is really there\n'

# http is refused by the script, so the live half drives curl directly with the
# very same config the script writes, minus the https-only lines. What is being
# tested here is the redirect policy, and that policy is scheme-independent.
live() {
  printf 'url = "http://127.0.0.1:%s%s"\n' "$port" "$1"
  printf 'request = "POST"\n'
  printf 'header = "Content-Type: application/x-www-form-urlencoded"\n'
  printf 'data-binary = "List-Unsubscribe=One-Click"\n'
  printf 'max-redirs = 0\n'
  printf 'max-time = 20\n'
  printf 'silent\n'
  printf 'output = "/dev/null"\n'
  printf 'write-out = "%%{http_code}"\n'
}

plain_status=$(live /plain | curl --config - 2>/dev/null)
check "a list that answers 200 reads as unsubscribed" "$plain_status" "200"

bounce_status=$(live /bounce | curl --config - 2>/dev/null)
check "a list that answers 302 reads as 302, not as its target" "$bounce_status" "302"

verdict=$(curl -s "http://127.0.0.1:$port/verdict")
check "and the redirect target was never contacted" "$verdict" "NOT-FOLLOWED"

# A request that never got an answer must read as "not sent" rather than as a
# status. curl writes `000` for it, which is all digits and would otherwise
# survive into the panel as a number nobody can act on.
unreachable=$(printf '%s %s %s\n' \
  "$(b64 'https://127.0.0.1:9') " "$(b64 'text/plain')" "$(b64 'x=1')" \
  | sh "$script" 2>/dev/null || true)
case "$unreachable" in
  *" 0") ok "an unreachable list reports no status at all" ;;
  *) bad "an unreachable list reports no status at all"; printf '         actual: %s\n' "$unreachable" ;;
esac

printf '\n'
if [ "$failures" -eq 0 ]; then
  printf 'unsubscribe.sh ok\n'
else
  printf '%s assertion(s) failed\n' "$failures"
  exit 1
fi
