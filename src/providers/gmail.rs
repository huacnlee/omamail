//! Closed Gmail REST request construction for the host boundary.
//!
//! OAuth browser interaction is deliberately outside this module. A missing
//! saved grant is an explicit `AuthRequired`, never an attempt to manufacture
//! a credential or an unauthenticated network request.

use std::time::Duration;

use omamail::platform::secrets::{Secret, SecretKey, SecretStore};
use serde_json::{Value, json};
use url::Url;

pub const MAX_RESPONSE_BYTES: usize = 1_048_576;
pub const MAX_REQUEST_BYTES: usize = 1_048_576;
const MAX_DEADLINE: Duration = Duration::from_secs(120);
const MAX_ID_BYTES: usize = 2048;
const MAX_ACTION_IDS: usize = 100;
const MAX_ACTION_ID_BYTES: usize = 64 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_RECURRENCE: usize = 32;
const MAX_EMAIL_BYTES: usize = 320;
const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
const GMAIL_BASE: &str = "https://gmail.googleapis.com/gmail/v1";
const CALENDAR_BASE: &str = "https://www.googleapis.com/calendar/v3";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestIdentity {
    pub account_id: String,
    pub object_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GmailAction {
    MarkRead,
    MarkUnread,
    Star,
    Unstar,
    Archive,
    Unarchive,
    Spam,
    Trash,
    Untrash,
}

#[derive(Clone, PartialEq, Eq)]
pub enum GmailOperation {
    List {
        query: String,
        max_results: u16,
        page_token: Option<String>,
    },
    Detail {
        message_id: String,
        full: bool,
    },
    Attachment {
        message_id: String,
        part_id: String,
    },
    Action {
        action: GmailAction,
        message_ids: Vec<String>,
    },
    Send {
        raw: String,
        thread_id: Option<String>,
    },
    DraftCreate {
        raw: String,
    },
    DraftUpdate {
        draft_id: String,
        raw: String,
    },
    DraftDelete {
        draft_id: String,
    },
    DraftSend {
        draft_id: String,
        raw: String,
    },
    DraftList {
        max_results: u16,
        page_token: Option<String>,
    },
    DraftGet {
        draft_id: String,
        full: bool,
    },
    CalendarEventsList {
        calendar_id: String,
        time_min: String,
        time_max: String,
    },
    CalendarCreate {
        calendar_id: String,
        event: CalendarEvent,
    },
    CalendarUpdate {
        calendar_id: String,
        event_id: String,
        event: CalendarEvent,
    },
    CalendarDelete {
        calendar_id: String,
        event_id: String,
    },
    CalendarList,
    CalendarWrite {
        calendar_id: String,
        event: CalendarEvent,
    },
}

#[derive(Clone, PartialEq, Eq)]
pub enum CalendarMoment {
    Date(String),
    DateTime(String),
}

#[derive(Clone, PartialEq, Eq)]
pub struct CalendarEvent {
    pub summary: String,
    pub description: String,
    pub location: String,
    pub start: CalendarMoment,
    pub end: CalendarMoment,
    pub recurrence: Vec<String>,
}

impl std::fmt::Debug for GmailOperation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::List { max_results, .. } => formatter
                .debug_struct("GmailOperation::List")
                .field("max_results", max_results)
                .finish_non_exhaustive(),
            Self::Detail { full, .. } => formatter
                .debug_struct("GmailOperation::Detail")
                .field("full", full)
                .finish_non_exhaustive(),
            Self::Attachment { .. } => formatter.write_str("GmailOperation::Attachment"),
            Self::Action {
                action,
                message_ids,
            } => formatter
                .debug_struct("GmailOperation::Action")
                .field("action", action)
                .field("message_count", &message_ids.len())
                .finish(),
            Self::Send { .. } => formatter.write_str("GmailOperation::Send([REDACTED])"),
            Self::DraftCreate { .. }
            | Self::DraftUpdate { .. }
            | Self::DraftDelete { .. }
            | Self::DraftSend { .. } => formatter.write_str("GmailOperation::Draft([REDACTED])"),
            Self::DraftList { .. } | Self::DraftGet { .. } => {
                formatter.write_str("GmailOperation::DraftRead")
            }
            Self::CalendarEventsList { .. } => {
                formatter.write_str("GmailOperation::CalendarEventsList")
            }
            Self::CalendarCreate { .. }
            | Self::CalendarUpdate { .. }
            | Self::CalendarDelete { .. } => {
                formatter.write_str("GmailOperation::CalendarWrite([REDACTED])")
            }
            Self::CalendarList => formatter.write_str("GmailOperation::CalendarList"),
            Self::CalendarWrite { .. } => {
                formatter.write_str("GmailOperation::CalendarWrite([REDACTED])")
            }
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct GmailHttpRequest {
    method: String,
    url: String,
    body: Option<String>,
    deadline: Duration,
}

impl GmailHttpRequest {
    fn new(method: &str, url: Url, body: Option<String>, deadline: Duration) -> Self {
        Self {
            method: method.to_owned(),
            url: url.into(),
            body,
            deadline,
        }
    }

    pub fn method(&self) -> &str {
        &self.method
    }
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn body(&self) -> Option<&str> {
        self.body.as_deref()
    }
    pub fn deadline(&self) -> Duration {
        self.deadline
    }
}

impl std::fmt::Debug for GmailHttpRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GmailHttpRequest")
            .field("method", &self.method)
            .field(
                "endpoint",
                &self
                    .url
                    .split_once('?')
                    .map_or(self.url.as_str(), |(path, _)| path),
            )
            .field("has_body", &self.body.is_some())
            .field("deadline", &self.deadline)
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct GmailHttpResponse {
    status: u16,
    body: Vec<u8>,
}

impl std::fmt::Debug for GmailHttpResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GmailHttpResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish()
    }
}

impl GmailHttpResponse {
    pub fn json(status: u16, body: Vec<u8>) -> Self {
        Self { status, body }
    }
}

pub trait GmailTransport: Send + Sync {
    /// The implementation owns HTTPS, process containment, its deadline, and
    /// streaming output cap. The credential is deliberately separate from the
    /// request so it cannot enter a URL, argv, or request debug output.
    /// This must be a streaming cap, not merely a post-read limit.
    fn max_response_bytes(&self) -> usize;

    fn execute(
        &self,
        request: GmailHttpRequest,
        credential: AccessToken,
    ) -> Result<GmailHttpResponse, GmailError>;
}

#[derive(Clone, PartialEq, Eq)]
pub struct AccessToken(Secret);

impl AccessToken {
    pub fn new(secret: Secret) -> Self {
        Self(secret)
    }
    pub fn expose(&self) -> &str {
        self.0.expose()
    }
}

impl std::fmt::Debug for AccessToken {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("AccessToken([REDACTED])")
    }
}

pub trait AccessTokenProvider: Send + Sync {
    fn access_token(
        &self,
        refresh_token: Secret,
        deadline: Duration,
    ) -> Result<AccessToken, GmailError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GmailError {
    AuthRequired,
    InvalidRequest,
    SecretUnavailable,
    DeadlineExceeded,
    OutputTooLarge,
    InvalidResponse,
    RemoteFailure,
    PlatformUnavailable,
}

#[derive(Clone, PartialEq)]
pub struct GmailReply {
    pub identity: RequestIdentity,
    pub payload: Value,
}

impl std::fmt::Debug for GmailReply {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GmailReply")
            .field("identity", &self.identity)
            .field("payload", &"[REDACTED]")
            .finish()
    }
}

pub struct GmailExecutor<'a> {
    secrets: &'a dyn SecretStore,
    transport: &'a dyn GmailTransport,
    token_provider: &'a dyn AccessTokenProvider,
    key: SecretKey,
    account: String,
}

pub struct GmailExecutorConfig<'a> {
    pub service: &'a str,
    pub renamed_service: &'a str,
    pub client_id: &'a str,
    pub account: &'a str,
    pub grant: &'a str,
}

impl<'a> GmailExecutorConfig<'a> {
    pub fn new(
        service: &'a str,
        renamed_service: &'a str,
        client_id: &'a str,
        account: &'a str,
        grant: &'a str,
    ) -> Self {
        Self {
            service,
            renamed_service,
            client_id,
            account,
            grant,
        }
    }
}

impl<'a> GmailExecutor<'a> {
    pub fn new(
        secrets: &'a dyn SecretStore,
        transport: &'a dyn GmailTransport,
        token_provider: &'a dyn AccessTokenProvider,
        config: GmailExecutorConfig<'_>,
    ) -> Result<Self, GmailError> {
        // `execute` turns an invalid configuration into a non-leaking error;
        // callers cannot use configuration text to construct a request.
        if !valid_email(config.account) {
            return Err(GmailError::InvalidRequest);
        }
        let key = SecretKey::gmail(
            config.service,
            config.renamed_service,
            config.client_id,
            config.account,
            config.grant,
        )
        .map_err(|_| GmailError::InvalidRequest)?;
        Ok(Self {
            secrets,
            transport,
            token_provider,
            key,
            account: config.account.to_owned(),
        })
    }

    pub fn execute(
        &self,
        identity: RequestIdentity,
        operation: GmailOperation,
        deadline: Duration,
    ) -> Result<GmailReply, GmailError> {
        let started = std::time::Instant::now();
        let object_required = matches!(
            operation,
            GmailOperation::Detail { .. }
                | GmailOperation::Attachment { .. }
                | GmailOperation::Action { .. }
        );
        if deadline.is_zero()
            || deadline > MAX_DEADLINE
            || !identity.valid(object_required)
            || identity.account_id != self.account
        {
            return Err(GmailError::InvalidRequest);
        }
        let _ = build_request(operation.clone(), deadline)?;
        if self.transport.max_response_bytes() > MAX_RESPONSE_BYTES {
            return Err(GmailError::OutputTooLarge);
        }
        // Validate every caller controlled field before consulting the keyring.
        let refresh_token = self.load_credential()?;
        let refresh_budget = deadline
            .checked_sub(started.elapsed())
            .filter(|value| !value.is_zero())
            .ok_or(GmailError::DeadlineExceeded)?;
        let access_token = self
            .token_provider
            .access_token(refresh_token, refresh_budget)?;
        let transport_budget = deadline
            .checked_sub(started.elapsed())
            .filter(|value| !value.is_zero())
            .ok_or(GmailError::DeadlineExceeded)?;
        let request = build_request(operation, transport_budget)?;
        let response = self.transport.execute(request, access_token)?;
        if response.body.len() > MAX_RESPONSE_BYTES {
            return Err(GmailError::OutputTooLarge);
        }
        if !(200..300).contains(&response.status) {
            return Err(GmailError::RemoteFailure);
        }
        let payload =
            serde_json::from_slice(&response.body).map_err(|_| GmailError::InvalidResponse)?;
        Ok(GmailReply { identity, payload })
    }

    fn load_credential(&self) -> Result<Secret, GmailError> {
        match self.secrets.get(&self.key) {
            Ok(Some(secret)) => Ok(secret),
            Ok(None) => Err(GmailError::AuthRequired),
            Err(_) => Err(GmailError::SecretUnavailable),
        }
    }
}

impl RequestIdentity {
    fn valid(&self, object_required: bool) -> bool {
        valid_email(&self.account_id)
            && (if object_required {
                valid_id(&self.object_id)
            } else {
                self.object_id.is_empty() || valid_id(&self.object_id)
            })
            && self.revision <= MAX_SAFE_REVISION
    }
}

fn build_request(
    operation: GmailOperation,
    deadline: Duration,
) -> Result<GmailHttpRequest, GmailError> {
    match operation {
        GmailOperation::List {
            query,
            max_results,
            page_token,
        } => {
            if query.len() > MAX_ID_BYTES
                || page_token
                    .as_ref()
                    .is_some_and(|value| value.len() > MAX_ID_BYTES)
            {
                return Err(GmailError::InvalidRequest);
            }
            let mut url = gmail_url("/users/me/messages")?;
            let max = u16::clamp(max_results, 1, 100);
            let mut pairs = url.query_pairs_mut();
            if !query.trim().is_empty() {
                pairs.append_pair("q", query.trim());
            }
            pairs.append_pair("maxResults", &max.to_string());
            if let Some(page) = page_token.filter(|value| !value.is_empty()) {
                pairs.append_pair("pageToken", &page);
            }
            drop(pairs);
            Ok(GmailHttpRequest::new("GET", url, None, deadline))
        }
        GmailOperation::Detail { message_id, full } => {
            let mut url = gmail_url(&format!(
                "/users/me/messages/{}",
                path_segment(&message_id)?
            ))?;
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("format", if full { "full" } else { "metadata" });
            if !full {
                for header in ["From", "To", "Subject", "Date", "List-Unsubscribe"] {
                    pairs.append_pair("metadataHeaders", header);
                }
            }
            drop(pairs);
            Ok(GmailHttpRequest::new("GET", url, None, deadline))
        }
        GmailOperation::Attachment {
            message_id,
            part_id,
        } => Ok(GmailHttpRequest::new(
            "GET",
            gmail_url(&format!(
                "/users/me/messages/{}/attachments/{}",
                path_segment(&message_id)?,
                path_segment(&part_id)?
            ))?,
            None,
            deadline,
        )),
        GmailOperation::Action {
            action,
            message_ids,
        } => action_request(action, message_ids, deadline),
        GmailOperation::Send { raw, thread_id } => {
            if raw.is_empty()
                || raw.len() > MAX_REQUEST_BYTES
                || thread_id.as_ref().is_some_and(|value| !valid_id(value))
            {
                return Err(GmailError::InvalidRequest);
            }
            let mut body = json!({ "raw": raw });
            if let Some(thread) = thread_id {
                if thread.is_empty() {
                    return Err(GmailError::InvalidRequest);
                }
                body["threadId"] = Value::String(thread);
            }
            request_json(
                "POST",
                gmail_url("/users/me/messages/send")?,
                body,
                deadline,
            )
        }
        GmailOperation::DraftCreate { raw } => {
            if raw.is_empty() || raw.len() > MAX_REQUEST_BYTES {
                return Err(GmailError::InvalidRequest);
            }
            request_json(
                "POST",
                gmail_url("/users/me/drafts")?,
                json!({"message":{"raw":raw}}),
                deadline,
            )
        }
        GmailOperation::DraftUpdate { draft_id, raw } => {
            if !valid_draft_id(&draft_id) || raw.is_empty() || raw.len() > MAX_REQUEST_BYTES {
                return Err(GmailError::InvalidRequest);
            }
            request_json(
                "PUT",
                gmail_url(&format!("/users/me/drafts/{}", path_segment(&draft_id)?))?,
                json!({"message":{"raw":raw}}),
                deadline,
            )
        }
        GmailOperation::DraftDelete { draft_id } if valid_draft_id(&draft_id) => {
            Ok(GmailHttpRequest::new(
                "DELETE",
                gmail_url(&format!("/users/me/drafts/{}", path_segment(&draft_id)?))?,
                None,
                deadline,
            ))
        }
        GmailOperation::DraftDelete { .. } => Err(GmailError::InvalidRequest),
        GmailOperation::DraftSend { draft_id, raw } => {
            if !valid_draft_id(&draft_id) || raw.is_empty() || raw.len() > MAX_REQUEST_BYTES {
                return Err(GmailError::InvalidRequest);
            }
            request_json(
                "POST",
                gmail_url("/users/me/drafts/send")?,
                json!({"id":draft_id,"message":{"raw":raw}}),
                deadline,
            )
        }
        GmailOperation::DraftList {
            max_results,
            page_token,
        } => {
            if max_results == 0 || max_results > 100 {
                return Err(GmailError::InvalidRequest);
            }
            let mut url = gmail_url("/users/me/drafts")?;
            url.query_pairs_mut()
                .append_pair("maxResults", &max_results.to_string());
            if let Some(token) = page_token {
                url.query_pairs_mut().append_pair("pageToken", &token);
            }
            Ok(GmailHttpRequest::new("GET", url, None, deadline))
        }
        GmailOperation::DraftGet { draft_id, full } => {
            if !valid_draft_id(&draft_id) {
                return Err(GmailError::InvalidRequest);
            }
            let mut url = gmail_url(&format!("/users/me/drafts/{}", path_segment(&draft_id)?))?;
            url.query_pairs_mut()
                .append_pair("format", if full { "full" } else { "metadata" });
            Ok(GmailHttpRequest::new("GET", url, None, deadline))
        }
        GmailOperation::CalendarEventsList {
            calendar_id,
            time_min,
            time_max,
        } => {
            if !valid_id(&calendar_id)
                || !valid_text(&time_min, 128)
                || !valid_text(&time_max, 128)
                || time_min >= time_max
            {
                return Err(GmailError::InvalidRequest);
            }
            let mut url = calendar_url(&format!(
                "/calendars/{}/events",
                path_segment(&calendar_id)?
            ))?;
            url.query_pairs_mut()
                .append_pair("timeMin", &time_min)
                .append_pair("timeMax", &time_max)
                .append_pair("singleEvents", "true")
                .append_pair("orderBy", "startTime");
            Ok(GmailHttpRequest::new("GET", url, None, deadline))
        }
        GmailOperation::CalendarCreate { calendar_id, event } => {
            calendar_write("POST", calendar_id, None, event, deadline)
        }
        GmailOperation::CalendarUpdate {
            calendar_id,
            event_id,
            event,
        } => calendar_write("PUT", calendar_id, Some(event_id), event, deadline),
        GmailOperation::CalendarDelete {
            calendar_id,
            event_id,
        } => {
            if !valid_id(&calendar_id) || !valid_id(&event_id) {
                return Err(GmailError::InvalidRequest);
            }
            Ok(GmailHttpRequest::new(
                "DELETE",
                calendar_url(&format!(
                    "/calendars/{}/events/{}",
                    path_segment(&calendar_id)?,
                    path_segment(&event_id)?
                ))?,
                None,
                deadline,
            ))
        }
        GmailOperation::CalendarList => Ok(GmailHttpRequest::new(
            "GET",
            calendar_url("/users/me/calendarList")?,
            None,
            deadline,
        )),
        GmailOperation::CalendarWrite { calendar_id, event } => {
            if !valid_id(&calendar_id) || !event.valid() {
                return Err(GmailError::InvalidRequest);
            }
            request_json(
                "POST",
                calendar_url(&format!(
                    "/calendars/{}/events",
                    path_segment(&calendar_id)?
                ))?,
                event.to_json(),
                deadline,
            )
        }
    }
}

fn calendar_write(
    method: &str,
    calendar_id: String,
    event_id: Option<String>,
    event: CalendarEvent,
    deadline: Duration,
) -> Result<GmailHttpRequest, GmailError> {
    if !valid_id(&calendar_id) || !event.valid() {
        return Err(GmailError::InvalidRequest);
    }
    let suffix = match event_id {
        Some(id) => format!("/{}", path_segment(&id)?),
        None => String::new(),
    };
    request_json(
        method,
        calendar_url(&format!(
            "/calendars/{}/events{}",
            path_segment(&calendar_id)?,
            suffix
        ))?,
        event.to_json(),
        deadline,
    )
}

fn action_request(
    action: GmailAction,
    ids: Vec<String>,
    deadline: Duration,
) -> Result<GmailHttpRequest, GmailError> {
    if ids.is_empty()
        || ids.len() > MAX_ACTION_IDS
        || ids.iter().map(String::len).sum::<usize>() > MAX_ACTION_ID_BYTES
        || ids.iter().any(|id| !valid_id(id))
    {
        return Err(GmailError::InvalidRequest);
    }
    match action {
        GmailAction::Trash | GmailAction::Untrash if ids.len() == 1 => {
            let verb = if action == GmailAction::Trash {
                "trash"
            } else {
                "untrash"
            };
            request_json(
                "POST",
                gmail_url(&format!(
                    "/users/me/messages/{}/{}",
                    path_segment(&ids[0])?,
                    verb
                ))?,
                json!({}),
                deadline,
            )
        }
        GmailAction::Trash | GmailAction::Untrash => Err(GmailError::InvalidRequest),
        action => {
            let (add, remove): (&[&str], &[&str]) = match action {
                GmailAction::MarkRead => (&[], &["UNREAD"]),
                GmailAction::MarkUnread => (&["UNREAD"], &[]),
                GmailAction::Star => (&["STARRED"], &[]),
                GmailAction::Unstar => (&[], &["STARRED"]),
                GmailAction::Archive => (&[], &["INBOX"]),
                GmailAction::Unarchive => (&["INBOX"], &[]),
                GmailAction::Spam => (&["SPAM"], &[]),
                GmailAction::Trash | GmailAction::Untrash => unreachable!(),
            };
            let body = json!({ "ids": ids, "addLabelIds": add, "removeLabelIds": remove });
            request_json(
                "POST",
                gmail_url("/users/me/messages/batchModify")?,
                body,
                deadline,
            )
        }
    }
}

fn request_json(
    method: &str,
    url: Url,
    body: Value,
    deadline: Duration,
) -> Result<GmailHttpRequest, GmailError> {
    let body = serde_json::to_string(&body).map_err(|_| GmailError::InvalidRequest)?;
    if body.len() > MAX_REQUEST_BYTES {
        return Err(GmailError::InvalidRequest);
    }
    Ok(GmailHttpRequest::new(method, url, Some(body), deadline))
}

fn gmail_url(path: &str) -> Result<Url, GmailError> {
    fixed_url(GMAIL_BASE, path)
}
fn calendar_url(path: &str) -> Result<Url, GmailError> {
    fixed_url(CALENDAR_BASE, path)
}
fn fixed_url(base: &str, path: &str) -> Result<Url, GmailError> {
    if !path.starts_with('/') || path.contains("..") {
        return Err(GmailError::InvalidRequest);
    }
    Url::parse(&format!("{base}{path}")).map_err(|_| GmailError::InvalidRequest)
}

fn path_segment(value: &str) -> Result<String, GmailError> {
    if !valid_id(value) || value.contains(['/', '\\']) {
        return Err(GmailError::InvalidRequest);
    }
    Ok(url::form_urlencoded::byte_serialize(value.as_bytes()).collect())
}

impl CalendarEvent {
    fn valid(&self) -> bool {
        !self.summary.trim().is_empty()
            && valid_text(&self.summary, MAX_HEADER_BYTES)
            && valid_text(&self.description, MAX_TEXT_BYTES)
            && valid_text(&self.location, MAX_HEADER_BYTES)
            && self.start.valid()
            && self.end.valid()
            && self.recurrence.len() <= MAX_RECURRENCE
            && self
                .recurrence
                .iter()
                .all(|rule| valid_text(rule, MAX_HEADER_BYTES))
    }

    fn to_json(&self) -> Value {
        json!({
            "summary": self.summary,
            "description": self.description,
            "location": self.location,
            "start": self.start.to_json(),
            "end": self.end.to_json(),
            "recurrence": self.recurrence,
        })
    }
}

impl CalendarMoment {
    fn valid(&self) -> bool {
        match self {
            Self::Date(value) | Self::DateTime(value) => {
                !value.is_empty() && valid_text(value, 128)
            }
        }
    }

    fn to_json(&self) -> Value {
        match self {
            Self::Date(value) => json!({ "date": value }),
            Self::DateTime(value) => json!({ "dateTime": value }),
        }
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_BYTES && !value.chars().any(char::is_control)
}
fn valid_draft_id(value: &str) -> bool {
    valid_id(value) && !value.contains(':')
}

fn valid_text(value: &str, cap: usize) -> bool {
    value.len() <= cap && !value.chars().any(char::is_control)
}

fn valid_email(value: &str) -> bool {
    value.len() <= MAX_EMAIL_BYTES
        && !value.chars().any(char::is_control)
        && !value.contains(char::is_whitespace)
        && value.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !domain.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        })
}

#[cfg(test)]
pub fn request_for_test(
    operation: GmailOperation,
    deadline: Duration,
) -> Result<GmailHttpRequest, GmailError> {
    build_request(operation, deadline)
}
