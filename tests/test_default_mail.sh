#!/bin/sh
# default-mail.sh claims mailto: and Omarchy's SUPER+SHIFT+E, and undoing it
# must leave the user's bindings.lua exactly as it was. Runs against a
# throwaway config and data home; Hyprland is never reloaded.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
script="$root/scripts/default-mail.sh"
fail() { printf 'test_default_mail.sh: %s\n' "$1" >&2; exit 1; }

[ -x "$script" ] || fail "scripts/default-mail.sh must be executable"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export XDG_CONFIG_HOME="$tmp/config" XDG_DATA_HOME="$tmp/data" HYPRLAND_INSTANCE_SIGNATURE=
bindings="$XDG_CONFIG_HOME/hypr/bindings.lua"
mkdir -p "$(dirname "$bindings")"
printf -- '-- mine\nhl.unbind("PRINT")\n' > "$bindings"
cp "$bindings" "$tmp/original"

[ "$(sh "$script" status)" = not-default ] || fail "a fresh config must not report default"

sh "$script" on "$root" >/dev/null
grep -qxF 'hl.unbind("SUPER + SHIFT + E")' "$bindings" || fail "on must unbind Omarchy's SUPER+SHIFT+E"
grep -qF "o.bind(\"SUPER + SHIFT + E\", \"Email\", \"omarchy-shell shell summon omamail '{}'\")" "$bindings" \
  || fail "on must bind SUPER+SHIFT+E to summon Omamail"
grep -qF 'compose' "$bindings" || fail "on must bind SUPER+SHIFT+ALT+E to a new message"
[ -f "$XDG_DATA_HOME/applications/omamail.desktop" ] || fail "on must register omamail.desktop"
if command -v xdg-mime >/dev/null 2>&1; then
  [ "$(sh "$script" status)" = default ] || fail "on must report default"
fi

sh "$script" on "$root" >/dev/null
[ "$(grep -c 'omamail default mail client, do not edit' "$bindings")" = 1 ] \
  || fail "a second on must not add a second block"

sh "$script" off >/dev/null
cmp -s "$tmp/original" "$bindings" || fail "off must restore bindings.lua byte for byte"
[ "$(sh "$script" status)" = not-default ] || fail "off must report not-default"

if sh "$script" bogus >/dev/null 2>&1; then fail "an unknown action must fail"; fi

printf 'test_default_mail.sh ok\n'
