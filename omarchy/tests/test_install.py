#!/usr/bin/env python3
"""install.sh against synthetic release archives, in a scratch HOME.

`curl` and `uname` are stand-ins on PATH: downloads come from a fixtures
directory and the platform is whatever the case asks for, so nothing reaches
the network or the host's install. Refusals are checked by what is left on
disk, not only by the exit status.
"""
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
INSTALLER = REPO / "install.sh"
HELPER = REPO / "omarchy/notice/omamail-app.sh"
APP_ID = "dev.huacnlee.omamail"
DESKTOP = (
    "[Desktop Entry]\nType=Application\nName=Omamail\nExec=Omamail\n"
    f"Icon={APP_ID}\nStartupWMClass={APP_ID}\nTerminal=false\n"
)


def linux_files(version):
    return {
        "Omamail/Omamail": (b"\x7fELF runner", 0o755),
        "Omamail/nsh/app.json": (json.dumps({"id": APP_ID, "version": version}).encode(), 0o644),
        "Omamail/nsh/bundle.nshc": (b"bytecode", 0o644),
        f"Omamail/{APP_ID}.desktop": (DESKTOP.encode(), 0o644),
        f"Omamail/{APP_ID}.png": (b"\x89PNG\r\n\x1a\n", 0o644),
    }


def macos_files(version):
    return {
        "Omamail.app/Contents/Info.plist": (b"<plist/>", 0o644),
        "Omamail.app/Contents/MacOS/Omamail": (b"macho", 0o755),
        "Omamail.app/Contents/Resources/nsh/app.json": (json.dumps({"version": version}).encode(), 0o644),
    }


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="omamail-install-test-")
        self.addCleanup(self.scratch.cleanup)
        self.dir = pathlib.Path(self.scratch.name)
        self.home = self.dir / "home with spaces"
        self.home.mkdir()
        self.fixtures = self.dir / "fixtures"
        self.fixtures.mkdir()
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.mock("uname", '#!/bin/sh\nif [ "$1" = -s ]; then echo "${MOCK_OS:-Linux}"; else echo "${MOCK_ARCH:-x86_64}"; fi\n')
        (self.bin / "curl").symlink_to(pathlib.Path(__file__).resolve().parent / "fake_curl.py")

    def mock(self, name, source):
        path = self.bin / name
        path.write_text(source)
        path.chmod(0o755)

    def release(self, version, files, target="linux-x86_64", extra=(), checksum=None):
        directory = self.fixtures / f"v{version}"
        directory.mkdir(exist_ok=True)
        # 0.13.0 published Omamail-*; later releases are lower case.
        name = f"{'Omamail' if version == '0.13.0' else 'omamail'}-{version}-{target}.tar.gz"
        with tarfile.open(directory / name, "w:gz") as tar:
            for member, (data, mode) in files.items():
                info = tarfile.TarInfo(member)
                info.size = len(data)
                info.mode = mode
                tar.addfile(info, io.BytesIO(data))
            for info in extra:
                tar.addfile(info)
        digest = checksum or hashlib.sha256((directory / name).read_bytes()).hexdigest()
        (directory / "SHA256SUMS").write_text(f"{digest}  {name}\n")
        return directory / name

    def install(self, *args, os_name="Linux", arch="x86_64", latest="0.13.0"):
        env = {
            "PATH": f"{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(self.home),
            "TMPDIR": str(self.dir),
            "FIXTURES": str(self.fixtures),
            "CURL_LOG": str(self.dir / "curl.log"),
            "MOCK_OS": os_name,
            "MOCK_ARCH": arch,
            "MOCK_LATEST": latest,
        }
        return subprocess.run(["sh", str(INSTALLER), *args], env=env, capture_output=True, text=True)

    def helper_status(self):
        return subprocess.run(
            ["sh", str(HELPER), "status"], capture_output=True, text=True,
            env={"PATH": "/usr/bin:/bin", "HOME": str(self.home), "XDG_DATA_DIRS": str(self.dir / "none")},
        ).stdout.strip()

    @property
    def app(self):
        return self.home / ".local/share/omamail/Omamail"

    @property
    def desktop(self):
        return self.home / f".local/share/applications/{APP_ID}.desktop"

    @property
    def link(self):
        return self.home / ".local/bin/omamail-app"

    def installed_version(self):
        return json.loads((self.app / "nsh/app.json").read_text())["version"]

    def assertRefused(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message, result.stderr)
        self.assertFalse(self.app.exists())
        self.assertFalse(self.link.exists() or self.link.is_symlink())
        self.assertFalse(self.desktop.exists())
        self.assertEqual([p.name for p in self.dir.iterdir() if p.name.startswith("omamail-install.")], [])

    def test_linux_installs_the_latest_release_where_the_notice_helper_finds_it(self):
        self.release("0.13.0", linux_files("0.13.0"))
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed_version(), "0.13.0")
        self.assertTrue(os.access(self.app / "Omamail", os.X_OK))
        self.assertEqual(os.readlink(self.link), str(self.app / "Omamail"))
        entry = self.desktop.read_text()
        self.assertIn(f'Exec="{self.app}/Omamail"\n', entry)
        self.assertIn(f"Icon={self.app}/{APP_ID}.png\n", entry)
        self.assertIn(f"StartupWMClass={APP_ID}\n", entry)
        self.assertEqual(self.helper_status(), "installed")

    def test_a_named_version_is_installed_without_asking_for_the_latest(self):
        self.release("0.13.1", linux_files("0.13.1"))
        result = self.install("--version", "v0.13.1", latest="9.9.9")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed_version(), "0.13.1")
        log = (self.dir / "curl.log").read_text()
        self.assertNotIn("/releases/latest", log)
        # Release file names are lower case after 0.13.0.
        self.assertIn("/v0.13.1/omamail-0.13.1-linux-x86_64.tar.gz", log)

    def test_0_13_0_is_downloaded_under_its_published_name(self):
        self.release("0.13.0", linux_files("0.13.0"))
        result = self.install("--version", "0.13.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("/v0.13.0/Omamail-0.13.0-linux-x86_64.tar.gz", (self.dir / "curl.log").read_text())

    def test_dir_installs_under_another_prefix(self):
        self.release("0.13.0", linux_files("0.13.0"))
        prefix = self.dir / "prefix"
        result = self.install("--dir", str(prefix))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((prefix / "share/omamail/Omamail/Omamail").is_file())
        self.assertTrue((prefix / "bin/omamail-app").is_symlink())
        self.assertTrue((prefix / f"share/applications/{APP_ID}.desktop").is_file())
        self.assertFalse(self.app.exists())

    def test_an_upgrade_replaces_the_app_and_keeps_user_data(self):
        self.release("0.13.0", linux_files("0.13.0"))
        self.assertEqual(self.install().returncode, 0)
        data = self.home / ".local/share/omamail/cache.db"
        data.write_text("mail")
        config = self.home / ".config/omamail/accounts.json"
        config.parent.mkdir(parents=True)
        config.write_text("[]")
        self.release("0.14.0", linux_files("0.14.0"))
        result = self.install(latest="0.14.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.installed_version(), "0.14.0")
        self.assertEqual(data.read_text(), "mail")
        self.assertEqual(config.read_text(), "[]")
        self.assertEqual(sorted(p.name for p in self.app.parent.iterdir()), ["Omamail", "cache.db"])

    def test_the_qt_app_is_removed_and_its_accounts_kept(self):
        legacy = self.home / ".local/omamail.app"
        (legacy / "bin").mkdir(parents=True)
        (legacy / "bin/omamail-app").write_text("qt")
        bin_dir = self.home / ".local/bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "omamail").symlink_to(legacy / "bin/omamail-app")
        applications = self.home / ".local/share/applications"
        applications.mkdir(parents=True)
        (applications / "omamail.desktop").write_text("[Desktop Entry]\n")
        config = self.home / ".config/omamail/accounts.json"
        config.parent.mkdir(parents=True)
        config.write_text("[]")
        self.release("0.13.0", linux_files("0.13.0"))
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(legacy.exists())
        self.assertFalse((bin_dir / "omamail").is_symlink())
        self.assertFalse((applications / "omamail.desktop").exists())
        self.assertEqual(config.read_text(), "[]")

    def test_an_omamail_link_that_is_not_the_qt_apps_is_left_alone(self):
        bin_dir = self.home / ".local/bin"
        bin_dir.mkdir(parents=True)
        other = self.dir / "elsewhere"
        other.write_text("someone else's")
        (bin_dir / "omamail").symlink_to(other)
        self.release("0.13.0", linux_files("0.13.0"))
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(os.readlink(bin_dir / "omamail"), str(other))

    def test_a_checksum_mismatch_installs_nothing(self):
        self.release("0.13.0", linux_files("0.13.0"), checksum="0" * 64)
        self.assertRefused(self.install(), "Checksum verification failed")

    def test_a_missing_checksum_installs_nothing(self):
        archive = self.release("0.13.0", linux_files("0.13.0"))
        (archive.parent / "SHA256SUMS").write_text("")
        self.assertRefused(self.install(), "Missing or invalid checksum")

    def test_a_parent_directory_entry_is_refused(self):
        self.release("0.13.0", linux_files("0.13.0"), extra=[tarfile.TarInfo("Omamail/../../escaped")])
        self.assertRefused(self.install(), "unsafe path")
        self.assertFalse((self.dir / "escaped").exists())

    def test_an_entry_outside_the_app_directory_is_refused(self):
        self.release("0.13.0", {**linux_files("0.13.0"), "Other/file": (b"x", 0o644)})
        self.assertRefused(self.install(), "unsafe path")

    def test_a_link_in_the_archive_is_refused(self):
        link = tarfile.TarInfo("Omamail/nsh/secrets")
        link.type = tarfile.SYMTYPE
        link.linkname = "../../../../.ssh"
        self.release("0.13.0", linux_files("0.13.0"), extra=[link])
        self.assertRefused(self.install(), "unsafe path")

    def test_an_archive_without_the_runner_is_refused(self):
        files = linux_files("0.13.0")
        del files["Omamail/Omamail"]
        self.release("0.13.0", files)
        self.assertRefused(self.install(), "missing Omamail")

    def test_a_qt_era_release_says_why_it_cannot_be_installed(self):
        self.assertRefused(self.install("--version", "0.12.0"), "Releases before 0.13.0")

    def test_an_invalid_version_is_refused_before_any_download(self):
        for version in ("latest;rm", "0.13", "0.13.0-rc.1", "../0.13.0"):
            self.assertRefused(self.install("--version", version), "Version must be")
        self.assertFalse((self.dir / "curl.log").exists())

    def test_unsupported_platforms_are_refused(self):
        for os_name, arch, message in (("Linux", "aarch64", "x86_64 only"), ("Darwin", "x86_64", "Apple silicon"),
                                       ("FreeBSD", "amd64", "install.ps1")):
            self.assertRefused(self.install(os_name=os_name, arch=arch), message)

    def test_uninstall_removes_the_app_and_keeps_user_data(self):
        self.release("0.13.0", linux_files("0.13.0"))
        self.assertEqual(self.install().returncode, 0)
        data = self.home / ".local/share/omamail/cache.db"
        data.write_text("mail")
        result = self.install("--uninstall")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.app.exists())
        self.assertFalse(self.link.is_symlink())
        self.assertFalse(self.desktop.exists())
        self.assertEqual(data.read_text(), "mail")
        self.assertEqual(self.helper_status(), "missing")

    @unittest.skipUnless(shutil.which("ditto"), "macOS installs copy with ditto")
    def test_macos_replaces_the_app_in_applications(self):
        app = self.home / "Applications/Omamail.app"
        (app / "Contents/MacOS").mkdir(parents=True)
        (app / "Contents/MacOS/omamail-app").write_text("qt")
        self.release("0.13.0", macos_files("0.13.0"), target="macos-aarch64")
        result = self.install(os_name="Darwin", arch="arm64")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((app / "Contents/MacOS/omamail-app").exists())
        self.assertTrue(os.access(app / "Contents/MacOS/Omamail", os.X_OK))
        self.assertEqual(sorted(p.name for p in app.parent.iterdir()), ["Omamail.app"])


if __name__ == "__main__":
    unittest.main()
