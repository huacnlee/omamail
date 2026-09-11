#!/usr/bin/env python3
"""Synthetic release tests; never access releases or the installed plugin."""
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "scripts/backend-runtime.py"


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve() / "plugin"
        (self.root / "scripts").mkdir(parents=True)
        self.assertTrue(SOURCE.exists(), "runtime manager has not been implemented")
        target = self.root / "scripts/backend-runtime.py"
        shutil.copyfile(SOURCE, target)
        spec = importlib.util.spec_from_file_location("runtime_manager", target)
        self.manager = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.manager)
        (self.root / "backend-version").write_text("0.8.2\n")
        (self.root / "backend-api.json").write_text('{"apiVersion": 1}')
        self.binary = self.root / "runtime/bin/omamail"
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {}, clear=True).start()
        patch.object(self.manager.Path, "home", return_value=self.root / "home").start()
        patch.object(self.manager.platform, "system", return_value="Linux").start()
        patch.object(self.manager.platform, "machine", return_value="x86_64").start()
        patch.object(self.manager, "download", side_effect=AssertionError("unexpected network")).start()

    def old(self):
        self.binary.parent.mkdir(parents=True, exist_ok=True)
        self.binary.write_bytes(b"#!/bin/sh\nprintf 'omamail 0.8.1\\n'\n")
        self.binary.chmod(0o700)
        return self.binary.read_bytes()

    def test_install_local_checks_version_and_preserves_old_runtime_on_failure(self):
        source = self.root / "target/release/omamail"
        source.parent.mkdir(parents=True)
        source.write_text("#!/bin/sh\nprintf 'omamail 0.8.2\\n'\n")
        source.chmod(0o700)
        result = self.manager.run("install-local")
        self.assertEqual(result["state"], "ready", result)
        installed = self.root / "runtime/bin/omamail"
        self.assertEqual(installed.read_bytes(), source.read_bytes())
        self.assertEqual(installed.stat().st_mode & 0o777, 0o700)
        previous = installed.read_bytes()
        source.write_text("#!/bin/sh\nprintf 'omamail 9.9.9\\n'\n")
        self.assertEqual(self.manager.run("install-local")["state"], "error")
        self.assertEqual(installed.read_bytes(), previous)
        source.unlink()
        self.assertEqual(self.manager.run("install-local")["state"], "error")
        self.assertEqual(installed.read_bytes(), previous)

    def test_make_install_builds_and_installs_before_linking(self):
        shutil.copyfile(SOURCE.parent.parent / "Makefile", self.root / "Makefile")
        tools = self.root / "tools"
        tools.mkdir()
        cargo = tools / "cargo"
        cargo.write_text(f"#!{sys.executable}\n" + '''import os, pathlib, sys
root = pathlib.Path.cwd()
args = sys.argv[1:]
assert args[:3] == ['build', '--locked', '--release']
assert args[args.index('--target-dir') + 1] == str(root / 'target')
assert args[args.index('--bin') + 1] == 'omamail'
if os.environ.get('BUILD_FAIL'): sys.exit(1)
binary = root / 'target/release/omamail'
binary.parent.mkdir(parents=True, exist_ok=True)
binary.write_text("#!/bin/sh\\nprintf 'omamail 0.8.2\\\\n'\\n")
binary.chmod(0o700)
''')
        cargo.chmod(0o700)
        link = self.root / "scripts/link-plugin.sh"
        link.write_text('''#!/bin/sh
set -eu
test "$(runtime/bin/omamail --version)" = 'omamail 0.8.2'
cmp target/release/omamail runtime/bin/omamail
touch linked
''')
        env = dict(os.environ, PATH=str(tools) + os.pathsep + os.defpath,
                   CARGO_TARGET_DIR=str(self.root / "other-target"))
        result = subprocess.run(["make", "install"], cwd=self.root, env=env, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        marker = self.root / "linked"
        self.assertTrue(marker.exists())
        previous = self.binary.read_bytes()
        marker.unlink()
        result = subprocess.run(["make", "install"], cwd=self.root,
                                env=dict(env, BUILD_FAIL="1"), capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(marker.exists())
        self.assertEqual(self.binary.read_bytes(), previous)

    def local_checkout(self):
        (self.root / ".git").mkdir()
        (self.root / "Cargo.toml").write_text('[package]\nversion = "0.9.0"\n')
        source = self.root / "target/release/omamail"
        source.parent.mkdir(parents=True)
        source.write_text("#!/bin/sh\nprintf 'omamail 0.9.0\\n'\n")
        source.chmod(0o700)
        return source

    def test_local_checkout_can_advance_without_changing_release_pin(self):
        self.local_checkout()
        for command in ("install-local", "status"):
            result = self.manager.run(command)
            self.assertEqual(result["state"], "ready", result)
            self.assertEqual(result["requiredVersion"], "0.9.0")
            self.assertEqual(result["installedVersion"], "0.9.0")
        self.assertEqual((self.root / "backend-version").read_text(), "0.8.2\n")
        marker = self.root / "runtime/local-build.json"
        self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
        home = self.root / "home"
        with patch.object(self.manager.Path, "home", return_value=home):
            self.assertEqual(self.manager.run("enable-cli")["state"], "ready")

    def test_local_marker_never_authorizes_changed_bytes_checkout_or_pin(self):
        self.local_checkout()
        self.assertEqual(self.manager.run("install-local")["state"], "ready")
        previous = self.binary.read_bytes()
        self.binary.write_bytes(previous + b"# modified\n")
        self.assertEqual(self.manager.run("status")["state"], "mismatch")
        self.binary.write_bytes(previous)
        (self.root / "Cargo.toml").write_text('[package]\nversion = "0.9.1"\n')
        self.assertEqual(self.manager.run("status")["state"], "mismatch")
        (self.root / "Cargo.toml").write_text('[package]\nversion = "0.9.0"\n')
        (self.root / ".git").rmdir()
        self.assertEqual(self.manager.run("status")["state"], "mismatch")
        (self.root / ".git").mkdir()
        (self.root / "backend-version").write_text("0.8.3\n")
        self.assertEqual(self.manager.run("status")["requiredVersion"], "0.8.3")

    def test_release_install_keeps_exact_pin_and_clears_local_marker(self):
        self.local_checkout()
        self.assertEqual(self.manager.run("install-local")["state"], "ready")
        self.release(self.archive(version="0.9.0"))
        self.assertEqual(self.manager.run("install")["state"], "error")
        self.assertEqual(self.manager.run("status")["state"], "ready")
        self.release(self.archive())
        result = self.manager.run("install")
        self.assertEqual(result["state"], "ready", result)
        self.assertEqual(result["requiredVersion"], "0.8.2")
        self.assertFalse((self.root / "runtime/local-build.json").exists())
        self.assertEqual(self.manager.run("status")["requiredVersion"], "0.8.2")

    def test_unsafe_local_marker_refused_without_touching_target(self):
        self.local_checkout()
        self.assertEqual(self.manager.run("install-local")["state"], "ready")
        marker = self.root / "runtime/local-build.json"
        marker.chmod(0o644)
        self.assertEqual(self.manager.run("status")["state"], "error")
        outside = self.root / "outside"
        marker.rename(outside)
        marker.symlink_to(outside)
        before = outside.read_bytes()
        for command in ("status", "install-local", "uninstall"):
            self.assertEqual(self.manager.run(command)["state"], "error")
            self.assertEqual(outside.read_bytes(), before)

    def test_local_override_is_removed_on_uninstall(self):
        self.local_checkout()
        self.assertEqual(self.manager.run("install-local")["state"], "ready")
        self.assertEqual(self.manager.run("uninstall")["state"], "missing")
        self.assertFalse((self.root / "runtime/local-build.json").exists())

    def test_failed_atomic_replacement_preserves_local_runtime_and_marker(self):
        source = self.local_checkout()
        self.assertEqual(self.manager.run("install-local")["state"], "ready")
        previous = self.binary.read_bytes()
        marker = self.root / "runtime/local-build.json"
        previous_marker = marker.read_bytes()
        source.write_bytes(previous + b"# new build\n")
        replace = os.replace
        def fail_binary(src, dst):
            if dst == self.binary:
                raise OSError("synthetic replacement failure")
            return replace(src, dst)
        self.release(self.archive())
        for command in ("install-local", "install"):
            with patch.object(self.manager.os, "replace", side_effect=fail_binary):
                self.assertEqual(self.manager.run(command)["state"], "error")
            self.assertEqual(self.binary.read_bytes(), previous)
            self.assertEqual(marker.read_bytes(), previous_marker)
            self.assertEqual(self.manager.run("status")["state"], "ready")

    def archive(self, name="omamail", kind=tarfile.REGTYPE, version="0.8.2", extra=False):
        content = ("#!/bin/sh\nprintf 'omamail " + version + "\\n'\n").encode()
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz") as archive:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            entry.mode = 0o4755
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                entry.linkname = "../../outside"
            entry.size = len(content) if kind == tarfile.REGTYPE else 0
            archive.addfile(entry, io.BytesIO(content))
            if extra:
                archive.addfile(tarfile.TarInfo("extra"))
        return stream.getvalue()

    def release(self, archive, bad_hash=False, after=None):
        digest = "0" * 64 if bad_hash else hashlib.sha256(archive).hexdigest()
        sums = (digest + "  omamail-linux-x86_64.tar.gz\n").encode()
        def download(url, limit):
            self.assertTrue(url.startswith("https://github.com/huacnlee/omamail/releases/download/v0.8.2/"))
            if after:
                after()
            return sums if url.endswith("SHA256SUMS") else archive
        patch.object(self.manager, "download", side_effect=download).start()

    def test_missing_status_never_downloads(self):
        result = self.manager.run("status")
        self.assertEqual(result, dict(state="missing", requiredVersion="0.8.2", requiredApiVersion=1, installedVersion="", executable=str(self.binary), error="", cliInstalled=False))
        self.assertFalse(self.binary.parent.exists())

    def test_release_status_uses_only_local_pin_and_api_despite_newer_cargo(self):
        self.local_checkout()
        self.release(self.archive())
        self.assertEqual(self.manager.run("install")["state"], "ready")
        (self.root / "Cargo.toml").write_text('[package]\nversion = "2.0.0"\n')
        result = self.manager.run("status")
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["requiredVersion"], "0.8.2")
        self.assertEqual(result["requiredApiVersion"], 1)
        (self.root / "backend-api.json").write_text('{"apiVersion": 2}')
        self.assertEqual(self.manager.run("status")["requiredApiVersion"], 2)

    def test_missing_or_invalid_api_contract_fails_closed(self):
        contract = self.root / "backend-api.json"
        for value in (0, -1, True, "1", 1.5):
            contract.write_text(json.dumps({"apiVersion": value}))
            self.assertEqual(self.manager.run("status")["state"], "error")
        contract.unlink()
        self.assertEqual(self.manager.run("status")["state"], "error")

    def test_failed_mutations_exit_nonzero_with_json_through_wrappers(self):
        old = self.old()
        environment = {"OMAMAIL_BIN": str(self.binary), "PATH": str(Path(sys.executable).parent) + os.pathsep + os.defpath}
        commands = [[sys.executable, str(self.root / "scripts/backend-runtime.py"), action]
                    for action in ("install", "uninstall", "enable-cli", "disable-cli")]
        for wrapper in ("install-backend.sh", "uninstall-backend.sh"):
            target = self.root / "scripts" / wrapper
            shutil.copyfile(SOURCE.parent / wrapper, target)
            commands.append(["/bin/sh", str(target)])
        for command in commands:
            with self.subTest(command=command):
                completed = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=10)
                response = json.loads(completed.stdout)
                self.assertEqual(response["state"], "error")
                self.assertNotEqual(completed.returncode, 0)
                self.assertEqual(completed.stderr, "")
                self.assertEqual(self.binary.read_bytes(), old)

    def test_invalid_operation_exits_nonzero_with_json(self):
        completed = subprocess.run([sys.executable, str(self.root / "scripts/backend-runtime.py"), "invalid"],
                                   capture_output=True, text=True, timeout=10)
        self.assertEqual(json.loads(completed.stdout)["state"], "error")
        self.assertNotEqual(completed.returncode, 0)

    def test_missing_and_mismatched_status_exit_successfully(self):
        environment = {"OMAMAIL_BIN": str(self.binary)}
        command = [sys.executable, str(self.root / "scripts/backend-runtime.py"), "status"]
        missing = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=10)
        self.assertEqual(json.loads(missing.stdout)["state"], "missing")
        self.assertEqual(missing.returncode, 0)
        self.old()
        mismatch = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=10)
        self.assertEqual(json.loads(mismatch.stdout)["state"], "mismatch")
        self.assertEqual(mismatch.returncode, 0)

    def test_unsupported_platform_exits_nonzero_with_json(self):
        # Run the actual entry point with only platform detection substituted.
        program = "import platform,runpy,sys; platform.system=lambda: 'Unsupported'; sys.argv=[sys.argv[1], 'status']; runpy.run_path(sys.argv[0], run_name='__main__')"
        completed = subprocess.run([sys.executable, "-c", program, str(self.root / "scripts/backend-runtime.py")],
                                   capture_output=True, text=True, timeout=10)
        self.assertEqual(json.loads(completed.stdout)["state"], "unsupported")
        self.assertNotEqual(completed.returncode, 0)

    def test_exact_install_and_uninstall_preserve_user_data(self):
        self.release(self.archive())
        (self.root / "accounts.json").write_text("keep")
        result = self.manager.run("install")
        self.assertEqual(result["state"], "ready", result)
        self.assertEqual(self.binary.stat().st_mode & 0o7777, 0o700)
        self.assertEqual(list(self.binary.parent.iterdir()), [self.binary])
        self.assertEqual(self.manager.run("uninstall")["state"], "missing")
        self.assertEqual((self.root / "accounts.json").read_text(), "keep")

    def test_rejected_releases_preserve_old_binary(self):
        old = self.old()
        cases = [dict(bad_hash=True), dict(version="9.9.9"), dict(name="../outside"), dict(kind=tarfile.SYMTYPE), dict(kind=tarfile.LNKTYPE), dict(kind=tarfile.DIRTYPE), dict(extra=True)]
        for case in cases:
            with self.subTest(case=case):
                bad_hash = case.pop("bad_hash", False)
                self.release(self.archive(**case), bad_hash)
                self.assertEqual(self.manager.run("install")["state"], "error")
                self.assertEqual(self.binary.read_bytes(), old)
                self.assertFalse((self.root / "outside").exists())

    def test_changed_pin_preserves_old_binary(self):
        old = self.old()
        self.release(self.archive(), after=lambda: (self.root / "backend-version").write_text("0.8.3\n"))
        self.assertEqual(self.manager.run("install")["state"], "error")
        self.assertEqual(self.binary.read_bytes(), old)

    def test_hidden_archive_headers_are_refused(self):
        old = self.old()
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w:gz", format=tarfile.GNU_FORMAT) as archive:
            metadata = tarfile.TarInfo("././@LongLink")
            metadata.type = tarfile.GNUTYPE_LONGNAME
            metadata.size = 8
            archive.addfile(metadata, io.BytesIO(b"omamail\0"))
            payload = b"#!/bin/sh\nprintf 'omamail 0.8.2\\n'\n"
            entry = tarfile.TarInfo("omamail")
            entry.size = len(payload)
            archive.addfile(entry, io.BytesIO(payload))
        self.release(stream.getvalue())
        self.assertEqual(self.manager.run("install")["state"], "error")
        self.assertEqual(self.binary.read_bytes(), old)

    def test_probe_output_is_bounded_and_diagnostics_are_private(self):
        self.old()
        self.binary.write_bytes(b"#!/bin/sh\nprintf 'secret' >&2\nwhile :; do printf 'secret'; done\n")
        result = self.manager.run("status")
        self.assertEqual(result["state"], "error")
        self.assertNotIn("secret", str(result))

    def test_binary_symlink_refused_even_for_uninstall(self):
        self.old()
        outside = self.root / "outside"
        self.binary.rename(outside)
        self.binary.symlink_to(outside)
        for command in ("status", "install", "uninstall"):
            self.assertEqual(self.manager.run(command)["state"], "error")
            self.assertTrue(self.binary.is_symlink())
            self.assertTrue(outside.exists())

    def test_malformed_and_oversize_archives_preserve_old_binary(self):
        old = self.old()
        self.release(b"not a gzip archive")
        self.assertEqual(self.manager.run("install")["state"], "error")
        self.assertEqual(self.binary.read_bytes(), old)
        self.release(self.archive())
        with patch.object(self.manager, "BINARY_LIMIT", 1):
            self.assertEqual(self.manager.run("install")["state"], "error")
        self.assertEqual(self.binary.read_bytes(), old)

    def test_ambiguous_checksum_preserves_old_binary(self):
        old = self.old()
        sums = ("a" * 64 + "  omamail-linux-x86_64.tar.gz\n") * 2
        with patch.object(self.manager, "download", return_value=sums.encode()):
            self.assertEqual(self.manager.run("install")["state"], "error")
        self.assertEqual(self.binary.read_bytes(), old)

    def test_untrusted_redirects_are_refused_before_request_creation(self):
        handler = self.manager.ReleaseRedirect()
        for url in ("http://github.com/file", "https://evil.example/file", "https://github.com.evil.example/file",
                    "https://user:secret@github.com/file", "https://github.com:444/file", "https://github.com/file\n"):
            with self.subTest(url=url), self.assertRaises(self.manager.Refused):
                handler.redirect_request(None, None, 302, "Found", {}, url)

    def test_all_development_mutations_refused(self):
        old = self.old()
        with patch.dict(os.environ, {"OMAMAIL_BIN": str(self.binary)}):
            for command in ("install", "uninstall", "enable-cli", "disable-cli"):
                self.assertEqual(self.manager.run(command)["state"], "error")
        self.assertEqual(self.binary.read_bytes(), old)

    def test_unsupported_platform_never_downloads(self):
        with patch.object(self.manager.platform, "system", return_value="Darwin"):
            self.assertEqual(self.manager.run("install")["state"], "unsupported")
        self.assertFalse(self.binary.exists())

    def test_install_has_no_fallible_probe_after_atomic_commit(self):
        self.old()
        self.release(self.archive())
        actual = self.manager.version_of
        def probe(path):
            if path == self.binary:
                raise self.manager.Refused("A post-commit check failed")
            return actual(path)
        with patch.object(self.manager, "version_of", side_effect=probe):
            result = self.manager.run("install")
        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["installedVersion"], "0.8.2")

    def test_development_status_uses_exact_explicit_executable(self):
        self.old()
        with patch.dict(os.environ, {"OMAMAIL_BIN": str(self.binary)}):
            result = self.manager.run("status")
            self.assertEqual(result["state"], "mismatch")
            self.assertEqual(result["installedVersion"], "0.8.1")
            self.assertEqual(result["executable"], str(self.binary))

    def test_lock_refusal_preserves_old_binary(self):
        old = self.old()
        with (self.root / "runtime/.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.manager.run("install")["state"], "error")
        self.assertEqual(self.binary.read_bytes(), old)

    def test_symlink_runtime_refused_without_touching_target(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "runtime").symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.manager.run("install")["state"], "error")
        self.assertEqual(list(outside.iterdir()), [])

    def test_development_binary_is_never_overwritten(self):
        external = self.root / "development"
        external.write_text("developer")
        with patch.dict(os.environ, {"OMAMAIL_BIN": str(external)}):
            self.assertEqual(self.manager.run("install")["state"], "error")
        self.assertEqual(external.read_text(), "developer")

    def test_cli_link_never_replaces_unrelated_file(self):
        self.release(self.archive())
        self.assertEqual(self.manager.run("install")["state"], "ready")
        home = self.root / "home"
        link = home / ".local/bin/omamail"
        link.parent.mkdir(parents=True)
        with patch.object(self.manager.Path, "home", return_value=home):
            link.write_text("unrelated")
            self.assertEqual(self.manager.run("enable-cli")["state"], "error")
            self.assertEqual(self.manager.run("disable-cli")["state"], "error")
            self.assertEqual(link.read_text(), "unrelated")
            link.unlink()
            self.assertEqual(self.manager.run("enable-cli")["state"], "ready")
            self.assertEqual(os.readlink(link), str(self.binary))
            self.assertTrue(self.manager.run("status")["cliInstalled"])
            self.assertTrue(self.manager.run("enable-cli")["cliInstalled"])
            self.assertEqual(self.manager.run("disable-cli")["state"], "ready")
            self.assertFalse(self.manager.run("status")["cliInstalled"])
            self.assertFalse(link.is_symlink())

    def test_cli_status_requires_exact_owned_link_and_valid_private_runtime(self):
        self.release(self.archive())
        self.assertFalse(self.manager.run("install")["cliInstalled"])
        link = self.root / "home/.local/bin/omamail"
        link.parent.mkdir(parents=True)
        foreign = self.root / "foreign"
        foreign.write_text("#!/bin/sh\ntouch " + str(self.root / "executed") + "\n")
        foreign.chmod(0o700)
        link.symlink_to(foreign)
        self.assertFalse(self.manager.run("status")["cliInstalled"])
        self.assertEqual(self.manager.run("disable-cli")["state"], "error")
        self.assertTrue(link.is_symlink())
        self.assertEqual(os.readlink(link), str(foreign))
        self.assertTrue(foreign.is_file())
        self.assertFalse((self.root / "executed").exists())
        link.unlink()
        link.write_text("foreign regular file")
        self.assertFalse(self.manager.run("status")["cliInstalled"])
        link.unlink()
        link.symlink_to(self.binary)
        self.assertTrue(self.manager.run("status")["cliInstalled"])
        self.binary.unlink()
        self.assertFalse(self.manager.run("status")["cliInstalled"])
        self.old()
        self.assertFalse(self.manager.run("status")["cliInstalled"])


if __name__ == "__main__":
    unittest.main()
