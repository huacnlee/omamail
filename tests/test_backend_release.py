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
from unittest import mock

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
        (self.root / 'app').mkdir(exist_ok=True)
        (self.root / 'app/CMakeLists.txt').write_text(
            'cmake_minimum_required(VERSION 3.21)\nproject(omamail-app VERSION 0.8.2 LANGUAGES CXX)\n')
        (self.root / 'backend-version').write_text('0.8.1\n')

    def test_backend_api_process_group_cleanup_is_native_on_windows_and_posix(self):
        spec = importlib.util.spec_from_file_location('backend_api_contract_test', ROOT / 'tests/test_backend_api.py')
        backend_api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(backend_api)
        self.assertEqual(backend_api.process_group_options('nt'),
                         {'creationflags': backend_api.WINDOWS_CREATE_NEW_PROCESS_GROUP})
        self.assertEqual(backend_api.process_group_options('posix'), {'start_new_session': True})

        class Process:
            pid = 42

            def __init__(self):
                self.killed = False

            def poll(self):
                return None

            def kill(self):
                self.killed = True

        windows = Process()
        with mock.patch.object(backend_api.subprocess, 'run') as taskkill:
            backend_api.terminate_process_group(windows, 'nt')
        taskkill.assert_called_once_with(
            ['taskkill', '/PID', '42', '/T', '/F'], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, check=False)
        self.assertTrue(windows.killed)
        posix = Process()
        with mock.patch.object(backend_api.os, 'killpg') as killpg:
            backend_api.terminate_process_group(posix, 'posix')
        killpg.assert_called_once_with(42, backend_api.signal.SIGKILL)
        self.assertFalse(posix.killed)

    def test_preparation_allows_old_pin_but_merge_requires_equality(self):
        self.metadata()
        self.assertEqual(self.run_helper('check', '--root', self.root, '--tag', 'v0.8.2').returncode, 0)
        self.assertNotEqual(self.run_helper('check', '--root', self.root, '--require-pin').returncode, 0)
        (self.root / 'Cargo.lock').write_text('[[package]]\nname = "omamail"\nversion = "0.8.1"\n')
        self.assertNotEqual(self.run_helper('check', '--root', self.root).returncode, 0)

    def test_release_version_includes_plugin_manifest_and_standalone_host(self):
        self.metadata()
        self.assertEqual(self.run_helper('check', '--root', self.root, '--tag', 'v0.8.2').returncode, 0)
        fixtures = {
            'manifest.json': '{"version":"0.8.1"}',
            'app/CMakeLists.txt': 'project(omamail-app VERSION 0.8.1 LANGUAGES CXX)\n',
        }
        for name, value in fixtures.items():
            with self.subTest(name=name):
                path = self.root / name
                original = path.read_text()
                path.write_text(value)
                result = self.run_helper('check', '--root', self.root, '--tag', 'v0.8.2')
                self.assertNotEqual(result.returncode, 0)
                path.write_text(original)

    def test_release_pr_gate_requires_published_version_before_merge(self):
        # Execute the actual workflow guard: removing or weakening it must let
        # the pre-publication release PR reach the forbidden merge marker.
        self.metadata()
        (self.root / 'scripts').mkdir()
        (self.root / 'scripts/package-backend.py').write_bytes((ROOT / 'scripts/package-backend.py').read_bytes())
        lines = (ROOT / '.github/workflows/ci.yml').read_text().splitlines()
        start = next(i for i, line in enumerate(lines) if 'case "$SOURCE_BRANCH" in' in line)
        end = next(i for i in range(start, len(lines)) if lines[i].strip() == 'esac')
        guard = '\n'.join(line.strip() for line in lines[start:end + 1])
        marker = self.root / 'merge-allowed'
        for branch, pin, allowed in [('release/0.8.2', '0.8.1', False),
                                     ('release/0.8.2', '0.8.2', True),
                                     ('feature', '0.8.1', True), ('main', '0.8.1', True)]:
            with self.subTest(branch=branch, pin=pin):
                (self.root / 'backend-version').write_text(pin + '\n')
                marker.unlink(missing_ok=True)
                result = subprocess.run(['bash', '-c', 'set -euo pipefail\n' + guard + '\ntouch merge-allowed'],
                                        cwd=self.root, env=dict(os.environ, SOURCE_BRANCH=branch),
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode == 0, allowed, result.stderr)
                self.assertEqual(marker.exists(), allowed)

    def api_fixture(self):
        self.metadata()
        backend = self.root / 'src/backend'
        backend.mkdir(parents=True)
        (backend / 'methods.rs').write_text('pub const ALL: &[&str] = &["system.info"];')
        contract = {'apiVersion': 1, 'releasedApiVersion': 1, 'protocolVersion': 1, 'methods': ['system.info'],
                    'contractCases': [{'name': 'handshake', 'method': 'system.info',
                                       'params': {}, 'types': {'name': 'string'}}],
                    'unreleased': {'methods': [], 'cases': []}}
        self.api = self.root / 'backend-api.json'
        self.api.write_text(json.dumps(contract))
        self.published = self.root / 'published-api.json'
        self.published.write_text(json.dumps(contract, indent=2, sort_keys=True))
        return contract

    def check_api(self, *args):
        return self.run_helper('check-api', '--root', self.root, *args)

    def test_internal_rust_versions_and_source_can_reuse_pin_and_api(self):
        self.api_fixture()
        (self.root / 'Cargo.toml').write_text('[package]\nname="omamail"\nversion="9.0.0"\n')
        (self.root / 'Cargo.lock').write_text('[[package]]\nname="omamail"\nversion="9.0.0"\n')
        (self.root / 'src/internal.rs').write_text('fn optimized() {}')
        pin = self.run_helper('pin-version', '--root', self.root)
        self.assertEqual(pin.returncode, 0, pin.stderr)
        self.assertEqual(pin.stdout.strip(), '0.8.1')
        result = self.run_helper('check-api', '--root', self.root, '--published', self.published)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_api_inventory_change_requires_contract_and_publication(self):
        contract = self.api_fixture()
        methods = self.root / 'src/backend/methods.rs'
        methods.write_text('pub const ALL: &[&str] = &["system.info", "message.new"];')
        self.assertNotEqual(self.check_api().returncode, 0)
        contract['methods'].append('message.new')
        self.api.write_text(json.dumps(contract))
        # A new method on the released version's contract is a lie about the
        # pinned binary: it has to be named unreleased, one step ahead.
        self.assertEqual(self.check_api().returncode, 0, 'the inventory agrees; only the published binary can say more')
        self.assertNotEqual(self.check_api('--published', self.published).returncode, 0)
        self.assertNotEqual(self.check_api('--baseline', self.published).returncode, 0)
        contract['apiVersion'] = 2
        self.api.write_text(json.dumps(contract))
        self.assertNotEqual(self.check_api('--published', self.published).returncode, 0, 'a step ahead names what it adds')
        contract['unreleased']['methods'] = ['message.new']
        self.api.write_text(json.dumps(contract))
        for args in ((), ('--published', self.published), ('--baseline', self.published)):
            result = self.check_api(*args)
            self.assertEqual(result.returncode, 0, (args, result.stderr))
        # Released or not, the pinned binary and the checkout agree on what it
        # speaks; a third step is refused until the second ships.
        contract['apiVersion'] = 3
        self.api.write_text(json.dumps(contract))
        self.assertNotEqual(self.check_api().returncode, 0)
        contract['apiVersion'] = 2
        contract['unreleased']['methods'] = ['nope.method']
        self.api.write_text(json.dumps(contract))
        self.assertNotEqual(self.check_api().returncode, 0)

    def test_api_inventory_accepts_only_the_reviewed_agent_platform_gate(self):
        contract = self.api_fixture()
        contract['methods'].append('agent.context')
        self.api.write_text(json.dumps(contract))
        methods = self.root / 'src/backend/methods.rs'
        methods.write_text('''pub const ALL: &[&str] = &[
            "system.info",
            #[cfg(all(feature = "agent", target_os = "linux"))]
            "agent.context",
        ];''')
        result = self.check_api()
        self.assertEqual(result.returncode, 0, result.stderr)
        methods.write_text(methods.read_text().replace('target_os = "linux"', 'target_os = "windows"'))
        self.assertNotEqual(self.check_api().returncode, 0)

    def test_unreleased_cases_follow_their_methods_and_a_release_folds_them(self):
        contract = self.api_fixture()
        methods = self.root / 'src/backend/methods.rs'
        methods.write_text('pub const ALL: &[&str] = &["system.info", "message.new"];')
        contract['methods'].append('message.new')
        contract['contractCases'].append({'name': 'new', 'method': 'message.new', 'params': {}, 'types': {'ok': 'boolean'}})
        contract['apiVersion'] = 2
        contract['unreleased'] = {'methods': ['message.new'], 'cases': []}
        self.api.write_text(json.dumps(contract))
        self.assertNotEqual(self.check_api().returncode, 0, 'a case on an unreleased method is unreleased')
        contract['unreleased']['cases'] = ['new']
        self.api.write_text(json.dumps(contract))
        self.assertEqual(self.check_api('--published', self.published).returncode, 0)
        # The published contract of the new release carries the step; once it
        # is pinned the checkout's released API is the whole contract again.
        self.published.write_text(json.dumps(contract))
        self.assertNotEqual(self.check_api('--published', self.published).returncode, 0,
                            'the checkout still calls the step unreleased')
        folded = dict(contract, releasedApiVersion=2, unreleased={'methods': [], 'cases': []})
        self.api.write_text(json.dumps(folded))
        self.assertEqual(self.check_api('--published', self.published).returncode, 0)
        # An old published contract, from before the split had a name, is read
        # as all released.
        self.published.write_text(json.dumps({'apiVersion': 2, 'protocolVersion': 1, 'methods': contract['methods'],
                                              'contractCases': contract['contractCases']}))
        self.assertEqual(self.check_api('--published', self.published).returncode, 0)

    def test_response_contract_changes_require_revision_bump(self):
        contract = self.api_fixture()
        self.assertEqual(self.run_helper('check-api', '--root', self.root,
                                         '--baseline', self.published).returncode, 0)
        contract['contractCases'][0]['types']['version'] = 'string'
        self.api.write_text(json.dumps(contract))
        for mode in ('--baseline', '--published'):
            self.assertNotEqual(self.run_helper('check-api', '--root', self.root,
                                               mode, self.published).returncode, 0)
        contract['apiVersion'] = 2
        contract['unreleased']['cases'] = ['handshake']
        self.api.write_text(json.dumps(contract))
        self.assertNotEqual(self.check_api('--baseline', self.published).returncode, 0,
                            'the released view lost its only case, which the pinned binary speaks')
        contract['contractCases'].append({'name': 'handshake-next', 'method': 'system.info', 'params': {}, 'types': {'version': 'string'}})
        contract['contractCases'][0]['types'].pop('version')
        contract['unreleased']['cases'] = ['handshake-next']
        self.api.write_text(json.dumps(contract))
        self.assertEqual(self.check_api('--baseline', self.published).returncode, 0)

    def test_unreleased_error_message_expectations_preserve_published_contract(self):
        contract = self.api_fixture()
        contract['apiVersion'] = 2
        contract['contractCases'].append({
            'name': 'strict parameters', 'method': 'system.info',
            'params': {'unexpected': True}, 'errorCode': -32602,
            'equals': {'message': 'Invalid params'}})
        contract['unreleased']['cases'] = ['strict parameters']
        self.api.write_text(json.dumps(contract))
        result = self.check_api('--published', self.published)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_api_revisions_and_pin_require_canonical_values(self):
        contract = self.api_fixture()
        for value in (True, 0, -1, '1', 1.5, 2147483648):
            for field in ('apiVersion', 'releasedApiVersion', 'protocolVersion'):
                with self.subTest(field=field, value=value):
                    invalid = dict(contract, **{field: value})
                    self.api.write_text(json.dumps(invalid))
                    self.assertNotEqual(self.run_helper('check-api', '--root', self.root).returncode, 0)
        for value in ('v0.9.0', '0.09.0', '0.9.0\r\n', '0.9.0\n\n', '0.9.0-beta', '0.9.0\0'):
            (self.root / 'backend-version').write_bytes(value.encode())
            self.assertNotEqual(self.run_helper('pin-version', '--root', self.root).returncode, 0)
        for value in ('{}', '[]', '{"apiVersion": 1, "apiVersion": 1}', ' ' * (4 * 1024 * 1024 + 1)):
            self.api.write_text(value)
            self.assertNotEqual(self.run_helper('check-api', '--root', self.root).returncode, 0)

    def source_fixture(self):
        self.metadata()
        (self.root / 'src').mkdir()
        (self.root / 'src/main.rs').write_text('fn main() {}')
        (self.root / 'ui').mkdir()
        (self.root / 'ui/App.qml').write_text('Item {}')
        self.build_manifest = self.root / 'backend-build.json'
        result = self.run_helper('provenance', '--root', self.root, '--output', self.build_manifest)
        self.assertEqual(result.returncode, 0, result.stderr)

    def provenance_matches(self):
        return self.run_helper('check-provenance', self.build_manifest, '--root', self.root).returncode == 0

    def test_provenance_is_deterministic_and_ui_only_changes_are_independent(self):
        self.source_fixture()
        first = self.build_manifest.read_bytes()
        self.assertTrue(self.provenance_matches())
        (self.root / 'ui/App.qml').write_text('Item { width: 200 }')
        (self.root / 'manifest.json').write_text('{"version":"0.8.2","description":"changed"}')
        self.assertTrue(self.provenance_matches())
        result = self.run_helper('provenance', '--root', self.root, '--output', self.build_manifest)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(first, self.build_manifest.read_bytes())

    def test_same_version_source_addition_modification_deletion_are_detected(self):
        self.source_fixture()
        source = self.root / 'src/main.rs'
        for path, value in ((source, 'fn main() { panic!(); }'),
                            (self.root / 'src/new.json', '{}'),
                            (self.root / 'Cargo.toml', '[profile.release]\nstrip = true\n'),
                            (self.root / 'rust-toolchain.toml', '[toolchain]\nchannel="stable"\n'),
                            (self.root / 'build.rs', 'fn main() {}')):
            with self.subTest(path=path.name):
                original = path.read_bytes() if path.exists() else None
                path.write_bytes((original or b'') + value.encode())
                self.assertFalse(self.provenance_matches())
                if original is None:
                    path.unlink()
                else:
                    path.write_bytes(original)
                self.assertTrue(self.provenance_matches())
        source.unlink()
        self.assertFalse(self.provenance_matches())

    def test_include_resources_and_cargo_configuration_are_inputs(self):
        self.source_fixture()
        (self.root / 'src/main.rs').write_text('const X: &str = include_str!("../ui/data.txt");')
        (self.root / 'ui/data.txt').write_text('embedded')
        (self.root / '.cargo').mkdir()
        config = self.root / '.cargo/config.toml'
        config.write_text('[build]\njobs=2\n')
        result = self.run_helper('provenance', '--root', self.root, '--output', self.build_manifest)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.provenance_matches())
        (self.root / 'ui/data.txt').write_text('changed')
        self.assertFalse(self.provenance_matches())
        (self.root / 'ui/data.txt').write_text('embedded')
        config.unlink()
        self.assertFalse(self.provenance_matches())

    def test_uninventoried_cargo_inputs_fail_closed(self):
        self.source_fixture()
        cargo = self.root / 'Cargo.toml'
        original = cargo.read_text()
        additions = [
            '[workspace]\nmembers=["other"]\n',
            '[dependencies]\nhelper={path="helper"}\n',
            '[target.\'cfg(unix)\'.dependencies]\nhelper={path="helper"}\n',
            '[patch.crates-io]\nhelper={path="helper"}\n',
            '[[bin]]\nname="other"\npath="outside/main.rs"\n',
            '[lib]\npath="outside/lib.rs"\n',
        ]
        for addition in additions:
            with self.subTest(addition=addition):
                cargo.write_text(original + addition)
                result = self.run_helper('provenance', '--root', self.root, '--output', self.build_manifest)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('explicit provenance support', result.stderr)
        cargo.write_text(original + 'build="tools/build.rs"\n')
        self.assertNotEqual(self.run_helper('provenance', '--root', self.root,
                                          '--output', self.build_manifest).returncode, 0)

    def test_external_literal_module_path_is_fingerprinted(self):
        self.source_fixture()
        external = self.root / 'external'
        external.mkdir()
        module = external / 'helper.rs'
        module.write_text('pub fn helper() {}')
        (self.root / 'src/main.rs').write_text('#[path = "../external/helper.rs"] mod helper;')
        result = self.run_helper('provenance', '--root', self.root, '--output', self.build_manifest)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.provenance_matches())
        module.write_text('pub fn helper() { panic!(); }')
        self.assertFalse(self.provenance_matches())
        module.write_text('mod more;')
        result = self.run_helper('provenance', '--root', self.root, '--output', self.build_manifest)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('explicit provenance support', result.stderr)

    def test_untrusted_provenance_and_unsafe_sources_fail_closed(self):
        self.source_fixture()
        original = self.build_manifest.read_text()
        payloads = ['[]', '{}', '{', original.replace('"schemaVersion": 1', '"schemaVersion": true'),
                    original.replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1'),
                    original.replace('0.8.2', '0.8.1'), original.replace('{', '{"extra": 1,', 1), ' ' * (4 * 1024 * 1024 + 1)]
        for payload in payloads:
            with self.subTest(length=len(payload)):
                self.build_manifest.write_text(payload)
                self.assertFalse(self.provenance_matches())
        self.build_manifest.write_text(original)
        real_manifest = self.root / 'real-build.json'
        self.build_manifest.rename(real_manifest)
        self.build_manifest.symlink_to(real_manifest)
        self.assertFalse(self.provenance_matches())
        self.build_manifest.unlink()
        real_manifest.rename(self.build_manifest)
        (self.root / 'src/linked').symlink_to(self.root / 'ui/App.qml')
        self.assertFalse(self.provenance_matches())
        (self.root / 'src/linked').unlink()
        (self.root / 'src/main.rs').write_text('include!(concat!(env!("OUT_DIR"), "/generated.rs"));')
        self.assertFalse(self.provenance_matches())

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

    def test_plugin_verifier_selects_exact_backend_asset_from_full_release_checksum(self):
        binary = self.root / 'binary'
        binary.write_bytes(b'plugin backend')
        binary.chmod(0o755)
        out = self.root / 'out'
        self.assertEqual(self.run_helper('package', binary, 'x86_64', out).returncode, 0)
        sums = out / 'SHA256SUMS'
        sums.write_text(sums.read_text() + '0' * 64 + '  omamail-app-linux-x86_64.tar.gz\n')
        result = self.run_helper('verify', out, '--arch', 'x86_64')
        self.assertEqual(result.returncode, 0, result.stderr)
        sums.write_text(sums.read_text() + '1' * 64 + '  unexpected.tar.gz\n')
        self.assertNotEqual(self.run_helper('verify', out, '--arch', 'x86_64').returncode, 0)

    def test_release_checksum_covers_exact_binary_and_installer_assets(self):
        out = self.root / 'release'
        out.mkdir()
        names = (
            'omamail-linux-x86_64.tar.gz', 'omamail-linux-aarch64.tar.gz',
            'omamail-app-macos-aarch64.tar.gz', 'omamail-app-linux-x86_64.tar.gz',
            'install.sh', 'install.ps1')
        for index, name in enumerate(names):
            (out / name).write_bytes(f'asset {index}'.encode())
        (out / 'backend-api.json').write_text('{}\n')
        (out / 'backend-build.json').write_text('{}\n')
        result = self.run_helper('release-checksums', out)
        self.assertEqual(result.returncode, 0, result.stderr)
        records = (out / 'SHA256SUMS').read_text().splitlines()
        self.assertEqual([line.split('  ', 1)[1] for line in records], sorted(names))
        self.assertEqual(self.run_helper('verify-release', out).returncode, 0)
        (out / 'omamail-app-linux-x86_64.tar.gz').write_bytes(b'changed')
        self.assertNotEqual(self.run_helper('verify-release', out).returncode, 0)
        (out / 'unexpected.bin').write_bytes(b'extra')
        self.assertNotEqual(self.run_helper('release-checksums', out).returncode, 0)

    def test_release_checksum_refuses_noncanonical_bytes_and_unsafe_assets(self):
        out = self.root / 'release'
        out.mkdir()
        names = (
            'omamail-linux-x86_64.tar.gz', 'omamail-linux-aarch64.tar.gz',
            'omamail-app-macos-aarch64.tar.gz', 'omamail-app-linux-x86_64.tar.gz',
            'install.sh', 'install.ps1')
        for name in names:
            (out / name).write_bytes(name.encode())
        (out / 'backend-api.json').write_text('{}\n')
        (out / 'backend-build.json').write_text('{}\n')
        self.assertEqual(self.run_helper('release-checksums', out).returncode, 0)
        canonical = (out / 'SHA256SUMS').read_bytes()
        for raw in (canonical.rstrip(b'\n'), canonical.replace(b'\n', b'\r\n'), canonical + b'\0'):
            with self.subTest(raw=raw[-8:]):
                (out / 'SHA256SUMS').write_bytes(raw)
                self.assertNotEqual(self.run_helper('verify-release', out).returncode, 0)
        (out / 'SHA256SUMS').write_bytes(canonical)
        target = self.root / 'real-installer'
        (out / 'install.sh').rename(target)
        (out / 'install.sh').symlink_to(target)
        self.assertNotEqual(self.run_helper('release-checksums', out).returncode, 0)
        self.assertNotEqual(self.run_helper('verify-release', out).returncode, 0)

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
        self.assertIn('project(omamail-app VERSION 0.8.3 ',
                      (self.root / 'app/CMakeLists.txt').read_text())
        self.assertNotEqual(subprocess.run(['git', '-C', str(self.root), 'rev-parse', '--verify', 'HEAD'], capture_output=True).returncode, 0)

    def test_pin_updates_only_source_branch_and_refuses_moved_remote(self):
        self.metadata()
        def git(*args):
            return subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True, text=True).stdout.strip()
        git('init', '-q')
        git('config', 'user.name', 'Test')
        git('config', 'user.email', 'test@example.invalid')
        # The release being pinned carries an unreleased step; the pin folds it.
        contract = {'apiVersion': 2, 'releasedApiVersion': 1, 'protocolVersion': 1,
                    'methods': ['system.info', 'message.new'],
                    'contractCases': [{'name': 'handshake', 'method': 'system.info', 'params': {}, 'types': {'name': 'string'}}],
                    'unreleased': {'methods': ['message.new'], 'cases': []}}
        (self.root / 'backend-api.json').write_text(json.dumps(contract, indent=2) + '\n')
        git('checkout', '-b', 'release/0.8.2')
        git('add', '.')
        git('commit', '-qm', 'prepare')
        prepared = git('rev-parse', 'HEAD')
        remote = self.root / 'remote.git'
        subprocess.run(['git', 'init', '--bare', '-q', str(remote)], check=True)
        git('remote', 'add', 'origin', str(remote))
        git('push', 'origin', 'HEAD:release/0.8.2', 'HEAD:main')
        result = self.run_helper('pin', '--root', self.root, '--branch', 'main', '--expected', prepared)
        self.assertNotEqual(result.returncode, 0, 'pin must never write directly to main')
        self.assertEqual((self.root / 'backend-version').read_text(), '0.8.1\n')
        result = self.run_helper('pin', '--root', self.root, '--branch', 'release/0.8.2', '--expected', prepared)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'backend-api.json\nbackend-version')
        self.assertEqual(git('ls-remote', 'origin', 'refs/heads/main').split()[0], prepared)
        self.assertEqual((self.root / 'backend-version').read_text(), '0.8.2\n')
        folded = json.loads((self.root / 'backend-api.json').read_text())
        self.assertEqual(folded['releasedApiVersion'], 2)
        self.assertEqual(folded['unreleased'], {'methods': [], 'cases': []})
        self.assertEqual(folded['methods'], contract['methods'])
        # Restore the old checkout without touching the remote's newer revision.
        git('checkout', '--detach', prepared)
        result = self.run_helper('pin', '--root', self.root, '--branch', 'release/0.8.2', '--expected', prepared)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.root / 'backend-version').read_text(), '0.8.1\n')
        self.assertEqual(git('rev-parse', 'HEAD'), prepared)


if __name__ == '__main__':
    unittest.main()
