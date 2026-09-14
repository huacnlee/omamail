#!/usr/bin/env python3
"""Layout tests for the native Unix release packager.

Qt deployment and executable smoke checks run on native release workers. These
tests supply synthetic executables and a platform plugin to exercise the exact
archive contract without pretending a foreign Qt binary is runnable.
"""

import json
import os
from pathlib import Path
import plistlib
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
PACKAGER = ROOT / "app/scripts/package-release.sh"
VERSION = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]


class PackageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.host = self.root / "omamail-app"
        self.backend = self.root / "omamail"
        self.plugin = self.root / "platform.plugin"
        for executable in (self.host, self.backend):
            executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            executable.chmod(0o700)
        self.plugin.write_bytes(b"platform")
        self.qml = self.root / "qml"
        self.ui = self.root / "ui"
        self.qml.mkdir()
        self.ui.mkdir()
        (self.qml / "Main.qml").write_text("import QtQuick\nItem {}\n", encoding="utf-8")
        (self.ui / "Service.qml").write_text("import QtQuick\nItem {}\n", encoding="utf-8")
        self.manifest = self.root / "manifest.json"
        self.manifest.write_text(json.dumps({"version": VERSION}), encoding="utf-8")
        self.dist = self.root / "dist"

    def tearDown(self):
        self.temp.cleanup()

    def package(self, target, **environment):
        env = dict(os.environ, OMAMAIL_PACKAGE_TEST_MODE="1", **environment)
        return subprocess.run(
            [
                str(PACKAGER), target,
                "--host", str(self.host),
                "--backend", str(self.backend),
                "--qml", str(self.qml),
                "--ui", str(self.ui),
                "--manifest", str(self.manifest),
                "--dist", str(self.dist),
                "--platform-plugin", str(self.plugin),
                "--test-layout",
            ],
            cwd=ROOT, env=env, text=True, capture_output=True,
        )

    def assert_archive(self, target, archive_name, top, required):
        result = self.package(target)
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = self.dist / archive_name
        self.assertEqual(Path(result.stdout.strip()), archive)
        self.assertTrue(archive.is_file())
        with tarfile.open(archive, "r:gz") as package:
            members = package.getmembers()
            names = [member.name.rstrip("/") for member in members]
            roots = {Path(name).parts[0] for name in names if name}
            self.assertEqual(roots, {top})
            self.assertEqual(len(names), len(set(names)))
            self.assertFalse(any(member.isdev() or member.isfifo() for member in members))
            self.assertFalse(any("JetBrainsMono" in name for name in names))
            for path in required:
                self.assertIn(f"{top}/{path}", names)
            metadata_name = (f"{top}/Contents/Resources/release.json"
                             if target == "macos-aarch64" else f"{top}/release.json")
            metadata = json.load(package.extractfile(metadata_name))
            self.assertEqual(metadata, {
                "schemaVersion": 1,
                "name": "omamail",
                "version": VERSION,
                "target": target,
                "topLevel": top,
            })
            if target == "macos-aarch64":
                info = plistlib.load(package.extractfile(f"{top}/Contents/Info.plist"))
                self.assertEqual(info["CFBundleDisplayName"], "Omamail")
                self.assertEqual(info["CFBundleName"], "Omamail")
                self.assertEqual(info["CFBundleIdentifier"], "com.omamail.app")
                self.assertEqual(info["CFBundleIconFile"], "omamail.icns")
                self.assertEqual(info["CFBundleExecutable"], "omamail-app")
                self.assertEqual(info["CFBundleShortVersionString"], VERSION)
                self.assertEqual(info["CFBundleVersion"], VERSION)
                self.assertNotIn("CFBundleURLTypes", info)
                packaged_icon = package.extractfile(
                    f"{top}/Contents/Resources/omamail.icns"
                ).read()
                self.assertEqual(
                    packaged_icon,
                    (ROOT / "app/resources/macos/omamail.icns").read_bytes(),
                )

    def test_macos_archive_layout(self):
        self.assert_archive(
            "macos-aarch64", "omamail-app-macos-aarch64.tar.gz", "Omamail.app",
            [
                "Contents/MacOS/omamail-app", "Contents/MacOS/omamail",
                "Contents/Resources/qml/Main.qml", "Contents/Resources/ui/Service.qml",
                "Contents/Resources/manifest.json",
                "Contents/Resources/licenses/NerdFonts-LICENSE",
                "Contents/Resources/licenses/NerdFonts-README.md",
                "Contents/Resources/licenses/NerdFonts-PROVENANCE.md",
                "Contents/Resources/licenses/Apache-2.0.txt",
                "Contents/Resources/licenses/Pomicons-OFL-1.1.txt",
                "Contents/Resources/licenses/GLYPH-SOURCES.md",
                "Contents/PlugIns/platforms/libqcocoa.dylib",
                "Contents/Resources/omamail.icns",
                "Contents/Info.plist",
            ],
        )

    def test_linux_archive_layout(self):
        self.assert_archive(
            "linux-x86_64", "omamail-app-linux-x86_64.tar.gz", "omamail.app",
            [
                "bin/omamail-app", "bin/omamail", "bin/qt.conf", "qml/Main.qml", "ui/Service.qml",
                "manifest.json", "plugins/platforms/libqxcb.so",
                "licenses/NerdFonts-LICENSE", "licenses/NerdFonts-README.md",
                "licenses/NerdFonts-PROVENANCE.md", "licenses/Apache-2.0.txt",
                "licenses/Pomicons-OFL-1.1.txt", "licenses/GLYPH-SOURCES.md",
                "share/applications/omamail.desktop",
                "share/icons/hicolor/scalable/apps/omamail.svg",
            ],
        )

        archive = self.dist / "omamail-app-linux-x86_64.tar.gz"
        with tarfile.open(archive, "r:gz") as package:
            desktop = package.extractfile(
                "omamail.app/share/applications/omamail.desktop"
            ).read().decode("utf-8")
            self.assertIn("\nName=Omamail\n", "\n" + desktop)
            self.assertIn("\nIcon=omamail\n", "\n" + desktop)

    def test_missing_payload_fails_without_archive(self):
        self.backend.unlink()
        result = self.package("linux-x86_64")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("backend is missing", result.stderr)
        self.assertFalse((self.dist / "omamail-app-linux-x86_64.tar.gz").exists())

    def test_manifest_version_mismatch_fails(self):
        self.manifest.write_text(json.dumps({"version": "9.9.9"}), encoding="utf-8")
        result = self.package("macos-aarch64")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match Cargo version", result.stderr)

    def test_test_layout_switch_is_not_a_production_bypass(self):
        env = dict(os.environ)
        env.pop("OMAMAIL_PACKAGE_TEST_MODE", None)
        result = subprocess.run(
            [str(PACKAGER), "linux-x86_64", "--test-layout"],
            cwd=ROOT, env=env, text=True, capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires OMAMAIL_PACKAGE_TEST_MODE=1", result.stderr)

    def test_macos_deployment_handles_split_qt_and_reseals_bundle(self):
        source = PACKAGER.read_text(encoding="utf-8")
        self.assertIn('QtSvg.framework/Versions/A/QtSvg', source)
        self.assertIn('-libpath="$svg_libs"', source)
        # Qt 6.8.3's macdeployqt rejects -no-codesign; the bundle is re-sealed below.
        self.assertNotIn('-no-codesign', source)
        self.assertNotIn('-codesign=', source)
        self.assertIn('codesign --force --deep --sign - "$app"', source)
        self.assertIn('codesign --verify --deep --strict "$app"', source)
        self.assertIn('smoke_platform=cocoa', source)


if __name__ == "__main__":
    unittest.main()
