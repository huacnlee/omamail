#!/bin/sh
set -eu

repository="huacnlee/omamail"
version="latest"
uninstall=0
archive_path="${OMAMAIL_BUNDLE_PATH:-}"
checksums_path="${OMAMAIL_SHA256SUMS_PATH:-}"

usage() {
  printf '%s\n' \
    'Usage: install.sh [--version <version>] [--archive <path> --checksums <path>] [--uninstall]' \
    'Installs the latest release unless an explicit version or local archive is selected.'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || { printf 'missing value for --version\n' >&2; exit 2; }; version=$2; shift 2 ;;
    --archive) [ "$#" -ge 2 ] || { printf 'missing value for --archive\n' >&2; exit 2; }; archive_path=$2; shift 2 ;;
    --checksums) [ "$#" -ge 2 ] || { printf 'missing value for --checksums\n' >&2; exit 2; }; checksums_path=$2; shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$version" in
  latest) requested_version=latest ;;
  v*) requested_version=${version#v} ;;
  *) requested_version=$version ;;
esac
case "$requested_version" in
  latest|[0-9]*.[0-9]*.[0-9]*) ;;
  *) printf 'invalid release version: %s\n' "$version" >&2; exit 2 ;;
esac
if [ "$requested_version" != latest ] && ! printf '%s\n' "$requested_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$'; then
  printf 'invalid release version: %s\n' "$version" >&2
  exit 2
fi

test_mode=${OMAMAIL_INSTALL_TEST_MODE:-0}
os=$(uname -s)
arch=$(uname -m)
if [ "$test_mode" = 1 ]; then
  os=${OMAMAIL_TEST_OS:-$os}
  arch=${OMAMAIL_TEST_ARCH:-$arch}
fi
case "$os:$arch" in
  Darwin:arm64|Darwin:aarch64)
    target=macos-aarch64
    top_level='Omamail.app'
    install_dir=${OMAMAIL_INSTALL_ROOT:-"$HOME/Applications/Omamail.app"}
    ;;
  Linux:x86_64|Linux:amd64)
    target=linux-x86_64
    top_level=omamail.app
    install_dir=${OMAMAIL_INSTALL_ROOT:-"$HOME/.local/omamail.app"}
    ;;
  *)
    printf 'unsupported platform: %s %s (published: macOS arm64, Linux x86_64)\n' "$os" "$arch" >&2
    exit 1
    ;;
esac

bin_dir=${OMAMAIL_BIN_DIR:-"$HOME/.local/bin"}
bin_link="$bin_dir/omamail"
desktop_dir=${OMAMAIL_DESKTOP_DIR:-"$HOME/.local/share/applications"}
desktop_file="$desktop_dir/omamail.desktop"

if [ "$uninstall" -eq 1 ]; then
  rm -rf "$install_dir" "$install_dir.previous"
  if [ "$os" = Linux ]; then
    rm -f "$bin_link" "$desktop_file"
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$desktop_dir" || true
  fi
  printf 'Omamail removed; user data was preserved.\n'
  exit 0
fi

if [ "$os" = Linux ] && [ "${OMAMAIL_TEST_SKIP_GLIBC:-0}" != 1 ]; then
  command -v ldd >/dev/null 2>&1 || { printf 'Omamail requires glibc >= 2.35.\n' >&2; exit 1; }
  ldd_line=$(ldd --version 2>&1 | head -n 1 || true)
  case "$ldd_line" in *musl*) printf 'Omamail requires glibc; musl is not supported.\n' >&2; exit 1 ;; esac
  glibc=$(printf '%s\n' "$ldd_line" | sed -n 's/.* \([0-9][0-9]*\.[0-9][0-9]*\)$/\1/p')
  [ -n "$glibc" ] || { printf 'could not confirm the installed glibc version.\n' >&2; exit 1; }
  major=${glibc%%.*}; minor=${glibc#*.}
  if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 35 ]; }; then
    printf 'Omamail requires glibc >= 2.35; found %s.\n' "$glibc" >&2
    exit 1
  fi
fi

command -v python3 >/dev/null 2>&1 || { printf 'python3 is required to validate the release archive.\n' >&2; exit 1; }
python3 - "$install_dir" "$bin_dir" "$desktop_dir" <<'PY'
import sys
for path in sys.argv[1:]:
    if not path or any(ord(character) < 32 or ord(character) == 127 for character in path):
        raise SystemExit("installation paths must not contain control characters")
PY
temp=$(mktemp -d "${TMPDIR:-/tmp}/omamail-install-XXXXXX")
chmod 700 "$temp"
bounded_copy="$temp/bounded-copy.py"
cat > "$bounded_copy" <<'PY'
import pathlib, sys

source_name, destination_name, limit_text, description = sys.argv[1:]
limit = int(limit_text)
destination = pathlib.Path(destination_name)
incoming = sys.stdin.buffer if source_name == "-" else open(source_name, "rb")
try:
    try:
        with destination.open("xb") as outgoing:
            total = 0
            while chunk := incoming.read(1024 * 1024):
                total += len(chunk)
                if total > limit:
                    raise ValueError(f"{description} is too large")
                outgoing.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
finally:
    if source_name != "-":
        incoming.close()
PY
chmod 600 "$bounded_copy"
bounded_download="$temp/bounded-download.py"
cat > "$bounded_download" <<'PY'
import pathlib, subprocess, sys

destination_name, limit_text, timeout_text, url = sys.argv[1:]
limit = int(limit_text)
timeout = int(timeout_text)
destination = pathlib.Path(destination_name)
curl = subprocess.Popen([
    "curl", "-q", "--globoff", "--fail", "--location",
    "--proto", "=https", "--proto-redir", "=https", "--tlsv1.2",
    "--connect-timeout", "15", "--max-time", str(timeout),
    "--max-filesize", str(limit), url,
], stdout=subprocess.PIPE)
try:
    try:
        with destination.open("xb") as output:
            total = 0
            while chunk := curl.stdout.read(1024 * 1024):
                total += len(chunk)
                if total > limit:
                    raise ValueError("release download is too large")
                output.write(chunk)
        status = curl.wait()
        if status != 0:
            raise RuntimeError(f"curl failed with exit status {status}")
        destination.chmod(0o600)
    except Exception:
        if curl.poll() is None:
            curl.kill()
        curl.wait()
        destination.unlink(missing_ok=True)
        raise
finally:
    if curl.stdout is not None:
        curl.stdout.close()
PY
chmod 600 "$bounded_download"
candidate="$install_dir.new.$$"
transaction_active=0
old_moved=0
new_moved=0
registration_started=0
committed=0
install_parent_created=0
bin_dir_created=0
desktop_dir_created=0
link_temp=
desktop_temp=
cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$transaction_active" -eq 1 ]; then
    set +e
    rollback
  fi
  [ -z "$link_temp" ] || rm -f "$link_temp"
  [ -z "$desktop_temp" ] || rm -f "$desktop_temp"
  rm -rf "$temp" "$candidate"
  if [ "$committed" -eq 0 ]; then
    [ "$desktop_dir_created" -eq 0 ] || rmdir "$desktop_dir" 2>/dev/null || true
    [ "$bin_dir_created" -eq 0 ] || rmdir "$bin_dir" 2>/dev/null || true
    [ "$install_parent_created" -eq 0 ] || rmdir "$(dirname -- "$install_dir")" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM
asset="omamail-app-$target.tar.gz"

if [ -n "$archive_path" ]; then
  [ -f "$archive_path" ] || { printf 'local release archive is missing: %s\n' "$archive_path" >&2; exit 1; }
  source_archive=$(CDPATH= cd -- "$(dirname -- "$archive_path")" && pwd)/$(basename -- "$archive_path")
  checksum_name=$(basename -- "$source_archive")
  if [ -z "$checksums_path" ]; then checksums_path="$(dirname -- "$source_archive")/SHA256SUMS"; fi
  [ -f "$checksums_path" ] || { printf 'SHA256SUMS is required for a local archive.\n' >&2; exit 1; }
  source_sums=$(CDPATH= cd -- "$(dirname -- "$checksums_path")" && pwd)/$(basename -- "$checksums_path")
  source_archive_bytes=$(wc -c < "$source_archive" | tr -d ' ')
  [ "$source_archive_bytes" -le 2147483648 ] || { printf 'release archive is too large.\n' >&2; exit 1; }
  source_sums_bytes=$(wc -c < "$source_sums" | tr -d ' ')
  [ "$source_sums_bytes" -le 1048576 ] || { printf 'checksum file is too large.\n' >&2; exit 1; }
  archive="$temp/local.tar.gz"
  sums="$temp/local.SHA256SUMS"
  python3 "$bounded_copy" "$source_archive" "$archive" 2147483648 'release archive'
  python3 "$bounded_copy" "$source_sums" "$sums" 1048576 'checksum file'
else
  command -v curl >/dev/null 2>&1 || { printf 'curl is required.\n' >&2; exit 1; }
  tag=$requested_version
  [ "$tag" = latest ] || tag="v$tag"
  if [ "$tag" = latest ]; then
    base="https://github.com/$repository/releases/latest/download"
  else
    base="https://github.com/$repository/releases/download/$tag"
  fi
  archive="$temp/$asset"
  sums="$temp/SHA256SUMS"
  printf 'Downloading %s...\n' "$asset"
  python3 "$bounded_download" "$archive" 2147483648 600 "$base/$asset"
  python3 "$bounded_download" "$sums" 1048576 60 "$base/SHA256SUMS"
  checksum_name=$asset
fi

expected=$(awk -v asset="$checksum_name" '
  BEGIN { count=0 }
  $1 ~ /^[0-9A-Fa-f]{64}$/ {
    name=$2; sub(/^\*/, "", name)
    if (name == asset) { value=tolower($1); count++ }
  }
  END { if (count == 1) print value }
' "$sums")
[ -n "$expected" ] || { printf 'SHA256SUMS must contain exactly one valid entry for %s.\n' "$checksum_name" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$archive" | awk '{print $1}')
else
  printf 'sha256sum or shasum is required to verify the release.\n' >&2
  exit 1
fi
[ "$actual" = "$expected" ] || { printf 'checksum mismatch for %s.\n' "$checksum_name" >&2; exit 1; }
archive_bytes=$(wc -c < "$archive" | tr -d ' ')
[ "$archive_bytes" -le 2147483648 ] || { printf 'release archive is too large.\n' >&2; exit 1; }

staging="$temp/extracted"
mkdir -m 700 "$staging"
python3 - "$archive" "$staging" "$top_level" "$target" "$requested_version" <<'PY'
import json, os, pathlib, plistlib, re, shutil, struct, sys, tarfile

archive, destination, expected_top, expected_target, requested_version = sys.argv[1:]
root = pathlib.Path(destination).resolve()
seen = set()
members = []
total = 0
with tarfile.open(archive, "r:gz") as package:
    for member in package:
        name = member.name
        if not name or name.startswith("/") or "\\" in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise SystemExit("release archive contains an unsafe path")
        raw_parts = name.rstrip("/").split("/")
        parts = pathlib.PurePosixPath(name).parts
        if (not parts or parts[0] != expected_top
                or any(part in ("", ".", "..") for part in raw_parts)):
            raise SystemExit("release archive has an unexpected top-level layout")
        folded = name.casefold().rstrip("/")
        if folded in seen:
            raise SystemExit("release archive contains duplicate entries")
        seen.add(folded)
        if not (member.isdir() or member.isfile() or member.issym()):
            raise SystemExit("release archive contains a link or special entry")
        if member.issym():
            link = member.linkname
            if (not link or link.startswith("/") or "\\" in link
                    or any(ord(c) < 32 or ord(c) == 127 for c in link)):
                raise SystemExit("release archive contains an unsafe link")
            link_target = pathlib.PurePosixPath(name).parent.joinpath(link)
            normalized = pathlib.PurePosixPath(os.path.normpath(str(link_target)))
            if not normalized.parts or normalized.parts[0] != expected_top or ".." in normalized.parts:
                raise SystemExit("release archive contains a link that escapes staging")
        if member.size < 0 or member.size > 512 * 1024 * 1024:
            raise SystemExit("release archive member is too large")
        total += member.size
        if total > 2 * 1024 * 1024 * 1024 or len(seen) > 4096:
            raise SystemExit("release archive exceeds extraction limits")
        members.append(member)
    for member in (item for item in members if not item.issym()):
        target = root.joinpath(*pathlib.PurePosixPath(member.name).parts)
        if os.path.commonpath((str(root), str(target.resolve(strict=False)))) != str(root):
            raise SystemExit("release archive path escapes staging")
        if member.isdir():
            target.mkdir(mode=0o700, parents=True, exist_ok=True)
            continue
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        source = package.extractfile(member)
        if source is None:
            raise SystemExit("release archive member could not be read")
        with source, target.open("xb") as output:
            shutil.copyfileobj(source, output, 1024 * 1024)
        target.chmod(0o700 if member.mode & 0o111 else 0o600)
    for member in (item for item in members if item.issym()):
        target = root.joinpath(*pathlib.PurePosixPath(member.name).parts)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.symlink_to(member.linkname)

base = root / expected_top
metadata_path = base / "release.json" if expected_target != "macos-aarch64" else base / "Contents/Resources/release.json"
def strict_json(path):
    if path.stat().st_size > 1024 * 1024:
        raise ValueError("metadata is too large")
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError(f"duplicate JSON property: {key}")
            result[key] = value
        return result
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=pairs)
try:
    metadata = strict_json(metadata_path)
except Exception as error:
    raise SystemExit(f"release metadata is missing or invalid: {error}")
if metadata != {"schemaVersion": 1, "name": "omamail", "version": metadata.get("version"), "target": expected_target, "topLevel": expected_top}:
    raise SystemExit("release metadata has invalid fields")
release_version = metadata.get("version")
if (not isinstance(release_version, str)
        or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?", release_version)):
    raise SystemExit("release metadata has no version")
if requested_version != "latest" and release_version != requested_version:
    raise SystemExit("release version does not match the requested version")
if expected_target == "macos-aarch64":
    required = [
        "Contents/MacOS/omamail-app", "Contents/MacOS/omamail",
        "Contents/Resources/qml/Main.qml", "Contents/Resources/ui/Service.qml",
        "Contents/Resources/manifest.json", "Contents/PlugIns/platforms/libqcocoa.dylib",
        "Contents/Resources/omamail.icns", "Contents/Info.plist",
    ]
    executable = required[:2]
else:
    required = [
        "bin/omamail-app", "bin/omamail", "bin/qt.conf", "qml/Main.qml", "ui/Service.qml",
        "manifest.json", "plugins/platforms/libqxcb.so",
        "share/applications/omamail.desktop", "share/icons/hicolor/scalable/apps/omamail.svg",
    ]
    executable = required[:2]
for relative in required:
    path = base / relative
    if not path.is_file() or path.is_symlink():
        raise SystemExit(f"release payload is missing {relative}")
for relative in executable:
    if not os.access(base / relative, os.X_OK):
        raise SystemExit(f"release executable is not executable: {relative}")
def has_expected_architecture(path, target):
    with path.open("rb") as binary:
        header = binary.read(4096)
    if target == "linux-x86_64":
        return (len(header) >= 20 and header[:7] == b"\x7fELF\x02\x01\x01"
                and struct.unpack_from("<H", header, 18)[0] == 62)
    thin = {
        b"\xcf\xfa\xed\xfe": "<",
        b"\xfe\xed\xfa\xcf": ">",
    }
    if header[:4] in thin:
        return (len(header) >= 8
                and struct.unpack_from(thin[header[:4]] + "I", header, 4)[0] == 0x0100000c)
    fat = {
        b"\xca\xfe\xba\xbe": (">", 20),
        b"\xbe\xba\xfe\xca": ("<", 20),
        b"\xca\xfe\xba\xbf": (">", 32),
        b"\xbf\xba\xfe\xca": ("<", 32),
    }
    if header[:4] not in fat or len(header) < 8:
        return False
    byte_order, record_size = fat[header[:4]]
    count = struct.unpack_from(byte_order + "I", header, 4)[0]
    if count < 1 or count > 64 or len(header) < 8 + count * record_size:
        return False
    return any(struct.unpack_from(byte_order + "I", header, 8 + index * record_size)[0]
               == 0x0100000c for index in range(count))
architecture_files = executable + (["Contents/PlugIns/platforms/libqcocoa.dylib"]
                                   if expected_target == "macos-aarch64"
                                   else ["plugins/platforms/libqxcb.so"])
for relative in architecture_files:
    if not has_expected_architecture(base / relative, expected_target):
        raise SystemExit(f"release binary has the wrong architecture: {relative}")
try:
    manifest = strict_json(base / ("Contents/Resources/manifest.json" if expected_target == "macos-aarch64" else "manifest.json"))
except Exception as error:
    raise SystemExit(f"release manifest is invalid: {error}")
if manifest.get("version") != release_version:
    raise SystemExit("release manifest version does not match release metadata")
if expected_target == "linux-x86_64":
    desktop_path = base / "share/applications/omamail.desktop"
    try:
        if desktop_path.stat().st_size > 1024 * 1024:
            raise ValueError("desktop entry is too large")
        desktop_text = desktop_path.read_text(encoding="utf-8", errors="strict")
    except Exception as error:
        raise SystemExit(f"Linux desktop entry is invalid: {error}")
    if re.search(r"mailto", desktop_text, re.IGNORECASE):
        raise SystemExit("Linux release must not register mailto handling")
if expected_target == "macos-aarch64":
    plist_path = base / "Contents/Info.plist"
    try:
        if plist_path.stat().st_size > 1024 * 1024:
            raise ValueError("Info.plist is too large")
        info = plistlib.loads(plist_path.read_bytes())
    except Exception as error:
        raise SystemExit(f"macOS Info.plist is invalid: {error}")
    if (info.get("CFBundleIdentifier") != "com.omamail.app"
            or info.get("CFBundleExecutable") != "omamail-app"
            or info.get("CFBundlePackageType") != "APPL"
            or info.get("CFBundleShortVersionString") != release_version
            or info.get("CFBundleVersion") != release_version):
        raise SystemExit("macOS Info.plist does not match the release")
    if "CFBundleURLTypes" in info or "CFBundleDocumentTypes" in info:
        raise SystemExit("macOS release must not register URL or document handlers")
PY

source_dir="$staging/$top_level"
if [ ! -d "$(dirname -- "$install_dir")" ]; then install_parent_created=1; fi
mkdir -p "$(dirname -- "$install_dir")"
rm -rf "$candidate"
cp -R "$source_dir" "$candidate" || { printf 'could not stage the new installation.\n' >&2; exit 1; }
if [ "$os" = Darwin ]; then
  xattr_command=/usr/bin/xattr
  if [ "$test_mode" = 1 ] && [ -n "${OMAMAIL_TEST_XATTR_COMMAND:-}" ]; then
    xattr_command=$OMAMAIL_TEST_XATTR_COMMAND
  fi
  [ -x "$xattr_command" ] || { printf 'xattr is required to prepare the unsigned macOS app.\n' >&2; exit 1; }
  candidate_absolute=$(CDPATH= cd -- "$(dirname -- "$candidate")" && pwd)/$(basename -- "$candidate")
  "$xattr_command" -dr com.apple.quarantine "$candidate_absolute" || {
    printf 'could not clear macOS quarantine from the unsigned app.\n' >&2
    exit 1
  }
fi

backup="$install_dir.previous"
had_install=0
had_bin=0
had_desktop=0
if [ -e "$install_dir" ] || [ -L "$install_dir" ]; then had_install=1; fi
if [ "$os" = Linux ]; then
  if [ ! -d "$bin_dir" ]; then bin_dir_created=1; fi
  if [ ! -d "$desktop_dir" ]; then desktop_dir_created=1; fi
  if [ -e "$bin_link" ] || [ -L "$bin_link" ]; then had_bin=1; cp -P "$bin_link" "$temp/bin.previous"; fi
  if [ -e "$desktop_file" ] || [ -L "$desktop_file" ]; then had_desktop=1; cp -P "$desktop_file" "$temp/desktop.previous"; fi
fi

rollback() {
  [ -z "$link_temp" ] || rm -f "$link_temp"
  [ -z "$desktop_temp" ] || rm -f "$desktop_temp"
  if [ "$new_moved" -eq 1 ]; then rm -rf "$install_dir"; fi
  if [ "$old_moved" -eq 1 ] && { [ -e "$backup" ] || [ -L "$backup" ]; }; then mv "$backup" "$install_dir"; fi
  if [ "$os" = Linux ] && [ "$registration_started" -eq 1 ]; then
    rm -f "$bin_link" "$desktop_file"
    if [ "$had_bin" -eq 1 ]; then cp -P "$temp/bin.previous" "$bin_link"; fi
    if [ "$had_desktop" -eq 1 ]; then cp -P "$temp/desktop.previous" "$desktop_file"; fi
  fi
}

install_transaction() {
  rm -rf "$backup" || return 1
  if [ "$had_install" -eq 1 ]; then
    mv "$install_dir" "$backup" || return 1
    old_moved=1
  fi
  mv "$candidate" "$install_dir" || return 1
  new_moved=1
  if [ "$os" = Linux ]; then
    registration_started=1
    mkdir -p "$bin_dir" "$desktop_dir" || return 1
    link_temp="$bin_link.new.$$"
    rm -f "$link_temp"
    ln -s "$install_dir/bin/omamail-app" "$link_temp" || return 1
    mv -f "$link_temp" "$bin_link" || return 1
    desktop_temp="$desktop_file.new.$$"
    python3 - "$install_dir/share/applications/omamail.desktop" "$desktop_temp" \
      "$install_dir/bin/omamail-app" "$install_dir/share/icons/hicolor/scalable/apps/omamail.svg" <<'PY' || return 1
import pathlib, sys
source, destination, executable, icon = sys.argv[1:]
def quoted(value):
    return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$') + '"'
lines = pathlib.Path(source).read_text(encoding="utf-8").splitlines()
output = []
seen_exec = seen_icon = False
for line in lines:
    if line.startswith("Exec="):
        output.append("Exec=" + quoted(executable)); seen_exec = True
    elif line.startswith("Icon="):
        output.append("Icon=" + icon.replace('\\', '\\\\')); seen_icon = True
    else:
        output.append(line)
if not seen_exec or not seen_icon:
    raise SystemExit("desktop entry is missing Exec or Icon")
pathlib.Path(destination).write_text("\n".join(output) + "\n", encoding="utf-8")
PY
    chmod 600 "$desktop_temp" || return 1
    mv -f "$desktop_temp" "$desktop_file" || return 1
  fi
  if [ "$test_mode" = 1 ] && [ "${OMAMAIL_TEST_FAIL_AFTER_REPLACE:-0}" = 1 ]; then return 1; fi
  return 0
}

transaction_active=1
if install_transaction; then
  transaction_active=0
  committed=1
  rm -rf "$backup" || true
else
  rollback
  transaction_active=0
  printf 'installation failed; the previous installation was restored.\n' >&2
  exit 1
fi

if [ "$os" = Linux ]; then
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$desktop_dir" || true
fi
printf 'Omamail installed at %s\n' "$install_dir"
