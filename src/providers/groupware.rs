//! Closed-schema execution boundary for compose and calendar host effects.
//!
//! Network implementations live behind [`Backend`]. This module validates the
//! complete request before credentials are read and gives the backend a bounded
//! deadline. In particular, CalDAV event URLs pass an exact-origin check first.

use std::{fmt, time::Duration};

use serde::Deserialize;
use serde_json::Value;
use url::Url;
use zeroize::Zeroizing;

use super::ics;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_RESULT_BYTES: usize = 1024 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_ID_BYTES: usize = 2048;
const MAX_DEADLINE_MS: u64 = 120_000;

pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(Zeroizing::new(value.into()))
    }

    pub fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Secret([REDACTED])")
    }
}

#[derive(Clone, PartialEq)]
pub enum BackendCall {
    GmailCompose {
        save: bool,
        account_id: String,
        draft: ComposeDraft,
    },
    ImapCompose {
        account_id: String,
        draft: ComposeDraft,
    },
    GmailDraftDelete {
        account_id: String,
        draft_id: String,
    },
    GoogleCalendarList {
        source_id: String,
        range: CalendarRange,
    },
    GoogleCalendarWrite {
        create: bool,
        source_id: String,
        account_id: String,
        event_id: String,
        payload: GoogleEventPayload,
    },
    GoogleCalendarDelete {
        source_id: String,
        account_id: String,
        event_id: String,
    },
    CaldavList {
        source_id: String,
        url: String,
        range: CalendarRange,
    },
    CaldavWrite {
        create: bool,
        source_id: String,
        url: String,
        payload: String,
    },
    CaldavDelete {
        source_id: String,
        url: String,
    },
}

// User-controlled message/event content must never enter diagnostic output.
impl fmt::Debug for BackendCall {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::GmailCompose { save, .. } => formatter
                .debug_struct("GmailCompose")
                .field("save", save)
                .finish_non_exhaustive(),
            Self::ImapCompose { .. } => formatter.write_str("ImapCompose { .. }"),
            Self::GmailDraftDelete { .. } => formatter.write_str("GmailDraftDelete { .. }"),
            Self::GoogleCalendarList { .. } => formatter.write_str("GoogleCalendarList { .. }"),
            Self::GoogleCalendarWrite { create, .. } => formatter
                .debug_struct("GoogleCalendarWrite")
                .field("create", create)
                .finish_non_exhaustive(),
            Self::GoogleCalendarDelete { .. } => formatter.write_str("GoogleCalendarDelete { .. }"),
            Self::CaldavList { .. } => formatter.write_str("CaldavList { .. }"),
            Self::CaldavWrite { .. } => formatter.write_str("CaldavWrite { .. }"),
            Self::CaldavDelete { .. } => formatter.write_str("CaldavDelete { .. }"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendError {
    Unsupported,
    AuthRequired,
    Unavailable,
    TimedOut,
    Failed,
}

pub trait Backend {
    fn read_secret(&self, identity: &str) -> Result<Secret, BackendError>;
    fn execute(
        &self,
        call: BackendCall,
        secret: &Secret,
        deadline: Duration,
    ) -> Result<Value, BackendError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostError {
    InvalidRequest,
    InvalidDeadline,
    RequestTooLarge,
    ResultTooLarge,
    OriginRefused,
    Unsupported,
    AuthRequired,
    Unavailable,
    TimedOut,
    BackendFailed,
}

impl fmt::Display for HostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRequest => "invalid groupware request",
            Self::InvalidDeadline => "invalid groupware deadline",
            Self::RequestTooLarge => "groupware request is too large",
            Self::ResultTooLarge => "groupware result is too large",
            Self::OriginRefused => "calendar URL origin refused",
            Self::Unsupported => "groupware provider is unsupported",
            Self::AuthRequired => "groupware authentication is required",
            Self::Unavailable => "groupware provider is unavailable",
            Self::TimedOut => "groupware operation timed out",
            Self::BackendFailed => "groupware operation failed",
        })
    }
}

impl std::error::Error for HostError {}

pub struct GroupwareHost<'a, B> {
    backend: &'a B,
}

impl<'a, B: Backend> GroupwareHost<'a, B> {
    pub fn new(backend: &'a B) -> Self {
        Self { backend }
    }

    pub fn execute_json(&self, input: &str) -> Result<Value, HostError> {
        if input.len() > MAX_REQUEST_BYTES {
            return Err(HostError::RequestTooLarge);
        }
        let request: Request =
            serde_json::from_str(input).map_err(|_| HostError::InvalidRequest)?;
        let deadline = checked_deadline(request.deadline_ms())?;
        let (call, identity) = request.into_call()?;
        // `into_call` includes CalDAV URL resolution and exact-origin validation.
        // Keep the credential lookup after it: the ordering is security relevant.
        let secret = self
            .backend
            .read_secret(&identity)
            .map_err(map_backend_error)?;
        let result = self
            .backend
            .execute(call, &secret, deadline)
            .map_err(map_backend_error)?;
        if serde_json::to_vec(&result)
            .map_err(|_| HostError::BackendFailed)?
            .len()
            > MAX_RESULT_BYTES
        {
            return Err(HostError::ResultTooLarge);
        }
        Ok(result)
    }
}

fn checked_deadline(milliseconds: u64) -> Result<Duration, HostError> {
    if milliseconds == 0 || milliseconds > MAX_DEADLINE_MS {
        Err(HostError::InvalidDeadline)
    } else {
        Ok(Duration::from_millis(milliseconds))
    }
}

fn map_backend_error(error: BackendError) -> HostError {
    match error {
        BackendError::Unsupported => HostError::Unsupported,
        BackendError::AuthRequired => HostError::AuthRequired,
        BackendError::Unavailable => HostError::Unavailable,
        BackendError::TimedOut => HostError::TimedOut,
        BackendError::Failed => HostError::BackendFailed,
    }
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Request {
    #[serde(rename = "compose.send")]
    ComposeSend(ComposeRequest),
    #[serde(rename = "compose.draft")]
    ComposeDraft(ComposeRequest),
    #[serde(rename = "compose.draft.delete")]
    ComposeDraftDelete(DraftDeleteRequest),
    #[serde(rename = "calendar.list")]
    CalendarList(CalendarListRequest),
    #[serde(rename = "calendar.google.write")]
    GoogleWrite(GoogleWriteRequest),
    #[serde(rename = "calendar.caldav.write")]
    CaldavWrite(CaldavWriteRequest),
    #[serde(rename = "calendar.google.delete")]
    GoogleDelete(GoogleDeleteRequest),
    #[serde(rename = "calendar.caldav.delete")]
    CaldavDelete(CaldavDeleteRequest),
}

impl Request {
    fn deadline_ms(&self) -> u64 {
        match self {
            Self::ComposeSend(value) | Self::ComposeDraft(value) => value.deadline_ms,
            Self::ComposeDraftDelete(value) => value.deadline_ms,
            Self::CalendarList(value) => value.deadline_ms,
            Self::GoogleWrite(value) => value.deadline_ms,
            Self::CaldavWrite(value) => value.deadline_ms,
            Self::GoogleDelete(value) => value.deadline_ms,
            Self::CaldavDelete(value) => value.deadline_ms,
        }
    }

    fn into_call(self) -> Result<(BackendCall, String), HostError> {
        match self {
            Self::ComposeSend(value) => value.into_call(false),
            Self::ComposeDraft(value) => value.into_call(true),
            Self::ComposeDraftDelete(value) => value.into_call(),
            Self::CalendarList(value) => value.into_call(),
            Self::GoogleWrite(value) => value.into_call(),
            Self::CaldavWrite(value) => value.into_call(),
            Self::GoogleDelete(value) => value.into_call(),
            Self::CaldavDelete(value) => value.into_call(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ComposeRequest {
    provider: String,
    account_id: String,
    deadline_ms: u64,
    draft: ComposeDraft,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DraftDeleteRequest {
    provider: String,
    account_id: String,
    deadline_ms: u64,
    draft_id: String,
}
impl DraftDeleteRequest {
    fn into_call(self) -> Result<(BackendCall, String), HostError> {
        if self.provider != "gmail" {
            return Err(HostError::Unsupported);
        }
        if !valid_email(&self.account_id)
            || !valid_text(&self.draft_id, MAX_HEADER_BYTES)
            || self.draft_id.is_empty()
            || self.draft_id.contains(':')
        {
            return Err(HostError::InvalidRequest);
        }
        let identity = format!("gmail:{}", self.account_id);
        Ok((
            BackendCall::GmailDraftDelete {
                account_id: self.account_id,
                draft_id: self.draft_id,
            },
            identity,
        ))
    }
}

impl ComposeRequest {
    fn into_call(self, save: bool) -> Result<(BackendCall, String), HostError> {
        if !matches!(self.provider.as_str(), "gmail" | "imap") {
            return Err(HostError::Unsupported);
        }
        if !valid_email(
            self.account_id
                .strip_prefix("imap:")
                .unwrap_or(&self.account_id),
        ) || !self.draft.valid(save)
        {
            return Err(HostError::InvalidRequest);
        }
        if self.provider == "imap" {
            if save {
                return Err(HostError::Unsupported);
            }
            return Ok((
                BackendCall::ImapCompose {
                    account_id: self.account_id.clone(),
                    draft: self.draft,
                },
                self.account_id,
            ));
        }
        if self.provider != "gmail" {
            return Err(HostError::Unsupported);
        }
        let identity = format!("gmail:{}", self.account_id);
        Ok((
            BackendCall::GmailCompose {
                save,
                account_id: self.account_id,
                draft: self.draft,
            },
            identity,
        ))
    }
}

#[derive(Deserialize, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ComposeDraft {
    mode: String,
    #[serde(deserialize_with = "address_list")]
    to: Vec<String>,
    #[serde(default)]
    #[serde(deserialize_with = "address_list")]
    cc: Vec<String>,
    #[serde(default)]
    #[serde(deserialize_with = "address_list")]
    bcc: Vec<String>,
    subject: String,
    body: String,
    #[serde(default, rename = "draftId")]
    draft_id: String,
    #[serde(default)]
    from: String,
    #[serde(default, rename = "threadId")]
    thread_id: String,
    #[serde(default, rename = "messageId")]
    message_id: String,
    #[serde(default, rename = "inReplyTo")]
    in_reply_to: String,
    #[serde(default)]
    references: String,
}
pub(crate) type ComposeParts = (
    String,
    Vec<String>,
    Vec<String>,
    Vec<String>,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
);

impl ComposeDraft {
    #[allow(dead_code)]
    pub(crate) fn mode(&self) -> &str {
        &self.mode
    }
    pub(crate) fn has_reply_context(&self) -> bool {
        !self.thread_id.is_empty() && !self.in_reply_to.is_empty()
    }
    #[allow(dead_code)]
    pub(crate) fn into_parts(self) -> ComposeParts {
        (
            self.mode,
            self.to,
            self.cc,
            self.bcc,
            self.subject,
            self.body,
            self.thread_id,
            self.message_id,
            self.in_reply_to,
            self.references,
            self.draft_id,
        )
    }
    fn valid(&self, save: bool) -> bool {
        matches!(
            self.mode.as_str(),
            "new" | "mailto" | "reply" | "replyAll" | "forward"
        ) && [&self.to, &self.cc, &self.bcc]
            .into_iter()
            .flatten()
            .all(|value| valid_email(value))
            && valid_text(&self.subject, MAX_HEADER_BYTES)
            && valid_text(&self.from, MAX_HEADER_BYTES)
            && !self.from.chars().any(char::is_control)
            && [
                &self.thread_id,
                &self.message_id,
                &self.in_reply_to,
                &self.references,
                &self.draft_id,
            ]
            .into_iter()
            .all(|value| {
                valid_text(value, MAX_HEADER_BYTES) && !value.chars().any(char::is_control)
            })
            && !self.draft_id.contains(':')
            && self.body.len() <= MAX_REQUEST_BYTES
            && (save
                || [&self.to, &self.cc, &self.bcc]
                    .into_iter()
                    .any(|value| !value.is_empty()))
    }
}

fn address_list<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Input {
        Text(String),
        List(Vec<String>),
    }
    Ok(match Input::deserialize(deserializer)? {
        Input::Text(value) => split_address_text(&value),
        Input::List(values) => values,
    })
}

fn split_address_text(value: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let (mut quoted, mut angled) = (false, false);
    for character in value.chars() {
        match character {
            '"' => quoted = !quoted,
            '<' if !quoted => angled = true,
            '>' if !quoted => angled = false,
            ',' if !quoted && !angled => {
                push_address(&mut values, &current);
                current.clear();
                continue;
            }
            _ => {}
        }
        current.push(character);
    }
    push_address(&mut values, &current);
    values
}

fn push_address(values: &mut Vec<String>, value: &str) {
    let trimmed = value.trim();
    let mailbox = trimmed
        .rsplit_once('<')
        .and_then(|(_, rest)| rest.strip_suffix('>'))
        .unwrap_or(trimmed)
        .trim();
    if !mailbox.is_empty() {
        values.push(mailbox.to_owned());
    }
}

#[derive(Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarRange {
    start_ms: i64,
    end_ms: i64,
}

impl CalendarRange {
    #[allow(dead_code)]
    pub(crate) fn parts(&self) -> (i64, i64) {
        (self.start_ms, self.end_ms)
    }
    fn valid(&self) -> bool {
        self.start_ms < self.end_ms
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CalendarListRequest {
    provider: String,
    source_id: String,
    #[serde(default)]
    source_url: String,
    deadline_ms: u64,
    range: CalendarRange,
}

impl CalendarListRequest {
    fn into_call(self) -> Result<(BackendCall, String), HostError> {
        if !valid_identity(&self.source_id) || !self.range.valid() {
            return Err(HostError::InvalidRequest);
        }
        match self.provider.as_str() {
            "google" => Ok((
                BackendCall::GoogleCalendarList {
                    source_id: self.source_id.clone(),
                    range: self.range,
                },
                format!("google-calendar:{}", self.source_id),
            )),
            "caldav" => {
                let url = collection_url(&self.source_url)?;
                Ok((
                    BackendCall::CaldavList {
                        source_id: self.source_id.clone(),
                        url,
                        range: self.range,
                    },
                    format!("caldav:{}", self.source_id),
                ))
            }
            _ => Err(HostError::Unsupported),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoogleWriteRequest {
    source_id: String,
    account_id: String,
    deadline_ms: u64,
    #[serde(default)]
    event_id: String,
    payload: GoogleEventPayload,
}

impl GoogleWriteRequest {
    fn into_call(self) -> Result<(BackendCall, String), HostError> {
        if !valid_identity(&self.source_id)
            || !valid_identity(&self.account_id)
            || (!self.event_id.is_empty() && !valid_identity(&self.event_id))
            || !self.payload.valid()
        {
            return Err(HostError::InvalidRequest);
        }
        let create = self.event_id.is_empty();
        let identity = format!("google-calendar:{}", self.source_id);
        Ok((
            BackendCall::GoogleCalendarWrite {
                create,
                source_id: self.source_id,
                account_id: self.account_id,
                event_id: self.event_id,
                payload: self.payload,
            },
            identity,
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoogleDeleteRequest {
    source_id: String,
    account_id: String,
    deadline_ms: u64,
    event_id: String,
}

impl GoogleDeleteRequest {
    fn into_call(self) -> Result<(BackendCall, String), HostError> {
        if !valid_identity(&self.source_id)
            || !valid_identity(&self.account_id)
            || !valid_identity(&self.event_id)
        {
            return Err(HostError::InvalidRequest);
        }
        let identity = format!("google-calendar:{}", self.source_id);
        Ok((
            BackendCall::GoogleCalendarDelete {
                source_id: self.source_id,
                account_id: self.account_id,
                event_id: self.event_id,
            },
            identity,
        ))
    }
}

#[derive(Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoogleEventPayload {
    summary: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    location: String,
    start: GoogleMoment,
    end: GoogleMoment,
    #[serde(default)]
    recurrence: Vec<String>,
}
pub(crate) type EventParts = (
    String,
    String,
    String,
    (String, String),
    (String, String),
    Vec<String>,
);

impl GoogleEventPayload {
    #[allow(dead_code)]
    pub(crate) fn into_parts(self) -> EventParts {
        (
            self.summary,
            self.description,
            self.location,
            self.start.into_parts(),
            self.end.into_parts(),
            self.recurrence,
        )
    }
    fn valid(&self) -> bool {
        !self.summary.trim().is_empty()
            && valid_text(&self.summary, MAX_HEADER_BYTES)
            && valid_text(&self.description, MAX_TEXT_BYTES)
            && valid_text(&self.location, MAX_HEADER_BYTES)
            && self.start.valid()
            && self.end.valid()
            && self.start.before(&self.end)
            && self.recurrence.len() <= 32
            && self
                .recurrence
                .iter()
                .all(|value| value.len() <= MAX_HEADER_BYTES && !has_control(value))
    }
}

#[derive(Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoogleMoment {
    #[serde(default)]
    date: String,
    #[serde(default)]
    date_time: String,
}

impl GoogleMoment {
    #[allow(dead_code)]
    fn into_parts(self) -> (String, String) {
        (self.date, self.date_time)
    }
    fn valid(&self) -> bool {
        let has_date = !self.date.is_empty();
        let has_date_time = !self.date_time.is_empty();
        has_date ^ has_date_time
            && self.date.len() <= 128
            && self.date_time.len() <= 128
            && !has_control(&self.date)
            && !has_control(&self.date_time)
    }

    fn before(&self, other: &Self) -> bool {
        match (self.value(), other.value()) {
            (Some(MomentValue::Date(left)), Some(MomentValue::Date(right))) => left < right,
            (Some(MomentValue::DateTime(left)), Some(MomentValue::DateTime(right))) => left < right,
            _ => false,
        }
    }

    fn value(&self) -> Option<MomentValue> {
        if !self.date.is_empty() {
            parse_date(&self.date).map(MomentValue::Date)
        } else {
            parse_datetime(&self.date_time).map(MomentValue::DateTime)
        }
    }
}

enum MomentValue {
    Date(i64),
    DateTime(i64),
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID_BYTES && !has_control(value)
}

fn valid_email(value: &str) -> bool {
    value.len() <= 320
        && !has_control(value)
        && !value.chars().any(char::is_whitespace)
        && value.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && !domain.is_empty()
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && domain.contains('.')
                && !domain.contains("..")
                && !domain.contains('@')
        })
}

fn valid_text(value: &str, cap: usize) -> bool {
    value.len() <= cap && !has_control(value)
}

fn parse_date(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return None;
    }
    let year = value[0..4].parse::<i32>().ok()?;
    let month = value[5..7].parse::<u32>().ok()?;
    let day = value[8..10].parse::<u32>().ok()?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&month) || day == 0 || day > days[(month - 1) as usize] {
        return None;
    }
    let adjusted = year - i32::from(month <= 2);
    let era = adjusted.div_euclid(400);
    let yoe = adjusted - era * 400;
    let shifted_month = month as i32 + if month > 2 { -3 } else { 9 };
    let doy = (153 * shifted_month + 2) / 5 + day as i32 - 1;
    Some((era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468) as i64)
}

fn parse_datetime(value: &str) -> Option<i64> {
    if !value.is_ascii() {
        return None;
    }
    let (date, rest) = value.split_once('T')?;
    let days = parse_date(date)?;
    let (time, offset) = if let Some(time) = rest.strip_suffix('Z') {
        (time, 0)
    } else {
        let index = rest
            .char_indices()
            .skip(1)
            .find(|(_, ch)| *ch == '+' || *ch == '-')
            .map(|(index, _)| index)?;
        let sign = if rest.as_bytes()[index] == b'+' {
            1
        } else {
            -1
        };
        let zone = &rest[index + 1..];
        if zone.len() != 5 || &zone[2..3] != ":" {
            return None;
        }
        let hours = zone[0..2].parse::<i64>().ok()?;
        let minutes = zone[3..5].parse::<i64>().ok()?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        (&rest[..index], sign * (hours * 3600 + minutes * 60))
    };
    let core = time.split_once('.').map_or(time, |(core, fraction)| {
        if fraction.is_empty() || !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
            ""
        } else {
            core
        }
    });
    if core.len() != 8 || &core[2..3] != ":" || &core[5..6] != ":" {
        return None;
    }
    let hour = core[0..2].parse::<i64>().ok()?;
    let minute = core[3..5].parse::<i64>().ok()?;
    let second = core[6..8].parse::<i64>().ok()?;
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    Some(days * 86400 + hour * 3600 + minute * 60 + second - offset)
}

fn has_control(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn valid_ics(value: &str) -> bool {
    ics::valid_event_calendar(value, MAX_TEXT_BYTES)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaldavWriteRequest {
    source_id: String,
    source_url: String,
    deadline_ms: u64,
    url: String,
    payload: String,
}

impl CaldavWriteRequest {
    fn into_call(self) -> Result<(BackendCall, String), HostError> {
        if !valid_identity(&self.source_id) || !valid_ics(&self.payload) {
            return Err(HostError::InvalidRequest);
        }
        let url = exact_origin_url(&self.source_url, &self.url)?;
        let collection = collection_url(&self.source_url)?;
        Ok((
            BackendCall::CaldavWrite {
                create: url == collection,
                source_id: self.source_id.clone(),
                url,
                payload: self.payload,
            },
            format!("caldav:{}", self.source_id),
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaldavDeleteRequest {
    source_id: String,
    source_url: String,
    deadline_ms: u64,
    url: String,
}

impl CaldavDeleteRequest {
    fn into_call(self) -> Result<(BackendCall, String), HostError> {
        if !valid_identity(&self.source_id) {
            return Err(HostError::InvalidRequest);
        }
        let url = exact_origin_url(&self.source_url, &self.url)?;
        Ok((
            BackendCall::CaldavDelete {
                source_id: self.source_id.clone(),
                url,
            },
            format!("caldav:{}", self.source_id),
        ))
    }
}

fn collection_url(raw: &str) -> Result<String, HostError> {
    let parsed = Url::parse(raw).map_err(|_| HostError::OriginRefused)?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(HostError::OriginRefused);
    }
    Ok(parsed.into())
}

fn exact_origin_url(collection: &str, target: &str) -> Result<String, HostError> {
    let base = Url::parse(collection).map_err(|_| HostError::OriginRefused)?;
    if base.scheme() != "https"
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
    {
        return Err(HostError::OriginRefused);
    }
    let resolved = base.join(target).map_err(|_| HostError::OriginRefused)?;
    if resolved.origin() != base.origin()
        || !resolved.username().is_empty()
        || resolved.password().is_some()
    {
        return Err(HostError::OriginRefused);
    }
    Ok(resolved.into())
}
