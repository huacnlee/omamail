#!/usr/bin/env python3
"""Exercise diagnostics with private synthetic state and a fake agent launcher."""
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import tempfile
import time
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

    def test_backend_provider_identifiers_survive_redaction(self):
        codes = ['gmail_http_failed', 'calendar_auth_refused', 'upload_capacity_exceeded',
                 'invalid_upload_encoding']
        self.call('record', [self.event(code) for code in codes])
        data = (self.folder / 'errors.json').read_text()
        for code in codes:
            self.assertIn(code, data)
        self.assertNotIn('unknown_error', data)

    def test_static_backend_error_vocabulary_does_not_drift(self):
        spec = importlib.util.spec_from_file_location('diagnostics', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # Source inspection is only a tripwire for additions to the reviewed,
        # exact runtime vocabulary. It must never populate MESSAGES at runtime.
        produced = re.compile(
            r'(?:\bErr\(\s*|=>\s*|\bok_or\(\s*|\bmap_err\(\|[^|]*\|\s*)'
            r'"([a-z]+_[a-z_]+)"')
        # Block-bodied error mappings and persisted outbox failure states also
        # return fixed identifiers without an adjacent Err()/ok_or() call.
        returned = re.compile(r'^\s*"([a-z]+_[a-z_]+)"\s*$', re.MULTILINE)
        stored = re.compile(r'\["error"\]\s*=\s*json!\("([a-z]+_[a-z_]+)"\)')
        codes = set()
        for path in (ROOT / 'src').rglob('*.rs'):
            if path.name == 'tests.rs' or path.stem.endswith(('_tests', '_test')):
                continue
            source = path.read_text()
            for pattern in (produced, returned, stored):
                codes.update(pattern.findall(source))
        # These are synthetic fixture errors, not production backend errors.
        codes -= {'unexpected_method', 'test_directories_override_active'}
        self.assertGreater(len(codes), 350)
        self.assertEqual(sorted(codes - module.MESSAGES), [])

    def test_mail_errors_survive_recording_and_report_regeneration(self):
        cases = [
            ('imap.list', 'imap_invalid_response'),
            ('imap.list', 'mail_auth_failed'),
            ('jmap.request', 'jmap_invalid_credential'),
            ('jmap.request', 'jmap_method_failed'),
            ('outbox.enqueue', 'outbox_full'),
            ('outbox.enqueue', 'outbox_send_refused'),
            ('accounts.save', 'accounts_busy'),
            ('accounts.save', 'accounts_write_failed'),
            ('attachment.store', 'attachment_open_refused'),
            ('mail.read', 'mail_account_unknown'),
            ('reader.render', 'reader_cancelled'),
            ('message.parse', 'invalid_message_encoding'),
            ('auth.token', 'credential_store_unavailable'),
            ('mail.list', 'session_failed'),
            ('mail.list', 'worker_failed'),
        ]
        events = [{'method': method, 'error': {'code': -32000, 'message': code}}
                  for method, code in cases]
        self.call('record', events)
        # Both another record and open sanitize saved entries again.
        self.call('record', [])
        self.call('open')
        entries = json.loads((self.folder / 'errors.json').read_text())
        report = (self.folder / 'report.txt').read_text()
        report_entries = [json.loads(line) for line in report.splitlines()
                          if line.startswith('{')]
        self.assertEqual(report_entries, entries)
        self.assertEqual([entry['message'] for entry in entries],
                         [code for _, code in cases])
        self.assertEqual([entry['method'] for entry in entries],
                         [method for method, _ in cases])
        self.assertNotIn('unknown_error', report)

    def test_error_shaped_private_values_never_reach_disk_report_or_launcher(self):
        values = [
            'imap_alice_example_com', 'jmap_refresh_token_synthetic_secret',
            'mail_subject_private_project', 'outbox_account_alice_example_com',
            'attachment_invoice_private_pdf', 'reader_message_private_id',
            'imap_invalid_response: server says alice@example.com',
            'jmap_method_failed https://mail.example.com/private?token=secret',
            'mail_auth_failed "password"\\مرحبا',
        ]
        values += ['attachment_open_refused' + suffix
                   for suffix in ['\r', '\n', '\r\n', '\x00', '_private', ' ']]
        self.call('record', [self.event(value) for value in values])
        log = self.folder / 'errors.json'
        entries = json.loads(log.read_text())
        self.assertEqual([entry['message'] for entry in entries],
                         ['unknown_error'] * len(values))
        # A modified old log goes through the same allowlist when opened.
        entries += [{'method': 'imap.list', 'code': -32000, 'message': value}
                    for value in values]
        log.write_text(json.dumps(entries))
        self.call('open')
        report = (self.folder / 'report.txt').read_text()
        launcher = (self.root / 'state/launched').read_text()
        self.assertEqual(report.count('unknown_error'), 2 * len(values))
        for value in values:
            self.assertNotIn(value, report)
            self.assertNotIn(value, launcher)

    def test_allowlist_matches_whole_values_and_fits_frontend_bound(self):
        spec = importlib.util.spec_from_file_location('diagnostics', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for code in module.MESSAGES:
            with self.subTest(code=code):
                self.assertLessEqual(len(code), 128)
                self.assertEqual(module.clean(self.event(code))['message'], code)
                for value in [code + '_private', 'private_' + code,
                              code + '\n', code + '\x00']:
                    self.assertEqual(module.clean(self.event(value))['message'],
                                     'unknown_error')
                    self.assertEqual(module.clean({'message': value}, True)['message'],
                                     'unknown_error')

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

    def test_open_does_not_kill_a_running_agent_window(self):
        # omarchy-agent execs a terminal that stays in the foreground. A wait
        # with timeout=15 used to SIGKILL that window. The fake launcher here
        # sleeps like that TUI; open must return without reaping it.
        launcher = self.bin / 'omarchy-agent'
        launcher.write_text(
            '#!/usr/bin/env python3\n'
            'import json, os, sys, time\n'
            'from pathlib import Path\n'
            'state = Path(os.environ["XDG_STATE_HOME"])\n'
            'state.joinpath("launched").write_text(json.dumps(sys.argv[1:]))\n'
            'state.joinpath("pid").write_text(str(os.getpid()))\n'
            'time.sleep(30)\n'
        )
        launcher.chmod(0o700)
        pid_file = self.root / 'state/pid'

        def stop_agent():
            if not pid_file.exists():
                return
            try:
                os.kill(int(pid_file.read_text()), signal.SIGKILL)
            except (ProcessLookupError, ValueError):
                pass

        self.addCleanup(stop_agent)
        started = time.monotonic()
        self.call('open')
        self.assertLess(time.monotonic() - started, 5)
        os.kill(int(pid_file.read_text()), 0)

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
