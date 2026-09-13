#!/usr/bin/env python3
"""Exercise diagnostics with private synthetic state and a fake agent launcher."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/diagnostics.py'


class Diagnostics(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.env = dict(os.environ, XDG_STATE_HOME=str(self.root / 'state'),
                        PATH=str(self.bin) + ':' + os.environ['PATH'])
        launcher = self.bin / 'omarchy-agent'
        launcher.write_text('#!/usr/bin/env python3\nimport os,sys,json\nfrom pathlib import Path\n'
                            'Path(os.environ["XDG_STATE_HOME"]).joinpath("launched").write_text(json.dumps(sys.argv[1:]))\n')
        launcher.chmod(0o700)
        self.folder = self.root / 'state/omamail/diagnostics'

    def call(self, mode, events=None, ok=True):
        result = subprocess.run(['python3', str(SCRIPT), mode],
                                input=json.dumps(events) if events is not None else '',
                                text=True, capture_output=True, env=self.env, timeout=8)
        self.assertEqual(result.returncode == 0, ok, result.stdout + result.stderr)
        return result

    def event(self, message='agent_invalid_state'):
        return {'method': 'agent.jobStart', 'error': {'code': -32000, 'message': message}}

    def test_log_is_private_bounded_and_redacted_before_persistence(self):
        self.call('record', [self.event(), self.event('SECRET-token\nagent_invalid_state'),
                             {'method': 'SECRET-address', 'error': {'message': 'SECRET-body'}}])
        log = self.folder / 'errors.json'
        data = log.read_text()
        self.assertIn('agent_invalid_state', data)
        self.assertNotIn('SECRET', data)
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.folder.stat().st_mode & 0o777, 0o700)
        self.assertFalse((self.root / 'state/launched').exists())
        for _ in range(5):
            self.call('record', [self.event('process_unavailable'), self.event()] * 16)
        self.assertLessEqual(len(json.loads(log.read_text())), 100)
        self.assertLess(log.stat().st_size, 65536)

    def test_only_explicit_open_launches_agent_with_report_path(self):
        self.call('record', [self.event()])
        self.call('open')
        args = json.loads((self.root / 'state/launched').read_text())
        self.assertEqual(args[0], '--prompt')
        self.assertIn(str(self.folder / 'report.txt'), args[1])
        report = (self.folder / 'report.txt').read_text()
        self.assertIn('agent_invalid_state', report)
        self.assertIn('backend', report)
        self.assertEqual((self.folder / 'report.txt').stat().st_mode & 0o777, 0o600)

    def test_untrusted_existing_log_is_sanitized_again(self):
        self.call('record', [self.event()])
        log = self.folder / 'errors.json'
        log.write_text(json.dumps([{'method': 'SECRET', 'message': 'SECRET', 'time': 'SECRET'}]))
        self.call('open')
        self.assertNotIn('SECRET', (self.folder / 'report.txt').read_text())

    def test_symlinks_never_write_or_launch(self):
        for name in ['errors.json', 'report.txt', '.lock']:
            with self.subTest(name=name):
                self.call('record', [])
                outside = self.root / 'outside'
                outside.write_text('KEEP')
                target = self.folder / name
                target.unlink(missing_ok=True)
                target.symlink_to(outside)
                self.call('open', ok=False)
                self.assertEqual(outside.read_text(), 'KEEP')
                self.assertFalse((self.root / 'state/launched').exists())
                target.unlink()

    def test_hardlinks_never_write_or_launch(self):
        self.call('record', [])
        outside = self.root / 'outside'
        outside.write_text('KEEP')
        outside.chmod(0o600)
        for name in ['errors.json', 'report.txt', '.lock']:
            with self.subTest(name=name):
                target = self.folder / name
                target.unlink(missing_ok=True)
                os.link(outside, target)
                self.call('open', ok=False)
                self.assertEqual(outside.read_text(), 'KEEP')
                self.assertFalse((self.root / 'state/launched').exists())
                target.unlink()

    def test_directory_link_cannot_create_files_outside_store(self):
        state = self.root / 'state'
        state.mkdir()
        outside = self.root / 'outside'
        outside.mkdir()
        (state / 'omamail').symlink_to(outside, target_is_directory=True)
        self.call('record', [self.event()], ok=False)
        self.assertEqual(list(outside.iterdir()), [])

    def test_control_characters_and_unknown_text_never_reach_report_or_argv(self):
        values = ['agent_invalid_state' + control for control in ['\r', '\n', '\r\n', '\x00']]
        values += ['SECRET-"\\-مرحبا', {'message': 'SECRET'}, None]
        self.call('record', [self.event(value) for value in values])
        self.call('open')
        report = (self.folder / 'report.txt').read_text()
        self.assertNotIn('SECRET', report)
        self.assertNotIn('agent_invalid_state', report)
        self.assertEqual(report.count('unknown_error'), len(values))
        self.assertNotIn('SECRET', (self.root / 'state/launched').read_text())


if __name__ == '__main__':
    unittest.main()
