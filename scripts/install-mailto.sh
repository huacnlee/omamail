#!/bin/sh
# Registers Omamail as the desktop handler for mailto: links.
#
# The plugin is not an installed application until this file exists: XDG only
# offers handlers that ship a .desktop claiming the scheme. The Exec path is
# this checkout, so a development symlink and a cloned install both work.
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

plugin_dir=${1:-}
claim_default=false
[ -n "$plugin_dir" ] || fail 'usage: install-mailto.sh <plugin-dir> [--claim-default]'
shift
while [ "$#" -gt 0 ]; do
  case "$1" in
    --claim-default) claim_default=true ;;
    *) fail 'usage: install-mailto.sh <plugin-dir> [--claim-default]' ;;
  esac
  shift
done
plugin_dir=$(cd "$plugin_dir" && pwd)
[ -x "$plugin_dir/scripts/mailto.sh" ] || fail 'install-mailto.sh: mailto.sh is missing'
[ -f "$plugin_dir/assets/omamail.svg" ] || fail 'install-mailto.sh: omamail.svg is missing'

data_home=${XDG_DATA_HOME:-${HOME:?}/.local/share}
apps="$data_home/applications"
mkdir -p "$apps"
desktop="$apps/omamail.desktop"
# First appearance on the machine claims mailto. Later starts refresh the
# Exec path and leave a default the user has since changed alone.
if [ ! -f "$desktop" ]; then
  claim_default=true
fi

cat > "$desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Omamail
Comment=Email client for Omarchy
Exec=$plugin_dir/scripts/mailto.sh %u
Icon=$plugin_dir/assets/omamail.svg
Terminal=false
StartupNotify=false
MimeType=x-scheme-handler/mailto;
Categories=Office;Network;Email;
EOF

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$apps" >/dev/null 2>&1 || true
fi

if [ "$claim_default" = true ]; then
  if command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime default omamail.desktop x-scheme-handler/mailto >/dev/null 2>&1 || true
  fi
  if command -v xdg-settings >/dev/null 2>&1; then
    xdg-settings set default-url-scheme-handler mailto omamail.desktop >/dev/null 2>&1 || true
  fi
fi
