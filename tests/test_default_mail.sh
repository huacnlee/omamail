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
expected_binding=$(cat <<'EOF'
o.bind("SUPER + SHIFT + E", "Email", "omarchy-shell shell summon omamail '{\"openSource\":\"shortcut\"}'")
EOF
)
grep -qxF "$expected_binding" "$bindings" \
  || fail "on must bind SUPER+SHIFT+E to summon Omamail"
grep -qF 'compose' "$bindings" || fail "on must bind SUPER+SHIFT+ALT+E to a new message"
[ -f "$XDG_DATA_HOME/applications/omamail.desktop" ] || fail "on must register omamail.desktop"
if command -v xdg-mime >/dev/null 2>&1; then
  [ "$(sh "$script" status)" = default ] || fail "on must report default"
fi

# Start from a binding written by a release before the presentation setting.
cp "$bindings" "$tmp/with-current"
sed 's/{.*shortcut.*}/{}/' "$tmp/with-current" > "$bindings"
if grep -q 'openSource' "$bindings"; then fail "legacy fixture still uses the new command"; fi
sh "$script" upgrade-shortcut
cmp -s "$tmp/with-current" "$bindings" || fail "only the managed inbox binding should change"
sh "$script" upgrade-shortcut
cmp -s "$tmp/with-current" "$bindings" || fail "migration must be idempotent"

sed '/^-- <<< omamail default mail client$/d' "$tmp/with-current" > "$bindings"
printf '%s\n' 'hl.unbind("SUPER + A")' >> "$bindings"
cp "$bindings" "$tmp/malformed"
if sh "$script" upgrade-shortcut >/dev/null 2>&1; then fail "reject a partial managed block"; fi
cmp -s "$tmp/malformed" "$bindings" || fail "invalid blocks must leave the file intact"
cp "$tmp/with-current" "$bindings"

# Dotfile managers can make bindings.lua a symlink to a config with no final newline.
mv "$bindings" "$tmp/dotfile"
ln -s "$tmp/dotfile" "$bindings"
sed 's/{.*shortcut.*}/{}/' "$tmp/with-current" > "$tmp/dotfile"
printf '%s' '-- last line' >> "$tmp/dotfile"
cat "$tmp/with-current" > "$tmp/dotfile-expected"
printf '%s' '-- last line' >> "$tmp/dotfile-expected"
sh "$script" upgrade-shortcut
[ -L "$bindings" ] || fail "migration must preserve the dotfile symlink"
cmp -s "$tmp/dotfile-expected" "$tmp/dotfile" || fail "migration must preserve the dotfile bytes"
rm "$bindings"
cp "$tmp/with-current" "$bindings"

mkdir -p "$tmp/bin"
cat > "$tmp/bin/hyprctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_RELOAD_LOG"
test -f "$TEST_RELOAD_RECOVERED"
EOF
chmod +x "$tmp/bin/hyprctl"
export TEST_RELOAD_LOG="$tmp/reload.log" TEST_RELOAD_RECOVERED="$tmp/reload-recovered"
sed 's/{.*shortcut.*}/{}/' "$tmp/with-current" > "$bindings"
if PATH="$tmp/bin:$PATH" HYPRLAND_INSTANCE_SIGNATURE=fixture sh "$script" upgrade-shortcut >/dev/null 2>&1; then
  fail "migration must report a failed live reload"
fi
cmp -s "$tmp/with-current" "$bindings" || fail "corrected binding must be ready for retry"
touch "$TEST_RELOAD_RECOVERED"
PATH="$tmp/bin:$PATH" HYPRLAND_INSTANCE_SIGNATURE=fixture sh "$script" upgrade-shortcut
[ "$(grep -cx reload "$TEST_RELOAD_LOG")" = 2 ] || fail "retry must reload an already-migrated binding"

sh "$script" on "$root" >/dev/null
[ "$(grep -c 'omamail default mail client, do not edit' "$bindings")" = 1 ] \
  || fail "a second on must not add a second block"

sh "$script" off >/dev/null
cmp -s "$tmp/original" "$bindings" || fail "off must restore bindings.lua byte for byte"
[ "$(sh "$script" status)" = not-default ] || fail "off must report not-default"

if sh "$script" bogus >/dev/null 2>&1; then fail "an unknown action must fail"; fi

printf 'test_default_mail.sh ok\n'
