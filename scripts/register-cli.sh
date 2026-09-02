#!/bin/sh
# Puts `omamail` on PATH, and the agents skill next to it, so a terminal or
# an agent can talk to the same mailboxes the window is signed into.
#
# The plugin is cloned, not packaged, so nothing else can put a binary in
# ~/.local/bin or a skill in ~/.agents/skills. A symlink back to this checkout
# means an update of the plugin is an update of both, and a development
# `make install` is too.
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
else
  ln -sf "$source" "$target"
fi

# The binary is what a terminal runs. The skill is what an agent reads first.
# Same rule as the command: a symlink is ours to refresh; a regular file is
# somebody else's and is left alone.
skill_source="$plugin_dir/agents"
[ -f "$skill_source/SKILL.md" ] || fail 'register-cli.sh: agents/SKILL.md is missing'
skill_home="${HOME:?}/.agents/skills"
mkdir -p "$skill_home"
skill_target="$skill_home/omamail"
if [ -e "$skill_target" ] && [ ! -L "$skill_target" ]; then
  printf '%s\n' "omamail: $skill_target already exists; not replacing" >&2
else
  ln -sfn "$skill_source" "$skill_target"
fi
