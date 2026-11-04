#!/usr/bin/env python3
"""Synthetic release tests; never access releases or the installed plugin."""
import base64
import email.message
import fcntl
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
import urllib.error
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
        (self.root / "backend-api.json").write_text('{"apiVersion": 1, "releasedApiVersion": 1, "unreleased": {"methods": [], "cases": []}}')
        self.data = Path(self.tmp.name).resolve() / "data/omamail"
        self.home = Path(self.tmp.name).resolve() / "home"
        self.binary = self.data / "bin/omamail"
        patch.object(self.manager, "DATA_ROOT", self.data).start()
        patch.object(self.manager, "BINARY", self.binary).start()
        patch.object(self.manager, "LOCAL_BUILD", self.data / "local-build.json").start()
        patch.object(self.manager, "LOCK", self.data / "runtime.lock").start()
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {}, clear=True).start()
        patch.object(self.manager.Path, "home", return_value=self.home).start()
        patch.object(self.manager.platform, "system", return_value="Linux").start()
        patch.object(self.manager.platform, "machine", return_value="x86_64").start()
        patch.object(self.manager, "download", side_effect=AssertionError("unexpected network")).start()

    def test_runtime_lives_in_xdg_data_outside_plugin_tree(self):
        data = Path(self.tmp.name).resolve() / "data"
        home = Path(self.tmp.name).resolve() / "home"
        target = self.root / "scripts/xdg-backend-runtime.py"
        shutil.copyfile(SOURCE, target)
        spec = importlib.util.spec_from_file_location("xdg_runtime_manager", target)
        manager = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"XDG_DATA_HOME": str(data)}, clear=True):
            spec.loader.exec_module(manager)
        self.assertEqual(manager.BINARY, data / "omamail/bin/omamail")
        self.assertFalse(manager.BINARY.is_relative_to(manager.ROOT))
        spec = importlib.util.spec_from_file_location("home_runtime_manager", target)
        manager = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {}, clear=True), patch.object(Path, "home", return_value=home):
            spec.loader.exec_module(manager)
        self.assertEqual(manager.BINARY, home / ".local/share/omamail/bin/omamail")

    def old(self):
        self.binary.parent.mkdir(parents=True, exist_ok=True)
        self.binary.write_bytes(b"#!/bin/sh\nprintf 'omamail 0.8.1\\n'\n")
        self.binary.chmod(0o700)
        return self.binary.read_bytes()

    def plugin_tree(self):
        return [(str(path.relative_to(self.root)), path.is_dir(),
                 b"" if path.is_dir() else path.read_bytes())
                for path in sorted(self.root.rglob("*"))]

    def test_install_and_cli_enable_do_not_write_the_watched_plugin_tree(self):
        self.release(self.archive())
        before = self.plugin_tree()
        self.assertEqual(self.manager.run("install")["state"], "ready")
        self.assertEqual(self.manager.run("enable-cli")["state"], "ready")
        self.assertEqual(self.plugin_tree(), before)
        self.assertTrue(self.binary.is_file())
        self.assertEqual(os.readlink(self.home / ".local/bin/omamail"), str(self.binary))

    def test_install_local_checks_version_and_preserves_old_runtime_on_failure(self):
        source = self.root / "target/release/omamail"
        source.parent.mkdir(parents=True)
        source.write_text("#!/bin/sh\nprintf 'omamail 0.8.2\\n'\n")
        source.chmod(0o700)
        result = self.manager.run("install-local")
        self.assertEqual(result["state"], "ready", result)
        installed = self.binary
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
        runtime_python = tools / "python3"
        runtime_python.write_text(f"#!{sys.executable}\n" + '''import platform, runpy, sys
platform.system = lambda: "Linux"
platform.machine = lambda: "x86_64"
sys.argv = sys.argv[1:]
runpy.run_path(sys.argv[0], run_name="__main__")
''')
        runtime_python.chmod(0o700)
        link = self.root / "scripts/link-plugin.sh"
        link.write_text(f'''#!/bin/sh
set -eu
test "$({self.binary} --version)" = 'omamail 0.8.2'
cmp target/release/omamail {self.binary}
touch linked
''')
        env = dict(os.environ, PATH=str(tools) + os.pathsep + os.defpath,
                   CARGO_TARGET_DIR=str(self.root / "other-target"),
                   XDG_DATA_HOME=str(self.data.parent))
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
        marker = self.data / "local-build.json"
        self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
        with patch.object(self.manager.Path, "home", return_value=self.home):
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
        self.assertFalse((self.data / "local-build.json").exists())
        self.assertEqual(self.manager.run("status")["requiredVersion"], "0.8.2")

    def test_unsafe_local_marker_refused_without_touching_target(self):
        self.local_checkout()
        self.assertEqual(self.manager.run("install-local")["state"], "ready")
        marker = self.data / "local-build.json"
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
        self.assertFalse((self.data / "local-build.json").exists())

    def test_failed_atomic_replacement_preserves_local_runtime_and_marker(self):
        source = self.local_checkout()
        self.assertEqual(self.manager.run("install-local")["state"], "ready")
        previous = self.binary.read_bytes()
        marker = self.data / "local-build.json"
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
        self.assertEqual(result, dict(state="missing", requiredVersion="0.8.2", requiredApiVersion=1, latestApiVersion=1, unreleasedMethods=[], installedVersion="", executable=str(self.binary), error="", cliInstalled=False))
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
        # The handshake wants the released revision; the step ahead of it is
        # reported beside it with the methods only that step has.
        (self.root / "backend-api.json").write_text('{"apiVersion": 2, "releasedApiVersion": 1, "unreleased": {"methods": ["message.new"], "cases": []}}')
        result = self.manager.run("status")
        self.assertEqual(result["requiredApiVersion"], 1)
        self.assertEqual(result["latestApiVersion"], 2)
        self.assertEqual(result["unreleasedMethods"], ["message.new"])
        (self.root / "backend-api.json").write_text('{"apiVersion": 2, "releasedApiVersion": 2, "unreleased": {"methods": [], "cases": []}}')
        self.assertEqual(self.manager.run("status")["requiredApiVersion"], 2)

    def test_missing_or_invalid_api_contract_fails_closed(self):
        contract = self.root / "backend-api.json"
        for value in (0, -1, True, "1", 1.5):
            contract.write_text(json.dumps({"apiVersion": value, "releasedApiVersion": 1, "unreleased": {"methods": [], "cases": []}}))
            self.assertEqual(self.manager.run("status")["state"], "error")
        for bad in ({"apiVersion": 3, "releasedApiVersion": 1, "unreleased": {"methods": [], "cases": []}},
                    {"apiVersion": 1}, {"apiVersion": 2, "releasedApiVersion": 1, "unreleased": {"methods": [1], "cases": []}}):
            contract.write_text(json.dumps(bad))
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
        self.data.mkdir(parents=True, exist_ok=True)
        with (self.data / "runtime.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.manager.run("install")["state"], "error")
        self.assertEqual(self.binary.read_bytes(), old)

    def test_symlink_runtime_refused_without_touching_target(self):
        outside = self.root / "outside"
        outside.mkdir()
        self.data.parent.mkdir(parents=True)
        self.data.symlink_to(outside, target_is_directory=True)
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
        link = self.home / ".local/bin/omamail"
        link.parent.mkdir(parents=True)
        with patch.object(self.manager.Path, "home", return_value=self.home):
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

    def test_cli_install_replaces_the_owned_legacy_runtime_link(self):
        self.release(self.archive())
        self.assertEqual(self.manager.run("install")["state"], "ready")
        legacy = self.root / "runtime/bin/omamail"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("old plugin-owned runtime")
        link = self.home / ".local/bin/omamail"
        link.parent.mkdir(parents=True)
        link.symlink_to(legacy)
        with patch.object(self.manager.Path, "home", return_value=self.home):
            result = self.manager.run("enable-cli")
        self.assertEqual(result["state"], "ready", result)
        self.assertEqual(os.readlink(link), str(self.binary))
        self.assertEqual(legacy.read_text(), "old plugin-owned runtime")

    def test_cli_install_recognizes_a_previous_omamail_checkout(self):
        self.release(self.archive())
        self.assertEqual(self.manager.run("install")["state"], "ready")
        previous = Path(self.tmp.name).resolve() / "previous-plugin"
        legacy = previous / "runtime/bin/omamail"
        legacy.parent.mkdir(parents=True)
        legacy.write_text("old plugin-owned runtime")
        legacy.chmod(0o700)
        (previous / "manifest.json").write_text(json.dumps({
            "schemaVersion": 1,
            "id": "omamail",
            "description": "x" * 2048,
        }))
        link = self.home / ".local/bin/omamail"
        link.parent.mkdir(parents=True)
        link.symlink_to(legacy)
        result = self.manager.run("enable-cli")
        self.assertEqual(result["state"], "ready", result)
        self.assertEqual(os.readlink(link), str(self.binary))
        self.assertEqual(legacy.read_text(), "old plugin-owned runtime")

    def test_failed_legacy_cli_migration_preserves_the_owned_link(self):
        self.release(self.archive())
        self.assertEqual(self.manager.run("install")["state"], "ready")
        legacy = self.root / "runtime/bin/omamail"
        link = self.home / ".local/bin/omamail"
        link.parent.mkdir(parents=True)
        link.symlink_to(legacy)
        with patch.object(self.manager.os, "replace", side_effect=OSError("synthetic failure")):
            self.assertEqual(self.manager.run("enable-cli")["state"], "error")
        self.assertEqual(os.readlink(link), str(legacy))

    def test_cli_status_requires_exact_owned_link_and_valid_private_runtime(self):
        self.release(self.archive())
        self.assertFalse(self.manager.run("install")["cliInstalled"])
        link = self.home / ".local/bin/omamail"
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


class ProxyEnvironmentTests(unittest.TestCase):
    """Synthetic proxy-discovery checks; a local recorder is the only peer."""
    def setUp(self):
        spec = importlib.util.spec_from_file_location("proxy_runtime_manager", SOURCE)
        self.manager = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {}, clear=True):
            spec.loader.exec_module(self.manager)
        patch.dict(os.environ, {}, clear=True).start()
        self.addCleanup(patch.stopall)

    def release_url(self):
        return "https://github.com/huacnlee/omamail/releases/download/v0.8.2/SHA256SUMS"

    def test_download_honors_standard_proxy_environment_variables(self):
        # With HTTPS_PROXY set, the request must travel through that proxy as a
        # CONNECT tunnel; a downloader that ignores it dials the release host
        # directly, which the guarded socket refuses without any real network.
        tunnels = []

        class RecordingProxy(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_CONNECT(self):
                tunnels.append(self.path)
                self.send_response(502)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingProxy)
        self.addCleanup(server.server_close)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.shutdown)
        connect = socket.socket.connect

        def local_only(sock, address):
            if address[0] not in ("127.0.0.1", "::1"):
                raise AssertionError("unexpected direct connection to " + address[0])
            return connect(sock, address)

        with patch.dict(os.environ, {"HTTPS_PROXY": "http://127.0.0.1:%d" % server.server_address[1]}), \
                patch("socket.socket.connect", local_only):
            with self.assertRaises(urllib.error.URLError):
                self.manager.download(self.release_url(), 64 * 1024)
        self.assertEqual(tunnels, ["github.com:443"])

    def test_download_without_proxy_variables_keeps_direct_connections(self):
        # With no proxy variables set, the URL's own host is resolved and
        # contacted directly; the transport must not gain a default proxy.
        resolved = []
        real_resolver = socket.getaddrinfo

        def resolver(host, port, *args):
            resolved.append(host)
            if host == "github.com":
                return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.0.2.1", port))]
            return real_resolver(host, port, *args)

        connected = []

        def refusing(sock, address):
            connected.append(address[0])
            raise OSError("synthetic offline")

        with patch("socket.getaddrinfo", resolver), patch("socket.socket.connect", refusing):
            with self.assertRaises(urllib.error.URLError):
                self.manager.download(self.release_url(), 64 * 1024)
        self.assertEqual(resolved, ["github.com"])
        self.assertEqual(connected, ["192.0.2.1"])

    def redirected_release_url(self):
        return "https://release-assets.githubusercontent.com/huacnlee/omamail/releases/download/v0.8.2/SHA256SUMS"

    def fake_transport(self, exchanges):
        # A synthetic https transport: each hop records its CONNECT tunnel and
        # request headers, github.com answers with the release redirect and
        # every other host with a small checksum body. No socket is opened.
        redirected = self.redirected_release_url()

        class Response(io.BytesIO):
            def __init__(self, status, body, headers=()):
                super().__init__(body)
                self.status = self.code = status
                self.reason = "Synthetic"
                self.msg = self.reason
                self.headers = email.message_from_string("".join(line + "\r\n" for line in headers))

            def info(self):
                return self.headers

        class Connection:
            debuglevel = 0
            _http_vsn = 11
            sock = None

            def __init__(self, host, timeout=None, **kwargs):
                self.host = host
                self.tunnel_host = None
                self.tunnel_headers = {}
                exchanges.append(self)

            def set_debuglevel(self, level):
                pass

            def set_tunnel(self, host, headers=None):
                self.tunnel_host = host
                self.tunnel_headers = {name.lower(): value for name, value in (headers or {}).items()}

            def request(self, method, selector, body=None, headers=None, encode_chunked=False):
                self.request_headers = {name.lower(): value for name, value in (headers or {}).items()}

            def getresponse(self):
                if self.tunnel_host == "github.com":
                    return Response(302, b"", ["Location: " + redirected])
                return Response(200, b"abc123  omamail-linux-x86_64.tar.gz\n")

            def close(self):
                pass

        return Connection

    def authenticated_proxy(self):
        credentials = base64.b64encode(b"synthetic-user:synthetic-secret").decode("ascii")
        return ("http://synthetic-user:synthetic-secret@127.0.0.1:9", "Basic " + credentials)

    def test_download_keeps_proxy_credentials_off_a_bypassed_redirect_origin(self):
        # The proxy is authenticated and NO_PROXY lets the redirected release
        # host bypass it. urllib copies request headers onto redirects, so the
        # inherited credentials must be discarded: they may ride the proxy's
        # CONNECT tunnel only, never the direct request to the origin.
        exchanges = []
        proxy, credentials = self.authenticated_proxy()
        with patch.dict(os.environ, {"HTTPS_PROXY": proxy,
                                     "NO_PROXY": "release-assets.githubusercontent.com"}), \
                patch("http.client.HTTPSConnection", self.fake_transport(exchanges)):
            content = self.manager.download(self.release_url(), 64 * 1024)
        self.assertEqual(content, b"abc123  omamail-linux-x86_64.tar.gz\n")
        self.assertEqual(len(exchanges), 2)
        proxy_hop, origin_hop = exchanges
        self.assertEqual(proxy_hop.host, "127.0.0.1:9")
        self.assertEqual(proxy_hop.tunnel_host, "github.com")
        self.assertEqual(proxy_hop.tunnel_headers.get("proxy-authorization"), credentials)
        self.assertNotIn("proxy-authorization", proxy_hop.request_headers)
        self.assertEqual(origin_hop.host, "release-assets.githubusercontent.com")
        self.assertIsNone(origin_hop.tunnel_host)
        self.assertNotIn("proxy-authorization", origin_hop.request_headers)
        self.assertNotIn(credentials, " ".join(origin_hop.request_headers.values()))

    def test_download_keeps_authenticating_the_proxy_across_redirects(self):
        # Discarding inherited credentials must not leave the proxy unnamed on
        # the redirected hop: while that hop is still proxied, its CONNECT
        # tunnel carries fresh credentials from the environment again.
        exchanges = []
        proxy, credentials = self.authenticated_proxy()
        with patch.dict(os.environ, {"HTTPS_PROXY": proxy}), \
                patch("http.client.HTTPSConnection", self.fake_transport(exchanges)):
            content = self.manager.download(self.release_url(), 64 * 1024)
        self.assertEqual(content, b"abc123  omamail-linux-x86_64.tar.gz\n")
        self.assertEqual([hop.host for hop in exchanges], ["127.0.0.1:9", "127.0.0.1:9"])
        self.assertEqual([hop.tunnel_host for hop in exchanges],
                         ["github.com", "release-assets.githubusercontent.com"])
        for hop in exchanges:
            self.assertEqual(hop.tunnel_headers.get("proxy-authorization"), credentials)
            self.assertNotIn("proxy-authorization", hop.request_headers)


if __name__ == "__main__":
    unittest.main()
