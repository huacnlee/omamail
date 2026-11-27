#!/usr/bin/env python3
"""Release metadata and asset checks for the NSH app.

  release.py version [--root DIR]
      Prints nsh.json's version after checking every versioned file agrees.
  release.py bump VERSION [--root DIR]
      Sets VERSION in nsh.json (and raises its build), core/Cargo.toml, the
      two Cargo.lock files and the plugin's manifest.json.
  release.py checksums DIR
      Writes DIR/SHA256SUMS over the release assets.
  release.py verify DIR --version VERSION [--root DIR]
      Checks DIR holds exactly the release's assets: the three archives
      `nsh package` makes, the signed update manifest, the installers and
      SHA256SUMS, each matching the others.

`verify` checks the manifest's signature against nsh.json's
`updater.publicKey` with the `cryptography` package; it is what the app does
before it trusts an update.
"""
import argparse
import base64
import hashlib
import io
import json
import pathlib
import re
import sys
import tarfile
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
APP_ID = "dev.huacnlee.omamail"
NAME = "Omamail"
REPOSITORY = "huacnlee/omamail"
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
# NSH updater platforms, as `nsh update-manifest` names them, and the
# archive each comes from.
PLATFORMS = {
    "macos-aarch64": "tar.gz",
    "linux-x86_64": "tar.gz",
    "windows-x86_64": "zip",
}
INSTALLERS = ("install.sh", "install.ps1")
# nsh-updater's signature framing (crates/nsh-updater/src/lib.rs, CONTEXT).
SIGNATURE_CONTEXT = b"nsh-updater-manifest\0"
MAX_MANIFEST = 1024 * 1024


class ReleaseError(Exception):
    pass


def fail(message):
    raise ReleaseError(message)


def archives(version):
    return {f"{NAME}-{version}-{platform}.{ext}": platform for platform, ext in PLATFORMS.items()}


def release_assets(version):
    return sorted([*archives(version), "latest.json", "latest.json.sig", *INSTALLERS, "SHA256SUMS"])


# Versioned files: (path, pattern whose group 2 is the version).
def versioned(root):
    return [
        (root / "core/Cargo.toml", re.compile(r'(\A\[package\]\nname = "omamail"\nversion = ")([^"]+)(")')),
        (root / "core/Cargo.lock", re.compile(r'(^\[\[package\]\]\nname = "omamail"\nversion = ")([^"]+)(")', re.M)),
        (root / "ext/omamail-native/Cargo.lock",
         re.compile(r'(^\[\[package\]\]\nname = "omamail"\nversion = ")([^"]+)(")', re.M)),
    ]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def parse(version):
    if not VERSION.fullmatch(version or ""):
        fail(f"expected MAJOR.MINOR.PATCH, got {version!r}")
    return tuple(map(int, version.split(".")))


def current_version(root):
    config = read_json(root / "nsh.json")
    version = config.get("version")
    parse(version)
    if config.get("id") != APP_ID:
        fail(f"nsh.json id is {config.get('id')!r}, not {APP_ID}")
    for path, pattern in versioned(root):
        found = pattern.findall(path.read_text(encoding="utf-8"))
        if len(found) != 1:
            fail(f"expected one omamail version in {path.relative_to(root)}")
        if found[0][1] != version:
            fail(f"{path.relative_to(root)} has {found[0][1]}, nsh.json has {version}")
    return version


def bump(root, version):
    current = current_version(root)
    if parse(version) <= parse(current):
        fail(f"the new version must be newer than {current}")
    plugin = read_json(root / "manifest.json")
    if parse(version) < parse(plugin.get("version")):
        fail(f"manifest.json is already at {plugin['version']}")
    edits = {}
    nsh = (root / "nsh.json").read_text(encoding="utf-8")
    build = read_json(root / "nsh.json").get("build", 0)
    if not isinstance(build, int) or build < 0:
        fail("nsh.json build must be a whole number")
    nsh, count = re.subn(r'("version"\s*:\s*")[^"]+(")', lambda m: m[1] + version + m[2], nsh, count=1)
    if count != 1:
        fail("nsh.json has no version")
    if '"build"' in nsh:
        nsh = re.sub(r'("build"\s*:\s*)\d+', lambda m: f"{m[1]}{build + 1}", nsh, count=1)
    else:
        nsh = nsh.replace(f'"version": "{version}"', f'"version": "{version}",\n  "build": {build + 1}', 1)
    edits[root / "nsh.json"] = nsh
    manifest, count = re.subn(r'("version"\s*:\s*")[^"]+(")', lambda m: m[1] + version + m[2],
                              (root / "manifest.json").read_text(encoding="utf-8"), count=1)
    if count != 1:
        fail("manifest.json has no version")
    edits[root / "manifest.json"] = manifest
    for path, pattern in versioned(root):
        text, count = pattern.subn(lambda m: m[1] + version + m[3], path.read_text(encoding="utf-8"))
        if count != 1:
            fail(f"expected one omamail version in {path.relative_to(root)}")
        edits[path] = text
    for path, text in edits.items():
        path.write_text(text, encoding="utf-8")
    if current_version(root) != version:
        fail("bump left the versions disagreeing")
    return [str(path.relative_to(root)) for path in edits]


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def regular_files(directory):
    files = {}
    for path in sorted(directory.iterdir()):
        if path.is_symlink() or not path.is_file():
            fail(f"{path.name} is not a regular file")
        files[path.name] = path
    return files


def write_checksums(directory):
    files = regular_files(directory)
    files.pop("SHA256SUMS", None)
    lines = [f"{sha256(path)}  {name}\n" for name, path in files.items()]
    (directory / "SHA256SUMS").write_text("".join(lines), encoding="utf-8")


def read_checksums(path):
    sums = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)", line)
        if not match or match[2] in sums:
            fail(f"SHA256SUMS has an invalid or repeated line: {line!r}")
        sums[match[2]] = match[1]
    return sums


def app_json_in(archive, platform):
    """The app.json inside an archive, after checking its one top-level directory."""
    top = f"{NAME}.app" if platform.startswith("macos") else NAME
    inner = f"{top}/Contents/Resources/nsh/app.json" if platform.startswith("macos") else f"{top}/nsh/app.json"
    runner = {
        "macos-aarch64": f"{top}/Contents/MacOS/{NAME}",
        "linux-x86_64": f"{top}/{NAME}",
        "windows-x86_64": f"{top}/{NAME}.exe",
    }[platform]
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as package:
            names = package.namelist()
            contents = {inner: package.read(inner)} if inner in names else {}
    else:
        with tarfile.open(archive, "r:gz") as package:
            members = {member.name.rstrip("/"): member for member in package.getmembers()}
            names = list(members)
            contents = {inner: package.extractfile(members[inner]).read()} if inner in members else {}
    for name in names:
        parts = pathlib.PurePosixPath(name).parts
        if not parts or parts[0] != top or ".." in parts or name.startswith("/") or "\\" in name:
            fail(f"{archive.name} has an entry outside {top}/: {name!r}")
    stripped = {name.rstrip("/") for name in names}
    for required in (inner, runner):
        if required not in stripped:
            fail(f"{archive.name} has no {required}")
    return json.loads(contents[inner])


def verify_signature(manifest, signature, public_key):
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError:
        fail("verifying latest.json.sig needs the cryptography package")
    try:
        key = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key, validate=True))
        key.verify(base64.b64decode(signature.strip(), validate=True), SIGNATURE_CONTEXT + manifest)
    except (InvalidSignature, ValueError) as error:
        fail(f"latest.json.sig does not match nsh.json's updater.publicKey ({error or 'invalid'})")


def verify(directory, version, root):
    parse(version)
    files = regular_files(directory)
    expected = release_assets(version)
    if sorted(files) != expected:
        fail(f"release assets differ: missing {sorted(set(expected) - set(files))}, "
             f"unexpected {sorted(set(files) - set(expected))}")
    sums = read_checksums(files["SHA256SUMS"])
    if sorted(sums) != sorted(name for name in expected if name != "SHA256SUMS"):
        fail("SHA256SUMS does not list exactly the release assets")
    for name, digest in sums.items():
        if sha256(files[name]) != digest:
            fail(f"checksum mismatch for {name}")
    for name, platform in archives(version).items():
        app = app_json_in(files[name], platform)
        if app.get("id") != APP_ID or app.get("version") != version:
            fail(f"{name} holds {app.get('id')} {app.get('version')}, not {APP_ID} {version}")
    raw = files["latest.json"].read_bytes()
    if len(raw) > MAX_MANIFEST:
        fail("latest.json is too large")
    manifest = json.loads(raw)
    if manifest.get("id") != APP_ID or manifest.get("version") != version:
        fail("latest.json names another app or version")
    if not isinstance(manifest.get("notes"), str) or not manifest["notes"].strip():
        fail("latest.json has no release notes")
    platforms = manifest.get("platforms")
    if not isinstance(platforms, dict) or sorted(platforms) != sorted(PLATFORMS):
        fail(f"latest.json platforms are {sorted(platforms or {})}, expected {sorted(PLATFORMS)}")
    for name, platform in archives(version).items():
        entry = platforms[platform]
        if (entry.get("url") != name or entry.get("sha256") != sums[name]
                or entry.get("size") != files[name].stat().st_size):
            fail(f"latest.json's {platform} entry does not match {name}")
    public_key = read_json(root / "nsh.json").get("updater", {}).get("publicKey")
    if not public_key:
        fail("nsh.json has no updater.publicKey")
    updater = read_json(root / "nsh.json")["updater"]
    if updater.get("github") != REPOSITORY:
        fail(f"nsh.json updater.github is not {REPOSITORY}")
    verify_signature(raw, files["latest.json.sig"].read_text(encoding="ascii"), public_key)
    for installer in INSTALLERS:
        if files[installer].read_bytes() != (root / "omarchy" / installer).read_bytes():
            fail(f"{installer} is not this revision's omarchy/{installer}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=pathlib.Path, default=ROOT)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version")
    bump_parser = commands.add_parser("bump")
    bump_parser.add_argument("version")
    checksums_parser = commands.add_parser("checksums")
    checksums_parser.add_argument("directory", type=pathlib.Path)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("directory", type=pathlib.Path)
    verify_parser.add_argument("--version", required=True)
    args = parser.parse_args(argv)
    root = args.root.resolve()
    try:
        if args.command == "version":
            print(current_version(root))
        elif args.command == "bump":
            for path in bump(root, args.version):
                print(path)
        elif args.command == "checksums":
            write_checksums(args.directory)
        elif args.command == "verify":
            verify(args.directory, args.version, root)
            print(f"verified {len(release_assets(args.version))} assets of {NAME} {args.version}")
    except ReleaseError as error:
        print(f"release: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
