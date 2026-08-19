#!/bin/sh
# Writes the Google OAuth client credentials read from stdin to
# $XDG_CONFIG_HOME/omarchy-gmail/credentials.json with owner-only permissions.
#
# The client id is not a secret, but a desktop client's secret is only
# "not treated as confidential" by Google — it is still not something to leave
# world-readable, and shell.json is world-readable.
set -eu

umask 077

config_home=${XDG_CONFIG_HOME:-$HOME/.config}
target_dir="$config_home/omarchy-gmail"
target="$target_dir/credentials.json"

mkdir -p "$target_dir"
chmod 700 "$target_dir" 2>/dev/null || true

payload=$(cat)
if [ -z "$payload" ]; then
  exit 3
fi

tmp="$target.tmp.$$"
printf '%s\n' "$payload" > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$target"
printf '%s\n' "$target"
