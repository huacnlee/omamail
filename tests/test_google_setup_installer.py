"""Installer lifecycle uses synthetic terminal launches; no packages/network."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('google_setup', ROOT / 'scripts/google-personal-setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class InstallerTests(unittest.TestCase):
    def test_package_failure_identifies_tool_and_exit_code(self):
        def which(name):
            return '/synthetic/omarchy' if name == 'omarchy' else None
        with patch.object(setup.shutil, 'which', side_effect=which), \
                patch.object(setup.subprocess, 'run', return_value=subprocess.CompletedProcess([], 23)) as run:
            with self.assertRaisesRegex(setup.Refused, r'uv installation failed \(exit 23\)'):
                setup.install_tools()
            self.assertEqual(run.call_args.args[0], ['omarchy', 'pkg', 'add', 'uv'])

    def test_zero_exit_without_executable_is_not_success(self):
        def which(name):
            return '/synthetic/omarchy' if name == 'omarchy' else None
        with patch.object(setup.shutil, 'which', side_effect=which), \
                patch.object(setup.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
            with self.assertRaisesRegex(setup.Refused, 'uv was installed but is not available'):
                setup.install_tools()

    def test_signin_redirect_refuses_external_origins_before_building_request(self):
        handler = setup.GooglePageRedirect()
        request = urllib.request.Request('https://console.cloud.google.com/auth/clients')
        for destination in ('https://example.com/', 'http://accounts.google.com/',
                            'https://accounts.google.com:444/', 'https://user@accounts.google.com/',
                            'https://accounts.google.com/\r\nInjected: value'):
            with self.subTest(destination=destination), \
                    patch.object(setup.urllib.request, 'Request') as next_request:
                with self.assertRaises(setup.Refused):
                    handler.redirect_request(request, None, 302, '', {}, destination)
                next_request.assert_not_called()

    def test_signin_redirect_does_not_copy_sensitive_headers(self):
        handler = setup.GooglePageRedirect()
        request = urllib.request.Request('https://console.cloud.google.com/auth/clients',
            headers={'Cookie': 'synthetic-cookie', 'X-Goog-Api-Key': 'synthetic-key'})
        following = handler.redirect_request(request, None, 302, '', {},
            'https://accounts.google.com/ServiceLogin')
        self.assertFalse(following.has_header('Cookie'))
        self.assertFalse(following.has_header('X-goog-api-key'))
        self.assertFalse(following.has_header('Authorization'))
        request.add_header('Authorization', 'synthetic-authorization')
        with self.assertRaises(setup.Refused):
            handler.redirect_request(request, None, 302, '', {}, 'https://accounts.google.com/')
        with self.assertRaises(setup.ApiRedirectRefused):
            setup.NoRedirect().redirect_request(request, None, 302, '', {}, 'https://example.com/')

    def test_personal_project_owner_mismatch_prevents_api_mutations(self):
        with tempfile.TemporaryDirectory(prefix='omamail-tools-') as directory:
            fd = setup.private_dir(Path(directory))
            console = Mock()
            project = 'omamail-personal-012345abcdef'
            account = 'owner@example.com'
            name = 'google-setup-' + setup.hashlib.sha256(account.encode()).hexdigest()[:24] + '.json'
            try:
                setup.write_private(fd, name, {'account': account, 'projectId': project}, None)
                with patch.object(setup, 'gcloud', side_effect=[
                        [{'account': account}],
                        {'projectId': project, 'lifecycleState': 'ACTIVE', 'labels': {}}
                ]) as cloud:
                    with self.assertRaisesRegex(setup.Refused, 'not created for this automatic setup'):
                        setup.provision(console, fd, account)
                    self.assertEqual([call.args[:2] for call in cloud.call_args_list],
                        [('auth', 'list'), ('projects', 'describe')])
                console.graphql.assert_not_called()
                console.request.assert_not_called()
                self.assertFalse((Path(directory) / 'credentials.json').exists())
            finally:
                os.close(fd)

    def run_terminal(self, ok):
        def terminal(command, **kwargs):
            self.assertEqual(command[:4], ['omarchy', 'launch', 'terminal', 'python3'])
            self.assertEqual(command[5:7], ['--install-tools', '--result-directory'])
            directory = Path(command[7])
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
            fd = setup.private_dir(directory)
            try:
                setup.write_private(fd, 'result.json', {'ok': ok}, None)
            finally:
                os.close(fd)
            return Mock(poll=Mock(return_value=None))
        return terminal

    def test_waits_for_terminal_result_and_cleans_private_result_directory(self):
        paths = []
        terminal = self.run_terminal(True)
        def launch(command, **kwargs):
            paths.append(Path(command[7]))
            return terminal(command, **kwargs)
        with patch.object(setup.shutil, 'which', return_value='/synthetic/omarchy'), \
                patch.object(setup.subprocess, 'Popen', side_effect=launch) as run:
            setup.install_tools_ui()
            self.assertEqual(run.call_count, 1)
        self.assertFalse(paths[0].exists())

    def test_cancelled_or_failed_terminal_is_not_reported_as_success(self):
        with patch.object(setup.shutil, 'which', return_value='/synthetic/omarchy'), \
                patch.object(setup.subprocess, 'Popen', side_effect=self.run_terminal(False)):
            with self.assertRaises(setup.Refused):
                setup.install_tools_ui()

    def test_attached_terminal_can_remain_running_until_result_arrives(self):
        commands = []
        def launch(command, **kwargs):
            self.assertNotIn('timeout', kwargs)
            commands.append(command)
            return Mock(poll=Mock(return_value=None))
        def complete_after_wait(seconds):
            self.run_terminal(True)(commands[0])
        with patch.object(setup.shutil, 'which', return_value='/synthetic/omarchy'), \
                patch.object(setup.subprocess, 'Popen', side_effect=launch), \
                patch.object(setup.time, 'sleep', side_effect=complete_after_wait) as wait:
            setup.install_tools_ui()
            wait.assert_called_once_with(1)

    def test_rejects_result_directory_outside_owned_temporary_directory_before_installing(self):
        with tempfile.TemporaryDirectory(prefix='unrelated-directory-') as directory:
            with patch.object(sys, 'argv', ['helper', '--install-tools', '--result-directory', directory]), \
                    patch.object(setup, 'install_tools') as install:
                with self.assertRaises(setup.Refused):
                    setup.main()
                install.assert_not_called()
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_rejects_symlinked_result_before_any_package_process(self):
        with tempfile.TemporaryDirectory(prefix='omamail-tools-') as directory:
            with tempfile.TemporaryDirectory() as elsewhere:
                target = Path(elsewhere) / 'untouched'
                target.write_text('keep this data')
                (Path(directory) / 'result.json').symlink_to(target)
                with patch.object(sys, 'argv', ['helper', '--install-tools', '--result-directory', directory]), \
                        patch.object(setup, 'install_tools') as install:
                    with self.assertRaises(OSError):
                        setup.main()
                    install.assert_not_called()
                    self.assertEqual(target.read_text(), 'keep this data')


if __name__ == '__main__':
    unittest.main()
