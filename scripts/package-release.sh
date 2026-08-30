#!/usr/bin/env bash
# Assemble a release artifact for the standalone client.
#
#   scripts/package-release.sh <platform> <binary> <output-dir>
#
# Platforms are `linux-x86_64` and `macos-arm64`, which are the two the release
# workflow builds on runners of their own architecture.
#
# **A binary on its own does not run.** `application_dir` in `src/lib.rs` looks
# for `app/gpui-shell.json` beside the executable, and the effect host reads its
# helpers out of `scripts/` beside that `app/` — the transport every IMAP and
# Gmail request goes through is one of them. So an artifact is the binary, the
# window's whole `app/` directory, and the helpers it shells out to, arranged
# where the resolver already looks:
#
#   linux-x86_64   omamail-<version>-linux-x86_64/
#                    bin/omamail          <- <prefix>/share/app is candidate two
#                    share/app/…
#                    share/scripts/…
#
#   macos-arm64    Omamail.app/Contents/
#                    MacOS/omamail        <- Resources/app is candidate one
#                    Resources/app/…
#                    Resources/scripts/…
#                    Info.plist
#
# Neither layout asks anything new of `application_dir`: the Unix prefix is the
# one a user can copy into /usr/local or ~/.local and have keep working, and the
# bundle is what macOS needs to show a name and an icon rather than a process.
set -euo pipefail

fail() { printf 'package-release: %s\n' "$1" >&2; exit 1; }

platform="${1-}"
binary="${2-}"
output_dir="${3-}"
[ -n "$platform" ] && [ -n "$binary" ] && [ -n "$output_dir" ] \
  || fail "usage: scripts/package-release.sh <platform> <binary> <output-dir>"
[ -f "$binary" ] || fail "no binary at $binary"

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The manifest version, because that is the version the tag was checked against
# and the one Omarchy installs. The binaries are named for the same release.
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$project_dir/manifest.json" | head -1)"
[ -n "$version" ] || fail "manifest.json carries no version"

# The application identity `gpui_shell::set_bundle_id` is given, which is what
# names the storage directory: a bundle claiming a different one would be a
# second installation as far as macOS and the store are concerned.
app_id="$(sed -n 's/.*APP_ID: &str = "\([^"]*\)".*/\1/p' "$project_dir/src/lib.rs" | head -1)"
[ -n "$app_id" ] || fail "src/lib.rs carries no APP_ID"

# What the host actually runs. Not the whole of `scripts/`: bump.sh and
# release-notes.sh are this repository's own tooling, and open-attachment.py and
# the config and keyring stores belong to the QML plugin, which installs itself
# by being cloned.
runtime_scripts=(
  attachment.sh
  contact-suggestions.py
  image-fetch.sh
  mail-transport.sh
  unsubscribe.sh
)

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

case "$platform" in
  linux-*)
    root="$staging/omamail-$version-$platform"
    binary_dir="$root/bin"
    resources="$root/share"
    ;;
  macos-*)
    root="$staging/Omamail.app"
    binary_dir="$root/Contents/MacOS"
    resources="$root/Contents/Resources"
    ;;
  *) fail "unknown platform $platform" ;;
esac

mkdir -p "$binary_dir" "$resources"
install -m 755 "$binary" "$binary_dir/omamail"
cp -R "$project_dir/app" "$resources/app"
mkdir -p "$resources/scripts"
for script in "${runtime_scripts[@]}"; do
  install -m 755 "$project_dir/scripts/$script" "$resources/scripts/$script"
done
install -m 644 "$project_dir/LICENSE" "$resources/LICENSE"

# Editor scaffolding is not part of a window. The type declarations and the
# jsconfig are read by tsc and by an editor; nothing loads them at run time.
find "$resources/app" \
  \( -name '*.d.ts' -o -name 'jsconfig.json' -o -name '*.fixture.js' \) \
  -delete

if [ -d "$root/Contents" ]; then
  cat >"$root/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleDisplayName</key>
	<string>Omamail</string>
	<key>CFBundleExecutable</key>
	<string>omamail</string>
	<key>CFBundleIdentifier</key>
	<string>$app_id</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Omamail</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$version</string>
	<key>CFBundleVersion</key>
	<string>$version</string>
	<key>LSMinimumSystemVersion</key>
	<string>11.0</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
PLIST
fi

mkdir -p "$output_dir"
archive="$(cd "$output_dir" && pwd)/omamail-$version-$platform.tar.gz"
# Plain tar, because the two platforms do not ship the same one: macOS has
# bsdtar and the GNU options that would make this byte-reproducible are not
# among the ones it takes.
tar -czf "$archive" -C "$staging" "$(basename "$root")"
printf '%s\n' "$archive"
