#!/bin/sh
# Install the published Omamail app for the current user. No sudo required.
set -eu

version="${OMAMAIL_VERSION:-latest}"
destination="${OMAMAIL_INSTALL_DIR:-}"
uninstall=0
usage() {
  printf '%s\n' 'Usage: install.sh [--version VERSION] [--dir DIRECTORY] [--uninstall]' \
    'Defaults: latest release; ~/Applications on macOS, ~/.local on Linux.'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version|--dir)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      if [ "$1" = --version ]; then version="$2"; else destination="$2"; fi
      shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
die() { printf 'Omamail: %s\n' "$*" >&2; exit 1; }
case "$(uname -s):$(uname -m)" in
  Darwin:arm64|Darwin:aarch64) platform=macos; target=macos-aarch64; destination="${destination:-$HOME/Applications}" ;;
  Darwin:*) die 'macOS releases are for Apple silicon only.' ;;
  Linux:x86_64|Linux:amd64) platform=linux; target=linux-x86_64; destination="${destination:-$HOME/.local}" ;;
  Linux:*) die 'Linux releases are for x86_64 only.' ;;
  *) die 'Use install.ps1 on Windows. This script supports macOS and Linux.' ;;
esac
app="$destination/Omamail.app"
if [ "$platform" = linux ]; then
  app="$destination/share/omamail/Omamail"
  link="$destination/bin/omamail-app"
  desktop="$destination/share/applications/dev.huacnlee.omamail.desktop"
fi

# The Qt-era app (0.12 and earlier) on Linux: its directory, its desktop
# entry, and its `omamail` link while that still points into it. Accounts and
# settings are shared with this app and stay.
remove_qt_app() {
  [ "$platform" = linux ] || return 0
  legacy="$HOME/.local/omamail.app"
  if [ -L "$HOME/.local/bin/omamail" ]; then
    case "$(readlink "$HOME/.local/bin/omamail")" in "$legacy"/*) rm -f "$HOME/.local/bin/omamail" ;; esac
  fi
  rm -f "$HOME/.local/share/applications/omamail.desktop"
  rm -rf "$legacy" "$legacy.previous"
}
refresh_launchers() {
  if command -v update-desktop-database >/dev/null; then
    update-desktop-database "$destination/share/applications" >/dev/null 2>&1 || true
  fi
}

if [ "$uninstall" = 1 ]; then
  rm -rf "$app"
  if [ "$platform" = linux ]; then
    rm -f "$link" "$desktop"
    rmdir "$destination/share/omamail" 2>/dev/null || true
    remove_qt_app
    refresh_launchers
  fi
  printf 'Removed Omamail. Accounts and settings were kept.\n'
  exit 0
fi

for tool in curl tar awk; do command -v "$tool" >/dev/null || die "Required command missing: $tool"; done
download() { curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location "$@"; }
repo=https://github.com/huacnlee/omamail
if [ "$version" = latest ]; then
  release_url="$(download --output /dev/null --write-out '%{url_effective}' "$repo/releases/latest")"
  version="${release_url##*/}"
fi
version="${version#v}"
awk -v version="$version" 'BEGIN {exit !(version ~ /^[0-9]+\.[0-9]+\.[0-9]+$/)}' \
  || die 'Version must be a release version such as 0.13.0 or v0.13.0.'
asset="Omamail-$version-$target.tar.gz"
base="$repo/releases/download/v$version"
work="$(mktemp -d "${TMPDIR:-/tmp}/omamail-install.XXXXXXXX")"
trap 'rm -rf "$work"' 0
printf 'Downloading Omamail %s for %s…\n' "$version" "$target"
download "$base/$asset" --output "$work/$asset" \
  || die "Could not download $asset. Releases before 0.13.0 are not installed by this script."
download "$base/SHA256SUMS" --output "$work/SHA256SUMS"
expected="$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1 }' "$work/SHA256SUMS")"
[ "${#expected}" -eq 64 ] || die "Missing or invalid checksum for $asset"
case "$expected" in *[!a-fA-F0-9]*) die "Missing or invalid checksum for $asset" ;; esac
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$work/$asset")"
elif command -v shasum >/dev/null; then
  actual="$(shasum -a 256 "$work/$asset")"
else die 'Required command missing: sha256sum or shasum'; fi
[ "${actual%% *}" = "$expected" ] || die 'Checksum verification failed; nothing was installed.'

# Only plain files and directories, inside the app's one top-level directory.
top=Omamail; [ "$platform" = macos ] && top=Omamail.app
tar -tzf "$work/$asset" > "$work/entries"
tar -tvzf "$work/$asset" > "$work/listing"
if awk -v top="$top" '!($0 == top || index($0, top "/") == 1) || /(^|\/)\.\.(\/|$)/ {bad=1} END {exit !bad}' "$work/entries" \
  || awk '!/^[-d]/ {bad=1} END {exit !bad}' "$work/listing"; then
  die 'Release archive contains an unsafe path.'
fi
mkdir "$work/unpacked"
tar -xzf "$work/$asset" -C "$work/unpacked"

if [ "$platform" = macos ]; then
  [ -x "$work/unpacked/Omamail.app/Contents/MacOS/Omamail" ] && [ -f "$work/unpacked/Omamail.app/Contents/Info.plist" ] \
    || die 'Release archive is missing Omamail.app.'
  mkdir -p "$destination"
  staging="$(mktemp -d "$destination/.omamail-install.XXXXXXXX")"
  trap 'rm -rf "$work" "${staging:-}"' 0
  ditto "$work/unpacked/Omamail.app" "$staging/Omamail.app"
else
  for file in Omamail nsh/app.json nsh/bundle.nshc dev.huacnlee.omamail.desktop dev.huacnlee.omamail.png; do
    [ -f "$work/unpacked/Omamail/$file" ] || die "Release archive is missing $file."
  done
  mkdir -p "$(dirname "$app")" "$destination/bin" "$destination/share/applications"
  staging="$(mktemp -d "$(dirname "$app")/.omamail-install.XXXXXXXX")"
  trap 'rm -rf "$work" "${staging:-}"' 0
  cp -R "$work/unpacked/Omamail" "$staging/Omamail"
fi
# Replace the app as a unit; put the previous version back if that fails.
previous="$staging/previous"
if [ -e "$app" ]; then mv "$app" "$previous"; fi
if ! mv "$staging/$(basename "$app")" "$app"; then
  if [ -e "$previous" ]; then mv "$previous" "$app"; fi
  die 'Could not replace the installed app; the previous version was kept.'
fi

if [ "$platform" = macos ]; then
  printf 'Installed %s\nOpen it from Finder. Omamail updates itself from then on.\n' "$app"
  exit 0
fi
# The packaged desktop entry names the runner and icon relative to the app;
# the installed one names them where they are.
awk -v exec="$app/Omamail" -v icon="$app/dev.huacnlee.omamail.png" '
  /^Exec=/ { print "Exec=\"" exec "\""; next }
  /^Icon=/ { print "Icon=" icon; next }
  /^TryExec=/ { next }
  { print }
' "$app/dev.huacnlee.omamail.desktop" > "$staging/desktop"
mv -f "$staging/desktop" "$desktop"
chmod 644 "$desktop"
ln -sfn "$app/Omamail" "$link"
remove_qt_app
refresh_launchers
printf 'Installed %s\nLaunch Omamail from your app launcher, or run %s. It updates itself from then on.\n' "$app" "$link"
printf '%s\n' 'Linux requires glibc 2.39+, GTK 4.14+ and WebKitGTK 6.0.'
