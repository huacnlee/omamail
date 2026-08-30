use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde_json::{Value, json};

use crate::{
    host_context::{
        CalendarContext, CalendarProvider, GmailContext, HostContext, HostContextRegistry,
        ImapContext,
    },
    imap_host::{
        self, ImapAccount, MailOperation, MailTransportExecutor, OutgoingFile, mime_boundary,
        multipart_body,
    },
    platform::{
        commands::SystemProcessRunner,
        secrets::{SecretKey, SecretStore, SystemSecretStore},
    },
    providers::{
        caldav_transport::{CaldavOperation, CaldavTransport, SystemCaldavResolver},
        gmail::{
            self, CalendarEvent, CalendarMoment, GmailExecutorConfig, GmailOperation,
            RequestIdentity,
        },
        google_transport::{
            GoogleAccessTokenProvider, RestrictedGoogleTransport, SystemGoogleResolver,
        },
        groupware::{
            Backend, BackendCall, BackendError, ComposeAttachment, MAX_ATTACHMENT_BYTES,
            MAX_ATTACHMENT_TOTAL_BYTES, Secret,
        },
    },
};

pub trait NativeGroupwareOps: Send + Sync {
    fn execute(
        &self,
        call: BackendCall,
        account: Option<GmailContext>,
        imap: Option<ImapContext>,
        source: Option<CalendarContext>,
        deadline: Duration,
    ) -> Result<Value, BackendError>;
}

pub struct NativeGroupwareRuntime<O = ProductionGroupwareOps> {
    contexts: Arc<HostContextRegistry>,
    ops: O,
}
pub struct NativeGroupwareSetup(Arc<HostContextRegistry>);

impl NativeGroupwareRuntime<ProductionGroupwareOps> {
    pub fn production(
        app_root: PathBuf,
        curl: PathBuf,
        credentials_file: PathBuf,
    ) -> (Self, NativeGroupwareSetup) {
        Self::with_ops(ProductionGroupwareOps {
            secrets: SystemSecretStore::default(),
            runner: SystemProcessRunner,
            google_resolver: SystemGoogleResolver,
            caldav_resolver: SystemCaldavResolver,
            curl,
            credentials_file,
            app_root,
        })
    }
}
impl<O> NativeGroupwareRuntime<O> {
    pub fn with_ops(ops: O) -> (Self, NativeGroupwareSetup) {
        let contexts = Arc::new(HostContextRegistry::new());
        (
            Self {
                contexts: Arc::clone(&contexts),
                ops,
            },
            NativeGroupwareSetup(contexts),
        )
    }
    pub fn ops(&self) -> &O {
        &self.ops
    }
}
impl NativeGroupwareSetup {
    pub fn configure(&self, json: &str) -> Result<(), &'static str> {
        self.0
            .replace_json(json)
            .map_err(|_| "invalid groupware configuration")
    }
}

impl<O: NativeGroupwareOps> Backend for NativeGroupwareRuntime<O> {
    fn read_secret(&self, identity: &str) -> Result<Secret, BackendError> {
        if let Some(account) = identity.strip_prefix("gmail:") {
            return matches!(
                self.contexts.resolve_account(account),
                Ok(HostContext::Gmail(_))
            )
            .then(|| Secret::new(identity))
            .ok_or(BackendError::Unavailable);
        }
        if identity.starts_with("imap:") {
            return matches!(
                self.contexts.resolve_account(identity),
                Ok(HostContext::Imap(_))
            )
            .then(|| Secret::new(identity))
            .ok_or(BackendError::Unavailable);
        }
        let source = identity
            .strip_prefix("google-calendar:")
            .or_else(|| identity.strip_prefix("caldav:"));
        source
            .and_then(|id| self.contexts.resolve_source(id).ok())
            .map(|_| Secret::new(identity))
            .ok_or(BackendError::Unavailable)
    }
    fn execute(
        &self,
        call: BackendCall,
        _: &Secret,
        deadline: Duration,
    ) -> Result<Value, BackendError> {
        if matches!(&call, BackendCall::GmailCompose { draft, .. } if matches!(draft.mode(), "reply" | "replyAll") && !draft.has_reply_context())
        {
            return Err(BackendError::Unsupported);
        }
        let (account, imap, source) = match &call {
            BackendCall::GmailCompose { account_id, .. }
            | BackendCall::GmailDraftDelete { account_id, .. } => {
                (gmail(&self.contexts, account_id), None, None)
            }
            BackendCall::ImapCompose { account_id, .. } => {
                let value = match self.contexts.resolve_account(account_id) {
                    Ok(HostContext::Imap(value)) => Some(value),
                    _ => None,
                };
                (None, value, None)
            }
            BackendCall::GoogleCalendarList { source_id, .. }
            | BackendCall::GoogleCalendarWrite { source_id, .. }
            | BackendCall::GoogleCalendarDelete { source_id, .. }
            | BackendCall::CaldavList { source_id, .. }
            | BackendCall::CaldavWrite { source_id, .. }
            | BackendCall::CaldavDelete { source_id, .. } => {
                let source = self
                    .contexts
                    .resolve_source(source_id)
                    .map_err(|_| BackendError::Unavailable)?;
                let account = gmail(&self.contexts, source.account_id());
                (account, None, Some(source))
            }
        };
        if let BackendCall::GoogleCalendarWrite { account_id, .. } = &call
            && source.as_ref().map(CalendarContext::account_id) != Some(account_id.as_str())
        {
            return Err(BackendError::Unavailable);
        }
        if let BackendCall::GoogleCalendarDelete { account_id, .. } = &call
            && source.as_ref().map(CalendarContext::account_id) != Some(account_id.as_str())
        {
            return Err(BackendError::Unavailable);
        }
        self.ops.execute(call, account, imap, source, deadline)
    }
}
fn gmail(registry: &HostContextRegistry, id: &str) -> Option<GmailContext> {
    match registry.resolve_account(id).ok()? {
        HostContext::Gmail(value) => Some(value),
        _ => None,
    }
}

pub struct ProductionGroupwareOps {
    secrets: SystemSecretStore,
    runner: SystemProcessRunner,
    google_resolver: SystemGoogleResolver,
    caldav_resolver: SystemCaldavResolver,
    curl: PathBuf,
    credentials_file: PathBuf,
    app_root: PathBuf,
}
impl NativeGroupwareOps for ProductionGroupwareOps {
    fn execute(
        &self,
        call: BackendCall,
        account: Option<GmailContext>,
        imap: Option<ImapContext>,
        source: Option<CalendarContext>,
        deadline: Duration,
    ) -> Result<Value, BackendError> {
        match call {
            BackendCall::ImapCompose { account_id, draft } => {
                let context = imap
                    .filter(|x| x.account_id() == account_id)
                    .ok_or(BackendError::Unavailable)?;
                let endpoint =
                    url::Url::parse(context.imap_url()).map_err(|_| BackendError::Failed)?;
                let key = SecretKey::imap_endpoint(
                    "omamail",
                    context.account_id(),
                    endpoint.host_str().ok_or(BackendError::Failed)?,
                    endpoint
                        .port_or_known_default()
                        .ok_or(BackendError::Failed)?,
                    context.username(),
                )
                .map_err(|_| BackendError::Failed)?;
                let password = self
                    .secrets
                    .get(&key)
                    .map_err(|_| BackendError::Unavailable)?
                    .ok_or(BackendError::Unavailable)?;
                let account = ImapAccount::new(
                    context.account_id(),
                    context.email(),
                    context.imap_url(),
                    context.smtp_url(),
                    context.username(),
                    password,
                )
                .map_err(|_| BackendError::Failed)?;
                // Read before the transport is planned: a missing or oversized
                // file stops the send with its own error rather than letting
                // the message go out without what the user attached.
                let files = load_attachments(draft.attachments())?;
                let parts: Vec<OutgoingFile<'_>> =
                    files.iter().map(LoadedAttachment::part).collect();
                let (
                    mode,
                    from,
                    to,
                    cc,
                    bcc,
                    subject,
                    body,
                    _thread_id,
                    _message_id,
                    in_reply_to,
                    references,
                    _draft_id,
                ) = draft.into_parts();
                let reply = matches!(mode.as_str(), "reply" | "replyAll");
                if reply && in_reply_to.is_empty() {
                    return Err(BackendError::Unsupported);
                }
                // The address the composer picked, which the request layer has
                // already refused unless it is one this mailbox may send as.
                // Only a draft that named none falls back to the account's.
                let operation = MailOperation::SendThreaded {
                    from: if from.is_empty() {
                        context.email()
                    } else {
                        from.as_str()
                    },
                    to: to.iter().map(String::as_str).collect(),
                    cc: cc.iter().map(String::as_str).collect(),
                    bcc: bcc.iter().map(String::as_str).collect(),
                    subject: &subject,
                    body: &body,
                    in_reply_to: reply.then_some(in_reply_to.as_str()),
                    references: reply.then_some(if references.is_empty() {
                        in_reply_to.as_str()
                    } else {
                        references.as_str()
                    }),
                    attachments: parts,
                };
                let planned =
                    imap_host::plan(&account, operation).map_err(|_| BackendError::Failed)?;
                imap_host::execute_with_runner(
                    planned,
                    &MailTransportExecutor::new(self.app_root.clone()),
                    deadline,
                    &self.runner,
                )
                .map_err(|error| match error {
                    imap_host::RunnerError::TimedOut => BackendError::TimedOut,
                    imap_host::RunnerError::PlatformUnavailable => BackendError::Unavailable,
                    _ => BackendError::Failed,
                })?;
                Ok(json!({"accepted":true}))
            }
            BackendCall::GmailCompose {
                save,
                account_id,
                draft,
            } => {
                let account = account
                    .filter(|x| x.account_id() == account_id)
                    .ok_or(BackendError::Unavailable)?;
                // Before the draft is taken apart, and before anything is sent:
                // a file that cannot be read stops the send here.
                let files = load_attachments(draft.attachments())?;
                let (
                    mode,
                    from,
                    to,
                    cc,
                    bcc,
                    subject,
                    body,
                    thread_id,
                    _message_id,
                    in_reply_to,
                    references,
                    draft_id,
                ) = draft.into_parts();
                debug_assert!(matches!(
                    mode.as_str(),
                    "new" | "mailto" | "reply" | "replyAll" | "forward"
                ));
                if matches!(mode.as_str(), "reply" | "replyAll")
                    && (thread_id.is_empty() || in_reply_to.is_empty())
                {
                    return Err(BackendError::Unsupported);
                }
                let raw = message(
                    // As above: the picked address, checked against this
                    // mailbox before the grant was read, and the account's own
                    // only where the draft named none.
                    if from.is_empty() {
                        account.account_id()
                    } else {
                        from.as_str()
                    },
                    &to,
                    &cc,
                    &bcc,
                    &subject,
                    &body,
                    (!in_reply_to.is_empty())
                        .then_some((in_reply_to.as_str(), references.as_str())),
                    &files,
                )?;
                let operation = if !save && !draft_id.is_empty() {
                    GmailOperation::DraftSend { draft_id, raw }
                } else if save && !draft_id.is_empty() {
                    GmailOperation::DraftUpdate { draft_id, raw }
                } else if save {
                    GmailOperation::DraftCreate { raw }
                } else {
                    GmailOperation::Send {
                        raw,
                        thread_id: (!thread_id.is_empty()).then_some(thread_id),
                    }
                };
                self.gmail(account, operation, deadline)
            }
            BackendCall::GmailDraftDelete {
                account_id,
                draft_id,
            } => {
                let account = account
                    .filter(|x| x.account_id() == account_id)
                    .ok_or(BackendError::Unavailable)?;
                self.gmail(account, GmailOperation::DraftDelete { draft_id }, deadline)
            }
            BackendCall::GoogleCalendarList { source_id, range } => {
                let source = google_source(source, &source_id)?;
                let account = account.ok_or(BackendError::Unavailable)?;
                let (start, end) = range.parts();
                self.gmail(
                    account,
                    GmailOperation::CalendarEventsList {
                        calendar_id: source
                            .remote_calendar_id()
                            .ok_or(BackendError::Unavailable)?
                            .to_owned(),
                        time_min: timestamp(start)?,
                        time_max: timestamp(end)?,
                    },
                    deadline,
                )
            }
            BackendCall::GoogleCalendarWrite {
                create,
                source_id,
                event_id,
                payload,
                ..
            } => {
                let source = google_source(source, &source_id)?;
                let account = account.ok_or(BackendError::Unavailable)?;
                let event = event(payload);
                let operation = if create {
                    GmailOperation::CalendarCreate {
                        calendar_id: source
                            .remote_calendar_id()
                            .ok_or(BackendError::Unavailable)?
                            .to_owned(),
                        event,
                    }
                } else {
                    GmailOperation::CalendarUpdate {
                        calendar_id: source
                            .remote_calendar_id()
                            .ok_or(BackendError::Unavailable)?
                            .to_owned(),
                        event_id,
                        event,
                    }
                };
                self.gmail(account, operation, deadline)
            }
            BackendCall::GoogleCalendarDelete {
                source_id,
                event_id,
                ..
            } => {
                let source = google_source(source, &source_id)?;
                let account = account.ok_or(BackendError::Unavailable)?;
                self.gmail(
                    account,
                    GmailOperation::CalendarDelete {
                        calendar_id: source
                            .remote_calendar_id()
                            .ok_or(BackendError::Unavailable)?
                            .to_owned(),
                        event_id,
                    },
                    deadline,
                )
            }
            BackendCall::CaldavList {
                source_id, range, ..
            } => {
                let source = caldav_source(source, &source_id)?;
                let (start_ms, end_ms) = range.parts();
                self.caldav(source, CaldavOperation::List { start_ms, end_ms }, deadline)
            }
            BackendCall::CaldavWrite {
                source_id,
                url,
                payload,
                ..
            } => self.caldav(
                caldav_source(source, &source_id)?,
                CaldavOperation::Write {
                    target: url,
                    payload,
                },
                deadline,
            ),
            BackendCall::CaldavDelete { source_id, url } => self.caldav(
                caldav_source(source, &source_id)?,
                CaldavOperation::Delete { target: url },
                deadline,
            ),
        }
    }
}
impl ProductionGroupwareOps {
    fn gmail(
        &self,
        account: GmailContext,
        operation: GmailOperation,
        deadline: Duration,
    ) -> Result<Value, BackendError> {
        let transport =
            RestrictedGoogleTransport::new(self.curl.clone(), &self.runner, &self.google_resolver);
        let tokens = GoogleAccessTokenProvider::new(
            self.credentials_file.clone(),
            account.client_id(),
            self.curl.clone(),
            &self.runner,
            &self.google_resolver,
        );
        let executor = gmail::GmailExecutor::new(
            &self.secrets,
            &transport,
            &tokens,
            GmailExecutorConfig::new(account.client_id(), account.account_id(), account.grant()),
        )
        .map_err(map_gmail)?;
        executor
            .execute(
                RequestIdentity {
                    account_id: account.account_id().to_owned(),
                    object_id: String::new(),
                    revision: 0,
                },
                operation,
                deadline,
            )
            .map(|x| x.payload)
            .map_err(map_gmail)
    }
    fn caldav(
        &self,
        source: CalendarContext,
        operation: CaldavOperation,
        deadline: Duration,
    ) -> Result<Value, BackendError> {
        let transport = CaldavTransport::new(
            source,
            &self.secrets,
            "omamail",
            self.curl.clone(),
            &self.runner,
            &self.caldav_resolver,
        )
        .map_err(map_caldav)?;
        let reply = transport.execute(operation, deadline).map_err(map_caldav)?;
        Ok(json!({"status":reply.status(), "body":String::from_utf8_lossy(reply.body())}))
    }
}
fn google_source(
    source: Option<CalendarContext>,
    id: &str,
) -> Result<CalendarContext, BackendError> {
    source
        .filter(|x| x.source_id() == id && x.provider() == CalendarProvider::Google)
        .ok_or(BackendError::Unavailable)
}
fn caldav_source(
    source: Option<CalendarContext>,
    id: &str,
) -> Result<CalendarContext, BackendError> {
    source
        .filter(|x| x.source_id() == id && x.provider() == CalendarProvider::Caldav)
        .ok_or(BackendError::Unavailable)
}
/// One attached file, read. The bytes are held here rather than in the request
/// because the host is what opens the file and what measures it.
pub(crate) struct LoadedAttachment {
    pub(crate) filename: String,
    pub(crate) mime_type: String,
    pub(crate) data: Vec<u8>,
}

// A filename and the bytes of a file are the message's content; only how much
// of it there is may be said out loud.
impl std::fmt::Debug for LoadedAttachment {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LoadedAttachment")
            .field("bytes", &self.data.len())
            .finish_non_exhaustive()
    }
}

impl LoadedAttachment {
    fn part(&self) -> OutgoingFile<'_> {
        OutgoingFile {
            filename: &self.filename,
            mime_type: &self.mime_type,
            data: &self.data,
        }
    }
}

/// Opens every file a draft named. A file that has gone missing, that is not a
/// regular file, or that is past the send limit stops the send with a distinct
/// error, because a message that quietly left out what the user attached is
/// worse than one that was not sent: the user cannot tell it happened.
pub(crate) fn load_attachments(
    files: &[ComposeAttachment],
) -> Result<Vec<LoadedAttachment>, BackendError> {
    let mut loaded = Vec::with_capacity(files.len());
    let mut total: u64 = 0;
    for file in files {
        let path = Path::new(file.path());
        // Follows a symlink deliberately — the user picked it — but a
        // directory, a socket or a device is not a file that was attached, and
        // reading one would either hang or send something nobody chose.
        let metadata = fs::metadata(path).map_err(|_| BackendError::AttachmentUnreadable)?;
        if !metadata.is_file() {
            return Err(BackendError::AttachmentUnreadable);
        }
        // Measured before the read, so an enormous file is refused rather than
        // pulled into memory first.
        if metadata.len() > MAX_ATTACHMENT_BYTES {
            return Err(BackendError::AttachmentTooLarge);
        }
        let data = fs::read(path).map_err(|_| BackendError::AttachmentUnreadable)?;
        // And again after it: the file could have grown between the two, and
        // what was read is what would go out.
        let length = data.len() as u64;
        if length > MAX_ATTACHMENT_BYTES {
            return Err(BackendError::AttachmentTooLarge);
        }
        total = total
            .checked_add(length)
            .ok_or(BackendError::AttachmentTooLarge)?;
        if total > MAX_ATTACHMENT_TOTAL_BYTES {
            return Err(BackendError::AttachmentTooLarge);
        }
        loaded.push(LoadedAttachment {
            filename: file.filename().to_owned(),
            mime_type: if file.mime_type().is_empty() {
                "application/octet-stream".to_owned()
            } else {
                file.mime_type().to_owned()
            },
            data,
        });
    }
    Ok(loaded)
}

#[allow(clippy::too_many_arguments)]
fn message(
    from: &str,
    to: &[String],
    cc: &[String],
    bcc: &[String],
    subject: &str,
    body: &str,
    reply: Option<(&str, &str)>,
    files: &[LoadedAttachment],
) -> Result<String, BackendError> {
    if [from, subject]
        .iter()
        .any(|x| x.chars().any(char::is_control))
    {
        return Err(BackendError::Failed);
    }
    let mut raw = format!("From: {from}\r\nTo: {}\r\n", to.join(", "));
    if !cc.is_empty() {
        raw.push_str(&format!("Cc: {}\r\n", cc.join(", ")));
    }
    if !bcc.is_empty() {
        raw.push_str(&format!("Bcc: {}\r\n", bcc.join(", ")));
    }
    if let Some((in_reply_to, references)) = reply {
        raw.push_str(&format!("In-Reply-To: {in_reply_to}\r\n"));
        raw.push_str(&format!(
            "References: {}\r\n",
            if references.is_empty() {
                in_reply_to
            } else {
                references
            }
        ));
    }
    // Encoded rather than written through, the way `Message.js` writes a
    // Subject: Gmail refuses a raw message carrying an 8-bit header.
    raw.push_str(&format!(
        "Subject: {}\r\nMIME-Version: 1.0\r\n",
        imap_host::header_text(subject)
    ));
    if files.is_empty() {
        raw.push_str(&format!(
            "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
            folded_base64(body)
        ));
    } else {
        // Assembled by the one MIME builder the SMTP path also uses, so a
        // Gmail message and an IMAP one carry a file the same way.
        let parts: Vec<OutgoingFile<'_>> = files.iter().map(LoadedAttachment::part).collect();
        raw.push_str(&multipart_body(body, &parts, &mime_boundary()));
    }
    Ok(URL_SAFE_NO_PAD.encode(raw))
}
fn folded_base64(value: &str) -> String {
    STANDARD
        .encode(value.as_bytes())
        .as_bytes()
        .chunks(76)
        .map(|line| std::str::from_utf8(line).expect("base64 ASCII"))
        .collect::<Vec<_>>()
        .join("\r\n")
}
fn map_gmail(error: gmail::GmailError) -> BackendError {
    match error {
        gmail::GmailError::AuthRequired => BackendError::AuthRequired,
        gmail::GmailError::SecretUnavailable | gmail::GmailError::PlatformUnavailable => {
            BackendError::Unavailable
        }
        gmail::GmailError::DeadlineExceeded => BackendError::TimedOut,
        _ => BackendError::Failed,
    }
}
fn map_caldav(error: crate::providers::caldav_transport::CaldavError) -> BackendError {
    use crate::providers::caldav_transport::CaldavError;
    match error {
        CaldavError::AuthRequired => BackendError::AuthRequired,
        CaldavError::UnknownSecret | CaldavError::PlatformUnavailable => BackendError::Unavailable,
        CaldavError::TimedOut => BackendError::TimedOut,
        _ => BackendError::Failed,
    }
}
fn timestamp(ms: i64) -> Result<String, BackendError> {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .map_err(|_| BackendError::Failed)?
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| BackendError::Failed)
}
fn event(payload: crate::providers::groupware::GoogleEventPayload) -> CalendarEvent {
    let (summary, description, location, start, end, recurrence) = payload.into_parts();
    let moment = |(date, date_time): (String, String)| {
        if date.is_empty() {
            CalendarMoment::DateTime(date_time)
        } else {
            CalendarMoment::Date(date)
        }
    };
    CalendarEvent {
        summary,
        description,
        location,
        start: moment(start),
        end: moment(end),
        recurrence,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::groupware::ComposeDraft;
    use std::io::Write as _;

    fn file(dir: &std::path::Path, name: &str, bytes: &[u8]) -> String {
        let path = dir.join(name);
        let mut handle = fs::File::create(&path).unwrap();
        handle.write_all(bytes).unwrap();
        path.to_str().unwrap().to_owned()
    }

    fn attachment(path: &str, filename: &str, mime_type: &str, size: u64) -> ComposeAttachment {
        serde_json::from_value(json!({
            "path": path,
            "filename": filename,
            "mimeType": mime_type,
            "size": size,
        }))
        .unwrap()
    }

    #[test]
    fn a_gmail_subject_that_is_not_ascii_goes_out_as_an_encoded_word() {
        let raw = message(
            "me@example.test",
            &["you@example.test".to_owned()],
            &[],
            &[],
            "Rapport d'\u{e9}t\u{e9}",
            "voici",
            None,
            &[],
        )
        .unwrap();
        let decoded = String::from_utf8(URL_SAFE_NO_PAD.decode(raw).unwrap()).unwrap();
        // Gmail refuses a raw message carrying an 8-bit header outright, so the
        // port writing the value straight in was a subject that could not be
        // sent at all rather than one that arrived wrong.
        assert!(decoded.contains(&format!(
            "Subject: =?UTF-8?B?{}?=\r\n",
            STANDARD.encode("Rapport d'\u{e9}t\u{e9}")
        )));
        assert!(!decoded.contains("Rapport d'\u{e9}t\u{e9}"));

        let plain = message(
            "me@example.test",
            &["you@example.test".to_owned()],
            &[],
            &[],
            "Quarterly report",
            "here",
            None,
            &[],
        )
        .unwrap();
        let decoded = String::from_utf8(URL_SAFE_NO_PAD.decode(plain).unwrap()).unwrap();
        assert!(decoded.contains("Subject: Quarterly report\r\n"));
    }

    #[test]
    fn the_from_the_composer_picked_is_what_the_message_says() {
        // The seam the address used to fall through: `into_parts` is what the
        // send path takes a draft apart with, and a `from` it did not return
        // was a From nobody could write.
        let draft: ComposeDraft = serde_json::from_value(json!({
            "mode": "new",
            "from": "Me@Example.test",
            "to": "you@example.test",
            "subject": "Hi",
            "body": "Body",
        }))
        .unwrap();
        let (_mode, from, to, cc, bcc, subject, body, ..) = draft.into_parts();
        assert_eq!(from, "Me@Example.test");
        let raw = message(&from, &to, &cc, &bcc, &subject, &body, None, &[]).unwrap();
        let decoded = String::from_utf8(URL_SAFE_NO_PAD.decode(raw).unwrap()).unwrap();
        assert!(decoded.starts_with("From: Me@Example.test\r\n"));

        // A draft that named none still goes out as the account, which is what
        // every message sent before an identity list existed did.
        let bare: ComposeDraft = serde_json::from_value(json!({
            "mode": "new",
            "to": "you@example.test",
            "subject": "Hi",
            "body": "Body",
        }))
        .unwrap();
        assert_eq!(bare.sender(), "");
    }

    #[test]
    fn reads_an_attached_file_and_defaults_a_media_type_it_was_not_given() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path(), "notes.txt", b"hello");
        let loaded = load_attachments(&[
            attachment(&path, "notes.txt", "text/plain", 5),
            attachment(&path, "second.bin", "", 5),
        ])
        .unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].data, b"hello");
        assert_eq!(loaded[0].mime_type, "text/plain");
        assert_eq!(loaded[1].mime_type, "application/octet-stream");
    }

    #[test]
    fn a_file_that_is_gone_or_is_not_a_file_stops_the_send_rather_than_being_left_out() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("gone.txt");
        assert_eq!(
            load_attachments(&[attachment(
                missing.to_str().unwrap(),
                "gone.txt",
                "text/plain",
                5
            )])
            .unwrap_err(),
            BackendError::AttachmentUnreadable
        );
        assert_eq!(
            load_attachments(&[attachment(
                dir.path().to_str().unwrap(),
                "a-directory",
                "text/plain",
                0
            )])
            .unwrap_err(),
            BackendError::AttachmentUnreadable
        );
    }

    #[test]
    fn the_size_on_disk_decides_not_the_size_the_request_declared() {
        let dir = tempfile::tempdir().unwrap();
        let big = file(
            dir.path(),
            "big.bin",
            &vec![0u8; MAX_ATTACHMENT_BYTES as usize + 1],
        );
        // The request understates it; the host measures the file it opened.
        assert_eq!(
            load_attachments(&[attachment(&big, "big.bin", "application/octet-stream", 1)])
                .unwrap_err(),
            BackendError::AttachmentTooLarge
        );
    }

    #[test]
    fn files_that_fit_one_at_a_time_are_refused_once_they_do_not_fit_together() {
        let dir = tempfile::tempdir().unwrap();
        let half = file(
            dir.path(),
            "half.bin",
            &vec![7u8; (MAX_ATTACHMENT_TOTAL_BYTES / 2) as usize + 1],
        );
        let one = attachment(&half, "half.bin", "application/octet-stream", 0);
        assert!(load_attachments(std::slice::from_ref(&one)).is_ok());
        assert_eq!(
            load_attachments(&[one.clone(), one]).unwrap_err(),
            BackendError::AttachmentTooLarge
        );
    }

    #[test]
    fn an_attached_file_reaches_the_wire_as_its_own_base64_mime_part() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(dir.path(), "report.pdf", b"%PDF-1.7 body");
        let files =
            load_attachments(&[attachment(&path, "report.pdf", "application/pdf", 13)]).unwrap();
        let encoded = message(
            "me@example.test",
            &["you@example.test".into()],
            &[],
            &[],
            "Subject",
            "the note",
            None,
            &files,
        )
        .unwrap();
        let raw = String::from_utf8(URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
        let boundary = raw
            .split("boundary=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
            .to_owned();
        assert!(raw.contains("Content-Type: multipart/mixed; boundary=\""));
        // The text the user typed is a part of its own, and base64 like every
        // other part, so nothing in a message can be read as the boundary.
        assert!(raw.contains(&format!(
            "--{boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
            STANDARD.encode("the note")
        )));
        assert!(raw.contains(&format!(
            "--{boundary}\r\nContent-Type: application/pdf; name=\"report.pdf\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\n\r\n{}\r\n",
            STANDARD.encode("%PDF-1.7 body")
        )));
        assert!(raw.ends_with(&format!("--{boundary}--\r\n")));
        // A message with no files keeps the single-part shape it always had.
        let plain = String::from_utf8(
            URL_SAFE_NO_PAD
                .decode(
                    message(
                        "me@example.test",
                        &["you@example.test".into()],
                        &[],
                        &[],
                        "Subject",
                        "the note",
                        None,
                        &[],
                    )
                    .unwrap(),
                )
                .unwrap(),
        )
        .unwrap();
        assert!(plain.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(!plain.contains("multipart/mixed"));
    }

    #[test]
    fn mime_body_is_folded_at_76_columns_and_round_trips_with_terminal_crlf() {
        let encoded = message(
            "me@example.test",
            &["you@example.test".into()],
            &[],
            &[],
            "Subject",
            &"é".repeat(200),
            None,
            &[],
        )
        .unwrap();
        let raw = String::from_utf8(URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
        assert!(raw.ends_with("\r\n"));
        let body = raw
            .split("\r\n\r\n")
            .nth(1)
            .unwrap()
            .strip_suffix("\r\n")
            .unwrap();
        assert!(body.split("\r\n").all(|line| line.len() <= 76));
        let decoded = STANDARD.decode(body.replace("\r\n", "")).unwrap();
        assert_eq!(String::from_utf8(decoded).unwrap(), "é".repeat(200));
    }
    #[test]
    fn typed_transport_errors_keep_fixed_classes() {
        assert_eq!(
            map_gmail(gmail::GmailError::AuthRequired),
            BackendError::AuthRequired
        );
        assert_eq!(
            map_gmail(gmail::GmailError::DeadlineExceeded),
            BackendError::TimedOut
        );
        assert_eq!(
            map_caldav(crate::providers::caldav_transport::CaldavError::PlatformUnavailable),
            BackendError::Unavailable
        );
        assert_eq!(
            map_caldav(crate::providers::caldav_transport::CaldavError::RemoteFailure),
            BackendError::Failed
        );
    }
}
