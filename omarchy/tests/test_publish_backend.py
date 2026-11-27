#!/usr/bin/env python3
"""Run the CI publication script with real Git/packages and a synthetic GitHub boundary."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'checkout'
        self.repo.mkdir()
        self.remote = self.root / 'origin.git'
        self.env = dict(os.environ)
        self.env.update(VERSION='0.2.0', BRANCH='release/0.2.0',
                        GITHUB_REF_TYPE='branch', GITHUB_REF_NAME='release/0.2.0',
                        GITHUB_REPOSITORY='example/mail', GH_REPOSITORY='example/mail',
                        GH_TOKEN='synthetic-test-token', TEST_MODE='', TEST_LOG=str(self.root / 'calls'))
        (self.repo / 'scripts').mkdir()
        for name in ('package-backend.py', 'publish-backend.sh', 'release-source.sh', 'release-notes.sh'):
            shutil.copy(ROOT / 'scripts' / name, self.repo / 'scripts' / name)
        (self.repo / 'src').mkdir()
        (self.repo / 'src/main.rs').write_text('fn main() {}')
        (self.repo / 'Cargo.toml').write_text('[package]\nname="omamail"\nversion="0.2.0"\n')
        (self.repo / 'Cargo.lock').write_text('[[package]]\nname="omamail"\nversion="0.2.0"\n')
        (self.repo / 'manifest.json').write_text('{"version":"0.2.0"}\n')
        (self.repo / 'app').mkdir()
        (self.repo / 'app/CMakeLists.txt').write_text(
            'cmake_minimum_required(VERSION 3.21)\nproject(omamail-app VERSION 0.2.0 LANGUAGES CXX)\n')
        (self.repo / 'install.sh').write_text('#!/bin/sh\nexit 0\n')
        (self.repo / 'install.ps1').write_text('exit 0\n')
        (self.repo / 'backend-version').write_text('0.1.0\n')
        self.contract = {'apiVersion': 2, 'releasedApiVersion': 1, 'protocolVersion': 1,
                         'methods': ['system.info', 'message.new'],
                         'contractCases': [{'name': 'handshake', 'method': 'system.info', 'params': {}, 'types': {'name': 'string'}}],
                         'unreleased': {'methods': ['message.new'], 'cases': []}}
        (self.repo / 'backend-api.json').write_text(json.dumps(self.contract))
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('add', '.')
        self.git('commit', '-qm', 'Initial')
        self.main = self.git('rev-parse', 'HEAD')
        subprocess.run(['git', 'init', '--bare', '-q', str(self.remote)], check=True)
        self.git('remote', 'add', 'origin', str(self.remote))
        self.git('tag', 'v0.1.0')
        self.git('push', '-q', 'origin', 'main', 'refs/tags/v0.1.0')
        self.git('switch', '-qc', 'release/0.2.0')
        self.git('commit', '-qm', 'Version 0.2.0', '--allow-empty')
        self.sha = self.git('rev-parse', 'HEAD')
        self.git('push', '-q', 'origin', 'release/0.2.0')
        self.env['GITHUB_SHA'] = self.sha
        binary = self.root / 'omamail'
        binary.write_bytes(b'synthetic binary; contract execution belongs to native CI')
        binary.chmod(0o755)
        for arch in ('x86_64', 'aarch64'):
            artifact = self.repo / 'artifacts' / ('backend-' + arch)
            self.helper('package', str(binary), arch, str(artifact))
            self.helper('provenance', '--output', str(artifact / 'backend-build.json'))
            shutil.copy(self.repo / 'backend-api.json', artifact / 'backend-api.json')
        app_assets = {
            'app-macos-aarch64': 'omamail-app-macos-aarch64.tar.gz',
            'app-linux-x86_64': 'omamail-app-linux-x86_64.tar.gz',
            'app-windows-x86_64': 'omamail-app-windows-x86_64.zip',
        }
        for artifact_name, asset_name in app_assets.items():
            artifact = self.repo / 'artifacts' / artifact_name
            artifact.mkdir(parents=True)
            (artifact / asset_name).write_bytes(('synthetic ' + asset_name).encode())
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        gh = bin_dir / 'gh'
        gh.write_text('''#!/usr/bin/env python3
import json, os, pathlib, shutil, subprocess, sys
args = sys.argv[1:]
mode = os.environ['TEST_MODE']
with open(os.environ['TEST_LOG'], 'a') as log:
    log.write(json.dumps(args) + '\\n')
# No call to GitHub may happen after an early pin update.
assert pathlib.Path('backend-version').read_text() == '0.1.0\\n'
assert json.loads(pathlib.Path('backend-api.json').read_text())['releasedApiVersion'] == 1
if args[:2] == ['api', '--paginate']:
    if mode == 'api-failure': sys.exit(1)
    if mode == 'existing': print('v0.2.0')
elif args[:3] == ['api', '--method', 'POST']:
    assert args[3] == 'repos/example/mail/releases/generate-notes'
    assert 'tag_name=v0.2.0' in args
    assert 'target_commitish=' + os.environ['GITHUB_SHA'] in args
    print('')
elif args[:2] == ['release', 'create']:
    assert '--verify-tag' in args and '--draft' in args
    uploaded = {pathlib.Path(arg).name for arg in args if arg.startswith('release-assets/')}
    assert uploaded == {
        'omamail-linux-x86_64.tar.gz', 'omamail-linux-aarch64.tar.gz',
        'omamail-app-macos-aarch64.tar.gz', 'omamail-app-linux-x86_64.tar.gz',
        'omamail-app-windows-x86_64.zip', 'install.sh', 'install.ps1',
        'SHA256SUMS', 'backend-api.json', 'backend-build.json'}
    tag = subprocess.check_output(['git', 'ls-remote', 'origin', 'refs/tags/v0.2.0'], text=True).split()[0]
    assert tag == os.environ['GITHUB_SHA']
    if mode == 'create-failure': sys.exit(1)
    pathlib.Path('draft-created').touch()
elif args[:2] == ['release', 'edit']:
    assert pathlib.Path('draft-created').exists()
    assert pathlib.Path('draft-downloaded').exists()
    if mode == 'edit-failure': sys.exit(1)
    pathlib.Path('public-release').touch()
elif args[:2] == ['release', 'download']:
    assert pathlib.Path('draft-created').exists()
    destination = pathlib.Path(args[args.index('--dir') + 1])
    is_public = pathlib.Path('public-release').exists()
    assert (destination.name == 'public-download') == is_public
    if (mode == 'download-failure' and not is_public) or (mode == 'public-download-failure' and is_public): sys.exit(1)
    for path in pathlib.Path('release-assets').iterdir():
        shutil.copy(path, destination / path.name)
    pathlib.Path('public-downloaded' if is_public else 'draft-downloaded').touch()
    if mode == 'corrupt' and not is_public:
        (destination / 'omamail-linux-aarch64.tar.gz').write_bytes(b'corrupt')
    if mode in ('corrupt-app', 'public-corrupt') and is_public == (mode == 'public-corrupt'):
        (destination / 'omamail-app-linux-x86_64.tar.gz').write_bytes(b'corrupt')
    if mode == 'wrong-contract' and not is_public:
        (destination / 'backend-api.json').write_text('{}')
    if mode == 'wrong-provenance' and not is_public:
        (destination / 'backend-build.json').write_text('{}')
    if mode == 'moved' and is_public:
        subprocess.run(['git', 'push', 'origin', 'HEAD:refs/heads/release/0.2.0'], check=True)
        subprocess.run(['git', '--git-dir', '../origin.git', 'update-ref', 'refs/heads/release/0.2.0', 'refs/heads/main'], check=True)
else:
    sys.exit('Unexpected gh operation: ' + repr(args))
''')
        gh.chmod(0o755)
        self.env['PATH'] = str(bin_dir) + os.pathsep + self.env['PATH']

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, capture_output=True, text=True, check=True).stdout.strip()

    def helper(self, *args):
        subprocess.run(['python3', 'scripts/package-backend.py', *args], cwd=self.repo,
                       capture_output=True, text=True, check=True)

    def publish(self, mode=''):
        self.env['TEST_MODE'] = mode
        if mode == 'missing-app':
            (self.repo / 'artifacts/app-linux-x86_64/omamail-app-linux-x86_64.tar.gz').unlink()
        return subprocess.run(['bash', 'scripts/publish-backend.sh'], cwd=self.repo, env=self.env,
                              capture_output=True, text=True)

    def test_publish_verifies_downloads_then_pins_same_branch(self):
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [json.loads(line) for line in (self.root / 'calls').read_text().splitlines()]
        stages = [call[1] for call in calls if call[0] == 'release']
        self.assertEqual(stages, ['create', 'download', 'edit', 'download'])
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/main').split()[0], self.main)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/tags/v0.2.0').split()[0], self.sha)
        self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/release/0.2.0').split()[0], self.git('rev-parse', 'HEAD'))
        self.assertEqual(self.git('rev-parse', 'HEAD^'), self.sha)
        self.assertEqual(self.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'backend-api.json\nbackend-version')
        self.assertEqual((self.repo / 'backend-version').read_text(), '0.2.0\n')
        folded = json.loads((self.repo / 'backend-api.json').read_text())
        self.assertEqual(folded['releasedApiVersion'], 2)
        self.assertEqual(folded['unreleased'], {'methods': [], 'cases': []})

    def test_failure_never_advances_pin_or_main(self):
        # Each subcase needs independent tags, checkout and simulated release state.
        for mode in ('api-failure', 'existing', 'create-failure', 'edit-failure',
                     'download-failure', 'corrupt', 'corrupt-app', 'wrong-contract',
                     'wrong-provenance', 'public-download-failure', 'public-corrupt',
                     'moved', 'missing-app'):
            with self.subTest(mode=mode):
                if mode != 'api-failure':
                    self.temp.cleanup()
                    self.setUp()
                result = self.publish(mode)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                calls = [json.loads(line) for line in (self.root / 'calls').read_text().splitlines()]
                stages = [call[1] for call in calls if call[0] == 'release']
                expected = ([] if mode in ('api-failure', 'existing', 'missing-app') else
                            ['create'] if mode == 'create-failure' else
                            ['create', 'download', 'edit', 'download']
                            if mode in ('public-download-failure', 'public-corrupt', 'moved') else
                            ['create', 'download', 'edit'] if mode == 'edit-failure' else
                            ['create', 'download'])
                self.assertEqual(stages, expected, result.stderr)
                if mode in ('download-failure', 'corrupt', 'corrupt-app',
                            'wrong-contract', 'wrong-provenance'):
                    self.assertFalse((self.repo / 'public-release').exists(), result.stderr)
                self.assertEqual((self.repo / 'backend-version').read_text(), '0.1.0\n')
                self.assertEqual(json.loads((self.repo / 'backend-api.json').read_text()), self.contract)
                self.assertEqual(self.git('rev-parse', 'HEAD'), self.sha)
                self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/main').split()[0], self.main)
                if mode != 'moved':
                    self.assertEqual(self.git('ls-remote', 'origin', 'refs/heads/release/0.2.0').split()[0], self.sha)
                if mode in ('api-failure', 'existing'):
                    self.assertEqual(self.git('ls-remote', 'origin', 'refs/tags/v0.2.0'), '')


if __name__ == '__main__':
    unittest.main()
