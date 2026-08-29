use std::{path::PathBuf, sync::Arc, time::Duration};

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
    imap_host::{self, ImapAccount, MailOperation, MailTransportExecutor},
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
        groupware::{Backend, BackendCall, BackendError, Secret},
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
            | BackendCall::CaldavList { source_id, .. }
            | BackendCall::CaldavWrite { source_id, .. } => {
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
                let (
                    mode,
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
                let operation = MailOperation::SendThreaded {
                    from: context.email(),
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
                let (
                    mode,
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
                    account.account_id(),
                    &to,
                    &cc,
                    &bcc,
                    &subject,
                    &body,
                    (!in_reply_to.is_empty())
                        .then_some((in_reply_to.as_str(), references.as_str())),
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
            GmailExecutorConfig::new(
                "omamail",
                "omamail-gmail",
                account.client_id(),
                account.account_id(),
                account.grant(),
            ),
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
fn message(
    from: &str,
    to: &[String],
    cc: &[String],
    bcc: &[String],
    subject: &str,
    body: &str,
    reply: Option<(&str, &str)>,
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
    raw.push_str(&format!("Subject: {subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n", folded_base64(body)));
    Ok(URL_SAFE_NO_PAD.encode(raw))
}
fn folded_base64(value: &str) -> String {
    STANDARD
        .encode(value)
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
