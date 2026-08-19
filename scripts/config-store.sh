#!/bin/sh
# Writes one line from stdin to $XDG_CONFIG_HOME/omamail/<name> with
# owner-only permissions.
#
# Neither file it writes is world-readable: a desktop client's secret is only
# "not treated as confidential" by Google, which is not the same as public, and
# the account list names every mailbox on this machine. Plugin settings would
# have been the obvious home for both, but shell.json is world-readable.
#
# One line, read with `read` rather than `cat`: Quickshell's Process.write()
# never closes stdin, so anything waiting for EOF hangs forever.
set -eu

name=${1:-}
case "$name" in
  credentials.json|accounts.json|window.json) ;;
  *)
    printf '%s\n' 'usage: config-store.sh credentials.json|accounts.json|window.json' >&2
    exit 2
    ;;
esac

umask 077

config_home=${XDG_CONFIG_HOME:-$HOME/.config}
target_dir="$config_home/omamail"
target="$target_dir/$name"

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
