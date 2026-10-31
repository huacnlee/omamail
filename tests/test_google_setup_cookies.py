"""Synthetic profile boundaries; never use a real browser, keyring or network.

Set OMAMAIL_GOOGLE_SETUP_SCRIPT to an unfixed helper to check the regression.
The optional pinned-dependency cases also run under the helper's uv environment.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('google_setup_cookies',
    os.environ.get('OMAMAIL_GOOGLE_SETUP_SCRIPT', ROOT / 'scripts/google-personal-setup.py'))
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
try:
    import browser_cookie3 as real_library
except ImportError:
    real_library = None


class CookieTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='omamail-synthetic-cookies-')
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.database = self.root / 'Cookies ? synthetic'
        self.output = io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.output))
        self.enterContext(contextlib.redirect_stderr(self.output))
        self.network = self.enterContext(patch.object(socket, 'socket', side_effect=AssertionError('network forbidden')))
        self.copy = self.enterContext(patch.object(shutil, 'copyfile', side_effect=AssertionError('copy forbidden')))
        self.temp = self.enterContext(patch.object(tempfile, 'NamedTemporaryFile', side_effect=AssertionError('temporary copy forbidden')))
        self.decrypted = []
        self.constructors = []
        self.legacy_load = Mock(side_effect=AssertionError('broad loader forbidden'))
        test = self
        class Decryptor:
            def __init__(self, **kwargs):
                test.constructors.append(kwargs)
            def _decrypt(self, value, encrypted, integrity):
                test.decrypted.append((value, encrypted, integrity))
                return encrypted[3:].decode()
        self.library = types.SimpleNamespace(**{
            name: Decryptor for name in ('Chrome', 'Chromium', 'Edge', 'Brave')})
        for name in ('chrome', 'chromium', 'edge', 'brave', 'firefox'):
            setattr(self.library, name, self.legacy_load)
        self.enterContext(patch.dict(sys.modules, browser_cookie3=self.library))
        if hasattr(setup, 'cookie_dependency_available'):
            self.enterContext(patch.object(setup, 'cookie_dependency_available', return_value=True))

    def chromium(self, *, wal=False):
        connection = sqlite3.connect(self.database)
        if wal:
            connection.execute('PRAGMA journal_mode=WAL')
        connection.executescript("CREATE TABLE meta (key TEXT, value TEXT);"
            "INSERT INTO meta VALUES ('version', '24');"
            "CREATE TABLE cookies (host_key TEXT, path TEXT, is_secure INTEGER, expires_utc INTEGER,"
            " name TEXT, value TEXT, is_httponly INTEGER, encrypted_value BLOB);")
        future = (time.time() + 3600 + 11644473600) * 1000000
        rows = [('.google.com', 'SAPISID', b'v11synthetic-google-session'),
                ('accounts.google.com', 'ACCOUNT', b'v10synthetic-account-session'),
                ('.example.com', 'OTHER', b'v11unrelated-session'),
                ('.google.com.example.com', 'OTHER', b'v11lookalike-session'),
                ('notgoogle.com', 'OTHER', b'v11lookalike-session')]
        connection.executemany('INSERT INTO cookies VALUES (?, "/", 1, ?, ?, "", 1, ?)',
            [(host, future, name, value) for host, name, value in rows])
        connection.commit()
        if not wal:
            connection.close()
        return connection

    def firefox(self):
        with contextlib.closing(sqlite3.connect(self.database)) as connection:
            connection.execute('CREATE TABLE moz_cookies (host TEXT, path TEXT, isSecure INTEGER, '
                'expiry INTEGER, name TEXT, value TEXT, isHttpOnly INTEGER, originAttributes TEXT)')
            connection.executemany('INSERT INTO moz_cookies VALUES (?, "/", 1, ?, ?, ?, 1, ?)', [
                ('.google.com', int(time.time()) + 3600, 'SAPISID', 'synthetic-google-session', ''),
                ('.example.com', int(time.time()) + 3600, 'OTHER', 'unrelated-session', ''),
                ('.google.com', int(time.time()) + 3600, 'CONTAINER', 'container-session', '^userContextId=1'),
                ('.google.com', int(time.time()) + 3600, 'PRIVATE', 'private-session', '^privateBrowsingId=1'),
            ])
            connection.commit()
        (self.root / 'sessionstore.js').write_text('{"cookies":[{"value":"unrelated-session"}]}')
        (self.root / 'sessionstore-backups').mkdir()
        (self.root / 'sessionstore-backups' / 'recovery.jsonlz4').write_bytes(b'unrelated-session')

    def snapshot(self):
        # SQLite may update existing WAL shared-memory lock metadata during a
        # normal reader transaction; the database and WAL bytes cannot change.
        return {str(path.relative_to(self.root)): ('shared-lock-metadata' if path.name.endswith('-shm')
                else hashlib.sha256(path.read_bytes()).hexdigest())
                for path in self.root.rglob('*') if path.is_file()}

    def assert_no_effects(self, before):
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.output.getvalue(), '')
        self.network.assert_not_called()
        self.copy.assert_not_called()
        self.temp.assert_not_called()
        self.legacy_load.assert_not_called()

    def session(self, browser):
        account = [None] * 8
        account[3], account[7] = 'owner@example.com', 0
        with patch.object(setup.ConsoleSession, 'read', side_effect=[
                json.dumps([None, [account]]).encode(), ('AIza' + 'A' * 35).encode()]):
            return setup.ConsoleSession('owner@example.com', browser, str(self.database))

    def test_supported_chromium_browsers_select_google_before_decryption_without_copy(self):
        self.chromium()
        before = self.snapshot()
        for browser in ('edge', 'chrome', 'chromium', 'brave'):
            with self.subTest(browser=browser):
                self.decrypted.clear()
                session = self.session(browser)
                self.assertEqual({c.value for c in session.jar},
                    {'synthetic-google-session', 'synthetic-account-session'})
                self.assertEqual([v[1] for v in self.decrypted],
                    [b'v11synthetic-google-session', b'v10synthetic-account-session'])
                self.assertTrue(all(v[2] for v in self.decrypted))
                self.assertEqual(self.constructors[-1]['cookie_file'], str(self.database))
                self.assert_no_effects(before)

    def test_firefox_uses_database_without_session_files_or_other_identities(self):
        self.firefox()
        before = self.snapshot()
        original_open = io.open
        def guarded_open(path, *args, **kwargs):
            self.assertNotIn('sessionstore', str(path))
            return original_open(path, *args, **kwargs)
        with patch.object(io, 'open', side_effect=guarded_open):
            session = self.session('firefox')
        self.assertEqual([(c.name, c.value) for c in session.jar], [('SAPISID', 'synthetic-google-session')])
        self.assertEqual(self.constructors, [])
        self.assert_no_effects(before)

    def test_busy_database_refuses_without_copy_or_request(self):
        self.chromium()
        connection = sqlite3.connect(self.database)
        self.addCleanup(connection.close)
        connection.execute('BEGIN EXCLUSIVE')
        before = self.snapshot()
        with patch.object(setup.urllib.request, 'build_opener') as network:
            with self.assertRaises(setup.Refused):
                self.session('edge')
            network.assert_not_called()
        connection.rollback()
        self.assertEqual(self.constructors, [])
        self.assert_no_effects(before)

    def test_invalid_database_refuses_without_copy_or_request(self):
        self.database.write_bytes(b'unrelated-session malformed database')
        before = self.snapshot()
        with patch.object(setup.urllib.request, 'build_opener') as network:
            with self.assertRaises(setup.Refused) as failure:
                self.session('edge')
            network.assert_not_called()
        self.assertNotIn('unrelated-session', str(failure.exception))
        self.assert_no_effects(before)

    def test_decryption_error_is_redacted_and_database_is_closed(self):
        self.chromium()
        before = self.snapshot()
        with patch.object(self.library.Edge, '_decrypt', side_effect=ValueError('synthetic-google-session')):
            with self.assertRaises(setup.Refused) as failure:
                self.session('edge')
        self.assertNotIn('synthetic-google-session', str(failure.exception))
        # An exclusive writer succeeding proves no read transaction survived.
        with contextlib.closing(sqlite3.connect(self.database, timeout=0)) as connection:
            connection.execute('BEGIN EXCLUSIVE')
        self.assert_no_effects(before)

    def test_cancellation_closes_database_without_copy_or_request(self):
        self.chromium()
        before = self.snapshot()
        with patch.object(self.library.Edge, '_decrypt', side_effect=lambda *a: setup.cancelled(15, None)), \
                patch.object(setup.urllib.request, 'build_opener') as network:
            with self.assertRaises(SystemExit) as failure:
                self.session('edge')
            self.assertEqual(failure.exception.code, 130)
            network.assert_not_called()
        with contextlib.closing(sqlite3.connect(self.database, timeout=0)) as connection:
            connection.execute('BEGIN EXCLUSIVE')
        self.assert_no_effects(before)

    def test_live_wal_is_read_without_snapshot_or_ignoring_locks(self):
        connection = self.chromium(wal=True)
        self.addCleanup(connection.close)
        before = self.snapshot()
        session = self.session('edge')
        self.assertIn('synthetic-google-session', [c.value for c in session.jar])
        self.assert_no_effects(before)

    def test_wal_without_shm_creates_only_bookkeeping_without_cookie_values(self):
        original_database = self.database
        for outcome in ('edge', 'firefox', 'failure', 'cancel'):
            with self.subTest(outcome=outcome):
                source = self.root / outcome / 'source'
                target = self.root / outcome / 'target'
                source.mkdir(parents=True)
                target.mkdir()
                self.database = source / 'Cookies'
                writer = self.chromium(wal=True)
                self.addCleanup(writer.close)
                writer.execute('CREATE TABLE moz_cookies (host TEXT, path TEXT, isSecure INTEGER, '
                    'expiry INTEGER, name TEXT, value TEXT, isHttpOnly INTEGER, originAttributes TEXT)')
                writer.executemany('INSERT INTO moz_cookies VALUES (?, "/", 1, ?, ?, ?, 1, "")', [
                    ('.google.com', int(time.time()) + 3600, 'SAPISID', 'synthetic-google-session'),
                    ('.example.com', int(time.time()) + 3600, 'OTHER', 'unrelated-session')])
                writer.commit()
                # Reconstruct synthetic DB/WAL bytes while the source writer
                # keeps WAL alive. Deliberately omit its shared-memory index.
                database = target / 'Cookies'
                for suffix in ('', '-wal'):
                    (target / ('Cookies' + suffix)).write_bytes(
                        (source / ('Cookies' + suffix)).read_bytes())
                self.database = database
                before = self.snapshot()
                shm = target / 'Cookies-shm'
                self.assertFalse(shm.exists())
                if outcome in ('edge', 'firefox'):
                    session = self.session(outcome)
                    self.assertIn('synthetic-google-session', [c.value for c in session.jar])
                else:
                    error = ValueError('synthetic-google-session') if outcome == 'failure' else SystemExit(130)
                    with patch.object(self.library.Edge, '_decrypt', side_effect=error):
                        with self.assertRaises(setup.Refused if outcome == 'failure' else SystemExit):
                            self.session('edge')
                # Normal SQLite locking can create this index even in mode=ro.
                # It must not persist any cookie bytes or change DB/WAL bytes.
                self.assertTrue(shm.is_file())
                metadata = shm.read_bytes()
                for value in (b'synthetic-google-session', b'synthetic-account-session',
                              b'unrelated-session', b'lookalike-session'):
                    self.assertNotIn(value, metadata)
                before[str(shm.relative_to(self.root))] = 'shared-lock-metadata'
                self.assert_no_effects(before)
        self.database = original_database

    def test_connection_rejects_writes_and_retains_normal_locking(self):
        self.chromium()
        before = self.snapshot()
        connect = sqlite3.connect
        opened = []
        def checked_connect(*args, **kwargs):
            connection = connect(*args, **kwargs)
            opened.append(connection)
            with self.assertRaisesRegex(sqlite3.OperationalError, 'readonly'):
                connection.execute('DELETE FROM cookies')
            connection.rollback()
            self.assertNotIn('immutable', args[0])
            self.assertNotIn('nolock', args[0])
            return connection
        with patch.object(setup.sqlite3, 'connect', side_effect=checked_connect):
            self.session('edge')
        self.assertEqual(len(opened), 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            opened[0].execute('SELECT 1')
        self.assert_no_effects(before)

    def test_unsupported_encryption_fails_before_keyring_or_request(self):
        self.chromium()
        with contextlib.closing(sqlite3.connect(self.database)) as connection:
            connection.execute("UPDATE cookies SET encrypted_value=? WHERE name='SAPISID'", (b'v20synthetic-session',))
            connection.commit()
        before = self.snapshot()
        with patch.object(setup.urllib.request, 'build_opener') as network:
            with self.assertRaises(setup.Refused):
                self.session('edge')
            network.assert_not_called()
        self.assertEqual(self.constructors, [])
        self.assert_no_effects(before)

    def test_firefox_default_discovery_reads_only_profile_metadata(self):
        self.firefox()
        profile_root = self.root / '.mozilla' / 'firefox'
        profile_root.mkdir(parents=True)
        (profile_root / 'profiles.ini').write_text(
            '[InstallSynthetic]\nDefault=chosen\n[Profile0]\nPath=other\nIsRelative=1\nDefault=1\n'
            '[Profile1]\nPath=chosen\nIsRelative=1\n')
        before = self.snapshot()
        with patch.object(Path, 'home', return_value=self.root):
            self.assertEqual(setup.cookie_database('firefox', None), profile_root / 'chosen' / 'cookies.sqlite')
        self.assert_no_effects(before)

    @unittest.skipUnless(real_library is not None, 'run in the pinned helper environment for dependency coverage')
    def test_firefox_with_pinned_dependency_never_attempts_temporary_storage(self):
        self.firefox()
        before = self.snapshot()
        session = None
        with patch.dict(sys.modules, browser_cookie3=real_library):
            try:
                session = self.session('firefox')
            except setup.Refused:
                # First assert the forbidden effect, even when a copying
                # attempt was intercepted before any synthetic data was copied.
                pass
        self.assert_no_effects(before)
        self.assertIsNotNone(session)
        self.assertEqual({c.value for c in session.jar}, {'synthetic-google-session'})

    @unittest.skipUnless(real_library is not None, 'run in the pinned helper environment for dependency coverage')
    def test_pinned_chromium_constructors_and_decryption_never_enter_library_readers(self):
        from Cryptodome.Cipher import AES
        from Cryptodome.Protocol.KDF import PBKDF2
        from Cryptodome.Util.Padding import pad
        self.chromium()
        key = PBKDF2(b'synthetic-keyring-password', b'saltysalt', 16, 1)
        for host, name in (('.google.com', 'SAPISID'), ('accounts.google.com', 'ACCOUNT')):
            data = hashlib.sha256(host.encode()).digest() + b'synthetic-google-session'
            encrypted = b'v11' + AES.new(key, AES.MODE_CBC, iv=b' ' * 16).encrypt(pad(data, 16))
            with contextlib.closing(sqlite3.connect(self.database)) as connection:
                connection.execute('UPDATE cookies SET encrypted_value=? WHERE name=?', (encrypted, name))
                connection.commit()
        before = self.snapshot()
        with patch.dict(sys.modules, browser_cookie3=real_library), \
                patch.object(real_library._LinuxPasswordManager, 'get_password', return_value=b'synthetic-keyring-password'), \
                patch.object(real_library, '_DatabaseConnetion', side_effect=AssertionError('library DB forbidden')) as database, \
                patch.object(real_library.ChromiumBased, 'load', side_effect=AssertionError('loader forbidden')) as loader, \
                patch.object(real_library, 'Firefox', side_effect=AssertionError('Firefox library forbidden')) as firefox:
            for browser in ('edge', 'chrome', 'chromium', 'brave'):
                session = self.session(browser)
                self.assertEqual({c.value for c in session.jar}, {'synthetic-google-session'})
            database.assert_not_called()
            loader.assert_not_called()
            firefox.assert_not_called()
        self.assert_no_effects(before)


if __name__ == '__main__':
    unittest.main()
