#!/usr/bin/env bash
# The CLI launcher, its PATH install, and the help text a process actually
# prints — the contract an agent reads before it sends mail.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() { printf 'test_cli.sh: %s\n' "$1" >&2; exit 1; }

[ -x scripts/omamail ] || fail "scripts/omamail must be executable"
[ -x scripts/register-cli.sh ] || fail "scripts/register-cli.sh must be executable"
[ -f cli/run.js ] || fail "cli/run.js is the node entry the launcher execs"
[ -f cli/Cli.js ] || fail "cli/Cli.js must exist"

command -v node >/dev/null 2>&1 || command -v nodejs >/dev/null 2>&1 \
  || fail "node is required to run the CLI tests"

help_out=$(scripts/omamail --help)
printf '%s\n' "$help_out" | grep -q 'Usage: omamail' \
  || fail "--help must print a usage line"
printf '%s\n' "$help_out" | grep -q 'message send' \
  || fail "--help must name message send"
printf '%s\n' "$help_out" | grep -q '\-\-json' \
  || fail "--help must name --json"

scripts/omamail help send | grep -q '\-\-to' \
  || fail "omamail help send must document --to"

version_out=$(scripts/omamail --version)
printf '%s\n' "$version_out" | grep -q '^omamail ' \
  || fail "--version must print 'omamail <version>'"

# Unknown commands are usage errors, and --json still makes the error machine
# readable so an agent that always passes it does not have to special-case help.
err_out=$(scripts/omamail --json wat 2>/dev/null || true)
printf '%s\n' "$err_out" | grep -q '"ok":false' \
  || fail "a usage error with --json must print a JSON object"

set +e
scripts/omamail wat >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 2 ] || fail "an unknown command must exit 2, got $status"

# No mailbox file is not a crash: account list is empty, everything else asks
# the user to sign in.
work=$(mktemp -d "${TMPDIR:-/tmp}/omamail-cli.XXXXXX")
trap 'rm -rf "$work"' EXIT
export XDG_CONFIG_HOME="$work/config"
mkdir -p "$work/config"

list_out=$(scripts/omamail account list)
printf '%s\n' "$list_out" | grep -q 'No mailbox is signed in' \
  || fail "account list with no accounts must say so"

set +e
scripts/omamail list >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 3 ] || fail "listing mail with no accounts must exit 3, got $status"

# A saved mailbox is listed without touching the network.
mkdir -p "$work/config/omamail"
printf '%s\n' '{"version":1,"accounts":[{"id":"me@example.com","email":"me@example.com","provider":"gmail","label":"Work","clientId":"","clientSecret":"","imap":{"imapHost":"","imapPort":993,"smtpHost":"","smtpPort":465,"username":"","aliases":[],"insecure":false}}],"activeId":"me@example.com"}' \
  > "$work/config/omamail/accounts.json"
listed=$(scripts/omamail --json account list)
printf '%s\n' "$listed" | grep -q 'me@example.com' \
  || fail "account list --json must include the saved address"
printf '%s\n' "$listed" | grep -q '"active":true' \
  || fail "account list --json must mark the active mailbox"

bin_home="$work/bin"
HOME="$work" XDG_BIN_HOME="$bin_home" sh scripts/register-cli.sh "$(pwd)"
[ -L "$bin_home/omamail" ] || fail "register-cli.sh must symlink omamail into the bin dir"
[ "$(readlink -f "$bin_home/omamail")" = "$(readlink -f "$(pwd)/scripts/omamail")" ] \
  || fail "the omamail symlink must point at this checkout's launcher"
[ -L "$work/.agents/skills/omamail" ] || fail "register-cli.sh must symlink the agents skill"
[ "$(readlink -f "$work/.agents/skills/omamail")" = "$(readlink -f "$(pwd)/agents")" ] \
  || fail "the agents skill symlink must point at this checkout's agents/"
[ -f "$work/.agents/skills/omamail/SKILL.md" ] || fail "the agents skill must contain SKILL.md"

# A real file in the way is left alone.
rm -f "$bin_home/omamail"
printf '%s\n' 'other' > "$bin_home/omamail"
HOME="$work" XDG_BIN_HOME="$bin_home" sh scripts/register-cli.sh "$(pwd)" 2>/dev/null \
  || fail "register-cli.sh must not fail when a regular file is already there"
[ "$(cat "$bin_home/omamail")" = other ] \
  || fail "register-cli.sh must not replace a regular file named omamail"

printf 'test_cli.sh ok\n'
