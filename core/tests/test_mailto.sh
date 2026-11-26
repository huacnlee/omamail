#!/bin/sh
# The desktop handler must summon Omamail with the mailto: URL intact.
# Toggle would close a window that is already open, which is the opposite of
# a link that asked to write a message.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/scripts/mailto.sh"
fail() { printf 'test_mailto.sh: %s\n' "$1" >&2; exit 1; }

[ -x "$script" ] || fail "scripts/mailto.sh must be executable"

printed=$(OMAMAIL_MAILTO_PRINT=1 sh "$script" 'mailto:jane@example.com?subject=Hi')
expected='omarchy-shell shell summon omamail {"mailto":"mailto:jane@example.com?subject=Hi"}'
[ "$printed" = "$expected" ] || fail "expected:
$expected
got:
$printed"

quoted=$(OMAMAIL_MAILTO_PRINT=1 sh "$script" 'mailto:jane@example.com?subject=Say "hi"')
echo "$quoted" | grep -q '"mailto":"mailto:jane@example.com?subject=Say \\"hi\\""' \
  || fail "a quote in the URL must be JSON-escaped, got: $quoted"

blank=$(OMAMAIL_MAILTO_PRINT=1 sh "$script")
[ "$blank" = 'omarchy-shell shell summon omamail {}' ] \
  || fail "no URL must still summon the window, got: $blank"

printf 'test_mailto.sh ok\n'
