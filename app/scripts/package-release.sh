#!/bin/sh
set -eu

usage() {
  printf '%s\n' \
    'Usage: app/scripts/package-release.sh <macos-aarch64|linux-x86_64> [options]' \
    'Options: --host PATH --backend PATH --qml DIR --ui DIR --manifest PATH --dist DIR --qt-bin DIR'
}

[ "$#" -ge 1 ] || { usage >&2; exit 2; }
target=$1
shift
case "$target" in macos-aarch64|linux-x86_64) ;; *) printf 'unsupported release target: %s\n' "$target" >&2; exit 2 ;; esac

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
host=${OMAMAIL_APP_HOST:-"$repo_root/app/build/omamail-app"}
backend=${OMAMAIL_BACKEND:-"$repo_root/target/release/omamail"}
qml=${OMAMAIL_STANDALONE_QML:-"$repo_root/app/qml"}
ui=${OMAMAIL_SHARED_UI:-"$repo_root/ui"}
manifest=${OMAMAIL_MANIFEST:-"$repo_root/manifest.json"}
dist=${OMAMAIL_DIST:-"$repo_root/dist"}
qt_bin=${OMAMAIL_QT_BIN:-}
platform_plugin=${OMAMAIL_PLATFORM_PLUGIN:-}
test_layout=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) host=${2:?missing --host value}; shift 2 ;;
    --backend) backend=${2:?missing --backend value}; shift 2 ;;
    --qml) qml=${2:?missing --qml value}; shift 2 ;;
    --ui) ui=${2:?missing --ui value}; shift 2 ;;
    --manifest) manifest=${2:?missing --manifest value}; shift 2 ;;
    --dist) dist=${2:?missing --dist value}; shift 2 ;;
    --qt-bin) qt_bin=${2:?missing --qt-bin value}; shift 2 ;;
    --platform-plugin) platform_plugin=${2:?missing --platform-plugin value}; shift 2 ;;
    --test-layout) test_layout=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$test_layout" -eq 1 ] && [ "${OMAMAIL_PACKAGE_TEST_MODE:-0}" != 1 ]; then
  printf '%s\n' '--test-layout requires OMAMAIL_PACKAGE_TEST_MODE=1' >&2
  exit 2
fi

version=$(sed -n '/^\[package\]/,/^\[/s/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$repo_root/Cargo.toml" | head -n 1)
[ -n "$version" ] || { printf 'Cargo.toml has no package version\n' >&2; exit 1; }
manifest_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["version"])' "$manifest")
[ "$manifest_version" = "$version" ] || { printf 'manifest version %s does not match Cargo version %s\n' "$manifest_version" "$version" >&2; exit 1; }
[ -x "$host" ] || { printf 'standalone host is missing or not executable: %s\n' "$host" >&2; exit 1; }
[ -x "$backend" ] || { printf 'backend is missing or not executable: %s\n' "$backend" >&2; exit 1; }
[ -f "$qml/Main.qml" ] || { printf 'standalone QML is missing: %s/Main.qml\n' "$qml" >&2; exit 1; }
[ -f "$ui/Service.qml" ] || { printf 'shared UI is missing: %s/Service.qml\n' "$ui" >&2; exit 1; }
[ -f "$manifest" ] || { printf 'manifest is missing: %s\n' "$manifest" >&2; exit 1; }
if find "$qml" "$ui" -type l -print | grep -q .; then
  printf 'QML inputs must not contain symbolic links\n' >&2
  exit 1
fi

if [ "$test_layout" -eq 0 ]; then
  actual_os=$(uname -s); actual_arch=$(uname -m)
  case "$target:$actual_os:$actual_arch" in
    macos-aarch64:Darwin:arm64|macos-aarch64:Darwin:aarch64|linux-x86_64:Linux:x86_64|linux-x86_64:Linux:amd64) ;;
    *) printf 'target %s must be packaged on its native architecture; found %s %s\n' "$target" "$actual_os" "$actual_arch" >&2; exit 1 ;;
  esac
fi

mkdir -p "$dist"
stage=$(mktemp -d "$dist/.package-$target-XXXXXX")
extract=$(mktemp -d "$dist/.verify-$target-XXXXXX")
trap 'rm -rf "$stage" "$extract"' EXIT HUP INT TERM

copy_product_files() {
  destination=$1
  mkdir -p "$destination/qml" "$destination/ui" "$destination/licenses"
  cp -R "$qml/." "$destination/qml/"
  cp -R "$ui/." "$destination/ui/"
  cp "$manifest" "$destination/manifest.json"
  cp "$repo_root/app/assets/fonts/NerdFonts-LICENSE" "$destination/licenses/NerdFonts-LICENSE"
  cp "$repo_root/app/assets/fonts/NerdFonts-README.md" "$destination/licenses/NerdFonts-README.md"
  cp "$repo_root/app/assets/fonts/NerdFonts-PROVENANCE.md" "$destination/licenses/NerdFonts-PROVENANCE.md"
  cp -R "$repo_root/app/assets/fonts/licenses/." "$destination/licenses/"
  cat > "$destination/release.json" <<EOF
{"schemaVersion":1,"name":"omamail","version":"$version","target":"$target","topLevel":"$top_level"}
EOF
}

qt_query() {
  key=$1
  if [ -n "$qt_bin" ] && [ -x "$qt_bin/qtpaths6" ]; then qtpaths="$qt_bin/qtpaths6"
  elif command -v qtpaths6 >/dev/null 2>&1; then qtpaths=$(command -v qtpaths6)
  elif command -v qtpaths >/dev/null 2>&1; then qtpaths=$(command -v qtpaths)
  else printf 'qtpaths6 is required\n' >&2; return 1
  fi
  "$qtpaths" --query "$key"
}

if [ "$target" = macos-aarch64 ]; then
  top_level='Omamail.app'
  app="$stage/$top_level"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$app/Contents/PlugIns/platforms"
  cp "$host" "$app/Contents/MacOS/omamail-app"
  cp "$backend" "$app/Contents/MacOS/omamail"
  copy_product_files "$app/Contents/Resources"
  sed "s/__VERSION__/$version/g" "$repo_root/app/resources/macos/Info.plist" > "$app/Contents/Info.plist"
  cp "$repo_root/app/resources/macos/omamail.icns" "$app/Contents/Resources/omamail.icns"
  chmod 755 "$app/Contents/MacOS/omamail-app" "$app/Contents/MacOS/omamail"
  if [ "$test_layout" -eq 1 ]; then
    [ -f "$platform_plugin" ] || { printf 'test platform plugin is missing\n' >&2; exit 1; }
    cp "$platform_plugin" "$app/Contents/PlugIns/platforms/libqcocoa.dylib"
  else
    if [ -n "$qt_bin" ] && [ -x "$qt_bin/macdeployqt" ]; then deploy="$qt_bin/macdeployqt"
    else deploy=$(command -v macdeployqt || true)
    fi
    [ -n "$deploy" ] || { printf 'macdeployqt is required\n' >&2; exit 1; }
    qt_libs=$(qt_query QT_INSTALL_LIBS)
    [ -d "$qt_libs" ] || { printf 'Qt library directory is missing: %s\n' "$qt_libs" >&2; exit 1; }
    svg_framework="$qt_libs/QtSvg.framework/Versions/A/QtSvg"
    if [ -f "$svg_framework" ]; then
      svg_framework=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$svg_framework")
      svg_libs=$(dirname "$(dirname "$(dirname "$(dirname "$svg_framework")")")")
      "$deploy" "$app" -qmldir="$app/Contents/Resources" \
        -libpath="$qt_libs" -libpath="$svg_libs" -always-overwrite
    else
      "$deploy" "$app" -qmldir="$app/Contents/Resources" \
        -libpath="$qt_libs" -always-overwrite
    fi
    [ -f "$app/Contents/PlugIns/platforms/libqcocoa.dylib" ] || { printf 'macdeployqt omitted the Cocoa platform plugin\n' >&2; exit 1; }
    command -v codesign >/dev/null 2>&1 || { printf 'codesign is required\n' >&2; exit 1; }
    # macdeployqt rewrites Mach-O load commands, invalidating Homebrew's
    # ad-hoc signatures. Re-seal the self-contained bundle without an identity
    # so macOS can load it; this is not Developer ID signing or notarization.
    # No signing option is passed to macdeployqt: Qt 6.8 signs only when asked
    # and rejects the opt-out flag newer Qt added, while any ad-hoc signature a
    # newer Qt applies by default is replaced here anyway.
    codesign --force --deep --sign - "$app"
    codesign --verify --deep --strict "$app"
  fi
  archive="$dist/omamail-app-macos-aarch64.tar.gz"
else
  top_level=omamail.app
  app="$stage/$top_level"
  mkdir -p "$app/bin" "$app/lib" "$app/plugins/platforms" "$app/share/applications" \
    "$app/share/icons/hicolor/scalable/apps"
  cp "$host" "$app/bin/omamail-app"
  cp "$backend" "$app/bin/omamail"
  copy_product_files "$app"
  cp "$repo_root/app/resources/linux/omamail.desktop" "$app/share/applications/omamail.desktop"
  cp "$repo_root/app/resources/icons/omamail.svg" "$app/share/icons/hicolor/scalable/apps/omamail.svg"
  cat > "$app/bin/qt.conf" <<'EOF'
[Paths]
Prefix=..
Plugins=plugins
QmlImports=qml
EOF
  chmod 755 "$app/bin/omamail-app" "$app/bin/omamail"
  if [ "$test_layout" -eq 1 ]; then
    [ -f "$platform_plugin" ] || { printf 'test platform plugin is missing\n' >&2; exit 1; }
    cp "$platform_plugin" "$app/plugins/platforms/libqxcb.so"
  else
    command -v patchelf >/dev/null 2>&1 || { printf 'patchelf is required\n' >&2; exit 1; }
    qt_plugins=$(qt_query QT_INSTALL_PLUGINS)
    qt_qml=$(qt_query QT_INSTALL_QML)
    qt_libs=$(qt_query QT_INSTALL_LIBS)
    qt_libexecs=$(qt_query QT_INSTALL_LIBEXECS)
    [ -f "$qt_plugins/platforms/libqxcb.so" ] || { printf 'Qt xcb platform plugin is missing\n' >&2; exit 1; }
    for plugin_dir in platforms platforminputcontexts xcbglintegrations imageformats iconengines networkinformation tls; do
      [ ! -d "$qt_plugins/$plugin_dir" ] || cp -R "$qt_plugins/$plugin_dir" "$app/plugins/"
    done
    scanner="$qt_libexecs/qmlimportscanner"
    [ -x "$scanner" ] || scanner=$(command -v qmlimportscanner || true)
    [ -n "$scanner" ] || { printf 'qmlimportscanner is required\n' >&2; exit 1; }
    "$scanner" -rootPath "$qml" -importPath "$qt_qml" > "$stage/qml-app.json"
    "$scanner" -rootPath "$ui" -importPath "$qt_qml" > "$stage/qml-ui.json"
    python3 - "$qt_qml" "$app/qml" "$stage/qml-app.json" "$stage/qml-ui.json" <<'PY'
import json, pathlib, shutil, sys
qt_root = pathlib.Path(sys.argv[1]).resolve()
destination = pathlib.Path(sys.argv[2])
seen = set()
for inventory in sys.argv[3:]:
    for entry in json.loads(pathlib.Path(inventory).read_text()):
        value = entry.get("path")
        if not value:
            continue
        source = pathlib.Path(value).resolve()
        try:
            relative = source.relative_to(qt_root)
        except ValueError:
            continue
        if relative in seen:
            continue
        seen.add(relative)
        if not source.is_dir():
            raise SystemExit(f"QML import is missing: {source}")
        shutil.copytree(source, destination / relative, dirs_exist_ok=True, symlinks=False)
PY
    python3 - "$app" "$qt_libs" <<'PY'
import os, pathlib, shutil, subprocess, sys
app = pathlib.Path(sys.argv[1]).resolve()
qt_libs = pathlib.Path(sys.argv[2]).resolve()
libdir = app / "lib"
allowed = {
    "linux-vdso.so.1", "libc.so.6", "libm.so.6", "libdl.so.2", "librt.so.1",
    "libpthread.so.0", "libgcc_s.so.1", "libstdc++.so.6", "ld-linux-x86-64.so.2",
}
def binaries():
    for path in app.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        try:
            with path.open("rb") as source:
                if source.read(4) == b"\x7fELF":
                    yield path
        except OSError:
            pass
def dependencies(path):
    environment = dict(os.environ, LD_LIBRARY_PATH=os.pathsep.join((str(libdir), str(qt_libs))))
    result = subprocess.run(["ldd", str(path)], text=True, capture_output=True, env=environment)
    if result.returncode:
        raise SystemExit(f"ldd failed for {path}: {result.stderr.strip()}")
    for line in result.stdout.splitlines():
        fields = line.strip().split()
        if "not found" in line:
            raise SystemExit(f"unresolved library for {path}: {line.strip()}")
        candidate = fields[2] if len(fields) >= 3 and fields[1] == "=>" and fields[2].startswith("/") else None
        if candidate:
            yield pathlib.Path(candidate)
while True:
    changed = False
    for binary in list(binaries()):
        for dependency in dependencies(binary):
            if dependency.name in allowed or (libdir / dependency.name).exists():
                continue
            target = libdir / dependency.name
            shutil.copy2(dependency.resolve(), target)
            changed = True
    if not changed:
        break
for binary in binaries():
    relative = os.path.relpath(libdir, binary.parent)
    subprocess.run(["patchelf", "--set-rpath", "$ORIGIN/" + relative, str(binary)], check=True)
environment = dict(os.environ, LD_LIBRARY_PATH=str(libdir))
for binary in binaries():
    result = subprocess.run(["ldd", str(binary)], text=True, capture_output=True, env=environment)
    if result.returncode or "not found" in result.stdout:
        raise SystemExit(f"deployed library audit failed for {binary}")
    for line in result.stdout.splitlines():
        fields = line.strip().split()
        resolved = fields[2] if len(fields) >= 3 and fields[1] == "=>" and fields[2].startswith("/") else None
        if resolved and pathlib.Path(resolved).name not in allowed:
            try:
                pathlib.Path(resolved).resolve().relative_to(app)
            except ValueError:
                raise SystemExit(f"non-system library remains outside bundle: {resolved}")
PY
  fi
  archive="$dist/omamail-app-linux-x86_64.tar.gz"
fi

rm -f "$archive"
COPYFILE_DISABLE=1 tar -czf "$archive" -C "$stage" "$top_level"

if [ "$test_layout" -eq 0 ]; then
  tar -xzf "$archive" -C "$extract"
  if [ "$target" = macos-aarch64 ]; then
    packaged_host="$extract/Omamail.app/Contents/MacOS/omamail-app"
    packaged_backend="$extract/Omamail.app/Contents/MacOS/omamail"
    smoke_platform=cocoa
  else
    packaged_host="$extract/omamail.app/bin/omamail-app"
    packaged_backend="$extract/omamail.app/bin/omamail"
    smoke_platform=offscreen
  fi
  isolated="$extract/home"
  mkdir -p "$isolated/config" "$isolated/cache" "$isolated/state"
  HOME="$isolated" XDG_CONFIG_HOME="$isolated/config" XDG_CACHE_HOME="$isolated/cache" XDG_STATE_HOME="$isolated/state" \
    QT_QPA_PLATFORM="$smoke_platform" "$packaged_host" --check-resources
  ready="$extract/ready.json"
  HOME="$isolated" XDG_CONFIG_HOME="$isolated/config" XDG_CACHE_HOME="$isolated/cache" XDG_STATE_HOME="$isolated/state" \
    QT_QPA_PLATFORM="$smoke_platform" "$packaged_host" --smoke-test "$ready"
  [ -s "$ready" ] || { printf 'standalone smoke test did not write readiness metadata\n' >&2; exit 1; }
  backend_version=$($packaged_backend --version)
  [ "$backend_version" = "omamail $version" ] || { printf 'bundled backend version mismatch: %s\n' "$backend_version" >&2; exit 1; }
  HOME="$isolated" XDG_CONFIG_HOME="$isolated/config" XDG_CACHE_HOME="$isolated/cache" XDG_STATE_HOME="$isolated/state" \
    python3 "$repo_root/tests/test_backend_api.py" --standalone \
      --binary "$packaged_backend" --expected-version "$version"
fi

printf '%s\n' "$archive"
