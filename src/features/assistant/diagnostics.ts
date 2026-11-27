// "Diagnose with AI...": a report of recent backend errors for the owner's
// own AI agent, port of omarchy/scripts/diagnostics.py. Privacy first: only
// error identifiers from a reviewed vocabulary, never server or provider
// text, mail, settings, URLs or credentials; anything else is recorded as
// "unknown_error". The report goes nowhere by itself: the owner takes it to
// their agent.

/** The reviewed vocabulary of backend error identifiers (diagnostics.py). */
export const KNOWN_ERRORS: ReadonlySet<string> = new Set([
  "accounts_busy", "accounts_conflict", "accounts_invalid", "accounts_setup_replacement",
  "accounts_too_large", "accounts_unexpected_removal", "accounts_unreadable",
  "accounts_version_unsupported", "accounts_write_failed", "agent_active_limit",
  "agent_cancel_failed", "agent_choose_claude", "agent_config_invalid", "agent_config_unavailable",
  "agent_context_account_missing", "agent_context_busy", "agent_context_cancelled",
  "agent_context_failed", "agent_context_invalid", "agent_context_missing",
  "agent_context_owner_mismatch", "agent_context_required", "agent_context_timeout",
  "agent_context_too_large", "agent_continuation_override", "agent_conversation_busy",
  "agent_id_required", "agent_identifier_too_large", "agent_invalid_context",
  "agent_invalid_display", "agent_invalid_draft", "agent_invalid_envelope", "agent_invalid_events",
  "agent_invalid_filename", "agent_invalid_history", "agent_invalid_id", "agent_invalid_jobs",
  "agent_invalid_messages", "agent_invalid_model", "agent_invalid_preview",
  "agent_invalid_process", "agent_invalid_proposal", "agent_invalid_provider",
  "agent_invalid_record", "agent_invalid_result", "agent_invalid_session", "agent_invalid_state",
  "agent_invalid_text", "agent_invalid_time", "agent_job_active", "agent_job_identity",
  "agent_job_missing", "agent_mcp_invalid", "agent_mcp_io", "agent_mcp_limit",
  "agent_parent_not_latest", "agent_parent_not_ready", "agent_projection_too_large",
  "agent_prompt_required", "agent_proposal_inactive", "agent_proposal_limit",
  "agent_random_failed", "agent_runtime_failed", "agent_server_invalid", "agent_server_required",
  "agent_server_timeout", "agent_server_unavailable", "agent_state_home_invalid",
  "agent_storage_busy", "agent_storage_limit", "agent_storage_unavailable", "agent_unsafe_storage",
  "agent_unsupported_context", "agent_worker_failed", "agent_worker_unavailable",
  "attachment_data_invalid", "attachment_image_unavailable", "attachment_not_owned",
  "attachment_not_regular", "attachment_open_refused", "attachment_path_invalid",
  "attachment_too_large", "attachment_unreadable", "attachment_write_failed",
  "auth_account_invalid", "auth_account_missing", "auth_cancelled", "auth_client_invalid",
  "auth_client_missing", "auth_consent_required", "auth_flow_missing", "auth_invalid_callback",
  "auth_invalid_profile", "auth_invalid_response", "auth_keyring_failed", "auth_listener_failed",
  "auth_missing_scope", "auth_offline_access_missing", "auth_port_unavailable",
  "auth_provider_invalid", "auth_random_failed", "auth_redirect_refused", "auth_refresh_failed",
  "auth_response_too_large", "auth_secret_invalid", "auth_signed_out", "auth_timeout",
  "auth_too_many_accounts", "auth_too_many_flows", "auth_transport_failed", "backend_needs_update",
  "cache_body_invalid", "cache_body_too_large", "cache_busy", "cache_cancelled",
  "cache_home_invalid", "cache_invalid_input", "cache_resource_invalid", "cache_stale_generation",
  "cache_store_invalid", "cache_store_too_large", "cache_too_many_files", "cache_unavailable",
  "cache_unsafe_path", "calendar_ambiguous_invitation", "calendar_attendance_unconfirmed",
  "calendar_attendee_not_found", "calendar_auth_refused", "calendar_auth_required",
  "calendar_conflict", "calendar_input_too_large", "calendar_invalid_input",
  "calendar_invalid_operation", "calendar_invalid_response", "calendar_invalid_url",
  "calendar_invitation_cancelled", "calendar_invitation_not_found",
  "calendar_invitation_series_required", "calendar_keyring_failed", "calendar_network_failed",
  "calendar_not_found", "calendar_organizer_mismatch", "calendar_origin_refused",
  "calendar_password_invalid", "calendar_password_missing", "calendar_provider_unsupported",
  "calendar_redirected", "calendar_reminder_not_found", "calendar_reminders_invalid",
  "calendar_reminders_unavailable", "calendar_request_failed", "calendar_response_too_large",
  "calendar_timeout", "calendar_too_many_calendars", "calendar_too_many_pages",
  "calendar_too_many_redirects", "calendar_too_many_reminders", "config_home_invalid",
  "contacts_auth_refused", "contacts_invalid_response", "contacts_network_failed",
  "contacts_request_failed", "contacts_response_too_large", "contacts_timeout",
  "conversation_limit", "credential_missing", "credential_store_unavailable",
  "gmail_account_unknown", "gmail_client_invalid", "gmail_client_missing",
  "gmail_client_permissions", "gmail_client_too_large", "gmail_client_unreadable",
  "gmail_draft_missing", "gmail_forbidden", "gmail_http_failed", "gmail_invalid_input",
  "gmail_invalid_response", "gmail_invalid_token", "gmail_keyring_failed", "gmail_length_required",
  "gmail_queue_dropped", "gmail_queue_full", "gmail_rate_limited", "gmail_response_too_large",
  "gmail_session_invalidated", "gmail_session_limit", "gmail_signed_out", "gmail_timeout",
  "gmail_token_account_invalid", "gmail_token_invalid", "gmail_token_missing",
  "gmail_unauthorized", "hey_account_mismatch", "hey_invalid_response", "hey_program_mismatch",
  "hey_unavailable", "home_invalid", "home_missing", "html_output_too_large", "html_too_complex",
  "html_too_large", "identities_limit", "imap_attachment_missing", "imap_command_failed",
  "imap_folder_unavailable", "imap_idle_unsupported", "imap_invalid_response",
  "imap_list_incomplete", "imap_message_missing", "imap_response_too_complex",
  "imap_search_expired", "imap_timeout", "imap_unexpected_continuation", "input_failed",
  "input_too_large", "intent_already_settled", "intent_coalesce_invalid", "intent_invalid",
  "intent_limit", "intent_stale", "intent_unavailable", "intent_unknown", "intent_view_invalid",
  "invalid_attachment_encoding", "invalid_hey_binding", "invalid_hey_identity", "invalid_json",
  "invalid_message", "invalid_message_encoding", "invalid_message_header", "invalid_params",
  "invalid_signature", "invalid_transfer_encoding", "invalid_upload_encoding",
  "jmap_account_limit", "jmap_anchor_not_found", "jmap_cancelled", "jmap_cleanup_failed",
  "jmap_destination_refused", "jmap_discovery_failed", "jmap_event_too_large",
  "jmap_events_unavailable", "jmap_forbidden", "jmap_import_failed", "jmap_invalid_credential",
  "jmap_invalid_event", "jmap_invalid_message", "jmap_invalid_request", "jmap_invalid_response",
  "jmap_invalid_session", "jmap_invalid_url", "jmap_message_not_found", "jmap_method_failed",
  "jmap_missing_mailbox", "jmap_network_failed", "jmap_no_mailbox", "jmap_request_limit",
  "jmap_request_too_large", "jmap_response_too_large", "jmap_resumed", "jmap_send_unavailable",
  "jmap_sender_unavailable", "jmap_settings_missing", "jmap_spam_unavailable",
  "jmap_stream_closed", "jmap_stream_limit", "jmap_stream_missing", "jmap_stream_poll_pending",
  "jmap_submission_failed", "jmap_submission_unconfirmed", "jmap_timeout",
  "jmap_transport_unavailable", "jmap_unauthorized", "jmap_unsupported_sort", "jmap_update_failed",
  "jmap_upload_failed", "m365_access_denied", "m365_attachment_not_found", "m365_auth_failed",
  "m365_bad_response", "m365_cancelled", "m365_consent_required", "m365_draft_unconfirmed",
  "m365_folder_unavailable", "m365_invalid_request", "m365_invalid_response",
  "m365_message_not_found", "m365_message_too_large", "m365_network_failed", "m365_not_a_draft",
  "m365_request_limit", "m365_response_too_large", "m365_send_failed", "m365_send_not_attempted",
  "m365_send_rejected", "m365_server_error", "m365_signed_out", "m365_tenant_invalid",
  "m365_throttled", "m365_timeout", "m365_tls_failed", "m365_wrong_account",
  "mail_account_invalid", "mail_account_unknown", "mail_action_destination_unavailable",
  "mail_action_invalid_change", "mail_action_invalid_target", "mail_action_target_limit",
  "mail_action_target_unknown", "mail_action_unavailable", "mail_auth_contact_admin",
  "mail_auth_expired", "mail_auth_failed", "mail_auth_privacy_required", "mail_auth_unauthorized",
  "mail_auth_unavailable", "mail_check_timeout", "mail_connection_closed", "mail_dns_failed",
  "mail_list_incomplete", "mail_mailbox_unavailable", "mail_mailbox_unknown", "mail_mark_unknown",
  "mail_network_failed", "mail_provider_unknown", "mail_read_conversation_mismatch",
  "mail_read_invalid_conversation", "mail_read_invalid_reader", "mail_read_message_mismatch",
  "mail_read_unsafe_reader", "mail_response_too_large", "mail_send_attachment_changed",
  "mail_send_attachment_limit", "mail_send_attachment_name", "mail_send_attachment_not_regular",
  "mail_send_attachment_path", "mail_send_attachment_too_large", "mail_send_attachment_unreadable",
  "mail_send_envelope_mismatch", "mail_send_identities_invalid", "mail_send_invalid_address",
  "mail_send_invalid_body", "mail_send_invalid_header", "mail_send_no_recipients",
  "mail_send_recipient_limit", "mail_send_sender_unavailable", "mail_send_unavailable",
  "mail_tls_failed", "mail_watch_limit", "mail_watch_unknown", "message_input_failed",
  "message_too_large", "method_not_found", "model_account_invalid", "model_action_unsupported",
  "model_batch_invalid", "model_invalid", "model_message_missing", "model_operation_unsupported",
  "model_output_too_large", "model_too_many_rows", "outbox_account_unavailable",
  "outbox_attachment_unavailable", "outbox_delivery_unknown", "outbox_draft_cleanup_unavailable",
  "outbox_full", "outbox_in_use", "outbox_invalid_delay", "outbox_invalid_params",
  "outbox_invalid_payload", "outbox_invalid_provider", "outbox_ipc_unsupported",
  "outbox_message_too_large", "outbox_not_finished", "outbox_not_found", "outbox_not_queued",
  "outbox_owner_unavailable", "outbox_payload_id_required", "outbox_recovered_unsent",
  "outbox_send_id_conflict", "outbox_send_refused", "outbox_stopped_unsent", "outbox_stopping",
  "outbox_storage_invalid", "outbox_storage_too_large", "outbox_storage_unavailable",
  "outbox_storage_unsafe", "outbox_unknown_method", "outlook_send_failed", "preload_cancelled",
  "preload_incomplete", "preload_invalid_page", "preload_invalid_resource",
  "preload_message_missing", "preload_timeout", "private_fs_busy", "private_fs_exists",
  "process_failed", "process_input_failed", "process_input_too_large", "process_job_failed",
  "process_output_failed", "process_output_too_large", "process_pipe_failed",
  "process_resume_failed", "process_termination_failed", "process_timed_out",
  "process_unavailable", "process_wait_failed", "public_destination_refused",
  "public_encoding_refused", "public_http_failed", "public_http_refused", "public_http_timeout",
  "public_image_refused", "public_response_too_large", "public_url_invalid", "random_unavailable",
  "reader_account_unknown", "reader_cancelled", "reader_message_mismatch",
  "reader_message_missing", "reader_provider_unknown", "reader_request_limit",
  "reader_resource_too_large", "reader_source_expired", "reader_timeout",
  "recovery_attachment_path_invalid", "recovery_busy", "recovery_conflict", "recovery_invalid",
  "recovery_invalid_send_id", "recovery_invalid_user_modified", "recovery_too_large",
  "recovery_unavailable", "request_cancelled", "request_timed_out", "session_failed",
  "smtp_command_failed", "smtp_delivery_unknown", "smtp_invalid_response", "smtp_no_recipients",
  "too_many_attachments", "too_many_mime_parts", "too_many_requests", "unknown_error",
  "unknown_method", "upload_capacity_exceeded", "upload_chunk_too_large", "upload_id_exhausted",
  "upload_incomplete", "upload_not_found", "upload_offset_mismatch", "upload_size_exceeded",
  "worker_failed", "Backend unavailable", "Backend stopped", "Backend response timed out",
  "Backend request timed out", "Request cancelled", "Too many pending requests",
  "Incompatible backend", "Invalid backend response", "Backend is shutting down",
  "Backend is not ready", "Invalid params", "Method not found",
]);

const METHOD = /^[a-z][A-Za-z]*(\.[A-Za-z]+){1,3}$/;
const LIMIT = 100;

export interface DiagnosticEvent {
  time: string;
  method: string;
  code: number | null;
  message: string;
}

/** One recorded error reduced to what may leave the app. */
export function cleanEvent(method: unknown, error: unknown, now = new Date()): DiagnosticEvent {
  const e = (error && typeof error === "object" ? error : {}) as { code?: unknown; message?: unknown };
  const m = typeof method === "string" && method.length <= 80 && METHOD.test(method) ? method : "backend.request";
  const code = typeof e.code === "number" && Number.isInteger(e.code) && e.code >= -32768 && e.code <= 32767 ? e.code : null;
  const message = typeof e.message === "string" && KNOWN_ERRORS.has(e.message) ? e.message : "unknown_error";
  return { time: now.toISOString().replace(/\.\d{3}Z$/, "Z"), method: m, code, message };
}

/** The last errors, newest last; the same error within 10 s is kept once. */
export class DiagnosticLog {
  private events: DiagnosticEvent[] = [];
  private last = "";
  private lastAt = 0;

  record(method: unknown, error: unknown, now = new Date()): void {
    const event = cleanEvent(method, error, now);
    const key = event.method + "|" + event.code + "|" + event.message;
    if (key === this.last && now.getTime() - this.lastAt < 10000) return;
    this.last = key;
    this.lastAt = now.getTime();
    this.events = this.events.concat([event]).slice(-LIMIT);
  }

  entries(): DiagnosticEvent[] {
    return this.events.slice();
  }
}

/** The text the owner hands their agent: the app's versions and the errors. */
export function diagnosticReport(info: { appVersion: string; apiVersion: number; os: string }, events: DiagnosticEvent[]): string {
  const lines = [
    "Omamail diagnostics",
    "app: " + info.appVersion,
    "API revision: " + info.apiVersion,
    "system: " + info.os,
    "",
    "Recent backend errors (known identifiers only; no raw provider text):",
  ];
  if (events.length === 0) lines.push("(none recorded)");
  for (const event of events) lines.push(JSON.stringify(event));
  return lines.join("\n") + "\n";
}

/** What the agent is asked, with the report inline (no file to point at). */
export function diagnosticPrompt(report: string): string {
  return (
    "Diagnose an Omamail error using the report below. Start with read-only investigation. " +
    "Explain the cause and propose a fix. Do not send mail, retry failed operations, change settings, " +
    "delete or move AI history, or read mail bodies, credentials or conversation files without explicit user approval. " +
    "An unknown_error means the original text was omitted for privacy. " +
    "agent_invalid_state can indicate AI history written by an incompatible backend version.\n\n" +
    report
  );
}
