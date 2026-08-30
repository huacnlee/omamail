#!/bin/sh
# The desktop handler must summon Omamail with the mailto: URL intact.
# Toggle would close a window that is already open, which is the opposite of
# a link that asked to write a message.
#
# Two branches, because there are two clients. Both are pinned here rather than
# left to whatever happens to be installed on the machine running the suite:
# an absent OMAMAIL_BIN would otherwise mean the standalone branch is tested on
# a developer's laptop and not in CI, or the other way round.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/scripts/mailto.sh"
fail() { printf 'test_mailto.sh: %s\n' "$1" >&2; exit 1; }

[ -x "$script" ] || fail "scripts/mailto.sh must be executable"

# ------------------------------------------------------ the shell plugin
# No standalone client to reach, so the link goes to the shell that is hosting
# the plugin.
missing=/nonexistent/omamail

printed=$(OMAMAIL_BIN="$missing" OMAMAIL_MAILTO_PRINT=1 sh "$script" \
  'mailto:jane@example.com?subject=Hi')
expected='omarchy-shell shell summon omamail {"mailto":"mailto:jane@example.com?subject=Hi"}'
[ "$printed" = "$expected" ] || fail "expected:
$expected
got:
$printed"

quoted=$(OMAMAIL_BIN="$missing" OMAMAIL_MAILTO_PRINT=1 sh "$script" \
  'mailto:jane@example.com?subject=Say "hi"')
echo "$quoted" | grep -q '"mailto":"mailto:jane@example.com?subject=Say \\"hi\\""' \
  || fail "a quote in the URL must be JSON-escaped, got: $quoted"

blank=$(OMAMAIL_BIN="$missing" OMAMAIL_MAILTO_PRINT=1 sh "$script")
[ "$blank" = 'omarchy-shell shell summon omamail {}' ] \
  || fail "no URL must still summon the window, got: $blank"

# ---------------------------------------------------- the standalone client
# The link is handed to the binary, whose own router decides whether that opens
# a window or reaches the one already up. Nothing here starts a second process
# by hand: that decision belongs to src/command_router.rs and nowhere else.
workspace=$(mktemp -d)
trap 'rm -rf "$workspace"' EXIT
binary="$workspace/omamail"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$binary"
chmod +x "$binary"

standalone=$(OMAMAIL_BIN="$binary" OMAMAIL_MAILTO_PRINT=1 sh "$script" \
  'mailto:jane@example.com?subject=Hi')
[ "$standalone" = "$binary mailto:jane@example.com?subject=Hi" ] \
  || fail "the standalone client must be handed the URL, got: $standalone"

standalone_blank=$(OMAMAIL_BIN="$binary" OMAMAIL_MAILTO_PRINT=1 sh "$script")
[ "$standalone_blank" = "$binary" ] \
  || fail "no URL must still open the window, got: $standalone_blank"

# A desktop handler is reachable by anything that can call xdg-open. The vector
# it builds is not the place to find out the argument was not a link.
if OMAMAIL_BIN="$binary" OMAMAIL_MAILTO_PRINT=1 sh "$script" \
    'https://example.com' >/dev/null 2>&1; then
  fail "a non-mailto argument must be refused"
fi
if OMAMAIL_BIN="$binary" OMAMAIL_MAILTO_PRINT=1 sh "$script" \
    '--command refresh' >/dev/null 2>&1; then
  fail "the handler must not forward an option as a link"
fi

# The scheme is case-insensitive everywhere else it is read, and xdg-open does
# not normalise it.
upper=$(OMAMAIL_BIN="$binary" OMAMAIL_MAILTO_PRINT=1 sh "$script" \
  'MAILTO:jane@example.com')
[ "$upper" = "$binary MAILTO:jane@example.com" ] \
  || fail "MAILTO: is the same scheme, got: $upper"

printf 'test_mailto.sh ok\n'
