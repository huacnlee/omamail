#!/bin/sh
# Writes one line from stdin to $XDG_CONFIG_HOME/omamail/<name> with
# owner-only permissions.
#
# No file it writes is world-readable: a desktop client's secret is only
# "not treated as confidential" by Google, which is not the same as public, and
# the account list names every mailbox on this machine. Compose recovery also
# contains message text. Plugin settings would have been the obvious home for
# these files, but shell.json is world-readable.
#
# One line, read with `read` rather than `cat`: Quickshell's Process.write()
# never closes stdin, so anything waiting for EOF hangs forever.
set -eu

name=${1:-}
case "$name" in
  credentials.json|accounts.json|window.json|calendars.json|compose.json) ;;
  *)
    printf '%s\n' 'usage: config-store.sh credentials.json|accounts.json|window.json|calendars.json|compose.json' >&2
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

# A plugin reload can briefly leave the retiring service with only its setup
# row in memory. If that stale instance reaches this writer after a real list
# has already been stored, accepting the write would replace every mailbox
# with first-run state. A saved account always has a validated email address;
# a draft has an empty one. Keep this invariant at the final write boundary so
# it also protects an old service instance during an upgrade.
if [ "$name" = accounts.json ] && [ -s "$target" ] \
  && grep -Eq '"email"[[:space:]]*:[[:space:]]*"[^"]+"' "$target" \
  && ! printf '%s\n' "$payload" \
    | grep -Eq '"email"[[:space:]]*:[[:space:]]*"[^"]+"'; then
  printf '%s\n' 'refusing to replace saved accounts with setup state' >&2
  exit 4
fi

mkdir -p "$target_dir"
chmod 700 "$target_dir" 2>/dev/null || true

tmp="$target.tmp.$$"
printf '%s\n' "$payload" > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$target"
printf '%s\n' "$target"
