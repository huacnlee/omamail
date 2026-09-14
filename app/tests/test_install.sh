#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
installer="$repo_root/install.sh"
temp=$(mktemp -d "${TMPDIR:-/tmp}/omamail-install-test-XXXXXX")
trap 'rm -rf "$temp"' EXIT HUP INT TERM

export HOME="$temp/home"
export OMAMAIL_INSTALL_TEST_MODE=1
export OMAMAIL_TEST_OS=Linux
export OMAMAIL_TEST_ARCH=x86_64
export OMAMAIL_TEST_SKIP_GLIBC=1
export OMAMAIL_INSTALL_ROOT="$temp/install/omamail.app"
export OMAMAIL_BIN_DIR="$temp/install/bin"
export OMAMAIL_DESKTOP_DIR="$temp/install/applications"
export OMAMAIL_LAUNCH_LOG="$temp/launched"
mkdir -p "$HOME" "$temp/fixtures"

make_archive() {
  output=$1
  kind=$2
  release_version=$3
  python3 - "$output" "$kind" "$release_version" <<'PY'
import io, json, plistlib, struct, tarfile, sys

def elf(machine=62):
    value = bytearray(64)
    value[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<H", value, 16, 2)
    struct.pack_into("<H", value, 18, machine)
    struct.pack_into("<I", value, 20, 1)
    return bytes(value)

def macho(cpu=0x0100000c):
    return struct.pack("<IIIIIIII", 0xfeedfacf, cpu, 0, 2, 0, 0, 0, 0)

output, kind, version = sys.argv[1:]
if kind in ("mac-valid", "mac-mailto", "mac-missing-info", "mac-wrong-arch"):
    top = "Omamail.app"
    plist = {
        "CFBundleIdentifier": "com.omamail.app",
        "CFBundleExecutable": "omamail-app",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version,
    }
    if kind == "mac-mailto":
        plist["CFBundleURLTypes"] = [{"CFBundleURLSchemes": ["mailto"]}]
    entries = {
        "Contents/MacOS/omamail-app": macho(),
        "Contents/MacOS/omamail": macho(),
        "Contents/Resources/qml/Main.qml": b"import QtQuick\nItem {}\n",
        "Contents/Resources/ui/Service.qml": b"import QtQuick\nItem {}\n",
        "Contents/Resources/manifest.json": json.dumps({"version": version}).encode(),
        "Contents/Resources/omamail.icns": b"icon",
        "Contents/PlugIns/platforms/libqcocoa.dylib": macho(),
        "Contents/Resources/release.json": json.dumps({
            "schemaVersion": 1, "name": "omamail", "version": version,
            "target": "macos-aarch64", "topLevel": top,
        }, separators=(",", ":")).encode(),
        "Contents/Info.plist": plistlib.dumps(plist),
        "Contents/Frameworks/Fixture.framework/Versions/A/Fixture": b"framework",
        "marker": b"mac-valid",
    }
    if kind == "mac-missing-info":
        del entries["Contents/Info.plist"]
    elif kind == "mac-wrong-arch":
        entries["Contents/MacOS/omamail-app"] = macho(0x01000007)
    with tarfile.open(output, "w:gz") as package:
        for relative, contents in entries.items():
            info = tarfile.TarInfo(f"{top}/{relative}")
            info.size = len(contents)
            info.mode = 0o755 if relative.startswith("Contents/MacOS/") else 0o644
            package.addfile(info, io.BytesIO(contents))
        link = tarfile.TarInfo(f"{top}/Contents/Frameworks/Fixture.framework/Versions/Current")
        link.type = tarfile.SYMTYPE
        link.linkname = "A"
        package.addfile(link)
    raise SystemExit(0)
top = "wrong.app" if kind == "top-level" else "omamail.app"
target = "macos-aarch64" if kind == "target" else "linux-x86_64"
metadata_version = "9.9.9" if kind == "version" else version
entries = {
    "bin/omamail-app": elf(),
    "bin/omamail": elf(),
    "bin/qt.conf": b"[Paths]\nPrefix=..\nPlugins=plugins\nQmlImports=qml\n",
    "qml/Main.qml": b"import QtQuick\nItem {}\n",
    "ui/Service.qml": b"import QtQuick\nItem {}\n",
    "manifest.json": json.dumps({"version": metadata_version}).encode(),
    "plugins/platforms/libqxcb.so": elf(),
    "share/applications/omamail.desktop": b"[Desktop Entry]\nExec=omamail\nIcon=omamail\n",
    "share/icons/hicolor/scalable/apps/omamail.svg": b"<svg/>",
    "release.json": json.dumps({
        "schemaVersion": 1, "version": metadata_version,
        "name": "omamail", "target": target, "topLevel": top,
    }, separators=(",", ":")).encode(),
    "marker": kind.encode(),
}
if kind == "linux-mailto":
    entries["share/applications/omamail.desktop"] = (
        b"[Desktop Entry]\nExec=omamail\nIcon=omamail\n"
        b"MimeType=x-scheme-handler/mailto;\n"
    )
elif kind == "wrong-binary-arch":
    entries["bin/omamail-app"] = elf(183)
if kind == "missing":
    del entries["bin/omamail"]
with tarfile.open(output, "w:gz") as package:
    for relative, contents in entries.items():
        info = tarfile.TarInfo(f"{top}/{relative}")
        info.size = len(contents)
        info.mode = 0o755 if relative in ("bin/omamail-app", "bin/omamail") else 0o644
        package.addfile(info, io.BytesIO(contents))
    if kind == "duplicate":
        contents = entries["bin/omamail-app"]
        info = tarfile.TarInfo(f"{top}/bin/omamail-app")
        info.size = len(contents)
        info.mode = 0o755
        package.addfile(info, io.BytesIO(contents))
    elif kind == "traversal":
        contents = b"escape"
        info = tarfile.TarInfo(f"{top}/../escaped")
        info.size = len(contents)
        package.addfile(info, io.BytesIO(contents))
    elif kind == "absolute":
        contents = b"escape"
        info = tarfile.TarInfo("/tmp/omamail-installer-escape")
        info.size = len(contents)
        package.addfile(info, io.BytesIO(contents))
    elif kind == "symlink":
        info = tarfile.TarInfo(f"{top}/escape")
        info.type = tarfile.SYMTYPE
        info.linkname = "../../outside"
        package.addfile(info)
    elif kind == "special":
        info = tarfile.TarInfo(f"{top}/pipe")
        info.type = tarfile.FIFOTYPE
        package.addfile(info)
PY
}

write_sums() {
  archive=$1
  mode=${2:-good}
  sums=$archive.SHA256SUMS
  if [ "$mode" = bad ]; then
    digest=0000000000000000000000000000000000000000000000000000000000000000
  elif command -v sha256sum >/dev/null 2>&1; then
    digest=$(sha256sum "$archive" | awk '{print $1}')
  else
    digest=$(shasum -a 256 "$archive" | awk '{print $1}')
  fi
  printf '%s  %s\n' "$digest" "$(basename -- "$archive")" > "$sums"
  printf '%s\n' "$sums"
}

install_archive() {
  archive=$1
  sums=$2
  version=$3
  "$installer" --archive "$archive" --checksums "$sums" --version "$version"
}

assert_old_install() {
  [ "$(cat "$OMAMAIL_INSTALL_ROOT/marker")" = valid ]
  [ "$(readlink "$OMAMAIL_BIN_DIR/omamail")" = "$OMAMAIL_INSTALL_ROOT/bin/omamail-app" ]
  grep -Fq "Exec=\"$OMAMAIL_INSTALL_ROOT/bin/omamail-app\"" "$OMAMAIL_DESKTOP_DIR/omamail.desktop"
  [ ! -e "$OMAMAIL_LAUNCH_LOG" ]
  [ ! -e "$OMAMAIL_INSTALL_ROOT.previous" ]
  if find "$temp/install" -name '*.new.*' -print | grep -q .; then
    printf 'rollback left a temporary registration or installation artifact\n' >&2
    exit 1
  fi
}

valid="$temp/fixtures/valid.tar.gz"
make_archive "$valid" valid 0.10.1
valid_sums=$(write_sums "$valid")
install_archive "$valid" "$valid_sums" 0.10.1
assert_old_install

for kind in traversal absolute symlink special duplicate missing top-level target version linux-mailto wrong-binary-arch; do
  archive="$temp/fixtures/$kind.tar.gz"
  make_archive "$archive" "$kind" 0.10.1
  sums=$(write_sums "$archive")
  if install_archive "$archive" "$sums" 0.10.1 >"$temp/$kind.out" 2>"$temp/$kind.err"; then
    printf 'hostile archive was accepted: %s\n' "$kind" >&2
    exit 1
  fi
  assert_old_install
done

bad_checksum="$temp/fixtures/bad-checksum.tar.gz"
make_archive "$bad_checksum" valid 0.10.1
bad_sums=$(write_sums "$bad_checksum" bad)
if install_archive "$bad_checksum" "$bad_sums" 0.10.1 >"$temp/checksum.out" 2>"$temp/checksum.err"; then
  printf 'bad checksum was accepted\n' >&2
  exit 1
fi
assert_old_install

duplicate_sums="$temp/fixtures/duplicate-sums.txt"
cat "$valid_sums" "$valid_sums" > "$duplicate_sums"
if install_archive "$valid" "$duplicate_sums" 0.10.1 >"$temp/sums.out" 2>"$temp/sums.err"; then
  printf 'duplicate checksum entries were accepted\n' >&2
  exit 1
fi
assert_old_install

oversized_sums="$temp/fixtures/oversized-sums.txt"
python3 - "$oversized_sums" <<'PY'
import pathlib, sys
with pathlib.Path(sys.argv[1]).open("wb") as output:
    output.seek(1024 * 1024)
    output.write(b"x")
PY
if install_archive "$valid" "$oversized_sums" 0.10.1 >"$temp/oversized-sums.out" 2>"$temp/oversized-sums.err"; then
  printf 'oversized checksum file was accepted\n' >&2
  exit 1
fi
assert_old_install

oversized_archive="$temp/fixtures/oversized.tar.gz"
python3 - "$oversized_archive" <<'PY'
import pathlib, sys
with pathlib.Path(sys.argv[1]).open("wb") as output:
    output.seek(2 * 1024 * 1024 * 1024)
    output.write(b"x")
PY
oversized_archive_sums="$temp/fixtures/oversized-archive-sums.txt"
printf '%064d  %s\n' 0 "$(basename -- "$oversized_archive")" > "$oversized_archive_sums"
if install_archive "$oversized_archive" "$oversized_archive_sums" 0.10.1 >"$temp/oversized-archive.out" 2>"$temp/oversized-archive.err"; then
  printf 'oversized archive was accepted\n' >&2
  exit 1
fi
assert_old_install

if OMAMAIL_TEST_ARCH=aarch64 install_archive "$valid" "$valid_sums" 0.10.1 >"$temp/arch.out" 2>"$temp/arch.err"; then
  printf 'unsupported architecture was accepted\n' >&2
  exit 1
fi
export OMAMAIL_TEST_ARCH=x86_64
assert_old_install

curl_stub="$temp/curl-stub"
mkdir -p "$curl_stub"
cat > "$curl_stub/curl" <<'SH'
#!/bin/sh
printf 'untrusted partial response'
exit 60
SH
chmod 700 "$curl_stub/curl"
if PATH="$curl_stub:$PATH" "$installer" --version 0.10.1 >"$temp/curl.out" 2>"$temp/curl.err"; then
  printf 'curl transport failure was accepted\n' >&2
  exit 1
fi
grep -Fq 'curl failed with exit status 60' "$temp/curl.err"
assert_old_install

upgrade="$temp/fixtures/upgrade.tar.gz"
make_archive "$upgrade" upgrade 0.10.2
upgrade_sums=$(write_sums "$upgrade")
if OMAMAIL_TEST_FAIL_AFTER_REPLACE=1 install_archive "$upgrade" "$upgrade_sums" 0.10.2 >"$temp/rollback.out" 2>"$temp/rollback.err"; then
  printf 'injected transactional failure unexpectedly succeeded\n' >&2
  exit 1
fi
unset OMAMAIL_TEST_FAIL_AFTER_REPLACE
assert_old_install

install_archive "$upgrade" "$upgrade_sums" 0.10.2
[ "$(cat "$OMAMAIL_INSTALL_ROOT/marker")" = upgrade ]
[ ! -e "$OMAMAIL_LAUNCH_LOG" ]

user_data="$HOME/.config/omamail/accounts.json"
mkdir -p "$(dirname -- "$user_data")"
printf 'preserve me\n' > "$user_data"
"$installer" --uninstall
[ ! -e "$OMAMAIL_INSTALL_ROOT" ]
[ ! -e "$OMAMAIL_BIN_DIR/omamail" ]
[ ! -e "$OMAMAIL_DESKTOP_DIR/omamail.desktop" ]
[ "$(cat "$user_data")" = 'preserve me' ]
[ ! -e "$OMAMAIL_LAUNCH_LOG" ]

export OMAMAIL_TEST_OS=Darwin
export OMAMAIL_TEST_ARCH=arm64
export OMAMAIL_INSTALL_ROOT="$temp/install/Omamail.app"
xattr_stub="$temp/xattr"
xattr_log="$temp/xattr.log"
cat > "$xattr_stub" <<'SH'
#!/bin/sh
set -eu
[ "$#" -eq 3 ]
[ "$1" = -dr ]
[ "$2" = com.apple.quarantine ]
expected_parent=$(CDPATH= cd -- "$(dirname -- "$OMAMAIL_INSTALL_ROOT")" && pwd)
expected_prefix="$expected_parent/$(basename -- "$OMAMAIL_INSTALL_ROOT").new."
case "$3" in "$expected_prefix"[0-9]*) ;; *) exit 2 ;; esac
printf '%s\n' "$1" "$2" "$3" >> "$OMAMAIL_TEST_XATTR_LOG"
[ "${OMAMAIL_TEST_XATTR_FAIL:-0}" != 1 ]
SH
chmod 700 "$xattr_stub"
export OMAMAIL_TEST_XATTR_COMMAND="$xattr_stub"
export OMAMAIL_TEST_XATTR_LOG="$xattr_log"
mac_archive="$temp/fixtures/mac-valid.tar.gz"
make_archive "$mac_archive" mac-valid 0.10.1
mac_sums=$(write_sums "$mac_archive")
install_archive "$mac_archive" "$mac_sums" 0.10.1
[ "$(cat "$OMAMAIL_INSTALL_ROOT/marker")" = mac-valid ]
[ "$(readlink "$OMAMAIL_INSTALL_ROOT/Contents/Frameworks/Fixture.framework/Versions/Current")" = A ]
[ "$(sed -n '1p' "$xattr_log")" = -dr ]
[ "$(sed -n '2p' "$xattr_log")" = com.apple.quarantine ]
logged_xattr_target=$(sed -n '3p' "$xattr_log")
case "$logged_xattr_target" in "$(CDPATH= cd -- "$(dirname -- "$OMAMAIL_INSTALL_ROOT")" && pwd)/$(basename -- "$OMAMAIL_INSTALL_ROOT").new."[0-9]*) ;; *) exit 1 ;; esac
[ ! -e "$OMAMAIL_LAUNCH_LOG" ]
export OMAMAIL_TEST_XATTR_FAIL=1
if install_archive "$mac_archive" "$mac_sums" 0.10.1 >"$temp/xattr-failure.out" 2>"$temp/xattr-failure.err"; then
  printf 'macOS install succeeded after xattr failed\n' >&2
  exit 1
fi
unset OMAMAIL_TEST_XATTR_FAIL
grep -Fq 'could not clear macOS quarantine' "$temp/xattr-failure.err"
[ "$(cat "$OMAMAIL_INSTALL_ROOT/marker")" = mac-valid ]
[ ! -e "$OMAMAIL_INSTALL_ROOT.previous" ]
for kind in mac-mailto mac-missing-info mac-wrong-arch; do
  archive="$temp/fixtures/$kind.tar.gz"
  make_archive "$archive" "$kind" 0.10.1
  sums=$(write_sums "$archive")
  if install_archive "$archive" "$sums" 0.10.1 >"$temp/$kind.out" 2>"$temp/$kind.err"; then
    printf 'malformed macOS archive was accepted: %s\n' "$kind" >&2
    exit 1
  fi
  [ "$(cat "$OMAMAIL_INSTALL_ROOT/marker")" = mac-valid ]
  [ ! -e "$OMAMAIL_LAUNCH_LOG" ]
done
"$installer" --uninstall
[ ! -e "$OMAMAIL_INSTALL_ROOT" ]
[ "$(cat "$user_data")" = 'preserve me' ]

if grep -Eqi 'xdg-mime|defaultapps|url protocol' "$installer"; then
  printf 'installer contains an active handler-registration command\n' >&2
  exit 1
fi
grep -Fq -- '--globoff' "$installer"
grep -Fq -- '--max-filesize' "$installer"
grep -Fq -- '2147483648' "$installer"

printf 'Unix installer archive and rollback tests PASS\n'
