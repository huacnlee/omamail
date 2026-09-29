#!/usr/bin/env python3
"""Private, bounded backend error records; launch diagnosis only on explicit open."""
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 65536
# An exact vocabulary, never a pattern that could admit a credential or server text.
MESSAGES = set('''agent_invalid_state agent_invalid_time agent_invalid_result
agent_invalid_messages agent_invalid_process agent_invalid_provider agent_invalid_session
agent_invalid_display agent_invalid_preview agent_invalid_text agent_invalid_id
agent_invalid_context agent_invalid_draft agent_invalid_jobs agent_job_identity
agent_job_missing agent_context_missing agent_context_required agent_context_too_large
agent_unsupported_context agent_continuation_override agent_prompt_required
agent_identifier_too_large agent_parent_not_ready agent_active_limit agent_choose_claude
agent_storage_unavailable agent_storage_busy agent_unsafe_storage agent_invalid_filename
agent_state_home_invalid agent_worker_failed agent_worker_unavailable agent_random_failed
agent_projection_too_large process_unavailable process_timed_out process_output_too_large
cache_unavailable unknown_error request_timed_out backend_needs_update
auth_account_invalid auth_account_missing auth_cancelled auth_client_invalid
auth_client_missing auth_consent_required auth_flow_missing auth_invalid_callback
auth_invalid_profile auth_invalid_response auth_keyring_failed auth_listener_failed
auth_missing_scope auth_offline_access_missing auth_port_unavailable auth_provider_invalid
auth_random_failed auth_redirect_refused auth_refresh_failed auth_response_too_large
auth_secret_invalid auth_signed_out auth_timeout auth_too_many_accounts auth_too_many_flows
auth_transport_failed calendar_auth_refused calendar_auth_required calendar_input_too_large
calendar_invalid_input calendar_invalid_operation calendar_invalid_response calendar_invalid_url
calendar_keyring_failed calendar_network_failed calendar_origin_refused calendar_password_invalid
calendar_password_missing calendar_provider_unsupported calendar_request_failed
calendar_response_too_large calendar_timeout calendar_too_many_calendars calendar_too_many_pages
calendar_too_many_redirects gmail_account_unknown gmail_client_invalid gmail_client_missing
gmail_client_permissions gmail_client_too_large gmail_client_unreadable gmail_draft_missing
gmail_forbidden gmail_http_failed gmail_invalid_input gmail_invalid_response gmail_invalid_token
gmail_keyring_failed gmail_length_required gmail_queue_dropped gmail_queue_full gmail_rate_limited
gmail_response_too_large gmail_session_invalidated gmail_session_limit gmail_timeout
gmail_token_account_invalid gmail_token_invalid gmail_token_missing gmail_unauthorized
upload_capacity_exceeded upload_chunk_too_large upload_id_exhausted upload_incomplete
upload_not_found upload_offset_mismatch upload_size_exceeded
invalid_upload_encoding'''.split()) | {
    'Backend unavailable', 'Backend stopped', 'Backend response timed out',
    'Backend request timed out', 'Request cancelled', 'Too many pending requests',
    'Incompatible backend', 'Invalid backend response', 'Backend is shutting down',
    'Backend is not ready', 'Invalid params', 'Method not found',
}
METHODS = set(json.loads((ROOT / 'backend-api.json').read_text())['methods']) | {'backend.request'}


def clean(event, existing=False):
    if not isinstance(event, dict):
        event = {}
    error = event if existing else event.get('error', {})
    if not isinstance(error, dict):
        error = {}
    method = event.get('method')
    message = error.get('message')
    code = error.get('code')
    timestamp = event.get('time') if existing else None
    if not isinstance(timestamp, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', timestamp):
        timestamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    return {'time': timestamp,
            'method': method if isinstance(method, str) and method in METHODS else 'backend.request',
            'code': code if type(code) is int and -32768 <= code <= 32767 else None,
            'message': message if isinstance(message, str) and message in MESSAGES else 'unknown_error'}


def check(fd, directory=False):
    info = os.fstat(fd)
    if (info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600)
            or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1)):
        raise ValueError('Unsafe diagnostic storage')


@contextlib.contextmanager
def storage():
    base = Path(os.environ.get('XDG_STATE_HOME') or Path.home() / '.local/state')
    if not base.is_absolute() or any(ord(c) < 32 or ord(c) == 127 for c in str(base)):
        raise ValueError('Invalid state path')
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    with contextlib.ExitStack() as stack:
        fd = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        stack.callback(os.close, fd)
        for name in ['omamail', 'diagnostics']:
            try:
                os.mkdir(name, 0o700, dir_fd=fd)
            except FileExistsError:
                pass
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            stack.callback(os.close, fd)
            check(fd, True)
        lock = os.open('.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
        stack.callback(os.close, lock)
        check(lock)
        deadline = time.monotonic() + 2
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError('Diagnostic storage busy')
                time.sleep(.02)
        yield fd, base / 'omamail/diagnostics'


def read(fd, name):
    try:
        handle = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return b''
    with os.fdopen(handle, 'rb') as file:
        check(file.fileno())
        data = file.read(LIMIT + 1)
        if len(data) > LIMIT:
            raise ValueError('Diagnostic file too large')
        return data


def write(fd, name, data):
    read(fd, name)  # Refuse unsafe existing files before creating a replacement.
    data = data.encode('utf-8')
    if len(data) > LIMIT:
        raise ValueError('Diagnostic file too large')
    temp = '.write-' + secrets.token_hex(12)
    handle = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        with os.fdopen(handle, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.rename(temp, name, src_dir_fd=fd, dst_dir_fd=fd)
    finally:
        try:
            os.unlink(temp, dir_fd=fd)
        except FileNotFoundError:
            pass


def main(mode):
    incoming = []
    if mode == 'record':
        raw = sys.stdin.buffer.readline(LIMIT + 1)
        if len(raw) > LIMIT:
            raise ValueError('Input too large')
        incoming = json.loads(raw)
        if not isinstance(incoming, list) or len(incoming) > 32:
            raise ValueError('Invalid diagnostic batch')
    elif mode != 'open':
        raise ValueError('Unknown operation')
    with storage() as (fd, folder):
        saved = json.loads(read(fd, 'errors.json') or b'[]')
        if not isinstance(saved, list):
            raise ValueError('Invalid log')
        entries = [clean(event, True) for event in saved[-100:]]
        entries = (entries + [clean(event) for event in incoming])[-100:]
        if mode == 'record':
            write(fd, 'errors.json', json.dumps(entries, ensure_ascii=True) + '\n')
            return
        # No task contents, configuration, URLs, stderr or environment values.
        manifest = json.loads((ROOT / 'manifest.json').read_text())
        report = 'Omamail diagnostics\n'
        report += 'plugin: ' + str(manifest['version']) + '\n'
        report += 'pinned backend: ' + (ROOT / 'backend-version').read_text().strip() + '\n'
        report += 'API revision: ' + str(json.loads((ROOT / 'backend-api.json').read_text())['apiVersion']) + '\n'
        report += '\nRecent backend errors (only known error identifiers are retained):\n'
        report += '\n'.join(json.dumps(event, ensure_ascii=True) for event in entries) or '(none recorded)'
        write(fd, 'report.txt', report + '\n')
    prompt = ('Diagnose an Omamail error using the local report at ' + str(folder / 'report.txt')
              + '. Start with read-only investigation. Explain the cause and propose a fix. '
                'Do not send mail, retry failed operations, change settings, delete or move AI history, '
                'or read mail bodies, credentials or conversation files without explicit user approval. '
                'An unknown error means the original text was omitted for privacy. '
                'agent_invalid_state can indicate AI history written by an incompatible backend version. '
                'The source checkout or installed plugin is at ' + str(ROOT) + '.')
    # omarchy-agent execs the terminal and can stay in the foreground for the
    # whole TUI session. Waiting with a timeout kills that window (SIGKILL).
    proc = subprocess.Popen(
        ['omarchy-agent', '--prompt', prompt],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        rc = proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        return
    if rc != 0:
        raise subprocess.CalledProcessError(rc, proc.args)


if __name__ == '__main__':
    try:
        main(sys.argv[1] if len(sys.argv) == 2 else '')
    except Exception:
        print('Could not save diagnostics or open the system AI.', file=sys.stderr)
        sys.exit(1)
