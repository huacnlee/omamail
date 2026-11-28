#!/usr/bin/env python3
"""scripts/release.py: version bumps and the release asset check.

The asset tests build what the release workflow uploads (the three
`nsh package` archives, a manifest signed with a throwaway key, the
installers and SHA256SUMS) in a scratch copy of the versioned files, then
break one thing at a time and expect `verify` to refuse it.
"""
import base64
import hashlib
import importlib.util
import io
import json
import pathlib
import shutil
import tarfile
import tempfile
import unittest
import zipfile

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

REPO = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("release", REPO / "omarchy/scripts/release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

VERSION = "0.13.0"


def scratch_root(directory, version="0.12.0", build=1, plugin="0.13.0", key=None):
    root = pathlib.Path(directory) / "repo"
    (root / "core").mkdir(parents=True)
    (root / "ext/omamail-native").mkdir(parents=True)
    (root / "omarchy").mkdir()
    updater = {"github": "huacnlee/omamail", "publicKey": key or "AAAA"}
    (root / "nsh.json").write_text(json.dumps(
        {"name": "Omamail", "id": "dev.huacnlee.omamail", "version": version, "build": build,
         "updater": updater}, indent=2) + "\n")
    (root / "manifest.json").write_text(json.dumps({"id": "omamail", "version": plugin}, indent=2) + "\n")
    (root / "core/Cargo.toml").write_text(f'[package]\nname = "omamail"\nversion = "{version}"\nedition = "2024"\n')
    lock = (f'[[package]]\nname = "aho"\nversion = "1.0.0"\n\n'
            f'[[package]]\nname = "omamail"\nversion = "{version}"\n\n'
            f'[[package]]\nname = "omamail-native"\nversion = "0.1.0"\n')
    (root / "core/Cargo.lock").write_text(lock)
    (root / "ext/omamail-native/Cargo.lock").write_text(lock)
    for installer in release.INSTALLERS:
        shutil.copy(REPO / installer, root / installer)
    return root


def tar_archive(path, files):
    with tarfile.open(path, "w:gz") as tar:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755
            tar.addfile(info, io.BytesIO(data))


def app_json(version, app_id="dev.huacnlee.omamail"):
    return json.dumps({"id": app_id, "version": version}).encode()


class ReleaseAssets(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.key = Ed25519PrivateKey.generate()
        public = self.key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        self.root = scratch_root(self.scratch.name, version=VERSION, key=base64.b64encode(public).decode())
        self.assets = pathlib.Path(self.scratch.name) / "assets"
        self.assets.mkdir()
        self.build_assets()

    def tearDown(self):
        self.scratch.cleanup()

    def build_assets(self, version=VERSION, linux_version=None):
        tar_archive(self.assets / f"omamail-{version}-macos-aarch64.tar.gz", {
            "Omamail.app/Contents/MacOS/Omamail": b"macho",
            "Omamail.app/Contents/Resources/nsh/app.json": app_json(version),
        })
        tar_archive(self.assets / f"omamail-{version}-linux-x86_64.tar.gz", {
            "Omamail/Omamail": b"elf",
            "Omamail/nsh/app.json": app_json(linux_version or version),
        })
        with zipfile.ZipFile(self.assets / f"omamail-{version}-windows-x86_64.zip", "w") as package:
            package.writestr("Omamail/Omamail.exe", b"MZ")
            package.writestr("Omamail/nsh/app.json", app_json(version))
        for installer in release.INSTALLERS:
            shutil.copy(REPO / installer, self.assets / installer)
        self.sign_manifest(version)

    def sign_manifest(self, version=VERSION, notes="- Changes\n"):
        platforms = {}
        for name, platform in release.archives(version).items():
            path = self.assets / name
            url = f"https://github.com/huacnlee/omamail/releases/download/v{version}/{name}"
            platforms[platform] = {"url": url, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                                   "size": path.stat().st_size}
        manifest = json.dumps({"id": "dev.huacnlee.omamail", "version": version, "notes": notes,
                               "platforms": platforms}, indent=2).encode()
        (self.assets / "latest.json").write_bytes(manifest)
        signature = self.key.sign(release.SIGNATURE_CONTEXT + manifest)
        (self.assets / "latest.json.sig").write_text(base64.b64encode(signature).decode() + "\n")
        (self.assets / "SHA256SUMS").unlink(missing_ok=True)
        release.write_checksums(self.assets)

    def assertRefused(self, message):
        with self.assertRaises(release.ReleaseError) as raised:
            release.verify(self.assets, VERSION, self.root)
        self.assertIn(message, str(raised.exception))

    def test_a_complete_release_verifies(self):
        release.verify(self.assets, VERSION, self.root)
        self.assertEqual(sorted(p.name for p in self.assets.iterdir()), release.release_assets(VERSION))

    def test_a_missing_platform_is_refused(self):
        (self.assets / f"omamail-{VERSION}-windows-x86_64.zip").unlink()
        self.assertRefused("missing")

    def test_an_extra_asset_is_refused(self):
        (self.assets / "omamail-linux-x86_64.tar.gz").write_bytes(b"old backend")
        self.assertRefused("unexpected")

    def test_a_changed_archive_is_refused(self):
        with (self.assets / f"omamail-{VERSION}-linux-x86_64.tar.gz").open("ab") as archive:
            archive.write(b"\0")
        self.assertRefused("checksum mismatch")

    def test_an_archive_of_another_version_is_refused(self):
        self.build_assets(linux_version="0.12.0")
        self.assertRefused("not dev.huacnlee.omamail 0.13.0")

    def test_a_manifest_signed_by_another_key_is_refused(self):
        self.key = Ed25519PrivateKey.generate()
        self.sign_manifest()
        self.assertRefused("does not match nsh.json's updater.publicKey")

    def test_a_manifest_changed_after_signing_is_refused(self):
        manifest = json.loads((self.assets / "latest.json").read_text())
        manifest["notes"] = "- Something else\n"
        (self.assets / "latest.json").write_text(json.dumps(manifest))
        (self.assets / "SHA256SUMS").unlink()
        release.write_checksums(self.assets)
        self.assertRefused("updater.publicKey")

    def test_a_manifest_pointing_at_the_latest_release_is_refused(self):
        # A relative URL resolves against releases/latest/download, which a
        # newer release would change under an app mid-update.
        manifest = json.loads((self.assets / "latest.json").read_text())
        for entry in manifest["platforms"].values():
            entry["url"] = entry["url"].rsplit("/", 1)[1]
        raw = json.dumps(manifest).encode()
        (self.assets / "latest.json").write_bytes(raw)
        (self.assets / "latest.json.sig").write_text(
            base64.b64encode(self.key.sign(release.SIGNATURE_CONTEXT + raw)).decode() + "\n")
        (self.assets / "SHA256SUMS").unlink()
        release.write_checksums(self.assets)
        self.assertRefused("entry does not match")

    def test_a_manifest_without_notes_is_refused(self):
        self.sign_manifest(notes=" ")
        self.assertRefused("no release notes")

    def test_an_installer_from_another_revision_is_refused(self):
        (self.assets / "install.sh").write_text("#!/bin/sh\necho other\n")
        (self.assets / "SHA256SUMS").unlink()
        release.write_checksums(self.assets)
        self.sign_manifest()
        self.assertRefused("is not this revision's install.sh")

    def test_an_archive_entry_outside_the_app_is_refused(self):
        tar_archive(self.assets / f"omamail-{VERSION}-linux-x86_64.tar.gz", {
            "Omamail/Omamail": b"elf",
            "Omamail/nsh/app.json": app_json(VERSION),
            "Omamail/../evil": b"x",
        })
        self.sign_manifest()
        self.assertRefused("outside Omamail/")

    def test_a_link_among_the_assets_is_refused(self):
        target = self.assets / "install.sh"
        moved = pathlib.Path(self.scratch.name) / "install.sh"
        target.rename(moved)
        target.symlink_to(moved)
        self.assertRefused("not a regular file")


class Versions(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = scratch_root(self.scratch.name)

    def tearDown(self):
        self.scratch.cleanup()

    def test_bump_sets_every_versioned_file(self):
        changed = release.bump(self.root, "0.13.0")
        self.assertEqual(sorted(changed), sorted([
            "nsh.json", "manifest.json", "core/Cargo.toml", "core/Cargo.lock", "ext/omamail-native/Cargo.lock"]))
        config = json.loads((self.root / "nsh.json").read_text())
        self.assertEqual((config["version"], config["build"]), ("0.13.0", 2))
        self.assertEqual(json.loads((self.root / "manifest.json").read_text())["version"], "0.13.0")
        self.assertEqual(release.current_version(self.root), "0.13.0")
        self.assertIn('name = "omamail-native"\nversion = "0.1.0"', (self.root / "core/Cargo.lock").read_text())

    def test_bump_refuses_an_older_or_equal_version(self):
        for version in ("0.12.0", "0.11.9"):
            with self.assertRaises(release.ReleaseError):
                release.bump(self.root, version)
        self.assertEqual(json.loads((self.root / "nsh.json").read_text())["version"], "0.12.0")

    def test_bump_refuses_a_version_behind_the_plugin(self):
        root = scratch_root(tempfile.mkdtemp(dir=self.scratch.name), plugin="0.14.0")
        with self.assertRaisesRegex(release.ReleaseError, "manifest.json is already at 0.14.0"):
            release.bump(root, "0.13.0")

    def test_bump_refuses_a_noncanonical_version(self):
        for version in ("v0.13.0", "0.13", "0.13.0-rc.1", "01.2.3"):
            with self.assertRaises(release.ReleaseError):
                release.bump(self.root, version)

    def test_disagreeing_versions_are_refused(self):
        path = self.root / "ext/omamail-native/Cargo.lock"
        path.write_text(path.read_text().replace('"0.12.0"', '"0.11.0"'))
        with self.assertRaisesRegex(release.ReleaseError, "has 0.11.0, nsh.json has 0.12.0"):
            release.current_version(self.root)

    def test_the_repository_versions_agree(self):
        release.current_version(REPO)


if __name__ == "__main__":
    unittest.main()
