#!/bin/sh
# Puts `omamail` on PATH so agents and terminals can talk to the same
# mailboxes the window is signed into.
#
# The plugin is cloned, not packaged, so nothing else can put a binary in
# ~/.local/bin. A symlink back to this checkout means an update of the plugin
# is an update of the command, and a development `make install` is too.
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

plugin_dir=${1:-}
[ -n "$plugin_dir" ] || fail 'usage: register-cli.sh <plugin-dir>'
plugin_dir=$(cd "$plugin_dir" && pwd)
[ -x "$plugin_dir/scripts/omamail" ] || fail 'register-cli.sh: scripts/omamail is missing or not executable'

bin_home=${XDG_BIN_HOME:-${HOME:?}/.local/bin}
mkdir -p "$bin_home"
target="$bin_home/omamail"
source="$plugin_dir/scripts/omamail"

# A regular file is somebody else's command. A symlink is ours to refresh, so
# a plugin that moved still answers `omamail` after the next shell start.
if [ -e "$target" ] && [ ! -L "$target" ]; then
  printf '%s\n' "omamail: $target already exists; not replacing" >&2
  exit 0
fi

ln -sf "$source" "$target"
