#!/usr/bin/env python3
"""install.sh against synthetic NSH release archives, in a scratch HOME.

Each case builds the archive `nsh package` would (the runner, nsh/app.json,
nsh/bundle.nshc, the desktop entry or Info.plist), lists it in a SHA256SUMS,
and runs the installer in test mode with --archive. Refusals are checked by
what is left on disk, not only by the exit status.
"""
import hashlib
import io
import json
import os
import pathlib
import plistlib
import struct
import subprocess
import tarfile
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "install.sh"
HELPER = ROOT / "notice" / "omamail-app.sh"
APP_ID = "dev.huacnlee.omamail"

ELF_X86_64 = b"\x7fELF\x02\x01\x01" + b"\0" * 11 + struct.pack("<H", 62) + b"\0" * 64
ELF_ARM64 = b"\x7fELF\x02\x01\x01" + b"\0" * 11 + struct.pack("<H", 183) + b"\0" * 64
MACHO_ARM64 = b"\xcf\xfa\xed\xfe" + struct.pack("<I", 0x0100000C) + b"\0" * 64


def linux_files(version, app_id=APP_ID, runner=ELF_X86_64, desktop=None):
    desktop = desktop or (
        "[Desktop Entry]\nType=Application\nName=Omamail\nExec=Omamail\n"
        f"Icon={app_id}\nStartupWMClass={app_id}\nTerminal=false\n"
    )
    return {
        "Omamail/Omamail": (runner, 0o755),
        "Omamail/nsh/app.json": (json.dumps({"name": "Omamail", "id": app_id, "version": version}).encode(), 0o644),
        "Omamail/nsh/bundle.nshc": (b"bytecode", 0o644),
        f"Omamail/{APP_ID}.desktop": (desktop.encode(), 0o644),
        f"Omamail/{APP_ID}.png": (b"\x89PNG\r\n\x1a\n", 0o644),
    }


def macos_files(version, bundle_id=APP_ID):
    info = plistlib.dumps({
        "CFBundleIdentifier": bundle_id,
        "CFBundleExecutable": "Omamail",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": "1",
    })
    return {
        "Omamail.app/Contents/Info.plist": (info, 0o644),
        "Omamail.app/Contents/MacOS/Omamail": (MACHO_ARM64, 0o755),
        "Omamail.app/Contents/Resources/nsh/app.json": (json.dumps({"id": APP_ID, "version": version}).encode(), 0o644),
        "Omamail.app/Contents/Resources/nsh/bundle.nshc": (b"bytecode", 0o644),
    }


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.scratch.name)
        self.home = self.dir / "home"
        self.home.mkdir()
        self.releases = self.dir / "releases"
        self.releases.mkdir()

    def tearDown(self):
        self.scratch.cleanup()

    def archive(self, name, files, extra=None):
        path = self.releases / name
        with tarfile.open(path, "w:gz") as tar:
            for member, (data, mode) in files.items():
                info = tarfile.TarInfo(member)
                info.size = len(data)
                info.mode = mode
                tar.addfile(info, io.BytesIO(data))
            for info in extra or []:
                tar.addfile(info)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        with (self.releases / "SHA256SUMS").open("a") as sums:
            sums.write(f"{digest}  {name}\n")
        return path

    def install(self, archive, *args, os_name="Linux", arch="x86_64", **env):
        environment = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.home),
            "TMPDIR": str(self.dir),
            "OMAMAIL_INSTALL_TEST_MODE": "1",
            "OMAMAIL_TEST_OS": os_name,
            "OMAMAIL_TEST_ARCH": arch,
            "OMAMAIL_TEST_SKIP_GLIBC": "1",
            "OMAMAIL_TEST_XATTR_COMMAND": "/usr/bin/true",
            **env,
        }
        command = ["sh", str(INSTALLER), *args]
        if archive is not None:
            command += ["--archive", str(archive)]
        return subprocess.run(command, env=environment, capture_output=True, text=True)

    @property
    def linux_app(self):
        return self.home / ".local/share/omamail/Omamail"

    @property
    def desktop(self):
        return self.home / f".local/share/applications/{APP_ID}.desktop"

    @property
    def link(self):
        return self.home / ".local/bin/omamail-app"

    def installed_version(self):
        return json.loads((self.linux_app / "nsh/app.json").read_text())["version"]

    def assertRefused(self, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message, result.stderr)
        self.assertFalse(self.linux_app.exists())
        self.assertFalse(self.link.exists() or self.link.is_symlink())
        self.assertFalse(self.desktop.exists())

    def test_linux_installs_where_the_notice_helper_finds_it(self):
        result = self.install(self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0")))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Omamail 0.13.0 installed", result.stdout)
        self.assertEqual(self.installed_version(), "0.13.0")
        self.assertTrue(os.access(self.linux_app / "Omamail", os.X_OK))
        self.assertEqual(os.readlink(self.link), str(self.linux_app / "Omamail"))
        entry = self.desktop.read_text()
        self.assertIn(f'Exec="{self.linux_app}/Omamail"\n', entry)
        self.assertIn(f"Icon={self.linux_app}/{APP_ID}.png\n", entry)
        self.assertIn(f"StartupWMClass={APP_ID}\n", entry)
        status = subprocess.run(
            ["sh", str(HELPER), "status"], capture_output=True, text=True,
            env={"PATH": "/usr/bin:/bin", "HOME": str(self.home), "XDG_DATA_DIRS": str(self.dir / "none")},
        )
        self.assertEqual(status.stdout.strip(), "installed", status.stderr)

    def test_linux_upgrade_removes_the_qt_app_and_keeps_user_data(self):
        legacy = self.home / ".local/omamail.app"
        (legacy / "bin").mkdir(parents=True)
        (legacy / "bin/omamail").write_text("qt")
        bin_dir = self.home / ".local/bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "omamail").symlink_to(legacy / "bin/omamail")
        applications = self.home / ".local/share/applications"
        applications.mkdir(parents=True)
        (applications / "omamail.desktop").write_text("[Desktop Entry]\n")
        config = self.home / ".config/omamail"
        config.mkdir(parents=True)
        (config / "accounts.json").write_text("[]")
        # The app's own data shares the install's parent directory.
        data = self.home / ".local/share/omamail/cache.db"
        data.parent.mkdir(parents=True)
        data.write_text("mail")

        result = self.install(self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0")))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(legacy.exists())
        self.assertFalse((bin_dir / "omamail").is_symlink())
        self.assertFalse((applications / "omamail.desktop").exists())
        self.assertEqual((config / "accounts.json").read_text(), "[]")
        self.assertEqual(data.read_text(), "mail")

    def test_an_omamail_link_that_is_not_the_qt_apps_is_left_alone(self):
        bin_dir = self.home / ".local/bin"
        bin_dir.mkdir(parents=True)
        other = self.dir / "elsewhere"
        other.write_text("someone else's")
        (bin_dir / "omamail").symlink_to(other)
        result = self.install(self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0")))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(os.readlink(bin_dir / "omamail"), str(other))

    def test_a_checksum_mismatch_installs_nothing(self):
        archive = self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0"))
        (self.releases / "SHA256SUMS").write_text(f"{'0' * 64}  {archive.name}\n")
        self.assertRefused(self.install(archive), "checksum mismatch")

    def test_a_missing_checksum_entry_installs_nothing(self):
        archive = self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0"))
        (self.releases / "SHA256SUMS").write_text("")
        self.assertRefused(self.install(archive), "exactly one valid entry")

    def test_another_apps_package_is_refused(self):
        archive = self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0", app_id="com.example.other"))
        self.assertRefused(self.install(archive), "app.json id")

    def test_the_version_inside_must_match_the_archive_name(self):
        archive = self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.12.9"))
        self.assertRefused(self.install(archive), "does not match the archive name")

    def test_a_requested_version_must_match_the_archive(self):
        archive = self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0"))
        self.assertRefused(self.install(archive, "--version", "0.14.0"), "does not match the requested version")

    def test_an_archive_for_another_platform_is_refused(self):
        archive = self.archive("Omamail-0.13.0-macos-aarch64.tar.gz", linux_files("0.13.0"))
        self.assertRefused(self.install(archive), "release archive name is not")

    def test_a_runner_for_another_architecture_is_refused(self):
        archive = self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0", runner=ELF_ARM64))
        self.assertRefused(self.install(archive), "wrong architecture")

    def test_a_mailto_handler_is_refused(self):
        desktop = "[Desktop Entry]\nType=Application\nExec=Omamail %u\nMimeType=x-scheme-handler/mailto;\n"
        archive = self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0", desktop=desktop))
        self.assertRefused(self.install(archive), "mailto")

    def test_an_entry_outside_the_app_directory_is_refused(self):
        escape = tarfile.TarInfo("Omamail/../../escaped")
        escape.size = 0
        archive = self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0"), extra=[escape])
        self.assertRefused(self.install(archive), "unexpected top-level layout")
        self.assertFalse((self.dir / "escaped").exists())

    def test_a_link_out_of_the_app_directory_is_refused(self):
        link = tarfile.TarInfo("Omamail/nsh/secrets")
        link.type = tarfile.SYMTYPE
        link.linkname = "../../../../.ssh"
        archive = self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0"), extra=[link])
        self.assertRefused(self.install(archive), "escapes staging")

    def test_a_failed_replace_restores_the_installed_app(self):
        first = self.install(self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0")))
        self.assertEqual(first.returncode, 0, first.stderr)
        entry = self.desktop.read_text()
        result = self.install(
            self.archive("Omamail-0.14.0-linux-x86_64.tar.gz", linux_files("0.14.0")),
            OMAMAIL_TEST_FAIL_AFTER_REPLACE="1",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("previous installation was restored", result.stderr)
        self.assertEqual(self.installed_version(), "0.13.0")
        self.assertEqual(self.desktop.read_text(), entry)
        self.assertFalse(pathlib.Path(f"{self.linux_app}.previous").exists())

    def test_uninstall_removes_the_app_and_keeps_accounts(self):
        self.assertEqual(self.install(self.archive("Omamail-0.13.0-linux-x86_64.tar.gz", linux_files("0.13.0"))).returncode, 0)
        config = self.home / ".config/omamail"
        config.mkdir(parents=True)
        (config / "accounts.json").write_text("[]")
        data = self.home / ".local/share/omamail/cache.db"
        data.write_text("mail")
        result = self.install(None, "--uninstall")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.linux_app.exists())
        self.assertFalse(self.link.is_symlink())
        self.assertFalse(self.desktop.exists())
        self.assertEqual((config / "accounts.json").read_text(), "[]")
        self.assertEqual(data.read_text(), "mail")

    def test_macos_replaces_the_app_in_applications(self):
        app = self.home / "Applications/Omamail.app"
        (app / "Contents/MacOS").mkdir(parents=True)
        (app / "Contents/MacOS/omamail-app").write_text("qt")
        archive = self.archive("Omamail-0.13.0-macos-aarch64.tar.gz", macos_files("0.13.0"))
        result = self.install(archive, os_name="Darwin", arch="arm64")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((app / "Contents/MacOS/omamail-app").exists())
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        self.assertEqual(info["CFBundleIdentifier"], APP_ID)
        self.assertTrue(os.access(app / "Contents/MacOS/Omamail", os.X_OK))

    def test_macos_refuses_another_bundle_id(self):
        archive = self.archive("Omamail-0.13.0-macos-aarch64.tar.gz", macos_files("0.13.0", bundle_id="com.omamail.app"))
        result = self.install(archive, os_name="Darwin", arch="arm64")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Info.plist does not match", result.stderr)
        self.assertFalse((self.home / "Applications/Omamail.app").exists())


if __name__ == "__main__":
    unittest.main()
