# The order an IMAP conversation reaches the server in, checked against a real
# curl and a real server.
#
# A Coremail server — 163.com and the mailboxes around it — answers every
# SELECT with "Unsafe Login" until the client has sent the RFC 2971 ID command.
# curl gives that refusal the same exit code as a denied login, so the mailbox
# reported a perfectly good password as wrong and loaded nothing.
#
# Getting ID in front of the SELECT is harder than it sounds, and the three
# facts below are why the transport has an `imap-id` mode rather than one more
# command in the ordinary one:
#
#   1. curl opens the URL's path itself, before the first command it was given,
#      so nothing can be placed in front of that SELECT.
#   2. Dropping the path wins the order and loses the answer: curl then hands
#      the reply to a different channel than the one the transport reads, which
#      is silent — exit 0, no error, an empty mailbox.
#   3. A server that has never heard of ID answers BAD, and curl runs with
#      --fail-early, so one BAD takes every command after it. Hence the
#      capability gate rather than sending it to everyone.
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v curl >/dev/null 2>&1 || { echo "test_imap_ordering.sh: no curl, skipped"; exit 0; }
command -v python3 >/dev/null 2>&1 || { echo "test_imap_ordering.sh: no python3, skipped"; exit 0; }

work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-imap-ordering.XXXXXX")
trap 'rm -rf "$work"; [ -z "${srv_pid:-}" ] || kill "$srv_pid" 2>/dev/null || true' EXIT INT TERM HUP

fail() { printf 'test_imap_ordering.sh: %s\n' "$1" >&2; exit 1; }

cat > "$work/server.py" <<'PY'
import re, socket, sys, threading

log_path, id_reply = sys.argv[1], sys.argv[2]

def handle(conn):
    f = conn.makefile("rwb", buffering=0)
    f.write(b"* OK [CAPABILITY IMAP4rev1 ID] fake ready\r\n")
    while True:
        line = f.readline()
        if not line:
            break
        text = line.decode("latin1").rstrip("\r\n")
        with open(log_path, "a") as fh:
            # The password is never interesting here and must not be written down.
            fh.write(re.sub(r"(?i)^(\S+\s+LOGIN)\s+.*$", r"\1", text) + "\n")
        parts = text.split(" ", 2)
        if len(parts) < 2:
            continue
        tag, cmd = parts[0], parts[1].upper()
        rest = parts[2].upper() if len(parts) > 2 else ""
        if cmd == "ID" and id_reply == "bad":
            f.write(("%s BAD Unknown command\r\n" % tag).encode())
        elif cmd == "ID":
            # Untagged, as a real server answers. curl treats this section as a
            # generic custom request and puts the line on stdout, where it is
            # indistinguishable from a message body unless the transport keeps
            # it out — so a server that stayed silent here would let a broken
            # transport pass this file.
            f.write(b'* ID ("name" "fake" "version" "1")\r\n')
            f.write(("%s OK done\r\n" % tag).encode())
        elif cmd == "CAPABILITY":
            f.write(b"* CAPABILITY IMAP4rev1 ID\r\n")
            f.write(("%s OK done\r\n" % tag).encode())
        elif cmd == "SELECT":
            f.write(b"* 2 EXISTS\r\n")
            f.write(("%s OK [READ-WRITE] done\r\n" % tag).encode())
        elif cmd == "UID" and "BODY" in rest:
            # A single numeric UID with a BODY item is the one request libcurl
            # recognises as a message fetch, and it puts the answer on stdout
            # rather than through the header callback.
            body = b"Subject: hello\r\n\r\nthe body\r\n"
            f.write(b"* 1 FETCH (UID 101 BODY[] {%d}\r\n" % len(body))
            f.write(body)
            f.write(b")\r\n")
            f.write(("%s OK done\r\n" % tag).encode())
        elif cmd == "UID" and "FETCH" in rest:
            f.write(b"* 1 FETCH (UID 101)\r\n* 2 FETCH (UID 102)\r\n")
            f.write(("%s OK done\r\n" % tag).encode())
        elif cmd in ("UID", "SEARCH"):
            f.write(b"* SEARCH 1\r\n")
            f.write(("%s OK done\r\n" % tag).encode())
        elif cmd == "LOGOUT":
            f.write(b"* BYE bye\r\n")
            f.write(("%s OK done\r\n" % tag).encode())
            break
        else:
            f.write(("%s OK done\r\n" % tag).encode())
    conn.close()

srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", 0))
srv.listen(5)
print(srv.getsockname()[1], flush=True)
while True:
    c, _ = srv.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
PY

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

start_server() {
  : > "$work/log"
  : > "$work/port"
  python3 "$work/server.py" "$work/log" "$1" > "$work/port" 2>/dev/null &
  srv_pid=$!
  port=""
  for _ in $(seq 1 50); do
    port=$(cat "$work/port" 2>/dev/null || true)
    [ -n "$port" ] && break
    sleep 0.1
  done
  [ -n "$port" ] || fail "the fake server never reported a port"
}

stop_server() {
  kill "$srv_pid" 2>/dev/null || true
  wait "$srv_pid" 2>/dev/null || true
  srv_pid=""
}

# One transport invocation. Prints curl's exit code; leaves the commands the
# server saw in "$work/log" and what the caller was handed in "$work/reply".
transport() {
  local id_reply=$1 path=$2; shift 2
  start_server "$id_reply"
  local fields=""
  for c in "$@"; do fields="$fields $(b64 "$c")"; done
  printf 'imap %s %s%s\n' "$(b64 "imap://127.0.0.1:$port$path")" "$(b64 'jane:pw')" "$fields" \
    | ./scripts/mail-transport.sh > "$work/out" 2>/dev/null || true
  stop_server
  sed -n 2p "$work/out" | base64 -d > "$work/reply" 2>/dev/null || : > "$work/reply"
  head -1 "$work/out"
}

commands() { sed -E 's/^[A-Za-z0-9]+ //' "$work/log" | tr '\n' '|'; }
fetch_rows() { grep -c '^\* [0-9]* FETCH' "$work/reply" || true; }

# The mode that carries the fix: the opening command runs against the server,
# the mailbox is opened after it, and the answer still reaches the caller.
start_server ok
printf 'imap-id %s %s %s %s %s\n' \
  "$(b64 "imap://127.0.0.1:$port")" "$(b64 "imap://127.0.0.1:$port/INBOX")" \
  "$(b64 'jane:pw')" "$(b64 'ID ("name" "omamail")')" "$(b64 'UID FETCH 1:* (UID)')" \
  | ./scripts/mail-transport.sh > "$work/out" 2>/dev/null || true
stop_server
sed -n 2p "$work/out" | base64 -d > "$work/reply" 2>/dev/null || : > "$work/reply"
[ "$(head -1 "$work/out")" = "0" ] || fail "imap-id should have succeeded, curl exited $(head -1 "$work/out")"
[ "$(commands)" = 'CAPABILITY|LOGIN|ID ("name" "omamail")|SELECT INBOX|UID FETCH 1:* (UID)|LOGOUT|' ] \
  || fail "ID must reach the server before SELECT, saw: $(commands)"
[ "$(fetch_rows)" = "2" ] || fail "imap-id must still deliver its FETCH rows, saw $(fetch_rows)"
[ "$(grep -c '^[A-Za-z0-9]* LOGIN$' "$work/log")" = "1" ] \
  || fail "the two sections must share one connection, and so one LOGIN"

# And a message body, which arrives by the other channel entirely: libcurl
# recognises a single numeric UID with a BODY item as a message fetch and puts
# it on stdout, where a sequence set's answer goes through the header callback.
# The opening command's own reply has to be kept off stdout for that to still
# be readable — one stray line there and every uncached message reads as having
# no text at all, which is what shipping this without the case did.
start_server ok
printf 'imap-id %s %s %s %s %s\n' \
  "$(b64 "imap://127.0.0.1:$port")" "$(b64 "imap://127.0.0.1:$port/INBOX")" \
  "$(b64 'jane:pw')" "$(b64 'ID ("name" "omamail")')" \
  "$(b64 'UID FETCH 101 (UID FLAGS BODY.PEEK[])')" \
  | ./scripts/mail-transport.sh > "$work/out" 2>/dev/null || true
stop_server
sed -n 2p "$work/out" | base64 -d > "$work/reply" 2>/dev/null || : > "$work/reply"
[ "$(head -1 "$work/out")" = "0" ] || fail "a body fetch should have succeeded, curl exited $(head -1 "$work/out")"
grep -q "the body" "$work/reply" \
  || fail "imap-id must deliver a message body, got: $(head -c 200 "$work/reply")"
case "$(commands)" in
  *'ID ("name" "omamail")|SELECT INBOX|UID FETCH 101'*) ;;
  *) fail "the body fetch must still run behind ID and SELECT, saw: $(commands)" ;;
esac

# Fact 1: why the ID cannot simply be the first command of an ordinary request.
code=$(transport ok "/INBOX" 'ID ("name" "omamail")' 'UID FETCH 1:* (UID)')
[ "$code" = "0" ] || fail "a pathed URL should have succeeded, curl exited $code"
case "$(commands)" in
  *'SELECT INBOX|ID '*) ;;
  *) fail "expected curl's own SELECT to precede the first command, saw: $(commands)" ;;
esac

# Fact 2: and why dropping the path instead is not the answer — the order comes
# out right and the FETCH rows never reach the caller.
code=$(transport ok "" 'ID ("name" "omamail")' 'SELECT "INBOX"' 'UID FETCH 1:* (UID)')
[ "$code" = "0" ] || fail "a pathless URL should have succeeded, curl exited $code"
[ "$(fetch_rows)" = "0" ] \
  || fail "a pathless URL now delivers FETCH rows; imap-id may be simplifiable"

# Fact 3: and why ID is gated on the capability rather than sent to everyone.
code=$(transport bad "" 'ID ("name" "omamail")' 'SELECT "INBOX"' 'UID FETCH 1:* (UID)')
[ "$code" = "0" ] && fail "a server that refuses ID must not be reported as success"
case "$(commands)" in
  *'UID FETCH'*) fail "--fail-early must stop the run at the BAD, saw: $(commands)" ;;
esac

# The gate itself lives in QML, where none of the above can reach it.
python3 - <<'SRC' || exit 1
import re, sys

text = open("providers/ImapClient.qml", encoding="utf-8").read()
start = text.index("function run(folder, commands, callback, existingHandle)")
end = text.index("function ensureFolders", start)
block = text[start:end]

gate = re.search(r'hasCapability\(root\.serverCapabilities,\s*"ID"\)', block)
if not gate:
    sys.exit("test_imap_ordering.sh: ID must be sent only to a server that advertised it")
if block.index("Imap.idCommand()") < gate.start():
    sys.exit("test_imap_ordering.sh: the ID command must sit behind the capability check")
if "imap-id " not in block:
    sys.exit("test_imap_ordering.sh: the ID command must travel in the transport's imap-id mode")
SRC

echo "imap ordering ok"
