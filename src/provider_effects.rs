use std::{
    collections::BTreeMap,
    fmt,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_INPUT: usize = 1_048_576;
const MAX_ID: usize = 2048;
const MAX_DEADLINE_MS: u64 = 120_000;
const JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_IDS_BYTES: usize = 65_536;
const MAX_TRANSPORT_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootRoute {
    Provider,
    Groupware,
}
pub fn root_route(input: &str) -> Result<RootRoute, &'static str> {
    if input.len() > MAX_INPUT {
        return Err("invalid provider request");
    }
    let value: Value = serde_json::from_str(input).map_err(|_| "invalid provider request")?;
    if value.get("operation").is_some() && value.get("type").is_some() {
        return Err("invalid provider request");
    }
    if value
        .get("operation")
        .and_then(Value::as_str)
        .is_some_and(|name| name.starts_with("gmail.") || name.starts_with("imap."))
    {
        Ok(RootRoute::Provider)
    } else if value
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|name| name.starts_with("compose.") || name.starts_with("calendar."))
    {
        Ok(RootRoute::Groupware)
    } else {
        Err("invalid provider request")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Gmail,
    Imap,
}

pub trait HostContext {
    fn provider_for(&self, account_id: &str) -> Option<Provider>;
    fn source_for(&self, source_id: &str) -> Option<SourceContext>;
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceContext {
    pub source_id: String,
    pub account_id: String,
    pub kind: String,
    pub url: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImapRuntime {
    pub special_use: BTreeMap<String, String>,
    pub archive_folder: Option<String>,
    pub trash_folder: Option<String>,
    pub supports_move: bool,
}
pub trait ImapRuntimeResolver {
    fn runtime_for(&self, account_id: &str, deadline: Duration) -> Option<ImapRuntime>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub account_id: String,
    pub object_id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
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
pub enum GmailCall {
    List {
        identity: Identity,
        query: String,
        max_results: u16,
        page_token: Option<String>,
    },
    Detail {
        identity: Identity,
        message_id: String,
        full: bool,
    },
    Attachment {
        identity: Identity,
        message_id: String,
        part_id: String,
    },
    Action {
        identity: Identity,
        action: GmailAction,
        message_ids: Vec<String>,
    },
}
impl fmt::Debug for GmailCall {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::List { max_results, .. } => f
                .debug_struct("GmailList")
                .field("max_results", max_results)
                .finish_non_exhaustive(),
            Self::Detail { full, .. } => f
                .debug_struct("GmailDetail")
                .field("full", full)
                .finish_non_exhaustive(),
            Self::Attachment { .. } => f.write_str("GmailAttachment { .. }"),
            Self::Action {
                action,
                message_ids,
                ..
            } => f
                .debug_struct("GmailAction")
                .field("action", action)
                .field("count", &message_ids.len())
                .finish(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImapCall {
    List {
        identity: Identity,
        folder: String,
        criteria: String,
        max_results: u16,
        page_token: Option<String>,
    },
    Detail {
        identity: Identity,
        message_id: String,
        full: bool,
    },
    Action {
        identity: Identity,
        action: String,
        message_ids: Vec<String>,
        destination: Option<String>,
        move_strategy: Option<ImapMoveStrategy>,
    },
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImapMoveStrategy {
    Move,
    CopyStoreUidExpunge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderFailure {
    Unavailable,
    /// This mailbox has no stored credential to work with, so nothing it is
    /// asked to do can succeed until somebody signs in again.
    ///
    /// It is its own class because it is the only failure here the user can
    /// act on, and the only one where retrying is pointless: filed under
    /// `Unavailable` it reached the window as "provider unavailable" beside a
    /// Retry button, which is how a Gmail mailbox that had lost its refresh
    /// token looked exactly like a Gmail that was briefly down.
    SignedOut,
    TimedOut,
    Failed,
    Uncertain,
}

pub trait GmailExecutor {
    fn execute(&self, call: GmailCall, deadline: Duration) -> Result<Value, ProviderFailure>;
}
pub trait ImapExecutor {
    fn execute(
        &self,
        call: ImapCall,
        deadline: Duration,
    ) -> Result<ImapTransportPayload, ProviderFailure>;
}

pub struct GmailExecutorAdapter<F>(pub F);
impl<F> GmailExecutor for GmailExecutorAdapter<F>
where
    F: Fn(GmailCall, Duration) -> Result<Value, ProviderFailure>,
{
    fn execute(&self, call: GmailCall, deadline: Duration) -> Result<Value, ProviderFailure> {
        (self.0)(call, deadline)
    }
}
pub struct ImapExecutorAdapter<F>(pub F);
impl<F> ImapExecutor for ImapExecutorAdapter<F>
where
    F: Fn(ImapCall, Duration) -> Result<ImapTransportPayload, ProviderFailure>,
{
    fn execute(
        &self,
        call: ImapCall,
        deadline: Duration,
    ) -> Result<ImapTransportPayload, ProviderFailure> {
        (self.0)(call, deadline)
    }
}

impl HostContext for omamail::host_context::HostContextRegistry {
    fn provider_for(&self, account_id: &str) -> Option<Provider> {
        match self.resolve_account(account_id).ok()? {
            omamail::host_context::HostContext::Gmail(_) => Some(Provider::Gmail),
            omamail::host_context::HostContext::Imap(_) => Some(Provider::Imap),
        }
    }
    fn source_for(&self, source_id: &str) -> Option<SourceContext> {
        let source = self.resolve_source(source_id).ok()?;
        Some(SourceContext {
            source_id: source.source_id().to_owned(),
            account_id: source.account_id().to_owned(),
            kind: match source.provider() {
                omamail::host_context::CalendarProvider::Google => "google",
                omamail::host_context::CalendarProvider::Caldav => "caldav",
            }
            .to_owned(),
            url: source.source_url().map(str::to_owned),
        })
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct ImapTransportPayload {
    pub status: i32,
    pub response_base64: String,
}
impl fmt::Debug for ImapTransportPayload {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImapTransportPayload")
            .field("status", &self.status)
            .field("response", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyIdentity {
    pub account_id: String,
    pub object_id: String,
    pub revision: u64,
}

#[derive(Clone, Serialize)]
pub struct ProviderReply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<ReplyIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
impl fmt::Debug for ProviderReply {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProviderReply")
            .field("ok", &self.ok)
            .field("has_data", &self.data.is_some())
            .field("identity", &self.identity.as_ref().map(|x| x.revision))
            .field("error", &self.error)
            .finish()
    }
}

pub struct ProviderDispatcher<'a> {
    context: &'a dyn HostContext,
    gmail: &'a dyn GmailExecutor,
    imap: &'a dyn ImapExecutor,
    imap_runtime: Option<&'a dyn ImapRuntimeResolver>,
}
impl<'a> ProviderDispatcher<'a> {
    pub fn new(
        context: &'a dyn HostContext,
        gmail: &'a dyn GmailExecutor,
        imap: &'a dyn ImapExecutor,
    ) -> Self {
        Self {
            context,
            gmail,
            imap,
            imap_runtime: None,
        }
    }
    pub fn with_imap_runtime(mut self, resolver: &'a dyn ImapRuntimeResolver) -> Self {
        self.imap_runtime = Some(resolver);
        self
    }
    pub fn dispatch(&self, input: &str) -> ProviderReply {
        if input.len() > MAX_INPUT {
            return failure("invalid provider request");
        }
        let request: Request = match serde_json::from_str(input) {
            Ok(value) => value,
            Err(_) => return failure("invalid provider request"),
        };
        match self.execute(request) {
            Ok((data, identity)) => ProviderReply {
                ok: true,
                data: Some(data),
                identity: Some(reply_identity(identity)),
                error: None,
            },
            Err(error) => failure(error),
        }
    }
    fn execute(&self, request: Request) -> Result<(Value, Identity), &'static str> {
        let deadline = checked_deadline(request.deadline_ms())?;
        let started = Instant::now();
        let identity = request.identity().to_identity()?;
        match request {
            Request::GmailList(value) => {
                self.require(&identity, Provider::Gmail, false)?;
                if value.max_results == 0
                    || value.max_results > 100
                    || !optional(&value.query, MAX_ID)
                    || !option(&value.page_token, MAX_ID)
                {
                    return Err("invalid provider request");
                }
                let call = GmailCall::List {
                    identity: identity.clone(),
                    query: value.query,
                    max_results: value.max_results,
                    page_token: value.page_token,
                };
                self.gmail
                    .execute(call, deadline)
                    .map(|data| (data, identity))
                    .map_err(provider_error)
            }
            Request::GmailDetail(value) => {
                self.require(&identity, Provider::Gmail, true)?;
                same_object(&identity, &value.message_id)?;
                let call = GmailCall::Detail {
                    identity: identity.clone(),
                    message_id: value.message_id,
                    full: value.full,
                };
                self.gmail
                    .execute(call, deadline)
                    .map(|data| (data, identity))
                    .map_err(provider_error)
            }
            Request::GmailAction(value) => {
                self.require(&identity, Provider::Gmail, true)?;
                ids(&value.message_ids)?;
                let call = GmailCall::Action {
                    identity: identity.clone(),
                    action: value.action,
                    message_ids: value.message_ids,
                };
                self.gmail
                    .execute(call, deadline)
                    .map(|data| (data, identity))
                    .map_err(provider_error)
            }
            Request::GmailAttachment(value) => {
                self.require(&identity, Provider::Gmail, true)?;
                same_object(&identity, &value.message_id)?;
                if !field(&value.part_id, MAX_ID)
                    || !value
                        .part_id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '-'))
                {
                    return Err("invalid provider request");
                }
                let call = GmailCall::Attachment {
                    identity: identity.clone(),
                    message_id: value.message_id,
                    part_id: value.part_id,
                };
                self.gmail
                    .execute(call, deadline)
                    .map(|data| (data, identity))
                    .map_err(provider_error)
            }
            Request::ImapList(value) => {
                self.require(&identity, Provider::Imap, false)?;
                if !field(&value.folder, 4096)
                    || !optional(&value.criteria, 16384)
                    || value.max_results == 0
                    || value.max_results > 100
                    || !option(&value.page_token, MAX_ID)
                {
                    return Err("invalid provider request");
                }
                let call = ImapCall::List {
                    identity: identity.clone(),
                    folder: value.folder,
                    criteria: value.criteria,
                    max_results: value.max_results,
                    page_token: value.page_token,
                };
                imap(self.imap.execute(call, deadline), identity)
            }
            Request::ImapDetail(value) => {
                self.require(&identity, Provider::Imap, true)?;
                same_object(&identity, &value.message_id)?;
                let call = ImapCall::Detail {
                    identity: identity.clone(),
                    message_id: value.message_id,
                    full: value.full,
                };
                imap(self.imap.execute(call, deadline), identity)
            }
            Request::ImapAction(value) => {
                self.require(&identity, Provider::Imap, true)?;
                ids(&value.message_ids)?;
                if !matches!(
                    value.action.as_str(),
                    "markRead"
                        | "markUnread"
                        | "star"
                        | "unstar"
                        | "archive"
                        | "unarchive"
                        | "trash"
                        | "untrash"
                ) {
                    return Err("invalid provider request");
                }
                let discovery_budget = deadline
                    .checked_sub(started.elapsed())
                    .filter(|value| !value.is_zero())
                    .ok_or("provider timed out")?;
                let (destination, move_strategy) = match value.action.as_str() {
                    "archive" => {
                        self.imap_destination(&identity.account_id, true, discovery_budget)?
                    }
                    "trash" => {
                        self.imap_destination(&identity.account_id, false, discovery_budget)?
                    }
                    "unarchive" | "untrash" => {
                        (Some("INBOX".to_owned()), Some(ImapMoveStrategy::Move))
                    }
                    _ => (None, None),
                };
                let call = ImapCall::Action {
                    identity: identity.clone(),
                    action: value.action,
                    message_ids: value.message_ids,
                    destination,
                    move_strategy,
                };
                let remaining = deadline
                    .checked_sub(started.elapsed())
                    .filter(|value| !value.is_zero())
                    .ok_or("provider timed out")?;
                imap(self.imap.execute(call, remaining), identity)
            }
            Request::ImapRuntime(_) => {
                self.require(&identity, Provider::Imap, false)?;
                if !identity.object_id.is_empty() {
                    return Err("provider context mismatch");
                }
                let runtime = self
                    .imap_runtime
                    .and_then(|resolver| resolver.runtime_for(&identity.account_id, deadline))
                    .ok_or("provider capability unavailable")?;
                let mut special_use = serde_json::Map::new();
                for (flag, folder) in runtime.special_use {
                    if matches!(
                        flag.as_str(),
                        "\\all" | "\\archive" | "\\drafts" | "\\junk" | "\\sent" | "\\trash"
                    ) && field(&folder, 4096)
                    {
                        special_use.insert(flag, Value::String(folder));
                    }
                }
                Ok((
                    serde_json::json!({"specialUse": special_use, "supportsMove": runtime.supports_move}),
                    identity,
                ))
            }
        }
    }
    fn require(
        &self,
        identity: &Identity,
        provider: Provider,
        object: bool,
    ) -> Result<(), &'static str> {
        if self.context.provider_for(&identity.account_id) != Some(provider)
            || (object && !field(&identity.object_id, MAX_ID))
            || (!object && !optional(&identity.object_id, MAX_ID))
        {
            Err("provider context mismatch")
        } else {
            Ok(())
        }
    }
    fn imap_destination(
        &self,
        account: &str,
        archive: bool,
        deadline: Duration,
    ) -> Result<(Option<String>, Option<ImapMoveStrategy>), &'static str> {
        let runtime = self
            .imap_runtime
            .and_then(|resolver| resolver.runtime_for(account, deadline))
            .ok_or("provider capability unavailable")?;
        let folder = if archive {
            runtime.archive_folder
        } else {
            runtime.trash_folder
        };
        folder
            .filter(|value| field(value, 4096))
            .map(|value| {
                (
                    Some(value),
                    Some(if runtime.supports_move {
                        ImapMoveStrategy::Move
                    } else {
                        ImapMoveStrategy::CopyStoreUidExpunge
                    }),
                )
            })
            .ok_or("provider capability unavailable")
    }
}

fn imap(
    result: Result<ImapTransportPayload, ProviderFailure>,
    identity: Identity,
) -> Result<(Value, Identity), &'static str> {
    result
        .and_then(|payload| {
            if payload.response_base64.len() > MAX_TRANSPORT_BYTES * 2 {
                return Err(ProviderFailure::Failed);
            }
            let decoded = STANDARD
                .decode(&payload.response_base64)
                .map_err(|_| ProviderFailure::Failed)?;
            if decoded.len() > MAX_TRANSPORT_BYTES {
                return Err(ProviderFailure::Failed);
            }
            Ok((serde_json::json!({"kind":"imap.transport","status":payload.status,"responseBase64":payload.response_base64}), identity))
        })
        .map_err(provider_error)
}
fn checked_deadline(ms: u64) -> Result<Duration, &'static str> {
    if ms == 0 || ms > MAX_DEADLINE_MS {
        Err("invalid provider request")
    } else {
        Ok(Duration::from_millis(ms))
    }
}
fn provider_error(error: ProviderFailure) -> &'static str {
    match error {
        ProviderFailure::Unavailable => "provider unavailable",
        // `app/application/mail-state.js`'s `SIGNED_OUT` reads this exact
        // sentence; `tests/test_source.sh` fails when the two drift apart.
        ProviderFailure::SignedOut => "provider requires sign-in",
        ProviderFailure::TimedOut => "provider timed out",
        ProviderFailure::Failed => "provider operation failed",
        ProviderFailure::Uncertain => "provider state uncertain; reload required",
    }
}
fn failure(error: &str) -> ProviderReply {
    ProviderReply {
        ok: false,
        data: None,
        identity: None,
        error: Some(error.to_owned()),
    }
}
fn reply_identity(value: Identity) -> ReplyIdentity {
    ReplyIdentity {
        account_id: value.account_id,
        object_id: value.object_id,
        revision: value.revision,
    }
}
fn field(value: &str, cap: usize) -> bool {
    !value.is_empty() && optional(value, cap)
}
fn optional(value: &str, cap: usize) -> bool {
    value.len() <= cap && !value.chars().any(char::is_control)
}
fn option(value: &Option<String>, cap: usize) -> bool {
    value.as_ref().is_none_or(|x| optional(x, cap))
}
fn ids(values: &[String]) -> Result<(), &'static str> {
    if values.is_empty()
        || values.len() > 100
        || values.iter().map(String::len).sum::<usize>() > MAX_IDS_BYTES
        || values.iter().any(|x| !field(x, MAX_ID))
    {
        Err("invalid provider request")
    } else {
        Ok(())
    }
}
fn same_object(identity: &Identity, value: &str) -> Result<(), &'static str> {
    if value == identity.object_id && field(value, MAX_ID) {
        Ok(())
    } else {
        Err("provider context mismatch")
    }
}

#[derive(Deserialize)]
#[serde(tag = "operation")]
enum Request {
    #[serde(rename = "gmail.list")]
    GmailList(ListRequest),
    #[serde(rename = "gmail.detail")]
    GmailDetail(DetailRequest),
    #[serde(rename = "gmail.action")]
    GmailAction(GmailActionRequest),
    #[serde(rename = "gmail.attachment")]
    GmailAttachment(AttachmentRequest),
    #[serde(rename = "imap.list")]
    ImapList(ImapListRequest),
    #[serde(rename = "imap.detail")]
    ImapDetail(DetailRequest),
    #[serde(rename = "imap.action")]
    ImapAction(ImapActionRequest),
    #[serde(rename = "imap.runtime")]
    ImapRuntime(RuntimeRequest),
}
impl Request {
    fn deadline_ms(&self) -> u64 {
        match self {
            Self::GmailList(x) => x.deadline_ms,
            Self::GmailDetail(x) | Self::ImapDetail(x) => x.deadline_ms,
            Self::GmailAction(x) => x.deadline_ms,
            Self::GmailAttachment(x) => x.deadline_ms,
            Self::ImapList(x) => x.deadline_ms,
            Self::ImapAction(x) => x.deadline_ms,
            Self::ImapRuntime(x) => x.deadline_ms,
        }
    }
    fn identity(&self) -> &WireIdentity {
        match self {
            Self::GmailList(x) => &x.identity,
            Self::GmailDetail(x) | Self::ImapDetail(x) => &x.identity,
            Self::GmailAction(x) => &x.identity,
            Self::GmailAttachment(x) => &x.identity,
            Self::ImapList(x) => &x.identity,
            Self::ImapAction(x) => &x.identity,
            Self::ImapRuntime(x) => &x.identity,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeRequest {
    deadline_ms: u64,
    identity: WireIdentity,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireIdentity {
    account_id: String,
    object_id: String,
    revision: u64,
}
impl WireIdentity {
    fn to_identity(&self) -> Result<Identity, &'static str> {
        if !field(&self.account_id, MAX_ID) || self.revision > JS_SAFE_INTEGER {
            Err("invalid provider request")
        } else {
            Ok(Identity {
                account_id: self.account_id.clone(),
                object_id: self.object_id.clone(),
                revision: self.revision,
            })
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListRequest {
    deadline_ms: u64,
    identity: WireIdentity,
    query: String,
    max_results: u16,
    page_token: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DetailRequest {
    deadline_ms: u64,
    identity: WireIdentity,
    message_id: String,
    full: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttachmentRequest {
    deadline_ms: u64,
    identity: WireIdentity,
    message_id: String,
    part_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GmailActionRequest {
    deadline_ms: u64,
    identity: WireIdentity,
    action: GmailAction,
    message_ids: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImapListRequest {
    deadline_ms: u64,
    identity: WireIdentity,
    folder: String,
    criteria: String,
    max_results: u16,
    page_token: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImapActionRequest {
    deadline_ms: u64,
    identity: WireIdentity,
    action: String,
    message_ids: Vec<String>,
}
