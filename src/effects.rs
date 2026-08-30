use std::{
    collections::HashSet,
    fmt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use gpui_shell::{HostModule, HostValue};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::platform::commands::{
    CommandError, CommandPolicy, HeyOperation, PreparedCommand, ProcessRunner, SystemProcessRunner,
    TransportOperation,
};
use crate::{
    host_context::HostContextRegistry,
    native_groupware_runtime::{NativeGroupwareRuntime, NativeGroupwareSetup},
    native_provider_runtime::{NativeProviderRuntime, NativeProviderSetup},
    provider_effects::{ProviderDispatcher, RootRoute, root_route},
    providers::groupware::GroupwareHost,
};

const MAX_DEADLINE_MS: u64 = 60_000;
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_HEY_STDOUT_BYTES: usize = 512 * 1024;
const MAX_HEY_ARGUMENT_BYTES: usize = 4 * 1024;
const MAX_IMAGE_STDOUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TRANSPORT_STDERR_BYTES: usize = 16 * 1024;
const UNSEEN_SCAN_LIMIT: &str = "100";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EffectHostError {
    InvalidRequest,
    Unsupported,
    Failed,
}
impl fmt::Display for EffectHostError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidRequest => "effect request is invalid",
            Self::Unsupported => "effect operation is unsupported",
            Self::Failed => "effect operation failed",
        })
    }
}
impl std::error::Error for EffectHostError {}

#[derive(Debug, Deserialize)]
#[serde(tag = "operation", deny_unknown_fields)]
pub enum EffectRequest {
    #[serde(rename = "hey.status")]
    HeyStatus {
        #[serde(rename = "deadlineMs")]
        deadline_ms: u64,
    },
    #[serde(rename = "hey.list")]
    HeyList {
        #[serde(rename = "deadlineMs")]
        deadline_ms: u64,
        #[serde(rename = "accountId")]
        account_id: String,
        identity: HeyIdentity,
        query: HeyQuery,
    },
    #[serde(rename = "hey.thread")]
    HeyThread {
        #[serde(rename = "deadlineMs")]
        deadline_ms: u64,
        #[serde(rename = "accountId")]
        account_id: String,
        identity: HeyIdentity,
        #[serde(rename = "messageId")]
        message_id: String,
    },
    #[serde(rename = "hey.action")]
    HeyAction {
        #[serde(rename = "deadlineMs")]
        deadline_ms: u64,
        #[serde(rename = "accountId")]
        account_id: String,
        identity: HeyIdentity,
        action: HeyAction,
        #[serde(rename = "messageIds")]
        message_ids: Vec<String>,
    },
    #[serde(rename = "hey.compose")]
    HeyCompose {
        #[serde(rename = "deadlineMs")]
        deadline_ms: u64,
        #[serde(rename = "accountId")]
        account_id: String,
        mode: String,
        #[serde(rename = "topicId")]
        topic_id: String,
        to: Vec<String>,
        cc: Vec<String>,
        bcc: Vec<String>,
        subject: String,
        body: String,
    },
    #[serde(rename = "imap.request")]
    ImapRequest {
        #[serde(rename = "deadlineMs")]
        deadline_ms: u64,
    },
    #[serde(rename = "gmail.request")]
    GmailRequest {
        #[serde(rename = "deadlineMs")]
        deadline_ms: u64,
    },
    #[serde(rename = "image.fetch")]
    ImageFetch {
        #[serde(rename = "deadlineMs")]
        deadline_ms: u64,
        url: String,
    },
    #[serde(rename = "unsubscribe")]
    Unsubscribe {
        #[serde(rename = "deadlineMs")]
        deadline_ms: u64,
        url: String,
        #[serde(rename = "contentType")]
        content_type: String,
        body: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HeyIdentity {
    account_id: String,
    query: String,
    object_id: String,
    revision: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum HeyQuery {
    Box {
        #[serde(rename = "box")]
        mailbox: HeyBox,
        #[serde(default)]
        unseen: bool,
        #[serde(default)]
        page: Option<String>,
    },
    Trash {
        #[serde(default)]
        page: Option<String>,
    },
    Label {
        label: String,
        #[serde(default)]
        page: Option<String>,
    },
    Search {
        text: String,
        #[serde(default)]
        page: Option<String>,
    },
    Drafts {
        #[serde(default)]
        page: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HeyBox {
    Imbox,
    Feedbox,
    Asidebox,
    Laterbox,
    Trailbox,
    Bubblebox,
}
impl HeyBox {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Imbox => "imbox",
            Self::Feedbox => "feedbox",
            Self::Asidebox => "asidebox",
            Self::Laterbox => "laterbox",
            Self::Trailbox => "trailbox",
            Self::Bubblebox => "bubblebox",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HeyAction {
    MarkRead,
    MarkUnread,
    Trash,
    Spam,
    Untrash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ThreadFlag {
    AllowPartial,
    Html,
}

impl ThreadFlag {
    fn argument(self) -> &'static str {
        match self {
            Self::AllowPartial => "--allow-partial",
            Self::Html => "--html",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "--allow-partial" => Some(Self::AllowPartial),
            "--html" => Some(Self::Html),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct EffectHost {
    policy: CommandPolicy,
    hey_runner: Arc<dyn HeyRunner>,
    dropped_thread_flags: Arc<Mutex<HashSet<ThreadFlag>>>,
    provider: Arc<dyn ProviderRuntime>,
    groupware: Arc<dyn GroupwareRuntime>,
    transport_runner: Arc<dyn ProcessRunner>,
}
pub trait GroupwareRuntime: Send + Sync {
    fn dispatch(&self, json: &str) -> String;
}
impl GroupwareRuntime for NativeGroupwareRuntime {
    fn dispatch(&self, json: &str) -> String {
        match GroupwareHost::new(self).execute_json(json) {
            Ok(data) => serde_json::to_string(&json!({"ok":true,"data":data})),
            Err(error) => serde_json::to_string(&json!({"ok":false,"error":error.to_string()})),
        }
        .unwrap_or_else(|_| r#"{"ok":false,"error":"groupware operation failed"}"#.into())
    }
}
struct UnsupportedGroupware;
impl GroupwareRuntime for UnsupportedGroupware {
    fn dispatch(&self, _: &str) -> String {
        r#"{"ok":false,"error":"groupware provider is unavailable"}"#.into()
    }
}

pub trait ProviderRuntime: Send + Sync {
    fn configure(&self, json: &str) -> Result<(), EffectHostError>;
    fn dispatch(&self, json: &str) -> String;
}

struct NativeProviderDispatch {
    runtime: Arc<NativeProviderRuntime>,
    context: Arc<HostContextRegistry>,
}
impl ProviderRuntime for NativeProviderDispatch {
    fn configure(&self, _: &str) -> Result<(), EffectHostError> {
        Err(EffectHostError::Unsupported)
    }
    fn dispatch(&self, json: &str) -> String {
        serde_json::to_string(
            &ProviderDispatcher::new(
                self.context.as_ref(),
                self.runtime.as_ref(),
                self.runtime.as_ref(),
            )
            .with_imap_runtime(self.runtime.as_ref())
            .dispatch(json),
        )
        .unwrap_or_else(|_| r#"{"ok":false,"error":"provider request failed"}"#.into())
    }
}

pub trait HeyRunner: Send + Sync {
    fn run_hey(&self, command: PreparedCommand) -> Result<HeyCommandOutput, CommandError>;
}

pub struct HeyCommandOutput {
    status: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}
impl HeyCommandOutput {
    pub fn success(stdout: impl AsRef<str>) -> Self {
        Self {
            status: Some(0),
            stdout: stdout.as_ref().as_bytes().to_vec(),
            stderr: Vec::new(),
        }
    }
    pub fn from_stdout(stdout: Vec<u8>) -> Self {
        Self {
            status: Some(0),
            stdout,
            stderr: Vec::new(),
        }
    }
}

struct SystemHeyRunner;
impl HeyRunner for SystemHeyRunner {
    fn run_hey(&self, command: PreparedCommand) -> Result<HeyCommandOutput, CommandError> {
        let output = SystemProcessRunner.run(command)?;
        Ok(HeyCommandOutput {
            status: output.status(),
            stdout: output.stdout().to_vec(),
            stderr: output.stderr().to_vec(),
        })
    }
}

impl EffectHost {
    pub fn new(app_root: &Path) -> Self {
        Self::native(app_root, Arc::new(SystemHeyRunner)).0
    }
    fn native(app_root: &Path, hey_runner: Arc<dyn HeyRunner>) -> (Self, NativeConfigure) {
        let checkout_root = app_root.parent().unwrap_or(app_root);
        let (runtime, setup) = NativeProviderRuntime::production(
            checkout_root.to_path_buf(),
            PathBuf::from("curl"),
            checkout_root.join("oauth-client.json"),
        );
        let runtime = Arc::new(runtime);
        let (groupware, groupware_setup) = NativeGroupwareRuntime::production(
            checkout_root.to_path_buf(),
            PathBuf::from("curl"),
            checkout_root.join("oauth-client.json"),
        );
        let context = Arc::new(HostContextRegistry::new());
        let mut host = Self::with_runners(
            app_root,
            hey_runner,
            Arc::new(NativeProviderDispatch {
                runtime,
                context: Arc::clone(&context),
            }),
        );
        host.groupware = Arc::new(groupware);
        (
            host,
            NativeConfigure {
                setup,
                context,
                groupware_setup,
            },
        )
    }
    pub fn with_hey_runner(app_root: &Path, hey_runner: Arc<dyn HeyRunner>) -> Self {
        Self::native(app_root, hey_runner).0
    }
    pub fn with_runners(
        app_root: &Path,
        hey_runner: Arc<dyn HeyRunner>,
        provider: Arc<dyn ProviderRuntime>,
    ) -> Self {
        Self::with_host_runtimes(
            app_root,
            hey_runner,
            provider,
            Arc::new(UnsupportedGroupware),
        )
    }
    pub fn with_host_runtimes(
        app_root: &Path,
        hey_runner: Arc<dyn HeyRunner>,
        provider: Arc<dyn ProviderRuntime>,
        groupware: Arc<dyn GroupwareRuntime>,
    ) -> Self {
        Self::with_all_runners(
            app_root,
            hey_runner,
            provider,
            groupware,
            Arc::new(SystemProcessRunner),
        )
    }
    pub fn with_transport_runner(
        app_root: &Path,
        hey_runner: Arc<dyn HeyRunner>,
        provider: Arc<dyn ProviderRuntime>,
        transport_runner: Arc<dyn ProcessRunner>,
    ) -> Self {
        Self::with_all_runners(
            app_root,
            hey_runner,
            provider,
            Arc::new(UnsupportedGroupware),
            transport_runner,
        )
    }
    fn with_all_runners(
        app_root: &Path,
        hey_runner: Arc<dyn HeyRunner>,
        provider: Arc<dyn ProviderRuntime>,
        groupware: Arc<dyn GroupwareRuntime>,
        transport_runner: Arc<dyn ProcessRunner>,
    ) -> Self {
        let checkout_root = app_root.parent().unwrap_or(app_root);
        Self {
            policy: CommandPolicy::new(
                "hey".into(),
                checkout_root.join("scripts/mail-transport.sh"),
                checkout_root.join("scripts/image-fetch.sh"),
                checkout_root.join("scripts/unsubscribe.sh"),
            ),
            hey_runner,
            dropped_thread_flags: Arc::new(Mutex::new(HashSet::new())),
            provider,
            groupware,
            transport_runner,
        }
    }
    pub fn configure(&self, json: &str) -> Result<(), EffectHostError> {
        self.provider.configure(json)
    }
    pub fn execute_json(&self, json: &str) -> Result<String, EffectHostError> {
        if json.len() > 1_048_576 {
            return Err(EffectHostError::InvalidRequest);
        }
        match root_route(json) {
            Ok(RootRoute::Provider) => Ok(self.provider.dispatch(json)),
            Ok(RootRoute::Groupware) => Ok(self.groupware.dispatch(json)),
            Err(_) => {
                let request = Self::parse(json)?;
                self.execute(request)
            }
        }
    }
    pub fn parse(json: &str) -> Result<EffectRequest, EffectHostError> {
        if json.len() > MAX_REQUEST_BYTES {
            return Err(EffectHostError::InvalidRequest);
        }
        let value: Value =
            serde_json::from_str(json).map_err(|_| EffectHostError::InvalidRequest)?;
        let operation = value
            .get("operation")
            .and_then(Value::as_str)
            .ok_or(EffectHostError::InvalidRequest)?;
        if !matches!(
            operation,
            "hey.status"
                | "hey.list"
                | "hey.thread"
                | "hey.action"
                | "hey.compose"
                | "imap.request"
                | "gmail.request"
                | "image.fetch"
                | "unsubscribe"
        ) {
            return Err(EffectHostError::Unsupported);
        }
        let request: EffectRequest =
            serde_json::from_value(value).map_err(|_| EffectHostError::InvalidRequest)?;
        validate_request(&request)?;
        Ok(request)
    }
    pub fn dispatch(_request: EffectRequest) -> Result<(), EffectHostError> {
        Err(EffectHostError::Unsupported)
    }
    pub fn execute(&self, request: EffectRequest) -> Result<String, EffectHostError> {
        match request {
            EffectRequest::HeyStatus { deadline_ms } => self.run(
                self.policy
                    .prepare_hey(HeyOperation::AuthStatus, Duration::from_millis(deadline_ms))
                    .map_err(|_| EffectHostError::InvalidRequest)?,
            ),
            EffectRequest::HeyList {
                deadline_ms,
                account_id,
                query,
                ..
            } => {
                let started = Instant::now();
                self.verify_hey_account(&account_id, started, deadline_ms)?;
                self.run(prepared_hey(
                    list_arguments(query)?,
                    remaining_ms(started, deadline_ms)?,
                )?)
            }
            EffectRequest::HeyThread {
                deadline_ms,
                account_id,
                message_id,
                ..
            } => {
                let started = Instant::now();
                self.verify_hey_account(&account_id, started, deadline_ms)?;
                let (_, topic) = message_parts(&message_id)?;
                self.run_thread(topic, started, deadline_ms)
            }
            EffectRequest::HeyAction {
                deadline_ms,
                account_id,
                action,
                message_ids,
                ..
            } => {
                let started = Instant::now();
                self.verify_hey_account(&account_id, started, deadline_ms)?;
                self.run(prepared_hey(
                    action_arguments(action, &message_ids)?,
                    remaining_ms(started, deadline_ms)?,
                )?)
            }
            EffectRequest::HeyCompose {
                deadline_ms,
                account_id,
                mode,
                topic_id,
                to,
                cc,
                bcc,
                subject,
                body,
            } => {
                let started = Instant::now();
                self.verify_hey_account(&account_id, started, deadline_ms)?;
                let args = if mode == "reply" {
                    vec!["reply".into(), topic_id]
                } else {
                    let mut args = vec!["compose".into(), "--to".into(), to.join(", ")];
                    if !cc.is_empty() {
                        args.extend(["--cc".into(), cc.join(", ")]);
                    }
                    if !bcc.is_empty() {
                        args.extend(["--bcc".into(), bcc.join(", ")]);
                    }
                    if !subject.is_empty() {
                        args.extend(["--subject".into(), subject]);
                    }
                    args
                };
                self.run(prepared_hey_stdin(
                    args,
                    body,
                    remaining_ms(started, deadline_ms)?,
                )?)
            }
            EffectRequest::ImageFetch { deadline_ms, url } => {
                let command = self
                    .policy
                    .prepare_transport(
                        TransportOperation::image_fetch(url),
                        Duration::from_millis(deadline_ms),
                    )
                    .map_err(|_| EffectHostError::InvalidRequest)?;
                let output = self
                    .transport_runner
                    .run_bounded(command, MAX_IMAGE_STDOUT_BYTES, MAX_TRANSPORT_STDERR_BYTES)
                    .map_err(|_| EffectHostError::Failed)?;
                encode_image_response(output)
            }
            EffectRequest::Unsubscribe {
                deadline_ms,
                url,
                content_type,
                body,
            } => {
                let command = self
                    .policy
                    .prepare_transport(
                        TransportOperation::unsubscribe(url, content_type, body),
                        Duration::from_millis(deadline_ms),
                    )
                    .map_err(|_| EffectHostError::InvalidRequest)?;
                let output = self
                    .transport_runner
                    .run_bounded(command, 64, MAX_TRANSPORT_STDERR_BYTES)
                    .map_err(|_| EffectHostError::Failed)?;
                encode_unsubscribe_response(output)
            }
            other => Self::dispatch(other).and(Ok("{}".into())),
        }
    }
    fn run(&self, command: PreparedCommand) -> Result<String, EffectHostError> {
        let output = self
            .hey_runner
            .run_hey(command)
            .map_err(|_| EffectHostError::Failed)?;
        encode_hey_envelope(output)
    }

    fn verify_hey_account(
        &self,
        account_id: &str,
        started: Instant,
        deadline_ms: u64,
    ) -> Result<(), EffectHostError> {
        let command = prepared_hey(
            vec!["accounts".into(), "list".into(), "--json".into()],
            remaining_ms(started, deadline_ms)?,
        )?;
        let output = self
            .hey_runner
            .run_hey(command)
            .map_err(|_| EffectHostError::Failed)?;
        if output.status != Some(0) || output.stdout.len() > MAX_HEY_STDOUT_BYTES {
            return Err(EffectHostError::Failed);
        }
        let envelope: HeyEnvelope =
            serde_json::from_slice(&output.stdout).map_err(|_| EffectHostError::Failed)?;
        if !envelope.ok {
            return Err(EffectHostError::Failed);
        }
        let first = envelope
            .data
            .as_array()
            .and_then(|rows| {
                rows.iter()
                    .find(|row| row.get("id").and_then(Value::as_str) != Some("all"))
            })
            .and_then(|row| row.get("email"))
            .and_then(Value::as_str)
            .map(|email| format!("hey:{}", email.to_ascii_lowercase()));
        if first.as_deref() != Some(account_id) {
            return Err(EffectHostError::Failed);
        }
        Ok(())
    }

    fn run_thread(
        &self,
        topic: &str,
        started: Instant,
        deadline_ms: u64,
    ) -> Result<String, EffectHostError> {
        loop {
            let dropped = self
                .dropped_thread_flags
                .lock()
                .map_err(|_| EffectHostError::Failed)?
                .clone();
            let command = prepared_hey(
                thread_arguments(topic, &dropped),
                remaining_ms(started, deadline_ms)?,
            )?;
            let output = self
                .hey_runner
                .run_hey(command)
                .map_err(|_| EffectHostError::Failed)?;
            if let Some(flag) = unknown_thread_flag(&output) {
                let mut dropped = self
                    .dropped_thread_flags
                    .lock()
                    .map_err(|_| EffectHostError::Failed)?;
                if dropped.insert(flag) {
                    continue;
                }
            }
            return encode_thread_response(output);
        }
    }
}

struct NativeConfigure {
    setup: NativeProviderSetup,
    context: Arc<HostContextRegistry>,
    groupware_setup: NativeGroupwareSetup,
}
impl NativeConfigure {
    fn configure(&self, json: &str) -> Result<(), EffectHostError> {
        self.context
            .replace_json(json)
            .map_err(|_| EffectHostError::InvalidRequest)?;
        self.setup
            .configure(json)
            .map_err(|_| EffectHostError::InvalidRequest)?;
        self.groupware_setup
            .configure(json)
            .map_err(|_| EffectHostError::InvalidRequest)
    }
}

fn validate_request(request: &EffectRequest) -> Result<(), EffectHostError> {
    let deadline = deadline(request);
    if deadline.is_zero() || deadline.as_millis() as u64 > MAX_DEADLINE_MS {
        return Err(EffectHostError::InvalidRequest);
    }
    match request {
        EffectRequest::HeyList {
            account_id,
            identity,
            query,
            ..
        } => {
            validate_hey_identity(account_id, identity, true)?;
            let _ = list_arguments(query.clone())?;
        }
        EffectRequest::HeyThread {
            account_id,
            identity,
            message_id,
            ..
        } => {
            validate_hey_identity(account_id, identity, false)?;
            if identity.object_id != *message_id {
                return Err(EffectHostError::InvalidRequest);
            }
            let _ = message_parts(message_id)?;
        }
        EffectRequest::HeyAction {
            account_id,
            identity,
            message_ids,
            ..
        } => {
            validate_hey_identity(account_id, identity, false)?;
            if message_ids.is_empty() || message_ids.len() > 100 {
                return Err(EffectHostError::InvalidRequest);
            }
            if identity.object_id != message_ids[0] {
                return Err(EffectHostError::InvalidRequest);
            }
            for id in message_ids {
                let _ = message_parts(id)?;
            }
        }
        EffectRequest::HeyCompose {
            account_id,
            mode,
            topic_id,
            to,
            cc,
            bcc,
            subject,
            body,
            ..
        } => {
            if !account_id.strip_prefix("hey:").is_some_and(valid_hey_email) {
                return Err(EffectHostError::InvalidRequest);
            }
            if !matches!(mode.as_str(), "reply" | "forward")
                || body.len() > MAX_REQUEST_BYTES
                || body.contains('\0')
                || subject.len() > 16_384
                || subject.contains(['\r', '\n'])
            {
                return Err(EffectHostError::InvalidRequest);
            }
            if mode == "reply" {
                if !is_numeric_id(topic_id) || !to.is_empty() || !cc.is_empty() || !bcc.is_empty() {
                    return Err(EffectHostError::InvalidRequest);
                }
            } else if !topic_id.is_empty()
                || to.is_empty()
                || to.len() + cc.len() + bcc.len() > 100
                || to
                    .iter()
                    .chain(cc)
                    .chain(bcc)
                    .any(|value| !valid_hey_email(value))
            {
                return Err(EffectHostError::InvalidRequest);
            }
        }
        EffectRequest::ImageFetch { url, .. } => {
            if url.len() > MAX_REQUEST_BYTES || url.contains(['\r', '\n', '\0']) {
                return Err(EffectHostError::InvalidRequest);
            }
        }
        EffectRequest::Unsubscribe {
            url,
            content_type,
            body,
            ..
        } if url.len() > MAX_REQUEST_BYTES || content_type.len() > 256 || body.len() > 4096 => {
            return Err(EffectHostError::InvalidRequest);
        }
        _ => {}
    }
    Ok(())
}

fn validate_hey_identity(
    account_id: &str,
    identity: &HeyIdentity,
    list: bool,
) -> Result<(), EffectHostError> {
    let Some(address) = account_id.strip_prefix("hey:") else {
        return Err(EffectHostError::InvalidRequest);
    };
    let address_parts = address.split('@').collect::<Vec<_>>();
    if identity.account_id != account_id
        || address.len() > 320
        || address != address.to_ascii_lowercase()
        || address_parts.len() != 2
        || address_parts[0].is_empty()
        || address_parts[1].is_empty()
        || !address_parts[1].contains('.')
        || address.chars().any(char::is_whitespace)
        || address.chars().any(char::is_control)
        || identity.query.len() > MAX_HEY_ARGUMENT_BYTES
        || identity.query.chars().any(char::is_control)
        || identity.object_id.len() > 64
        || identity.revision > i64::MAX as u64
        || (list && !identity.object_id.is_empty())
        || (!list && identity.object_id.is_empty())
    {
        return Err(EffectHostError::InvalidRequest);
    }
    Ok(())
}

fn remaining_ms(started: Instant, deadline_ms: u64) -> Result<u64, EffectHostError> {
    let remaining = Duration::from_millis(deadline_ms)
        .checked_sub(started.elapsed())
        .filter(|duration| !duration.is_zero())
        .ok_or(EffectHostError::Failed)?;
    u64::try_from(remaining.as_millis().max(1)).map_err(|_| EffectHostError::Failed)
}

fn deadline(request: &EffectRequest) -> Duration {
    Duration::from_millis(match request {
        EffectRequest::HeyStatus { deadline_ms }
        | EffectRequest::HeyList { deadline_ms, .. }
        | EffectRequest::HeyThread { deadline_ms, .. }
        | EffectRequest::HeyAction { deadline_ms, .. }
        | EffectRequest::HeyCompose { deadline_ms, .. }
        | EffectRequest::ImapRequest { deadline_ms }
        | EffectRequest::GmailRequest { deadline_ms } => *deadline_ms,
        EffectRequest::ImageFetch { deadline_ms, .. }
        | EffectRequest::Unsubscribe { deadline_ms, .. } => *deadline_ms,
    })
}

fn encode_image_response(
    output: crate::platform::commands::ProcessOutput,
) -> Result<String, EffectHostError> {
    if output.status() != Some(0) {
        return Err(EffectHostError::Failed);
    }
    let data_uri = std::str::from_utf8(output.stdout())
        .map_err(|_| EffectHostError::Failed)?
        .trim_end();
    let permitted = [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/jpg;base64,",
        "data:image/gif;base64,",
        "data:image/webp;base64,",
        "data:image/bmp;base64,",
    ];
    if data_uri.contains(['\r', '\n'])
        || !permitted.iter().any(|prefix| data_uri.starts_with(prefix))
    {
        return Err(EffectHostError::Failed);
    }
    serde_json::to_string(&json!({"ok":true,"data":{"dataUri":data_uri}}))
        .map_err(|_| EffectHostError::Failed)
}

fn encode_unsubscribe_response(
    output: crate::platform::commands::ProcessOutput,
) -> Result<String, EffectHostError> {
    if output.status() != Some(0) {
        return Err(EffectHostError::Failed);
    }
    let answer = std::str::from_utf8(output.stdout())
        .map_err(|_| EffectHostError::Failed)?
        .trim();
    let fields = answer.split_whitespace().collect::<Vec<_>>();
    if fields.len() != 2 {
        return Err(EffectHostError::Failed);
    }
    let curl_status = fields[0]
        .parse::<u16>()
        .map_err(|_| EffectHostError::Failed)?;
    let http_status = fields[1]
        .parse::<u16>()
        .map_err(|_| EffectHostError::Failed)?;
    if curl_status > 255 || http_status > 999 {
        return Err(EffectHostError::Failed);
    }
    serde_json::to_string(&json!({"ok":true,"data":{"httpStatus":http_status,"unsubscribed":curl_status == 0 && (200..300).contains(&http_status)}})).map_err(|_| EffectHostError::Failed)
}
fn prepared_hey_stdin(
    arguments: Vec<String>,
    body: String,
    deadline_ms: u64,
) -> Result<PreparedCommand, EffectHostError> {
    PreparedCommand::new(
        PathBuf::from("hey"),
        arguments,
        Some(crate::platform::secrets::Secret::new(body)),
        Duration::from_millis(deadline_ms),
    )
    .map_err(|_| EffectHostError::InvalidRequest)
}
fn valid_hey_email(value: &str) -> bool {
    value.len() <= 320
        && !value.chars().any(char::is_control)
        && !value.contains(char::is_whitespace)
        && value
            .split_once('@')
            .is_some_and(|(l, d)| !l.is_empty() && d.contains('.'))
}
fn prepared_hey(
    arguments: Vec<String>,
    deadline_ms: u64,
) -> Result<PreparedCommand, EffectHostError> {
    PreparedCommand::new(
        PathBuf::from("hey"),
        arguments,
        None,
        Duration::from_millis(deadline_ms),
    )
    .map_err(|_| EffectHostError::InvalidRequest)
}
fn list_arguments(query: HeyQuery) -> Result<Vec<String>, EffectHostError> {
    let page = |page: Option<String>| {
        checked_text(page.as_deref().unwrap_or(""), true)
            .map(|value| if value.is_empty() { None } else { Some(value) })
    };
    match query {
        HeyQuery::Box {
            mailbox,
            unseen,
            page: cursor,
        } => {
            let mut args = vec!["box".into(), mailbox.as_str().into(), "--json".into()];
            if unseen {
                args.extend(["--limit".into(), UNSEEN_SCAN_LIMIT.into()]);
            }
            if let Some(page) = page(cursor)? {
                args.extend(["--page".into(), page]);
            }
            Ok(args)
        }
        HeyQuery::Trash { page: cursor } => {
            let mut args = vec![
                "search".into(),
                "--in".into(),
                "trash".into(),
                "--json".into(),
            ];
            if let Some(page) = page(cursor)? {
                args.extend(["--page".into(), page]);
            }
            Ok(args)
        }
        HeyQuery::Label {
            label,
            page: cursor,
        } => {
            let mut args = vec![
                "label".into(),
                checked_text(&label, false)?,
                "--json".into(),
            ];
            if let Some(page) = page(cursor)? {
                args.extend(["--page".into(), page]);
            }
            Ok(args)
        }
        HeyQuery::Search { text, page: cursor } => {
            let mut args = vec![
                "search".into(),
                checked_text(&text, false)?,
                "--json".into(),
            ];
            if let Some(page) = page(cursor)? {
                args.extend(["--page".into(), page]);
            }
            Ok(args)
        }
        HeyQuery::Drafts { page: cursor } => {
            let mut args = vec!["draft".into(), "list".into(), "--json".into()];
            if let Some(page) = page(cursor)? {
                args.extend(["--page".into(), page]);
            }
            Ok(args)
        }
    }
}
fn checked_text(value: &str, allow_empty: bool) -> Result<String, EffectHostError> {
    if value.len() > MAX_HEY_ARGUMENT_BYTES
        || (!allow_empty && value.is_empty())
        || value.starts_with('-')
        || value.chars().any(|character| character.is_control())
    {
        return Err(EffectHostError::InvalidRequest);
    }
    Ok(value.to_owned())
}
fn message_parts(id: &str) -> Result<(&str, &str), EffectHostError> {
    let Some((posting, topic)) = id.split_once(':') else {
        return Err(EffectHostError::InvalidRequest);
    };
    if id.matches(':').count() != 1 || !is_numeric_id(posting) || !is_numeric_id(topic) {
        return Err(EffectHostError::InvalidRequest);
    }
    Ok((posting, topic))
}
fn is_numeric_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit())
}
fn action_arguments(action: HeyAction, ids: &[String]) -> Result<Vec<String>, EffectHostError> {
    let mut postings = Vec::new();
    for id in ids {
        let (posting, _) = message_parts(id)?;
        if !postings.iter().any(|item: &String| item == posting) {
            postings.push(posting.to_owned());
        }
    }
    if postings.is_empty() {
        return Err(EffectHostError::InvalidRequest);
    }
    let mut args = match action {
        HeyAction::MarkRead => vec!["seen".into()],
        HeyAction::MarkUnread => vec!["unseen".into()],
        HeyAction::Trash => vec!["trash".into()],
        HeyAction::Spam => vec!["spam".into()],
        HeyAction::Untrash => vec!["move".into()],
    };
    args.extend(postings);
    if matches!(action, HeyAction::Untrash) {
        args.extend(["--to".into(), "imbox".into()]);
    }
    args.push("--json".into());
    Ok(args)
}

fn thread_arguments(topic: &str, dropped: &HashSet<ThreadFlag>) -> Vec<String> {
    let mut arguments = vec!["threads".into(), topic.into()];
    for flag in [ThreadFlag::AllowPartial, ThreadFlag::Html] {
        if !dropped.contains(&flag) {
            arguments.push(flag.argument().into());
        }
    }
    arguments
}

fn unknown_thread_flag(output: &HeyCommandOutput) -> Option<ThreadFlag> {
    let flag = if output.status != Some(0) {
        unknown_flag(&output.stdout).or_else(|| unknown_flag(&output.stderr))
    } else {
        unknown_envelope_flag(&output.stdout)
    };
    flag.and_then(|flag| ThreadFlag::parse(&flag))
}

fn unknown_envelope_flag(bytes: &[u8]) -> Option<String> {
    let envelope = serde_json::from_slice::<Value>(bytes).ok()?;
    if envelope.get("ok").and_then(Value::as_bool) != Some(false) {
        return None;
    }
    envelope
        .get("error")
        .and_then(Value::as_str)
        .and_then(unknown_flag_text)
}

fn unknown_flag(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?;
    let error = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| text.to_owned());
    unknown_flag_text(&error)
}

fn unknown_flag_text(error: &str) -> Option<String> {
    let marker = "unknown flag:";
    let start = error.find(marker)? + marker.len();
    let flag = error[start..].split_whitespace().next()?;
    if flag.starts_with("--")
        && flag
            .bytes()
            .all(|byte| byte == b'-' || byte.is_ascii_alphanumeric())
    {
        Some(flag.to_owned())
    } else {
        None
    }
}

#[derive(Deserialize)]
struct HeyEnvelope {
    ok: bool,
    #[serde(default)]
    data: Value,
}
fn encode_hey_envelope(output: HeyCommandOutput) -> Result<String, EffectHostError> {
    if output.status != Some(0) || output.stdout.len() > MAX_HEY_STDOUT_BYTES {
        return Err(EffectHostError::Failed);
    }
    let envelope: HeyEnvelope =
        serde_json::from_slice(&output.stdout).map_err(|_| EffectHostError::Failed)?;
    if !envelope.ok {
        return Err(EffectHostError::Failed);
    }
    serde_json::to_string(&json!({ "ok": true, "data": envelope.data }))
        .map_err(|_| EffectHostError::Failed)
}

fn encode_thread_response(output: HeyCommandOutput) -> Result<String, EffectHostError> {
    if output.status != Some(0) || output.stdout.len() > MAX_HEY_STDOUT_BYTES {
        return Err(EffectHostError::Failed);
    }
    let first = output
        .stdout
        .iter()
        .copied()
        .find(|byte| !byte.is_ascii_whitespace());
    if first != Some(b'{') {
        let html = String::from_utf8(output.stdout).map_err(|_| EffectHostError::Failed)?;
        return serde_json::to_string(&json!({
            "ok": true,
            "data": { "kind": "thread", "html": html, "text": "" },
        }))
        .map_err(|_| EffectHostError::Failed);
    }
    let envelope: HeyEnvelope =
        serde_json::from_slice(&output.stdout).map_err(|_| EffectHostError::Failed)?;
    if !envelope.ok {
        return Err(EffectHostError::Failed);
    }
    let text = envelope
        .data
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.get("body").and_then(Value::as_str))
                .map(str::trim)
                .filter(|body| !body.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n───\n\n")
        })
        .unwrap_or_default();
    serde_json::to_string(&json!({
        "ok": true,
        "data": { "kind": "thread", "html": "", "text": text },
    }))
    .map_err(|_| EffectHostError::Failed)
}

pub fn install_effect_host(app_root: &Path) -> Result<(), gpui_shell::HostError> {
    let (host, configure_host) = EffectHost::native(app_root, Arc::new(SystemHeyRunner));
    let configure_host = Arc::new(configure_host);
    let checkout_root = app_root.parent().unwrap_or(app_root);
    let imap_setup = Arc::new(crate::imap_setup::production(checkout_root.to_path_buf()));
    let gmail_setup = Arc::new(crate::gmail_setup::production(checkout_root));
    let hey_setup = Arc::new(
        crate::hey_setup::ProductionHeySetup::new(
            crate::hey_setup::standard_hey_candidates(),
            PathBuf::from("/usr/bin/xdg-terminal-exec"),
        )
        .map_err(|error| gpui_shell::HostError::from(error.to_owned()))?,
    );
    let attachment_root = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let attachment_host = Arc::new(
        crate::attachment_host::AttachmentHost::new(
            attachment_root,
            crate::attachment_host::XdgOpenLauncher,
        )
        .map_err(|error| gpui_shell::HostError::from(error.to_string()))?,
    );
    gpui_shell::export_module(
        HostModule::new("omamail-host-context")
            .declarations("export function configure(contextJson: string): Promise<string>;")
            .async_function("configure", move |arguments| {
                let json = arguments.string(0)?.to_owned();
                let configure_host = Arc::clone(&configure_host);
                Ok(async move {
                    configure_host
                        .configure(&json)
                        .map(|_| HostValue::from("{}"))
                        .map_err(|error| gpui_shell::HostError::from(error.to_string()))
                })
            }),
    )?;
    gpui_shell::export_module(
        HostModule::new("omamail-imap-setup")
            .declarations("export function dispatch(request: string): Promise<string>;")
            .async_function("dispatch", move |arguments| {
                let request = arguments.string(0)?.to_owned();
                let imap_setup = Arc::clone(&imap_setup);
                Ok(async move { Ok(HostValue::from(imap_setup.dispatch(&request))) })
            }),
    )?;
    gpui_shell::export_module(
        HostModule::new("omamail-gmail-setup")
            .declarations("export function dispatch(request: string): Promise<string>;")
            .async_function("dispatch", move |arguments| {
                let request = arguments.string(0)?.to_owned();
                let gmail_setup = Arc::clone(&gmail_setup);
                Ok(async move { Ok(HostValue::from(gmail_setup.dispatch(&request))) })
            }),
    )?;
    gpui_shell::export_module(
        HostModule::new("omamail-hey-setup")
            .declarations("export function dispatch(request: string): Promise<string>;")
            .async_function("dispatch", move |arguments| {
                let request = arguments.string(0)?.to_owned();
                let hey_setup = Arc::clone(&hey_setup);
                Ok(async move { Ok(HostValue::from(hey_setup.dispatch(&request))) })
            }),
    )?;
    gpui_shell::export_module(
        HostModule::new("omamail-attachment")
            .declarations("export function open(request: string): Promise<string>;")
            .async_function("open", move |arguments| {
                let request = arguments.string(0)?.to_owned();
                let attachment_host = Arc::clone(&attachment_host);
                Ok(async move {
                    attachment_host
                        .open_json(&request)
                        .map(|_| HostValue::from("{}"))
                        .map_err(|error| gpui_shell::HostError::from(error.to_string()))
                })
            }),
    )?;
    gpui_shell::export_module(
        HostModule::new("omamail-effects")
            .declarations("export function dispatch(request: string): Promise<string>;")
            .async_function("dispatch", move |arguments| {
                let request = arguments.string(0)?.to_owned();
                let host = host.clone();
                Ok(async move {
                    host.execute_json(&request)
                        .map(HostValue::from)
                        .map_err(|error| gpui_shell::HostError::from(error.to_string()))
                })
            }),
    )
}
