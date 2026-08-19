#!/bin/sh
# Writes the Google OAuth client credentials read from stdin to
# $XDG_CONFIG_HOME/omarchy-gmail/credentials.json with owner-only permissions.
#
# The client id is not a secret, but a desktop client's secret is only
# "not treated as confidential" by Google — it is still not something to leave
# world-readable, and shell.json is world-readable.
#
# One line, read with `read` rather than `cat`: Quickshell's Process.write()
# never closes stdin, so anything waiting for EOF hangs forever.
set -eu

umask 077

config_home=${XDG_CONFIG_HOME:-$HOME/.config}
target_dir="$config_home/omarchy-gmail"
target="$target_dir/credentials.json"

IFS= read -r payload
if [ -z "$payload" ]; then
  exit 3
fi

mkdir -p "$target_dir"
chmod 700 "$target_dir" 2>/dev/null || true

tmp="$target.tmp.$$"
printf '%s\n' "$payload" > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$target"
printf '%s\n' "$target"
