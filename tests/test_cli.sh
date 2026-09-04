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

# A transport that dies before printing its three-line response did not send
# anything. Empty stdout must not be parsed as curl status zero and reported as
# a successful delivery.
runtime_bin="$work/runtime-bin"
mkdir -p "$runtime_bin"
cat > "$runtime_bin/secret-tool" <<'EOF'
#!/bin/sh
printf '%s' 'password'
EOF
cat > "$runtime_bin/curl" <<'EOF'
#!/bin/sh
cat >/dev/null
printf '* CAPABILITY IMAP4rev1 MOVE\r\n* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\Sent) "/" "Sent Items"\r\n* LIST (\\HasNoChildren) "/" "Sent"\r\nA1 OK done\r\n'
EOF
cat > "$runtime_bin/mktemp" <<'EOF'
#!/bin/sh
count=0
[ ! -f "$OMAMAIL_TEST_MKTEMP_COUNT" ] || count=$(cat "$OMAMAIL_TEST_MKTEMP_COUNT")
count=$((count + 1))
printf '%s\n' "$count" > "$OMAMAIL_TEST_MKTEMP_COUNT"
[ "$count" -ne 1 ] || exec /usr/bin/mktemp "$@"
exit 1
EOF
chmod +x "$runtime_bin/secret-tool" "$runtime_bin/curl" "$runtime_bin/mktemp"
printf '%s\n' '{"version":1,"accounts":[{"id":"imap:me@example.com","email":"me@example.com","provider":"imap","imap":{"imapHost":"imap.example.com","imapPort":993,"smtpHost":"smtp.example.com","smtpPort":465,"username":"me@example.com","aliases":[{"email":"alias@example.com","displayName":"Alias","isDefault":false}],"insecure":false}}],"activeId":"imap:me@example.com"}' \
  > "$work/config/omamail/accounts.json"
set +e
smtp_failure=$(PATH="$runtime_bin:$PATH" OMAMAIL_TEST_MKTEMP_COUNT="$work/mktemp-count" \
  scripts/omamail send --to you@example.com --body hello 2>&1)
status=$?
set -e
[ "$status" -ne 0 ] \
  || fail "an SMTP transport that exits before a response must not be reported as sent: $smtp_failure"
runtime_ok_bin="$work/runtime-ok-bin"
mkdir -p "$runtime_ok_bin"
cp "$runtime_bin/secret-tool" "$runtime_ok_bin/secret-tool"
cp "$runtime_bin/curl" "$runtime_ok_bin/curl"

# IMAP send-as addresses are the mailbox address and its configured aliases,
# exactly as they are in the window. An arbitrary --from must be refused before
# it reaches SMTP.
set +e
from_failure=$(PATH="$runtime_ok_bin:$PATH" \
  scripts/omamail send --to you@example.com --from impostor@example.com --body hello 2>&1)
status=$?
set -e
[ "$status" -ne 0 ] \
  || fail "IMAP accepted a From address the mailbox does not own: $from_failure"
printf '%s\n' "$from_failure" | grep -q 'valid From address' \
  || fail "IMAP must explain that an unauthorized From address is invalid"
alias_send=$(PATH="$runtime_ok_bin:$PATH" \
  scripts/omamail send --to you@example.com --from alias@example.com --body hello)
[ "$alias_send" = "Sent" ] \
  || fail "a configured IMAP alias did not reach a successful SMTP delivery: $alias_send"
case_mailboxes=$(PATH="$runtime_ok_bin:$PATH" scripts/omamail --json mailbox list)
printf '%s\n' "$case_mailboxes" | grep -q '"key":"Sent"' \
  || fail "mailbox list dropped a server folder that case-collides with a built-in key: $case_mailboxes"
printf '%s\n' "$case_mailboxes" | grep -q '"key":"INBOX"' \
  && fail "mailbox list duplicated the built-in Inbox with the actual INBOX folder: $case_mailboxes"
printf '%s\n' "$case_mailboxes" | grep -q '"key":"Sent Items"' \
  && fail "mailbox list duplicated the built-in Sent key with its SPECIAL-USE folder: $case_mailboxes"
set +e
invalid_ids=$(PATH="$runtime_ok_bin:$PATH" scripts/omamail star 42:Sent Items 2>&1)
status=$?
set -e
[ "$status" -eq 2 ] \
  || fail "an unquoted IMAP folder must refuse the whole action as invalid input: $invalid_ids (exit $status)"

# A draft id names a draft, not a HEY topic. Reading one must use `draft show`
# and retain the draft's headers and body in the CLI response.
cat > "$runtime_ok_bin/hey" <<'EOF'
#!/bin/sh
if [ "$*" = "draft show 123 --json" ]; then
  printf '%s\n' '{"ok":true,"data":{"id":123,"subject":"Draft subject","body":"Draft body","to":["you@example.com"],"cc":[],"bcc":[],"updated_at":"2026-09-04T01:02:03Z"}}'
  exit 0
fi
printf '%s\n' '{"ok":false,"error":"wrong HEY resource"}'
exit 1
EOF
chmod +x "$runtime_ok_bin/hey"
printf '%s\n' '{"version":1,"accounts":[{"id":"hey:me@hey.com","email":"me@hey.com","provider":"hey"}],"activeId":"hey:me@hey.com"}' \
  > "$work/config/omamail/accounts.json"
set +e
draft_read=$(PATH="$runtime_ok_bin:$PATH" scripts/omamail --json read draft:123 2>&1)
status=$?
set -e
[ "$status" -eq 0 ] \
  || fail "a HEY draft id must be read as a draft: $draft_read"
printf '%s\n' "$draft_read" | grep -q '"subject":"Draft subject"' \
  || fail "a HEY draft read must retain its subject"
printf '%s\n' "$draft_read" | grep -q '"body":"Draft body"' \
  || fail "a HEY draft read must retain its body"

# Dynamic mailbox discovery is a live operation. If IMAP authentication fails,
# returning only the built-in fallback folders makes a broken account look
# healthy and hides every server-defined folder.
printf '%s\n' '{"version":1,"accounts":[{"id":"imap:me@example.com","email":"me@example.com","provider":"imap","imap":{"imapHost":"imap.example.com","imapPort":993,"smtpHost":"smtp.example.com","smtpPort":465,"username":"me@example.com","aliases":[],"insecure":false}}],"activeId":"imap:me@example.com"}' \
  > "$work/config/omamail/accounts.json"

# A shell can exit zero without completing the transport's three-line protocol.
# Blank or truncated stdout is not an empty successful IMAP response.
malformed_root="$work/malformed-root"
mkdir -p "$malformed_root/scripts"
ln -s "$(pwd)/account" "$malformed_root/account"
ln -s "$(pwd)/cli" "$malformed_root/cli"
ln -s "$(pwd)/message" "$malformed_root/message"
ln -s "$(pwd)/providers" "$malformed_root/providers"
ln -s "$(pwd)/manifest.json" "$malformed_root/manifest.json"
cat > "$malformed_root/scripts/mail-transport.sh" <<'EOF'
#!/bin/sh
printf '\n\n'
exit 0
EOF
chmod +x "$malformed_root/scripts/mail-transport.sh"
set +e
malformed_imap=$(OMAMAIL_ROOT="$malformed_root" PATH="$runtime_ok_bin:$PATH" \
  node cli/run.js mailbox list 2>&1)
status=$?
set -e
[ "$status" -ne 0 ] \
  || fail "IMAP accepted an incomplete transport response: $malformed_imap"

auth_fail_bin="$work/auth-fail-bin"
mkdir -p "$auth_fail_bin"
cat > "$auth_fail_bin/secret-tool" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$auth_fail_bin/secret-tool"
set +e
invalid_before_auth=$(PATH="$auth_fail_bin:$PATH" scripts/omamail star 42:Sent Items 2>&1)
status=$?
set -e
[ "$status" -eq 2 ] \
  || fail "invalid IMAP action ids must be refused before authentication: $invalid_before_auth (exit $status)"
set +e
invalid_read_before_auth=$(PATH="$auth_fail_bin:$PATH" scripts/omamail read not-an-id 2>&1)
status=$?
set -e
[ "$status" -eq 4 ] \
  || fail "an invalid IMAP read id must be refused before authentication: $invalid_read_before_auth (exit $status)"
set +e
mailbox_failure=$(PATH="$auth_fail_bin:$PATH" scripts/omamail mailbox list 2>&1)
status=$?
set -e
[ "$status" -eq 3 ] \
  || fail "mailbox list must classify a missing IMAP credential as auth: $mailbox_failure (exit $status)"
set +e
read_auth_failure=$(PATH="$auth_fail_bin:$PATH" scripts/omamail --json read 42:INBOX 2>&1)
status=$?
set -e
[ "$status" -eq 3 ] \
  || fail "read must classify a missing IMAP credential as auth: $read_auth_failure (exit $status)"
printf '%s\n' "$read_auth_failure" | grep -q '"code":"auth"' \
  || fail "JSON auth failures must carry the documented auth code: $read_auth_failure"

# A transport timeout is an operational failure, not proof that a message does
# not exist. `read` reserves exit 4 for an authoritative not-found answer.
network_fail_bin="$work/network-fail-bin"
mkdir -p "$network_fail_bin"
cp "$runtime_bin/secret-tool" "$network_fail_bin/secret-tool"
cat > "$network_fail_bin/curl" <<'EOF'
#!/bin/sh
cat >/dev/null
printf '%s\n' 'operation timed out' >&2
exit 28
EOF
chmod +x "$network_fail_bin/curl"
set +e
network_read=$(PATH="$network_fail_bin:$PATH" scripts/omamail --json read 42:INBOX 2>&1)
status=$?
set -e
[ "$status" -eq 1 ] \
  || fail "read must classify a transport timeout as an operational error: $network_read (exit $status)"
printf '%s\n' "$network_read" | grep -q '"code":"error"' \
  || fail "JSON transport failures must carry the documented error code: $network_read"

# The status command promises the unread number used by the panel badge. Gmail
# defines that with the provider's unread query, not with INBOX label metadata.
gmail_bin="$work/gmail-bin"
mkdir -p "$gmail_bin"
cat > "$gmail_bin/secret-tool" <<'EOF'
#!/bin/sh
printf '%s' 'refresh-token'
EOF
cat > "$gmail_bin/curl" <<'EOF'
#!/bin/sh
IFS= read -r config
case "$config" in
  *oauth2.googleapis.com/token*) printf '%s\n200' '{"access_token":"access-token","expires_in":3600}' ;;
  *labels/INBOX*) printf '%s\n200' '{"messagesUnread":99}' ;;
  *messages*) printf '%s\n200' '{"messages":[],"resultSizeEstimate":7}' ;;
  *) printf '%s\n500' '{"error":{"message":"unexpected request"}}' ;;
esac
EOF
chmod +x "$gmail_bin/secret-tool" "$gmail_bin/curl"
printf '%s\n' '{"version":1,"accounts":[{"id":"me@gmail.com","email":"me@gmail.com","provider":"gmail"}],"activeId":"me@gmail.com"}' \
  > "$work/config/omamail/accounts.json"
printf '%s\n' '{"version":2,"accounts":[{"id":"me@gmail.com","clientId":"1234-test.apps.googleusercontent.com","clientSecret":"GOCSPX-secret","projectId":"test"}]}' \
  > "$work/config/omamail/credentials.json"
set +e
gmail_status=$(PATH="$gmail_bin:$PATH" scripts/omamail --json status 2>&1)
status=$?
set -e
[ "$status" -eq 0 ] || fail "Gmail status failed: $gmail_status"
printf '%s\n' "$gmail_status" | grep -q '"unread":7' \
  || fail "Gmail status did not use the badge's unread query: $gmail_status"

printf 'test_cli.sh ok\n'
