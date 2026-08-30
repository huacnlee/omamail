#!/usr/bin/env bash
# What a release artifact has to contain to be a working mail client.
#
# The binary alone is not one: it finds the window through `application_dir`,
# and the effect host shells out to helpers beside it. Both facts live in Rust,
# so the checks here read them out of the sources rather than repeating them —
# a script added to `src/` and forgotten here would otherwise ship an artifact
# whose IMAP requests have nothing to run.
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/omamail-package-test.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM HUP

failures=0
ok() { printf '  ok   %s\n' "$1"; }
bad() {
  printf '  FAIL %s\n' "$1"
  failures=$((failures + 1))
}
check() {
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1"
    printf '         expected: %s\n' "$3"
    printf '         actual:   %s\n' "$2"
  fi
}
present() {
  if [ -e "$2" ]; then ok "$1"; else bad "$1"; printf '         missing: %s\n' "$2"; fi
}

version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$project_dir/manifest.json" | head -1)"
app_id="$(sed -n 's/.*APP_ID: &str = "\([^"]*\)".*/\1/p' "$project_dir/src/lib.rs" | head -1)"

printf '#!/bin/sh\nprintf stand-in\n' >"$work/omamail"
chmod +x "$work/omamail"

for platform in linux-x86_64 macos-arm64; do
  archive="$(bash "$project_dir/scripts/package-release.sh" "$platform" "$work/omamail" "$work/$platform")"
  check "$platform is named for the manifest version" \
    "$(basename "$archive")" "omamail-$version-$platform.tar.gz"
  mkdir -p "$work/$platform/unpacked"
  tar xzf "$archive" -C "$work/$platform/unpacked"

  if [ "$platform" = "linux-x86_64" ]; then
    root="$work/$platform/unpacked/omamail-$version-$platform"
    binary="$root/bin/omamail"
    resources="$root/share"
  else
    root="$work/$platform/unpacked/Omamail.app"
    binary="$root/Contents/MacOS/omamail"
    resources="$root/Contents/Resources"
  fi

  # The layout is only correct relative to the binary: this is the arrangement
  # `application_dir` resolves, and `tests/application_contract.rs` holds the
  # resolver to the same two shapes from the other side.
  present "$platform ships the executable where the bundle expects it" "$binary"
  [ -x "$binary" ] && ok "$platform ships it executable" || bad "$platform ships it executable"
  present "$platform carries the window" "$resources/app/gpui-shell.json"
  present "$platform carries the window's entry point" "$resources/app/main.js"
  present "$platform carries the icons the window draws" "$resources/app/assets/icons/reply.svg"
  present "$platform carries the licence" "$resources/LICENSE"

  # Every helper the host builds a path to, found rather than listed: the
  # artifact ships what `src/` runs, whatever that becomes. `join("scripts/…")`
  # is the match rather than the bare name, because the sources name others in
  # prose — the companion script and the mailto handler belong to the desktop
  # that installs the plugin, not to this binary.
  for script in $(grep -ohE 'join\("scripts/[a-z-]+\.(sh|py)"\)' "$project_dir"/src/*.rs \
    | sed -E 's/^join\("//; s/"\)$//' | sort -u); do
    present "$platform carries $script" "$resources/$script"
    [ -x "$resources/$script" ] \
      && ok "$platform ships $script executable" \
      || bad "$platform ships $script executable"
  done

  # Editor scaffolding is not part of a window, and app/gpui.d.ts alone is
  # bigger than everything else in the artifact put together.
  if find "$resources/app" -name '*.d.ts' | grep -q .; then
    bad "$platform leaves no type declarations behind"
  else
    ok "$platform leaves no type declarations behind"
  fi
done

# The bundle's identity is the one the process claims for itself. A plist
# naming a different id would be a second installation as far as macOS and the
# store are concerned.
plist="$work/macos-arm64/unpacked/Omamail.app/Contents/Info.plist"
present "the bundle carries an Info.plist" "$plist"
check "the bundle claims the identity the host sets" \
  "$(sed -n '/CFBundleIdentifier/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$plist")" "$app_id"
check "the bundle carries the manifest version" \
  "$(sed -n '/CFBundleShortVersionString/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$plist")" "$version"
check "the bundle names the executable it ships" \
  "$(sed -n '/CFBundleExecutable/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$plist")" "omamail"
# A handler declared here is a promise the router cannot keep off Linux: the
# command socket is Linux's, and nothing in this process answers an Apple event.
# See the report in the pull request rather than adding one here.
if grep -q CFBundleURLTypes "$plist"; then
  bad "the bundle claims no URL scheme it cannot answer"
else
  ok "the bundle claims no URL scheme it cannot answer"
fi

if [ "$failures" -eq 0 ]; then
  printf 'test_package_release.sh ok\n'
else
  printf 'test_package_release.sh: %s failed\n' "$failures" >&2
  exit 1
fi
