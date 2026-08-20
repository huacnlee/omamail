#!/usr/bin/env bash
set -euo pipefail

# The inverse of install.sh: take the marketplace clone back out of
# plugin-backups and put it where the shell loads omamail from. The checkout
# that install.sh pointed at is left alone.

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_id="omamail"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
plugin_home="$config_home/omarchy/plugins"
install_path="$plugin_home/$plugin_id"
backup_home="$config_home/omarchy/plugin-backups"
restart_shell=true

usage() { printf 'Usage: %s [--no-restart]\n' "$0"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-restart) restart_shell=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

command -v omarchy >/dev/null 2>&1 || {
  printf '%s\n' 'omarchy is required to restore this plugin.' >&2
  exit 1
}

# Newest backup by the timestamp install.sh put in the name. A glob that
# matches nothing must not become a literal.
shopt -s nullglob
backups=("$backup_home/$plugin_id.bak."*)
shopt -u nullglob
if (( ${#backups[@]} == 0 )); then
  printf '%s\n' "No backup under $backup_home. install.sh has not been run here." >&2
  exit 1
fi
# Lexical order matches the timestamp format %Y%m%d%H%M%S.
backup_path="${backups[-1]}"

if [[ -d "$install_path" && ! -L "$install_path" ]]; then
  printf '%s\n' "Omamail at $install_path is already a real install, not a symlink." >&2
  exit 1
fi

if [[ -L "$install_path" ]]; then
  current="$(readlink -f "$install_path")"
  if [[ "$current" != "$project_dir" ]]; then
    printf 'The symlink at %s points at %s, not this checkout.\n' \
      "$install_path" "$current" >&2
    exit 1
  fi
  rm "$install_path"
elif [[ -e "$install_path" ]]; then
  printf '%s\n' "$install_path exists and is not a symlink. Refusing to replace it." >&2
  exit 1
fi

mv "$backup_path" "$install_path"
printf 'Restored %s to %s\n' "$backup_path" "$install_path"

if $restart_shell; then
  printf '%s\n' 'Restarting Omarchy shell…'
  omarchy restart shell
fi

omarchy-shell shell rescanPlugins
omarchy plugin enable "$plugin_id"

printf 'Omamail is the marketplace install again.\n'
printf '%s\n' 'This checkout was not deleted.'
