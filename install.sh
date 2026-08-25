#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_id="omamail"
old_plugin_id="gmail.omarchy"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
plugin_home="$config_home/omarchy/plugins"
install_path="$plugin_home/$plugin_id"
old_install_path="$plugin_home/$old_plugin_id"
# Backups must live outside the plugins directory. Omarchy scans every
# subdirectory of it for a manifest, so a backup left alongside the install is
# a second plugin with the same id — and the shell then loads the stale copy.
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
  printf '%s\n' 'omarchy is required to install this plugin.' >&2
  exit 1
}

# None of these are hard requirements for installing: the window opens without
# them and the setup page names whichever is missing. Installing them is the
# user's call, and this script never does it for them.
# socat, openssl and xdg-open are the Google sign-in; curl is every IMAP
# mailbox; secret-tool holds the secret either way.
missing=()
for tool in socat secret-tool openssl xdg-open curl; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if (( ${#missing[@]} )); then
  printf 'Note: %s not on PATH. Signing in to a mailbox needs them.\n' "${missing[*]}" >&2
fi

printf '%s\n' 'Validating plugin…'
omarchy plugin validate "$project_dir"

"$project_dir/scripts/migrate-storage.sh"

mkdir -p "$plugin_home"
if [[ ! -e "$install_path" && ! -L "$install_path" \
    && ( -e "$old_install_path" || -L "$old_install_path" ) ]]; then
  mv "$old_install_path" "$install_path"
fi
if [[ -L "$install_path" && "$(readlink -f "$install_path")" == "$project_dir" ]]; then
  :
elif [[ -e "$install_path" || -L "$install_path" ]]; then
  mkdir -p "$backup_home"
  backup_path="$backup_home/$plugin_id.bak.$(date +%Y%m%d%H%M%S)"
  mv "$install_path" "$backup_path"
  printf 'Backed up the previous install to %s\n' "$backup_path"
  ln -s "$project_dir" "$install_path"
else
  ln -s "$project_dir" "$install_path"
fi

if $restart_shell; then
  printf '%s\n' 'Restarting Omarchy shell…'
  omarchy restart shell
fi

printf '%s\n' 'Registering Omamail in the bar…'
omarchy-shell shell rescanPlugins
omarchy plugin enable "$plugin_id"

printf '%s\n' 'Registering Omamail as the mailto handler…'
"$project_dir/scripts/install-mailto.sh" "$install_path" --claim-default

printf 'Omamail installed for development at %s\n' "$install_path"
printf '%s\n' 'Click the envelope in the bar. QML edits are read through the symlink.'
