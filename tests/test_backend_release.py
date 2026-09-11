#!/usr/bin/env python3
"""Exercise release preparation, package integrity and pin commit guards."""
import hashlib
import gzip
import io
import importlib.util
import json
from pathlib import Path
import subprocess
import os
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_helper(self, *args):
        return subprocess.run(['python3', str(ROOT / 'scripts/package-backend.py'), *map(str, args)], capture_output=True, text=True)

    def metadata(self):
        (self.root / 'Cargo.toml').write_text('[package]\nname = "omamail"\nversion = "0.8.2"\n')
        (self.root / 'Cargo.lock').write_text('[[package]]\nname = "omamail"\nversion = "0.8.2"\n')
        (self.root / 'manifest.json').write_text(json.dumps({'version': '0.8.2'}))
        (self.root / 'backend-version').write_text('0.8.1\n')

    def test_preparation_allows_old_pin_but_merge_requires_equality(self):
        self.metadata()
        self.assertEqual(self.run_helper('check', '--root', self.root, '--tag', 'v0.8.2').returncode, 0)
        self.assertNotEqual(self.run_helper('check', '--root', self.root, '--require-pin').returncode, 0)
        (self.root / 'Cargo.lock').write_text('[[package]]\nname = "omamail"\nversion = "0.8.1"\n')
        self.assertNotEqual(self.run_helper('check', '--root', self.root).returncode, 0)

    def test_archive_has_only_regular_executable_and_checksum_detects_corruption(self):
        binary = self.root / 'binary'
        binary.write_bytes(b'example binary')
        binary.chmod(0o755)
        result = self.run_helper('package', binary, 'x86_64', self.root / 'out')
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = self.root / 'out/omamail-linux-x86_64.tar.gz'
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
            self.assertEqual([m.name for m in members], ['omamail'])
            self.assertTrue(members[0].isreg())
            self.assertEqual(members[0].mode, 0o755)
        self.assertEqual(self.run_helper('verify', archive.parent, '--arch', 'x86_64').returncode, 0)
        archive.write_bytes(archive.read_bytes() + b'corrupt')
        self.assertNotEqual(self.run_helper('verify', archive.parent, '--arch', 'x86_64').returncode, 0)

    def test_matching_hash_does_not_authorize_symlink_archive(self):
        archive = self.root / 'omamail-linux-x86_64.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            item = tarfile.TarInfo('omamail')
            item.type = tarfile.SYMTYPE
            item.linkname = '/tmp/forbidden'
            tar.addfile(item)
        (self.root / 'SHA256SUMS').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')
        self.assertNotEqual(self.run_helper('verify', self.root, '--arch', 'x86_64').returncode, 0)

    def test_workflow_negative_gates_stop_before_next_effect(self):
        # Execute the workflows' actual guard commands, with a following effect.
        for workflow in ('ci.yml', 'release.yml'):
            gates = [line.strip() for line in (ROOT / '.github/workflows' / workflow).read_text().splitlines()
                     if 'grep ' in line]
            self.assertTrue(gates)
            for gate in gates:
                for fixture, should_pass in [('INTERP NEEDED\nv0.8.2\n', False), ('safe\n', True), (None, False)]:
                    with self.subTest(workflow=workflow, gate=gate, fixture=fixture):
                        for name in ('program-headers.txt', 'dynamic-headers.txt', 'releases.txt'):
                            path = self.root / name
                            if fixture is None:
                                path.unlink(missing_ok=True)
                            else:
                                path.write_text(fixture)
                        effect = self.root / 'published'
                        effect.unlink(missing_ok=True)
                        result = subprocess.run(['bash', '-c', 'set -euo pipefail\n' + gate + '\nprintf reached > published\n'],
                                                cwd=self.root, env=dict(os.environ, VERSION='0.8.2'), capture_output=True)
                        self.assertEqual(result.returncode == 0, should_pass)
                        self.assertEqual(effect.exists(), should_pass)

    def test_physical_archive_metadata_padding_and_trailing_data_are_refused(self):
        archive = self.root / 'omamail-linux-x86_64.tar.gz'
        base = io.BytesIO()
        with tarfile.open(fileobj=base, mode='w') as tar:
            member = tarfile.TarInfo('omamail')
            member.mode = 0o755
            member.size = 1
            tar.addfile(member, io.BytesIO(b'x'))
        raw = base.getvalue()
        pax = io.BytesIO()
        with tarfile.open(fileobj=pax, mode='w', format=tarfile.PAX_FORMAT) as tar:
            member.pax_headers = {'comment': 'hidden physical metadata'}
            tar.addfile(member, io.BytesIO(b'x'))
        gnu = tarfile.TarInfo('././@LongLink')
        gnu.type = tarfile.GNUTYPE_LONGNAME
        gnu.size = 8
        payloads = [pax.getvalue(), gnu.tobuf(format=tarfile.GNU_FORMAT) + b'omamail\0' + bytes(504) + raw,
                    raw[:513] + b'!' + raw[514:], raw + b'garbage', raw[:1024]]
        spec = importlib.util.spec_from_file_location('release_runtime_test', ROOT / 'scripts/backend-runtime.py')
        runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runtime)
        runtime.ROOT = self.root
        runtime.BINARY = self.root / 'runtime/bin/omamail'
        runtime.BINARY.parent.mkdir(parents=True)
        runtime.BINARY.write_bytes(b'old working runtime')
        (self.root / 'backend-version').write_text('0.8.2\n')
        for payload in payloads:
            with self.subTest(payload_size=len(payload)):
                archive.write_bytes(gzip.compress(payload))
                (self.root / 'SHA256SUMS').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '  ' + archive.name + '\n')
                self.assertNotEqual(self.run_helper('verify', self.root, '--arch', 'x86_64').returncode, 0)
                runtime.download = lambda url, limit: ((self.root / 'SHA256SUMS').read_bytes()
                                                      if url.endswith('SHA256SUMS') else archive.read_bytes())
                with self.assertRaises(runtime.Refused):
                    runtime.install('0.8.2', 'x86_64')
                self.assertEqual(runtime.BINARY.read_bytes(), b'old working runtime')

    def test_bump_prepares_metadata_without_advancing_pin_or_committing(self):
        self.metadata()
        (self.root / 'scripts').mkdir()
        for name in ('bump.sh', 'package-backend.py'):
            (self.root / 'scripts' / name).write_bytes((ROOT / 'scripts' / name).read_bytes())
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        result = subprocess.run(['bash', str(self.root / 'scripts/bump.sh'), '0.8.3'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'backend-version').read_text(), '0.8.1\n')
        self.assertEqual(json.loads((self.root / 'manifest.json').read_text())['version'], '0.8.3')
        self.assertNotEqual(subprocess.run(['git', '-C', str(self.root), 'rev-parse', '--verify', 'HEAD'], capture_output=True).returncode, 0)

    def test_pin_updates_only_source_branch_and_refuses_moved_remote(self):
        self.metadata()
        def git(*args):
            return subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True, text=True).stdout.strip()
        git('init', '-q')
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.invalid')
        git('checkout', '-b', 'feature')
        git('add', '.')
        git('commit', '-qm', 'prepare')
        prepared = git('rev-parse', 'HEAD')
        remote = self.root / 'remote.git'
        subprocess.run(['git', 'init', '--bare', '-q', str(remote)], check=True)
        git('remote', 'add', 'origin', str(remote))
        git('push', 'origin', 'HEAD:feature', 'HEAD:main')
        result = self.run_helper('pin', '--root', self.root, '--branch', 'feature', '--expected', prepared)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'backend-version')
        self.assertEqual(git('ls-remote', 'origin', 'refs/heads/main').split()[0], prepared)
        self.assertEqual((self.root / 'backend-version').read_text(), '0.8.2\n')
        # Restore the old checkout without touching the remote's newer revision.
        git('checkout', '--detach', prepared)
        result = self.run_helper('pin', '--root', self.root, '--branch', 'feature', '--expected', prepared)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'backend-version').read_text(), '0.8.1\n')
        self.assertEqual(git('rev-parse', 'HEAD'), prepared)


if __name__ == '__main__':
    unittest.main()
