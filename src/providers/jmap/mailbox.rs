//! High-level mailbox operations own credentials, session state and protocol.
use super::query::string;
use super::*;
use std::sync::Arc;
use tokio::sync::Mutex as AsyncMutex;
pub(super) const CORE: &str = "urn:ietf:params:jmap:core";
pub(super) const MAIL: &str = "urn:ietf:params:jmap:mail";
pub(super) const SUBMISSION: &str = "urn:ietf:params:jmap:submission";
pub(super) const BOX_PROPERTIES: &[&str] = &[
    "id",
    "name",
    "parentId",
    "role",
    "sortOrder",
    "totalEmails",
    "unreadEmails",
    "unreadThreads",
];
pub(super) const MEMBER_PROPERTIES: &[&str] = &["id", "threadId", "mailboxIds", "keywords"];
#[derive(Default)]
pub(super) struct Context {
    pub(super) rejected: std::sync::atomic::AtomicBool,
    pub(super) retired: Arc<std::sync::atomic::AtomicBool>,
    snapshot: AsyncMutex<Option<Snapshot>>,
    pub(super) summaries: Mutex<Cache>,
    pub(super) blocks: Mutex<Cache>,
    pub(super) memberships: Mutex<Cache>,
    pub(super) known: Mutex<Map<String, Value>>,
}
// Each cache has a retained-memory allowance, independent of entry count.
// A conservative JSON-size multiplier covers Value/String allocation overhead.
const CACHE_BYTES: usize = 8 * 1024 * 1024;
#[derive(Default)]
pub(super) struct Cache {
    entries: HashMap<String, (Value, usize)>,
    bytes: usize,
}
impl Cache {
    pub(super) fn get(&self, id: &str) -> Option<&Value> {
        self.entries.get(id).map(|v| &v.0)
    }
    pub(super) fn len(&self) -> usize {
        self.entries.len()
    }
    pub(super) fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }
    pub(super) fn insert(&mut self, id: String, value: Value) {
        let size = serde_json::to_vec(&value)
            .map(|v| v.len())
            .unwrap_or(CACHE_BYTES)
            .saturating_mul(4)
            .saturating_add(id.len() * 4 + 128);
        if size > CACHE_BYTES {
            return;
        }
        if let Some((_, old)) = self.entries.remove(&id) {
            self.bytes = self.bytes.saturating_sub(old);
        }
        if self.bytes.saturating_add(size) > CACHE_BYTES || self.entries.len() >= 4096 {
            self.clear();
        }
        self.bytes += size;
        self.entries.insert(id, (value, size));
    }
}
#[derive(Clone)]
pub(super) struct Snapshot {
    pub(super) document: Value,
    pub(super) boxes: Vec<Value>,
    pub(super) credential: Value,
    pub(super) address: String,
    pub(super) account: String,
    pub(super) roles: Value,
    pub(super) slots: Arc<Semaphore>,
    pub(super) uploads: Arc<Semaphore>,
}
use serde_json::Map;
impl Snapshot {
    pub(super) fn limit(&self, name: &str, fallback: usize) -> usize {
        self.document["capabilities"][CORE][name]
            .as_u64()
            .filter(|n| *n > 0)
            .map(|n| n.min(4096) as usize)
            .unwrap_or(fallback)
    }
}
impl Session {
    pub(super) fn context(&self, id: &str) -> Result<Arc<Context>, &'static str> {
        if !id.starts_with("jmap:") || id.len() > 512 {
            return Err("invalid_params");
        }
        let mut contexts = self.contexts.lock().map_err(|_| "session_failed")?;
        if contexts.len() >= 64 && !contexts.contains_key(id) {
            return Err("jmap_account_limit");
        }
        Ok(contexts.entry(id.to_owned()).or_default().clone())
    }
    pub(super) async fn install_verified(
        &self,
        id: &str,
        document: Value,
        boxes: Vec<Value>,
        credential: Value,
        address: &str,
    ) -> Result<(), &'static str> {
        let account = super::discovery::verify_session(&document)?.to_owned();
        let concurrency = document["capabilities"][CORE]["maxConcurrentRequests"]
            .as_u64()
            .unwrap_or(4)
            .clamp(1, 16) as usize;
        let uploads = document["capabilities"][CORE]["maxConcurrentUpload"]
            .as_u64()
            .unwrap_or(4)
            .clamp(1, 16) as usize;
        let snapshot = Snapshot {
            roles: query::roles(&boxes),
            document,
            boxes,
            credential,
            address: address.into(),
            account,
            slots: Arc::new(Semaphore::new(concurrency)),
            uploads: Arc::new(Semaphore::new(uploads)),
        };
        let context = Arc::new(Context::default());
        *context.snapshot.lock().await = Some(snapshot);
        let mut contexts = self.contexts.lock().map_err(|_| "session_failed")?;
        if contexts.len() >= 64 && !contexts.contains_key(id) {
            return Err("jmap_account_limit");
        }
        if let Some(old) = contexts.insert(id.to_owned(), context) {
            old.retired
                .store(true, std::sync::atomic::Ordering::Release);
        }
        Ok(())
    }
    pub(super) async fn snapshot(
        &self,
        id: &str,
        context: &Context,
    ) -> Result<Snapshot, &'static str> {
        let mut held = context.snapshot.lock().await;
        if let Some(snapshot) = held.as_ref() {
            return Ok(snapshot.clone());
        }
        let lookup = id.to_owned();
        let settings = tokio::task::spawn_blocking(move || crate::auth::settings("jmap", &lookup))
            .await
            .map_err(|_| "worker_failed")??;
        let secret = crate::auth::password("jmap", id).await?;
        let username = settings["jmap"]["username"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or(string(&settings["email"]));
        let credential = json!({"scheme":settings["jmap"]["authScheme"].as_str().unwrap_or("basic"),"username":username,"secret":secret});
        let document = self
            .document(
                "session",
                string(&settings["jmap"]["sessionUrl"]),
                &credential,
                None,
            )
            .await?;
        let account = super::discovery::verify_session(&document)?.to_owned();
        let limits = &document["capabilities"][CORE];
        let concurrency = limits["maxConcurrentRequests"]
            .as_u64()
            .unwrap_or(4)
            .clamp(1, 16) as usize;
        let uploads = limits["maxConcurrentUpload"]
            .as_u64()
            .unwrap_or(4)
            .clamp(1, 16) as usize;
        let mut snapshot = Snapshot {
            document,
            boxes: Vec::new(),
            credential,
            address: string(&settings["email"]).into(),
            account,
            roles: json!({}),
            slots: Arc::new(Semaphore::new(concurrency)),
            uploads: Arc::new(Semaphore::new(uploads)),
        };
        let body = json!({"using":[CORE,MAIL],"methodCalls":[["Mailbox/get",{"accountId":snapshot.account,"ids":null,"properties":BOX_PROPERTIES},"0"]]});
        let result = self
            .document(
                "call",
                string(&snapshot.document["apiUrl"]),
                &snapshot.credential,
                Some(body.to_string()),
            )
            .await?;
        snapshot.boxes = argument(&result, "0", "Mailbox/get")?["list"]
            .as_array()
            .ok_or("jmap_invalid_response")?
            .clone();
        snapshot.roles = query::roles(&snapshot.boxes);
        *held = Some(snapshot.clone());
        Ok(snapshot)
    }
    pub(super) async fn api(
        &self,
        context: &Context,
        snapshot: &Snapshot,
        calls: Value,
        submission: bool,
    ) -> Result<Value, &'static str> {
        active(context)?;
        let _slot = snapshot
            .slots
            .acquire()
            .await
            .map_err(|_| "session_failed")?;
        active(context)?;
        let using = if submission {
            json!([CORE, MAIL, SUBMISSION])
        } else {
            json!([CORE, MAIL])
        };
        let result = self
            .document(
                "call",
                string(&snapshot.document["apiUrl"]),
                &snapshot.credential,
                Some(json!({"using":using,"methodCalls":calls}).to_string()),
            )
            .await?;
        if let Some(state) = result["sessionState"].as_str()
            && snapshot.document["state"]
                .as_str()
                .is_some_and(|known| known != state)
        {
            *context.snapshot.lock().await = None;
        }
        let responses = result["methodResponses"]
            .as_array()
            .ok_or("jmap_invalid_response")?;
        let mut known = context.known.lock().map_err(|_| "session_failed")?;
        for response in responses {
            let method = string(&response[0]);
            if method == "error" {
                continue;
            }
            let state = response[1]
                .get("newState")
                .or_else(|| response[1].get("state"));
            let kind = method.split('/').next().unwrap_or("");
            if let Some(state) = state.filter(|v| v.is_string())
                && ["Email", "Mailbox", "Thread", "Identity", "EmailSubmission"].contains(&kind)
            {
                if state.as_str().is_some_and(|v| v.len() > 4096) {
                    return Err("jmap_response_too_large");
                }
                known.insert(kind.into(), state.clone());
            }
        }
        Ok(result)
    }
    pub(super) async fn get_emails(
        &self,
        context: &Context,
        snapshot: &Snapshot,
        ids: &[String],
        full: bool,
        members: bool,
    ) -> Result<Vec<Value>, &'static str> {
        let chunks: Vec<_> = ids.chunks(snapshot.limit("maxObjectsInGet", 256)).collect();
        let reads = chunks.into_iter().map(|chunk| async move {
            let mut args = super::resource::email_get(&snapshot.account, chunk, full);
            if members {
                args["properties"] = json!(MEMBER_PROPERTIES);
            }
            let result = self
                .api(context, snapshot, json!([["Email/get", args, "0"]]), false)
                .await?;
            Ok::<_, &'static str>(
                argument(&result, "0", "Email/get")?["list"]
                    .as_array()
                    .ok_or("jmap_invalid_response")?
                    .clone(),
            )
        });
        let mut reads = reads;
        let mut emails = Vec::new();
        let mut bytes = 0usize;
        loop {
            let batch: Vec<_> = reads.by_ref().take(4).collect();
            if batch.is_empty() {
                break;
            }
            for result in futures_util::future::join_all(batch).await {
                let list = result?;
                for email in &list {
                    bytes = bytes.saturating_add(
                        serde_json::to_vec(email)
                            .map_err(|_| "jmap_invalid_response")?
                            .len(),
                    );
                    if bytes > MAX_BODY {
                        return Err("jmap_response_too_large");
                    }
                }
                emails.extend(list);
            }
        }
        Ok(emails)
    }
    pub(super) async fn native(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        let result = self.native_inner(method, params).await;
        if result == Err("jmap_unauthorized")
            && let Some(account) = params["accountId"].as_str()
            && let Ok(context) = self.context(account)
        {
            context
                .rejected
                .store(true, std::sync::atomic::Ordering::Release);
        }
        result
    }
    async fn native_inner(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        if ![
            "jmap.profile",
            "jmap.session",
            "jmap.list",
            "jmap.messages",
            "jmap.read",
            "jmap.attachment",
            "jmap.labels",
            "jmap.labelCounts",
            "jmap.watch",
            "jmap.modify",
            "jmap.batchModify",
            "jmap.trash",
            "jmap.untrash",
            "jmap.sendAs",
            "jmap.send",
            "jmap.saveDraft",
            "jmap.invalidate",
        ]
        .contains(&method)
        {
            return Err("method_not_found");
        }
        let id = text(params, "accountId")?;
        if method == "jmap.invalidate" {
            if let Some(context) = self
                .contexts
                .lock()
                .map_err(|_| "session_failed")?
                .remove(id)
            {
                context
                    .retired
                    .store(true, std::sync::atomic::Ordering::Release);
            }
            self.policies
                .lock()
                .map_err(|_| "session_failed")?
                .remove(id);
            return Ok(json!({"data":{},"state":null}));
        }
        let context = self.context(id)?;
        if context.rejected.load(std::sync::atomic::Ordering::Acquire) {
            return Err("jmap_unauthorized");
        }
        let mut snapshot = self.snapshot(id, &context).await?;
        let data = match method {
            "jmap.profile" => {
                json!({"email":snapshot.address,"messagesTotal":0,"threadsTotal":0,"historyId":""})
            }
            "jmap.session" => json!({}),
            "jmap.list" => self.list(&context, &snapshot, params).await?,
            "jmap.messages" => self.messages(&context, &snapshot, params).await?,
            "jmap.read" => self.read(&context, &snapshot, params).await?,
            "jmap.attachment" => {
                self.attachment(&snapshot, text(params, "attachmentId")?)
                    .await?
            }
            "jmap.labels" => {
                let result=self.api(&context,&snapshot,json!([["Mailbox/get",{"accountId":snapshot.account,"ids":null,"properties":BOX_PROPERTIES},"0"]]),false).await?;
                snapshot.boxes = argument(&result, "0", "Mailbox/get")?["list"]
                    .as_array()
                    .ok_or("jmap_invalid_response")?
                    .clone();
                snapshot.roles = query::roles(&snapshot.boxes);
                *context.snapshot.lock().await = Some(snapshot.clone());
                query::labels(&snapshot.boxes)
            }
            "jmap.labelCounts" => {
                let label = text(params, "id")?;
                let result=self.api(&context,&snapshot,json!([["Mailbox/get",{"accountId":snapshot.account,"ids":[label],"properties":BOX_PROPERTIES},"0"]]),false).await?;
                let boxes = &argument(&result, "0", "Mailbox/get")?["list"];
                query::counts(
                    boxes
                        .as_array()
                        .and_then(|v| v.first())
                        .unwrap_or(&json!({"id":label})),
                )
            }
            "jmap.watch" => {
                let template = string(&snapshot.document["eventSourceUrl"]);
                if template.is_empty() {
                    return Err("jmap_events_unavailable");
                }
                let endpoint = fill(
                    template,
                    &[
                        ("types", "Email,Mailbox"),
                        ("closeafter", "no"),
                        ("ping", "30"),
                    ],
                );
                let request = prepare(
                    &json!({"verb":"stream","url":endpoint,"credential":snapshot.credential}),
                )?;
                let mut streams = self.streams.lock().map_err(|_| "session_failed")?;
                let stream_id = text(params, "streamId")?.to_owned();
                if streams.len() >= 16 && !streams.contains_key(&stream_id) {
                    return Err("jmap_stream_limit");
                }
                let (sender, receiver) = mpsc::channel(8);
                let client = self.client.as_ref().map_err(|e| *e)?.clone();
                streams.insert(
                    stream_id,
                    Stream {
                        task: tokio::spawn(stream::run_scoped(
                            client,
                            request,
                            sender,
                            Some((snapshot.account.clone(), context.clone())),
                        )),
                        receiver: Arc::new(AsyncMutex::new(receiver)),
                    },
                );
                json!({"opened":true})
            }
            _ => self.mutation(&context, &snapshot, method, params).await?,
        };
        let known = context.known.lock().map_err(|_| "session_failed")?.clone();
        Ok(
            json!({"data":data,"state":{"session":snapshot.document,"mailboxes":snapshot.boxes,"knownStates":known}}),
        )
    }
}
pub(super) fn argument<'a>(
    result: &'a Value,
    id: &str,
    method: &str,
) -> Result<&'a Value, &'static str> {
    let response = result["methodResponses"]
        .as_array()
        .and_then(|v| v.iter().find(|v| v[2] == id))
        .ok_or("jmap_invalid_response")?;
    if response[0] == "error" {
        return Err(match string(&response[1]["type"]) {
            "anchorNotFound" => "jmap_anchor_not_found",
            "requestTooLarge" => "jmap_request_too_large",
            "forbidden" => "jmap_forbidden",
            _ => "jmap_method_failed",
        });
    }
    if response[0] != method {
        return Err("jmap_invalid_response");
    }
    Ok(&response[1])
}
pub(super) fn ids(value: &Value) -> Result<Vec<String>, &'static str> {
    let list = value.as_array().ok_or("invalid_params")?;
    if list.len() > 4096 {
        return Err("jmap_request_too_large");
    }
    let mut ids = Vec::new();
    for value in list {
        let id = value.as_str().ok_or("invalid_params")?.trim();
        if id.is_empty() || id.len() > 1024 {
            return Err("invalid_params");
        }
        if !ids.iter().any(|s| s == id) {
            ids.push(id.to_owned());
        }
    }
    Ok(ids)
}
pub(super) fn fill(template: &str, values: &[(&str, &str)]) -> String {
    let mut result = template.to_owned();
    for (key, value) in values {
        let mut encoded = String::new();
        for b in value.bytes() {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                encoded.push(b as char);
            } else {
                encoded.push_str(&format!("%{b:02X}"));
            }
        }
        result = result.replace(&format!("{{{key}}}"), &encoded);
    }
    result
}
#[cfg(test)]
#[path = "mailbox_runtime_tests.rs"]
mod tests;

pub(super) fn active(context: &Context) -> Result<(), &'static str> {
    if context.retired.load(std::sync::atomic::Ordering::Acquire) {
        return Err("jmap_cancelled");
    }
    if context.rejected.load(std::sync::atomic::Ordering::Acquire) {
        return Err("jmap_unauthorized");
    }
    Ok(())
}
