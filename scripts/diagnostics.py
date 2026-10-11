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
# An exact, reviewed vocabulary, never a pattern that could admit a credential or
# server text. tests/test_diagnostics.py flags new static backend identifiers;
# review their source before adding them here, never derive this set at runtime.
MESSAGES = set('''accounts_busy accounts_conflict accounts_invalid accounts_setup_replacement accounts_too_large
accounts_unexpected_removal accounts_unreadable accounts_version_unsupported accounts_write_failed
agent_active_limit agent_cancel_failed agent_choose_claude
agent_config_invalid agent_config_unavailable agent_context_owner_mismatch agent_conversation_busy
agent_invalid_envelope agent_invalid_history agent_invalid_proposal
agent_mcp_invalid agent_mcp_io agent_mcp_limit agent_parent_not_latest
agent_proposal_inactive agent_proposal_limit agent_server_invalid agent_server_required
agent_server_timeout agent_server_unavailable agent_context_account_missing
agent_context_busy agent_context_cancelled agent_context_failed agent_context_invalid
agent_context_missing agent_context_required agent_context_timeout agent_context_too_large
agent_continuation_override agent_id_required agent_identifier_too_large agent_invalid_context
agent_invalid_display agent_invalid_draft agent_invalid_events agent_invalid_filename
agent_invalid_id agent_invalid_jobs agent_invalid_messages agent_invalid_model agent_invalid_preview
agent_invalid_process agent_invalid_provider agent_invalid_record agent_invalid_result
agent_invalid_session agent_invalid_state agent_invalid_text agent_invalid_time agent_job_active
agent_job_identity agent_job_missing agent_parent_not_ready agent_projection_too_large
agent_prompt_required agent_random_failed agent_runtime_failed agent_state_home_invalid
agent_storage_busy agent_storage_limit agent_storage_unavailable agent_unsafe_storage
agent_unsupported_context agent_worker_failed agent_worker_unavailable
attachment_data_invalid attachment_not_owned attachment_not_regular attachment_open_refused
attachment_path_invalid attachment_too_large attachment_unreadable attachment_write_failed
auth_account_invalid auth_account_missing auth_cancelled auth_client_invalid auth_client_missing
auth_consent_required auth_device_code_failed auth_device_token_failed auth_flow_expired auth_flow_missing auth_invalid_callback auth_invalid_profile
auth_invalid_response auth_keyring_failed auth_listener_failed auth_missing_scope
auth_offline_access_missing auth_port_unavailable auth_provider_invalid auth_random_failed
auth_redirect_refused auth_refresh_failed auth_response_too_large auth_secret_invalid
auth_signed_out auth_timeout auth_too_many_accounts auth_too_many_flows auth_transport_failed auth_user_denied
backend_needs_update
cache_body_invalid cache_body_too_large cache_busy cache_cancelled cache_home_invalid
cache_invalid_input cache_resource_invalid cache_stale_generation cache_store_invalid
cache_store_too_large cache_too_many_files cache_unavailable cache_unsafe_path
calendar_ambiguous_invitation calendar_attendance_unconfirmed calendar_attendee_not_found
calendar_auth_refused calendar_auth_required calendar_conflict calendar_input_too_large
calendar_invalid_input calendar_invalid_operation calendar_invalid_response calendar_invalid_url
calendar_invitation_cancelled calendar_invitation_not_found calendar_keyring_failed
calendar_network_failed calendar_not_found calendar_organizer_mismatch calendar_origin_refused
calendar_password_invalid calendar_password_missing calendar_provider_unsupported
calendar_reminder_not_found calendar_reminders_invalid calendar_reminders_unavailable
calendar_request_failed calendar_response_too_large calendar_timeout calendar_too_many_calendars
calendar_too_many_pages calendar_too_many_redirects calendar_too_many_reminders
config_home_invalid
conversation_limit
credential_missing credential_store_unavailable
gmail_account_unknown gmail_client_invalid gmail_client_missing gmail_client_permissions
gmail_client_too_large gmail_client_unreadable gmail_draft_missing gmail_forbidden
gmail_http_failed gmail_invalid_input gmail_invalid_response gmail_invalid_token
gmail_keyring_failed gmail_length_required gmail_queue_dropped gmail_queue_full
gmail_rate_limited gmail_response_too_large gmail_session_invalidated gmail_session_limit
gmail_timeout gmail_token_account_invalid gmail_token_invalid gmail_token_missing
gmail_unauthorized
hey_account_mismatch hey_invalid_response hey_program_mismatch hey_unavailable
home_invalid home_missing
html_output_too_large html_too_complex html_too_large
identities_limit
imap_attachment_missing imap_command_failed imap_folder_unavailable imap_idle_unsupported
imap_invalid_response imap_list_incomplete imap_message_missing imap_response_too_complex
imap_search_expired imap_timeout imap_unexpected_continuation
input_failed input_too_large
intent_already_settled intent_coalesce_invalid intent_invalid intent_limit intent_stale
intent_unavailable intent_unknown intent_view_invalid
invalid_attachment_encoding invalid_hey_binding invalid_hey_identity invalid_json
invalid_message invalid_message_encoding invalid_message_header invalid_params invalid_signature
invalid_transfer_encoding invalid_upload_encoding
jmap_account_limit jmap_anchor_not_found jmap_cancelled jmap_cleanup_failed
jmap_destination_refused jmap_discovery_failed jmap_event_too_large jmap_events_unavailable
jmap_forbidden jmap_import_failed jmap_invalid_credential jmap_invalid_event
jmap_invalid_message jmap_invalid_request jmap_invalid_response jmap_invalid_session
jmap_invalid_url jmap_message_not_found jmap_method_failed jmap_missing_mailbox
jmap_network_failed jmap_no_mailbox jmap_request_limit jmap_request_too_large
jmap_response_too_large jmap_resumed jmap_send_unavailable jmap_sender_unavailable
jmap_settings_missing jmap_spam_unavailable jmap_stream_closed jmap_stream_limit
jmap_stream_missing jmap_stream_poll_pending jmap_submission_failed jmap_submission_unconfirmed
jmap_timeout jmap_transport_unavailable jmap_unauthorized jmap_unsupported_sort
jmap_update_failed jmap_upload_failed
mail_account_invalid mail_account_unknown mail_action_destination_unavailable
mail_action_invalid_change mail_action_invalid_target mail_action_target_limit
mail_action_target_unknown mail_action_unavailable mail_auth_failed mail_check_timeout
mail_connection_closed mail_dns_failed mail_list_incomplete mail_mailbox_unavailable
mail_mailbox_unknown mail_mark_unknown mail_network_failed mail_provider_unknown
mail_read_conversation_mismatch mail_read_invalid_conversation mail_read_invalid_reader
mail_read_message_mismatch mail_read_unsafe_reader mail_response_too_large
mail_send_attachment_changed mail_send_attachment_limit mail_send_attachment_name
mail_send_attachment_not_regular mail_send_attachment_path mail_send_attachment_too_large
mail_send_attachment_unreadable mail_send_envelope_mismatch mail_send_identities_invalid
mail_send_invalid_address mail_send_invalid_body mail_send_invalid_header
mail_send_no_recipients mail_send_recipient_limit mail_send_sender_unavailable
mail_send_unavailable mail_tls_failed mail_watch_limit mail_watch_unknown
message_input_failed message_too_large
method_not_found
model_account_invalid model_action_unsupported model_batch_invalid model_invalid
model_message_missing model_operation_unsupported model_output_too_large model_too_many_rows
outbox_account_unavailable outbox_attachment_unavailable outbox_delivery_unknown
outbox_draft_cleanup_unavailable outbox_full outbox_in_use outbox_invalid_delay
outbox_invalid_params outbox_invalid_payload outbox_invalid_provider outbox_message_too_large
outbox_not_finished outbox_not_found outbox_not_queued outbox_owner_unavailable
outbox_payload_id_required outbox_recovered_unsent outbox_send_id_conflict outbox_send_refused
outbox_stopped_unsent outbox_stopping outbox_storage_invalid
outbox_storage_too_large outbox_storage_unavailable outbox_storage_unsafe outbox_unknown_method
outlook_send_failed
preload_cancelled preload_incomplete preload_invalid_page preload_invalid_resource
preload_message_missing preload_timeout
private_fs_busy private_fs_exists
process_failed process_input_failed process_input_too_large process_job_failed
process_output_failed process_output_too_large process_pipe_failed process_resume_failed
process_termination_failed process_timed_out process_unavailable process_wait_failed
public_destination_refused public_encoding_refused public_http_failed public_http_refused
public_http_timeout public_image_refused public_response_too_large public_url_invalid
random_unavailable
reader_account_unknown reader_cancelled reader_message_mismatch reader_message_missing
reader_provider_unknown reader_request_limit reader_resource_too_large reader_source_expired
reader_timeout
recovery_attachment_path_invalid recovery_busy recovery_conflict recovery_invalid recovery_invalid_send_id
recovery_invalid_user_modified recovery_too_large recovery_unavailable
request_cancelled request_timed_out
session_failed
smtp_command_failed smtp_delivery_unknown smtp_invalid_response smtp_no_recipients
too_many_attachments too_many_mime_parts too_many_requests
unknown_error unknown_method
upload_capacity_exceeded upload_chunk_too_large upload_id_exhausted upload_incomplete
upload_not_found upload_offset_mismatch upload_size_exceeded
worker_failed'''.split()) | {
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
