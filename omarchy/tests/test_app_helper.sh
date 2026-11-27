#!/bin/sh
# omamail-app.sh, the notice widget's only helper, in a throwaway HOME: it
# reports the app missing or installed (XDG_DATA_DIRS split on ':' only, no
# globbing), and keeps the plugin's settings once: private to the owner,
# refused whole past 64 KiB, written through a mktemp file in the target
# directory and renamed, never through a planted link. No network.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
HELPER="$HERE/../notice/omamail-app.sh"
SANDBOX=$(mktemp -d "${TMPDIR:-/tmp}/omamail-helper.XXXXXX")
trap 'rm -rf -- "$SANDBOX"' EXIT INT TERM

fail() {
  echo "test_app_helper.sh: $1" >&2
  exit 1
}

# run [DATA_DIRS] -- COMMAND: the helper with only this sandbox in its env.
DATA_DIRS="$SANDBOX/system"
run() {
  env -i HOME="$SANDBOX/home" XDG_CONFIG_HOME="$SANDBOX/config" \
    XDG_DATA_HOME="$SANDBOX/data" XDG_DATA_DIRS="$DATA_DIRS" PATH="/usr/bin:/bin" \
    sh "$HELPER" "$@"
}
entry() {
  mkdir -p "$1/applications"
  : > "$1/applications/dev.huacnlee.omamail.desktop"
}

mkdir -p "$SANDBOX/home" "$SANDBOX/system" "$SANDBOX/data"

# Status and open.
[ "$(run status)" = missing ] || fail "status must say missing with no app installed"
if run open 2>/dev/null; then fail "open must fail when the app is missing"; fi

# XDG_DATA_DIRS: a directory with a space and a '*' is found as written.
odd="$SANDBOX/sys tem*"
entry "$odd"
DATA_DIRS="$SANDBOX/nothing:$odd"
[ "$(run status)" = installed ] || fail "an XDG_DATA_DIRS entry with a space and '*' must be taken as written"
# ...and a pattern is not expanded: "$SANDBOX/sys*" names no directory.
DATA_DIRS="$SANDBOX/sys*"
[ "$(run status)" = missing ] || fail "XDG_DATA_DIRS must not be globbed"
DATA_DIRS="$SANDBOX/system"

entry "$SANDBOX/data"
[ "$(run status)" = installed ] || fail "status must say installed once the desktop entry exists"

# Export: kept as given, private.
dir="$SANDBOX/config/omamail"
file="$dir/plugin-settings.json"
printf '{"accountsShown":true}' | run export-settings
[ "$(cat "$file")" = '{"accountsShown":true}' ] || fail "export-settings must keep what it was given"
[ -n "$(find "$file" -type f -perm 600)" ] || fail "the export must be private to its owner (0600)"
[ -n "$(find "$dir" -prune -type d -perm 700)" ] || fail "the export directory must be private (0700)"

# Exactly 64 KiB is accepted.
head -c 65536 /dev/zero | tr '\0' 'a' | run export-settings
[ "$(wc -c < "$file" | tr -d ' ')" = 65536 ] || fail "64 KiB of settings must be kept whole"

# One byte more is refused whole: a clear error, the old export untouched.
printf '{"kept":1}' | run export-settings
status=0
head -c 65537 /dev/zero | tr '\0' 'a' | run export-settings 2> "$SANDBOX/err" || status=$?
[ "$status" = 3 ] || fail "oversized settings must exit 3, not $status"
grep -q "larger than 65536 bytes" "$SANDBOX/err" || fail "oversized settings must say why"
[ "$(cat "$file")" = '{"kept":1}' ] || fail "oversized settings must leave the old export as it was"
[ -z "$(find "$dir" -name '.plugin-settings.json.*')" ] || fail "a refused export must leave no temporary"

# A planted link at the export is replaced, not followed.
victim="$SANDBOX/victim"
printf 'untouched' > "$victim"
ln -sf "$victim" "$file"
printf '{"new":1}' | run export-settings
[ "$(cat "$victim")" = untouched ] || fail "the export must not write through a planted link"
[ -f "$file" ] && [ ! -L "$file" ] || fail "the export must be a regular file after replacing a link"
[ "$(cat "$file")" = '{"new":1}' ] || fail "the export must hold the new settings"

# A planted link in place of the directory is refused.
mv "$dir" "$SANDBOX/real-omamail"
mkdir "$SANDBOX/elsewhere"
ln -s "$SANDBOX/elsewhere" "$dir"
if printf '{}' | run export-settings 2>/dev/null; then fail "a linked export directory must be refused"; fi
[ -z "$(find "$SANDBOX/elsewhere" -type f)" ] || fail "nothing may be written through a linked export directory"

if run unknown 2>/dev/null; then fail "an unknown command must fail"; fi

echo "ok: omamail-app.sh status, open and export-settings"
