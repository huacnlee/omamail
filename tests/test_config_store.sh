#!/usr/bin/env bash
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d /tmp/omamail-config-store-test.XXXXXX)
trap 'rm -rf "$work"' EXIT
export XDG_CONFIG_HOME="$work/config"
store="$project_dir/scripts/config-store.sh"
target="$XDG_CONFIG_HOME/omamail/accounts.json"

saved='{"version":1,"accounts":[{"id":"ada@example.com","email":"ada@example.com"}],"activeId":"ada@example.com"}'
write() { printf '%s\n' "$1" | "$store" accounts.json >/dev/null; }
refused() {
  if printf '%s\n' "$1" | "$store" accounts.json >/dev/null 2>&1; then
    echo "config-store.sh: $2" >&2
    exit 1
  fi
}

# First run has nothing to protect, so the placeholder list is written.
write '{"version":1,"accounts":[{"id":"","email":""}],"activeId":""}'
grep -q '"email":""' "$target"

# A real account replaces it, and one real account replaces another.
write "$saved"
grep -q 'ada@example.com' "$target"
write '{"version":1,"accounts":[{"id":"bob@example.com","email":"bob@example.com"}],"activeId":"bob@example.com"}'
grep -q 'bob@example.com' "$target"

write "$saved"

# Setup state must never replace a saved account.
refused '{"version":1,"accounts":[{"id":"","email":""}],"activeId":""}' \
  'a first-run payload must not replace saved accounts'
grep -q 'ada@example.com' "$target"

# The address field can hold something that is not an address — a username
# typed into it, most likely. Accounts.js derives no id from such a row, so it
# is setup state too, and a merely non-empty address must not read as a saved
# account here. This is what let a working mailbox be overwritten by a row
# nothing could select or remove.
for junk in 'ada' 'ada@' '@example.com' 'no-at-sign' 'trailing@dot.'; do
  refused "{\"version\":1,\"accounts\":[{\"id\":\"\",\"email\":\"$junk\"}],\"activeId\":\"\"}" \
    "\"$junk\" is not an address and must not replace saved accounts"
done
grep -q 'ada@example.com' "$target"

# A real address still gets through, including the shapes the coarse pattern
# has to keep accepting.
for good in 'ada@example.com' 'a.b+c@mail.example.co.uk' 'x@a.io'; do
  write "{\"version\":1,\"accounts\":[{\"id\":\"$good\",\"email\":\"$good\"}],\"activeId\":\"$good\"}"
  grep -qF "$good" "$target"
done

# The guard is for the account list alone; the other files it writes are
# unconditional.
printf '%s\n' '{"zoom":1}' | "$store" window.json >/dev/null
grep -q '"zoom":1' "$XDG_CONFIG_HOME/omamail/window.json"

# An unknown name, an empty payload, and the permissions the files are kept at.
if printf '%s\n' 'x' | "$store" secrets.json >/dev/null 2>&1; then
  echo 'config-store.sh: an unknown file name must be refused' >&2
  exit 1
fi
if printf '\n' | "$store" accounts.json >/dev/null 2>&1; then
  echo 'config-store.sh: an empty payload must be refused' >&2
  exit 1
fi
[ "$(stat -c '%a' "$target")" = 600 ] \
  || { echo 'config-store.sh: the account list must stay owner-only' >&2; exit 1; }

echo 'config-store.sh ok'
