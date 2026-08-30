//! Concrete, dependency-injectable runtime behind the closed provider dispatcher.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;

use crate::{
    host_context::{GmailContext, HostContext, HostContextRegistry, ImapContext},
    imap_host::{self, Action, ImapAccount, MailOperation, MailTransportExecutor},
    platform::{
        commands::SystemProcessRunner,
        secrets::{SecretKey, SecretStore, SystemSecretStore},
    },
    provider_effects::{
        self, GmailCall, ImapCall, ImapMoveStrategy, ImapTransportPayload, ProviderFailure,
    },
    providers::{
        gmail::{self, GmailExecutorConfig, GmailOperation, RequestIdentity},
        google_transport::{
            GoogleAccessTokenProvider, RestrictedGoogleTransport, SystemGoogleResolver,
        },
    },
};

pub trait NativeProviderBackend: Send + Sync {
    fn gmail(
        &self,
        context: &GmailContext,
        call: GmailCall,
        deadline: Duration,
    ) -> Result<Value, ProviderFailure>;
    fn imap(
        &self,
        context: &ImapContext,
        call: ImapCall,
        deadline: Duration,
    ) -> Result<ImapTransportPayload, ProviderFailure>;
    fn discover_imap_runtime(
        &self,
        _context: &ImapContext,
        _deadline: Duration,
    ) -> Option<provider_effects::ImapRuntime> {
        None
    }
}

pub struct NativeProviderRuntime<B = ProductionProviderBackend> {
    contexts: Arc<HostContextRegistry>,
    backend: B,
    imap_runtime: Arc<Mutex<HashMap<String, (Instant, provider_effects::ImapRuntime)>>>,
}

impl NativeProviderRuntime<ProductionProviderBackend> {
    pub fn production(
        app_root: PathBuf,
        curl: PathBuf,
        credentials_file: PathBuf,
    ) -> (Self, NativeProviderSetup) {
        Self::with_backend(ProductionProviderBackend {
            secrets: SystemSecretStore::default(),
            runner: SystemProcessRunner,
            resolver: SystemGoogleResolver,
            app_root,
            curl,
            credentials_file,
        })
    }
}

impl<B> NativeProviderRuntime<B> {
    pub fn with_backend(backend: B) -> (Self, NativeProviderSetup) {
        let contexts = Arc::new(HostContextRegistry::new());
        let imap_runtime = Arc::new(Mutex::new(HashMap::new()));
        let setup = NativeProviderSetup {
            contexts: Arc::clone(&contexts),
            imap_runtime: Arc::clone(&imap_runtime),
        };
        (
            Self {
                contexts,
                backend,
                imap_runtime,
            },
            setup,
        )
    }
    pub fn backend(&self) -> &B {
        &self.backend
    }
}

pub struct NativeProviderSetup {
    contexts: Arc<HostContextRegistry>,
    imap_runtime: Arc<Mutex<HashMap<String, (Instant, provider_effects::ImapRuntime)>>>,
}
impl NativeProviderSetup {
    pub fn configure(&self, trusted_json: &str) -> Result<(), &'static str> {
        self.contexts
            .replace_json(trusted_json)
            .map_err(|_| "invalid native provider configuration")?;
        self.imap_runtime
            .lock()
            .map_err(|_| "invalid native provider configuration")?
            .clear();
        Ok(())
    }
    pub fn confirmed_legacy_imap_migration_key(
        &self,
        account: &str,
        host: &str,
        port: u16,
        username: &str,
        previous_endpoint_fingerprint: &str,
    ) -> Result<SecretKey, &'static str> {
        SecretKey::imap_endpoint_migration(
            "omamail",
            account,
            host,
            port,
            username,
            previous_endpoint_fingerprint,
        )
        .map_err(|_| "invalid legacy IMAP migration")
    }
}

impl<B: NativeProviderBackend> provider_effects::ImapRuntimeResolver for NativeProviderRuntime<B> {
    fn runtime_for(
        &self,
        account_id: &str,
        deadline: Duration,
    ) -> Option<provider_effects::ImapRuntime> {
        if let Some((created, value)) = self.imap_runtime.lock().ok()?.get(account_id).cloned()
            && created.elapsed() < Duration::from_secs(300)
        {
            return Some(value);
        }
        let HostContext::Imap(context) = self.contexts.resolve_account(account_id).ok()? else {
            return None;
        };
        let value = self.backend.discover_imap_runtime(&context, deadline)?;
        self.imap_runtime
            .lock()
            .ok()?
            .insert(account_id.to_owned(), (Instant::now(), value.clone()));
        Some(value)
    }
}

impl<B: NativeProviderBackend> provider_effects::GmailExecutor for NativeProviderRuntime<B> {
    fn execute(&self, call: GmailCall, deadline: Duration) -> Result<Value, ProviderFailure> {
        let account = call_identity(&call).account_id.clone();
        let HostContext::Gmail(context) = self
            .contexts
            .resolve_account(&account)
            .map_err(|_| ProviderFailure::Unavailable)?
        else {
            return Err(ProviderFailure::Unavailable);
        };
        let GmailCall::List {
            identity,
            max_results,
            query,
            ..
        } = &call
        else {
            return self.backend.gmail(&context, call, deadline);
        };
        let started = Instant::now();
        let listed = self.backend.gmail(&context, call.clone(), deadline)?;
        let ids = listed
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if ids.len() > usize::from(*max_results) {
            return Err(ProviderFailure::Failed);
        }
        let next = listed.get("nextPageToken").cloned();
        if next.as_ref().is_some_and(|value| !value.is_string()) {
            return Err(ProviderFailure::Failed);
        }
        let mut messages = Vec::with_capacity(ids.len());
        for item in ids {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| {
                    !id.is_empty() && id.len() <= 2048 && !id.chars().any(char::is_control)
                })
                .ok_or(ProviderFailure::Failed)?;
            if (query == "in:drafts") != id.starts_with("draft:") {
                return Err(ProviderFailure::Failed);
            }
            let remaining = deadline
                .checked_sub(started.elapsed())
                .filter(|value| !value.is_zero())
                .ok_or(ProviderFailure::TimedOut)?;
            let detail = self.backend.gmail(
                &context,
                GmailCall::Detail {
                    identity: provider_effects::Identity {
                        account_id: identity.account_id.clone(),
                        object_id: id.to_owned(),
                        revision: identity.revision,
                    },
                    message_id: id.to_owned(),
                    full: false,
                },
                remaining,
            )?;
            if !valid_gmail_detail(&detail, id) {
                return Err(ProviderFailure::Failed);
            }
            messages.push(detail);
            if serde_json::to_vec(&messages)
                .map_err(|_| ProviderFailure::Failed)?
                .len()
                > 1_048_576
            {
                return Err(ProviderFailure::Failed);
            }
        }
        let mut result = serde_json::json!({"messages":messages});
        if let Some(token) = next {
            result["nextPageToken"] = token;
        }
        if serde_json::to_vec(&result)
            .map_err(|_| ProviderFailure::Failed)?
            .len()
            > 1_048_576
        {
            return Err(ProviderFailure::Failed);
        }
        Ok(result)
    }
}
fn valid_gmail_detail(detail: &Value, expected_id: &str) -> bool {
    let Some(object) = detail.as_object() else {
        return false;
    };
    let Some(headers) = object
        .get("payload")
        .and_then(Value::as_object)
        .and_then(|payload| payload.get("headers"))
        .and_then(Value::as_array)
    else {
        return false;
    };
    let reserved_is_typed_draft = expected_id.strip_prefix("draft:").is_some_and(|draft_id| {
        !draft_id.is_empty() && object.get("draftId").and_then(Value::as_str) == Some(draft_id)
    });
    object.get("id").and_then(Value::as_str) == Some(expected_id)
        && (!expected_id.starts_with("draft:") || reserved_is_typed_draft)
        && headers.len() <= 512
        && headers.iter().all(|header| {
            header.as_object().is_some_and(|value| {
                value
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|text| {
                        !text.is_empty() && text.len() <= 256 && !text.chars().any(char::is_control)
                    })
                    && value
                        .get("value")
                        .and_then(Value::as_str)
                        .is_some_and(|text| {
                            text.len() <= 65_536 && !text.chars().any(|c| c == '\0')
                        })
            })
        })
        && object.get("labelIds").is_none_or(|labels| {
            labels.as_array().is_some_and(|labels| {
                labels.len() <= 256
                    && labels.iter().all(|label| {
                        label.as_str().is_some_and(|text| {
                            !text.is_empty()
                                && text.len() <= 1024
                                && !text.chars().any(char::is_control)
                        })
                    })
            })
        })
        && object.get("threadId").is_none_or(|value| {
            value.as_str().is_some_and(|text| {
                !text.is_empty() && text.len() <= 2048 && !text.chars().any(char::is_control)
            })
        })
        && object.get("snippet").is_none_or(|value| {
            value
                .as_str()
                .is_some_and(|text| text.len() <= 65_536 && !text.contains('\0'))
        })
}
impl<B: NativeProviderBackend> provider_effects::ImapExecutor for NativeProviderRuntime<B> {
    fn execute(
        &self,
        call: ImapCall,
        deadline: Duration,
    ) -> Result<ImapTransportPayload, ProviderFailure> {
        if matches!(&call, ImapCall::List { criteria, page_token, .. } if (!criteria.is_empty() && criteria != "ALL") || page_token.is_some())
        {
            return Err(ProviderFailure::Unavailable);
        }
        let account = imap_identity(&call).account_id.clone();
        let HostContext::Imap(context) = self
            .contexts
            .resolve_account(&account)
            .map_err(|_| ProviderFailure::Unavailable)?
        else {
            return Err(ProviderFailure::Unavailable);
        };
        self.backend.imap(&context, call, deadline)
    }
}

pub struct ProductionProviderBackend {
    secrets: SystemSecretStore,
    runner: SystemProcessRunner,
    resolver: SystemGoogleResolver,
    app_root: PathBuf,
    curl: PathBuf,
    credentials_file: PathBuf,
}

impl NativeProviderBackend for ProductionProviderBackend {
    fn gmail(
        &self,
        context: &GmailContext,
        call: GmailCall,
        deadline: Duration,
    ) -> Result<Value, ProviderFailure> {
        let identity = call_identity(&call).clone();
        let draft_read = match &call {
            GmailCall::List {
                query,
                max_results,
                page_token,
                ..
            } if query == "in:drafts" => Some(GmailOperation::DraftList {
                max_results: *max_results,
                page_token: page_token.clone(),
            }),
            GmailCall::Detail {
                message_id, full, ..
            } if message_id.starts_with("draft:") => {
                let draft_id = message_id
                    .strip_prefix("draft:")
                    .filter(|id| !id.is_empty())
                    .ok_or(ProviderFailure::Failed)?;
                Some(GmailOperation::DraftGet {
                    draft_id: draft_id.to_owned(),
                    full: *full,
                })
            }
            _ => None,
        };
        let operation = draft_read.unwrap_or(gmail_operation(call)?);
        let is_draft_read = matches!(
            operation,
            GmailOperation::DraftList { .. } | GmailOperation::DraftGet { .. }
        );
        let transport =
            RestrictedGoogleTransport::new(self.curl.clone(), &self.runner, &self.resolver);
        let tokens = GoogleAccessTokenProvider::new(
            self.credentials_file.clone(),
            context.client_id(),
            self.curl.clone(),
            &self.runner,
            &self.resolver,
        );
        let executor = gmail::GmailExecutor::new(
            &self.secrets,
            &transport,
            &tokens,
            GmailExecutorConfig::new(context.client_id(), context.account_id(), context.grant()),
        )
        .map_err(gmail_error)?;
        let payload = executor
            .execute(
                RequestIdentity {
                    account_id: identity.account_id,
                    object_id: identity.object_id,
                    revision: identity.revision,
                },
                operation,
                deadline,
            )
            .map(|reply| reply.payload)
            .map_err(gmail_error)?;
        if !is_draft_read {
            return Ok(payload);
        }
        normalize_draft_payload(payload)
    }

    fn imap(
        &self,
        context: &ImapContext,
        call: ImapCall,
        deadline: Duration,
    ) -> Result<ImapTransportPayload, ProviderFailure> {
        let endpoint = url::Url::parse(context.imap_url()).map_err(|_| ProviderFailure::Failed)?;
        let key = SecretKey::imap_endpoint(
            "omamail",
            context.account_id(),
            endpoint.host_str().ok_or(ProviderFailure::Failed)?,
            endpoint
                .port_or_known_default()
                .ok_or(ProviderFailure::Failed)?,
            context.username(),
        )
        .map_err(|_| ProviderFailure::Failed)?;
        let password = self
            .secrets
            .get(&key)
            .map_err(|_| ProviderFailure::Unavailable)?
            .ok_or(ProviderFailure::Unavailable)?;
        let account = ImapAccount::new(
            context.account_id(),
            context.email(),
            context.imap_url(),
            context.smtp_url(),
            context.username(),
            password,
        )
        .map_err(|_| ProviderFailure::Failed)?;
        let mut bytes = Vec::new();
        let action_may_have_committed = matches!(call, ImapCall::Action { .. });
        for operation in imap_operations(&call)? {
            let planned =
                imap_host::plan(&account, operation).map_err(|_| ProviderFailure::Failed)?;
            let reply = imap_host::execute_with_runner(
                planned,
                &MailTransportExecutor::new(self.app_root.clone()),
                deadline,
                &self.runner,
            )
            .map_err(|error| {
                if action_may_have_committed {
                    ProviderFailure::Uncertain
                } else {
                    imap_error(error)
                }
            })?;
            bytes.extend_from_slice(reply.stdout());
        }
        Ok(ImapTransportPayload {
            status: 0,
            response_base64: STANDARD.encode(bytes),
        })
    }

    fn discover_imap_runtime(
        &self,
        context: &ImapContext,
        deadline: Duration,
    ) -> Option<provider_effects::ImapRuntime> {
        let endpoint = url::Url::parse(context.imap_url()).ok()?;
        let key = SecretKey::imap_endpoint(
            "omamail",
            context.account_id(),
            endpoint.host_str()?,
            endpoint.port_or_known_default()?,
            context.username(),
        )
        .ok()?;
        let password = self.secrets.get(&key).ok()??;
        let account = ImapAccount::new(
            context.account_id(),
            context.email(),
            context.imap_url(),
            context.smtp_url(),
            context.username(),
            password,
        )
        .ok()?;
        let planned = imap_host::plan(&account, MailOperation::Discover).ok()?;
        let reply = imap_host::execute_with_runner(
            planned,
            &MailTransportExecutor::new(self.app_root.clone()),
            deadline,
            &self.runner,
        )
        .ok()?;
        parse_discovery(reply.stdout())
    }
}

fn parse_discovery(bytes: &[u8]) -> Option<provider_effects::ImapRuntime> {
    let text = std::str::from_utf8(bytes).ok()?;
    if text.contains('\0')
        || text.as_bytes().iter().enumerate().any(|(index, byte)| {
            (*byte == b'\r' && text.as_bytes().get(index + 1) != Some(&b'\n'))
                || (*byte == b'\n'
                    && index.checked_sub(1).and_then(|i| text.as_bytes().get(i)) != Some(&b'\r'))
        })
    {
        return None;
    }
    let mut archive_folder = None;
    let mut trash_folder = None;
    let mut special_use = std::collections::BTreeMap::new();
    let mut supports_move = false;
    let mut saw_capability = false;
    let mut saw_list = false;
    let mut completed = false;
    for line in text.trim_end_matches("\r\n").split("\r\n") {
        if line.is_empty() || completed {
            return None;
        }
        if let Some(capabilities) = line.strip_prefix("* CAPABILITY ") {
            if saw_capability || capabilities.is_empty() {
                return None;
            }
            saw_capability = true;
            supports_move = capabilities
                .split_ascii_whitespace()
                .any(|value| value.eq_ignore_ascii_case("MOVE"));
            continue;
        }
        if let Some(list) = line.strip_prefix("* LIST (") {
            saw_list = true;
            let (flags, remainder) = list.split_once(") ")?;
            let remainder = remainder.strip_prefix("NIL ").or_else(|| {
                quoted_prefix(remainder).and_then(|(_, rest)| rest.strip_prefix(' '))
            })?;
            let (mailbox, trailing) = quoted_prefix(remainder)?;
            if !trailing.is_empty() || mailbox.is_empty() {
                return None;
            }
            for flag in flags.split_ascii_whitespace() {
                let normalized = if flag.eq_ignore_ascii_case("\\All") {
                    Some("\\all")
                } else if flag.eq_ignore_ascii_case("\\Archive") {
                    Some("\\archive")
                } else if flag.eq_ignore_ascii_case("\\Drafts") {
                    Some("\\drafts")
                } else if flag.eq_ignore_ascii_case("\\Junk") {
                    Some("\\junk")
                } else if flag.eq_ignore_ascii_case("\\Sent") {
                    Some("\\sent")
                } else if flag.eq_ignore_ascii_case("\\Trash") {
                    Some("\\trash")
                } else {
                    None
                };
                if let Some(normalized) = normalized
                    && special_use
                        .insert(normalized.to_owned(), mailbox.clone())
                        .is_some()
                {
                    return None;
                }
                if flag.eq_ignore_ascii_case("\\Archive") {
                    if archive_folder.replace(mailbox.clone()).is_some() {
                        return None;
                    }
                } else if flag.eq_ignore_ascii_case("\\Trash")
                    && trash_folder.replace(mailbox.clone()).is_some()
                {
                    return None;
                }
            }
            continue;
        }
        let mut fields = line.split_ascii_whitespace();
        let tag = fields.next()?;
        let status = fields.next()?;
        if tag.starts_with('*')
            || tag.starts_with('+')
            || !tag.bytes().all(|byte| byte.is_ascii_alphanumeric())
            || status != "OK"
        {
            return None;
        }
        completed = true;
    }
    if !saw_capability || !saw_list || !completed {
        return None;
    }
    Some(provider_effects::ImapRuntime {
        special_use,
        archive_folder,
        trash_folder,
        supports_move,
    })
}

fn quoted_prefix(value: &str) -> Option<(String, &str)> {
    let mut characters = value.char_indices();
    if characters.next()?.1 != '"' {
        return None;
    }
    let mut output = String::new();
    let mut escaped = false;
    for (index, character) in characters {
        if escaped {
            output.push(character);
            escaped = false;
            continue;
        }
        match character {
            '\\' => escaped = true,
            '"' => return Some((output, &value[index + 1..])),
            value if value.is_control() => return None,
            value => output.push(value),
        }
    }
    None
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod discovery_tests {
    use super::parse_discovery;

    #[test]
    fn accepts_only_completed_capability_and_special_use_list() {
        let parsed = parse_discovery(b"* CAPABILITY IMAP4rev1 MOVE\r\n* LIST (\\HasNoChildren \\Archive) \"/\" \"All Mail\"\r\n* LIST (\\Sent) \"/\" \"Sent Items\"\r\n* LIST (\\Trash) \"/\" \"Deleted\\\" Items\"\r\nA001 OK done\r\n").unwrap();
        assert!(parsed.supports_move);
        assert_eq!(parsed.archive_folder.as_deref(), Some("All Mail"));
        assert_eq!(parsed.trash_folder.as_deref(), Some("Deleted\" Items"));
        assert_eq!(
            parsed.special_use.get("\\sent").map(String::as_str),
            Some("Sent Items")
        );
    }

    #[test]
    fn rejects_hostile_or_incomplete_discovery_responses() {
        for response in [
            "* OK unsolicited\r\n* CAPABILITY MOVE\r\n* LIST (\\Archive) \"/\" \"A\"\r\nA1 OK done\r\n",
            "* CAPABILITY MOVE\r\n* STATUS INBOX (MESSAGES 1)\r\nA1 OK done\r\n",
            "* CAPABILITY MOVE\r\n* LIST (\\Archive) \"/\" \"A\"\r\nA1 NO denied\r\n",
            "* CAPABILITY MOVE\r\n* LIST (\\Archive) \"/\" \"broken\r\nA1 OK done\r\n",
            "* CAPABILITY MOVE\r\n* LIST (\\Archive) \"/\" \"A\"\r\n",
            "* CAPABILITY MOVE\r\n* LIST (\\Archive) \"/\" \"A\"\r\nA1 OK done\r\n* LIST (\\Trash) \"/\" \"T\"\r\n",
        ] {
            assert!(
                parse_discovery(response.as_bytes()).is_none(),
                "accepted {response:?}"
            );
        }
        let near_miss = parse_discovery(b"* CAPABILITY IMAP4rev1\r\n* LIST (\\NotArchive \\TrashCan) \"/\" \"A\"\r\nA1 OK done\r\n").unwrap();
        assert!(near_miss.archive_folder.is_none() && near_miss.trash_folder.is_none());
    }
}

fn call_identity(call: &GmailCall) -> &provider_effects::Identity {
    match call {
        GmailCall::List { identity, .. }
        | GmailCall::Detail { identity, .. }
        | GmailCall::Attachment { identity, .. }
        | GmailCall::Action { identity, .. } => identity,
    }
}
fn normalize_draft_payload(mut payload: Value) -> Result<Value, ProviderFailure> {
    if let Some(drafts) = payload.get_mut("drafts").and_then(Value::as_array_mut) {
        let mut messages = Vec::with_capacity(drafts.len());
        for draft in drafts.iter() {
            let id = draft
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 2048)
                .filter(|id| !id.contains(':') && !id.chars().any(char::is_control))
                .ok_or(ProviderFailure::Failed)?;
            messages.push(serde_json::json!({"id":format!("draft:{id}")}));
        }
        let mut result = serde_json::json!({"messages":messages});
        if let Some(token) = payload.get("nextPageToken") {
            result["nextPageToken"] = token.clone();
        }
        return Ok(result);
    }
    let draft_id = payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 2048)
        .filter(|id| !id.contains(':') && !id.chars().any(char::is_control))
        .ok_or(ProviderFailure::Failed)?
        .to_owned();
    let mut message = payload
        .get_mut("message")
        .and_then(Value::as_object_mut)
        .ok_or(ProviderFailure::Failed)?
        .clone();
    message.insert("id".into(), Value::String(format!("draft:{draft_id}")));
    message.insert("draftId".into(), Value::String(draft_id));
    Ok(Value::Object(message))
}

#[cfg(test)]
mod draft_tests {
    use super::*;
    #[test]
    fn draft_list_and_get_are_normalized_without_guessing_message_ids() {
        let list = normalize_draft_payload(serde_json::json!({"drafts":[{"id":"draft-1","message":{"id":"message-1"}}],"nextPageToken":"next"})).unwrap();
        assert_eq!(list["messages"][0]["id"], "draft:draft-1");
        assert_eq!(list["nextPageToken"], "next");
        let detail = normalize_draft_payload(serde_json::json!({"id":"draft-1","message":{"id":"message-1","threadId":"thread-1","payload":{"headers":[]}}})).unwrap();
        assert_eq!(detail["id"], "draft:draft-1");
        assert_eq!(detail["draftId"], "draft-1");
        assert_eq!(detail["threadId"], "thread-1");
        assert_eq!(
            normalize_draft_payload(serde_json::json!({"drafts":[{"id":"draft:collision"}]})),
            Err(ProviderFailure::Failed),
        );
        assert!(!valid_gmail_detail(
            &serde_json::json!({"id":"draft:collision","payload":{"headers":[]}}),
            "draft:collision",
        ));
    }
}
fn imap_identity(call: &ImapCall) -> &provider_effects::Identity {
    match call {
        ImapCall::List { identity, .. }
        | ImapCall::Detail { identity, .. }
        | ImapCall::Action { identity, .. } => identity,
    }
}
fn gmail_operation(call: GmailCall) -> Result<GmailOperation, ProviderFailure> {
    Ok(match call {
        GmailCall::List {
            query,
            max_results,
            page_token,
            ..
        } => GmailOperation::List {
            query,
            max_results,
            page_token,
        },
        GmailCall::Detail {
            message_id, full, ..
        } => GmailOperation::Detail { message_id, full },
        GmailCall::Attachment {
            message_id,
            part_id,
            ..
        } => GmailOperation::Attachment {
            message_id,
            part_id,
        },
        GmailCall::Action {
            action,
            message_ids,
            ..
        } => GmailOperation::Action {
            action: match action {
                provider_effects::GmailAction::MarkRead => gmail::GmailAction::MarkRead,
                provider_effects::GmailAction::MarkUnread => gmail::GmailAction::MarkUnread,
                provider_effects::GmailAction::Star => gmail::GmailAction::Star,
                provider_effects::GmailAction::Unstar => gmail::GmailAction::Unstar,
                provider_effects::GmailAction::Archive => gmail::GmailAction::Archive,
                provider_effects::GmailAction::Unarchive => gmail::GmailAction::Unarchive,
                provider_effects::GmailAction::Spam => gmail::GmailAction::Spam,
                provider_effects::GmailAction::Trash => gmail::GmailAction::Trash,
                provider_effects::GmailAction::Untrash => gmail::GmailAction::Untrash,
            },
            message_ids,
        },
    })
}
fn imap_operations<'a>(call: &'a ImapCall) -> Result<Vec<MailOperation<'a>>, ProviderFailure> {
    match call {
        ImapCall::List {
            folder,
            criteria,
            page_token,
            ..
        } if (criteria.is_empty() || criteria == "ALL") && page_token.is_none() => {
            Ok(vec![MailOperation::List { folder }])
        }
        ImapCall::List { .. } => Err(ProviderFailure::Unavailable),
        ImapCall::Detail { message_id, .. } => Ok(vec![MailOperation::Detail { message_id }]),
        ImapCall::Action {
            action,
            message_ids,
            destination,
            move_strategy,
            ..
        } if !message_ids.is_empty() => {
            let action = match action.as_str() {
                "markRead" => Action::MarkSeen,
                "markUnread" => Action::MarkUnseen,
                "star" => Action::AddFlag("\\Flagged"),
                "unstar" => Action::RemoveFlag("\\Flagged"),
                "archive" | "unarchive" | "trash" | "untrash" => match move_strategy {
                    Some(ImapMoveStrategy::Move) => Action::Move {
                        destination: destination.as_deref().ok_or(ProviderFailure::Unavailable)?,
                    },
                    Some(ImapMoveStrategy::CopyStoreUidExpunge) => Action::CopyStoreUidExpunge {
                        destination: destination.as_deref().ok_or(ProviderFailure::Unavailable)?,
                    },
                    None => return Err(ProviderFailure::Unavailable),
                },
                _ => return Err(ProviderFailure::Unavailable),
            };
            Ok(vec![MailOperation::BatchAction {
                message_ids: message_ids.iter().map(String::as_str).collect(),
                action,
            }])
        }
        ImapCall::Action { .. } => Err(ProviderFailure::Unavailable),
    }
}
/// The class a failed Gmail call is reported as, and the host's own note of it.
///
/// `ProviderFailure` is three words wide, so a credential the keyring would not
/// give up, a token Google would not accept and a mailbox that simply is not
/// there all reach the window as "Unavailable". That is the right thing to show
/// somebody — none of the distinctions are theirs to act on — but it left no way
/// at all to tell them apart from outside the process, which is how "Gmail will
/// not load the list" became a question nobody could answer.
///
/// The line names the class and nothing else. `GmailError` is a fieldless enum:
/// there is no address, request, reply or token in it to leak.
fn gmail_error(error: gmail::GmailError) -> ProviderFailure {
    eprintln!("Gmail: a call returned {error:?}");
    match error {
        gmail::GmailError::DeadlineExceeded => ProviderFailure::TimedOut,
        // The keyring answered and had nothing under any name this credential
        // has ever been filed under. That is a mailbox to sign in to, not a
        // service to try again in a minute.
        gmail::GmailError::AuthRequired => ProviderFailure::SignedOut,
        gmail::GmailError::PlatformUnavailable | gmail::GmailError::SecretUnavailable => {
            ProviderFailure::Unavailable
        }
        _ => ProviderFailure::Failed,
    }
}
fn imap_error(error: imap_host::RunnerError) -> ProviderFailure {
    match error {
        imap_host::RunnerError::TimedOut => ProviderFailure::TimedOut,
        imap_host::RunnerError::PlatformUnavailable => ProviderFailure::Unavailable,
        _ => ProviderFailure::Failed,
    }
}
