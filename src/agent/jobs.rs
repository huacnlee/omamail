//! Durable background assistant admission and lifecycle. Mail never crosses argv.
use super::{
    provider::Provider,
    storage::{Store, check_id},
    stream::ClaudeStream,
};
use serde_json::{Value, json};
use std::{
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::process::CommandExt,
    },
    process::Stdio,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
type Result<T> = std::result::Result<T, &'static str>;
pub const INPUT_LIMIT: usize = 1024 * 1024;
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn text(value: &Value) -> Result<&str> {
    let s = value.as_str().ok_or("agent_invalid_text")?;
    if s.chars().any(|c| {
        (c < ' ' && !matches!(c, '\t' | '\r' | '\n')) || ('\u{7f}'..='\u{9f}').contains(&c)
    }) {
        return Err("agent_invalid_text");
    }
    Ok(s)
}
pub fn session(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

fn validate_draft(value: &Value) -> Result<()> {
    let draft = value.as_object().ok_or("agent_invalid_draft")?;
    for (key, value) in draft {
        if !["to", "cc", "bcc", "subject", "body", "from"].contains(&key.as_str()) {
            return Err("agent_invalid_draft");
        }
        text(value)?;
    }
    Ok(())
}

fn validate_messages(value: &Value, limit: usize) -> Result<()> {
    let entries = value
        .as_array()
        .filter(|entries| !entries.is_empty() && entries.len() <= limit)
        .ok_or("agent_invalid_messages")?;
    for entry in entries {
        let entry = entry
            .as_object()
            .filter(|entry| {
                entry.len() == 2 && entry.contains_key("messageId") && entry.contains_key("message")
            })
            .ok_or("agent_invalid_messages")?;
        for value in entry.values() {
            text(value)?;
        }
    }
    Ok(())
}

fn validate_mail_update(value: &Value) -> Result<()> {
    let update = value.as_object().ok_or("agent_invalid_context")?;
    if ["accountId", "messageId", "message"]
        .iter()
        .any(|key| !update.contains_key(*key))
    {
        return Err("agent_invalid_context");
    }
    for (key, value) in update {
        match key.as_str() {
            "accountId" | "messageId" => {
                if text(value)?.chars().count() > 4096 {
                    return Err("agent_identifier_too_large");
                }
            }
            "message" | "threadContext" => {
                text(value)?;
            }
            "threadMessages" => validate_messages(value, 100)?,
            _ => return Err("agent_invalid_context"),
        }
    }
    Ok(())
}

pub fn validate_payload(value: &Value) -> Result<Value> {
    let o = value.as_object().ok_or("agent_invalid_context")?;
    if serde_json::to_vec(value)
        .map_err(|_| "agent_invalid_context")?
        .len()
        > INPUT_LIMIT
    {
        return Err("agent_context_too_large");
    }
    if o.contains_key("parent")
        && (!o.contains_key("prompt")
            || o.keys()
                .any(|k| !["parent", "prompt", "draftUpdate", "mailUpdate"].contains(&k.as_str())))
    {
        return Err("agent_continuation_override");
    }
    for (k, v) in o {
        match k.as_str() {
            "mailUpdate" => {
                if !o.contains_key("parent") {
                    return Err("agent_continuation_override");
                }
                validate_mail_update(v)?;
            }
            "draftUpdate" => {
                if !o.contains_key("parent") {
                    return Err("agent_invalid_draft");
                }
                let update = v.as_object().ok_or("agent_invalid_draft")?;
                if update.keys().any(|k| {
                    !["accountId", "draftKey", "draft", "messageId", "envelope"]
                        .contains(&k.as_str())
                }) || !update.contains_key("draft")
                {
                    return Err("agent_invalid_draft");
                }
                for key in ["accountId", "draftKey"] {
                    let id = text(&v[key])?;
                    if id.is_empty() || id.len() > 4096 {
                        return Err("agent_invalid_draft");
                    }
                }
                if let Some(message) = update.get("messageId") {
                    if text(message)?.is_empty() {
                        return Err("agent_invalid_draft");
                    }
                }
                let draft = v["draft"].as_object().ok_or("agent_invalid_draft")?;
                if draft.len() != 6
                    || ["from", "to", "cc", "bcc", "subject", "body"]
                        .iter()
                        .any(|key| !draft.contains_key(*key))
                {
                    return Err("agent_invalid_draft");
                }
                validate_draft(&v["draft"])?;
                if let Some(envelope) = v.get("envelope") {
                    super::proposals::envelope(envelope, &v["accountId"], &v["draftKey"])?;
                }
            }
            "envelope" => super::proposals::envelope(v, &value["accountId"], &value["draftKey"])?,
            "messages" => validate_messages(v, 20)?,
            "threadMessages" => validate_messages(v, 100)?,
            "draft" => validate_draft(v)?,
            // A look for calendar events: one message, the fixed ask, no draft
            // and no continuation — a look answers once and is not talked to.
            "events" => {
                if v != true
                    || o.contains_key("messages")
                    || o.contains_key("draft")
                    || o.contains_key("parent")
                    || o["messageId"].as_str().unwrap_or("").is_empty()
                {
                    return Err("agent_invalid_events");
                }
            }
            "accountId" | "account" | "messageId" | "subject" | "prompt" | "message"
            | "threadContext" | "draftKey" | "draftFingerprint" | "parent" | "folder" => {
                let s = text(v)?;
                if [
                    "accountId",
                    "messageId",
                    "subject",
                    "draftKey",
                    "draftFingerprint",
                ]
                .contains(&k.as_str())
                    && s.chars().count() > 4096
                {
                    return Err("agent_identifier_too_large");
                }
                if k == "parent" {
                    check_id(s)?;
                }
            }
            _ => return Err("agent_unsupported_context"),
        }
    }
    if value["prompt"].as_str().unwrap_or("").trim().is_empty() {
        return Err("agent_prompt_required");
    }
    Ok(value.clone())
}
fn draft_payload(value: &Value) -> Result<Value> {
    let object = value.as_object().ok_or("agent_invalid_draft")?;
    if object
        .keys()
        .any(|k| !["draftFields", "ask", "account", "accountId"].contains(&k.as_str()))
    {
        return Err("agent_invalid_draft");
    }
    let fields = value["draftFields"]
        .as_object()
        .ok_or("agent_invalid_draft")?;
    let get = |key: &str| -> Result<String> {
        fields
            .get(key)
            .map(text)
            .transpose()
            .map(|s| s.unwrap_or("").to_owned())
    };
    let from = get("from")?;
    let to = get("to")?;
    let subject = get("subject")?;
    let body = get("body")?;
    let hash = draft_fingerprint(&json!({"from":from,"to":to,"subject":subject,"body":body}))?;
    let account = text(&value["account"])?;
    let owner = text(&value["accountId"])?;
    let title = subject.trim();
    let mut payload = validate_payload(
        &json!({"messageId":"","accountId":owner,"draftKey":get("draftKey")?,"draftFingerprint":hash,"draft":{"from":if from.is_empty(){account}else{&from},"to":to,"cc":get("cc")?,"bcc":get("bcc")?,"subject":subject,"body":body},"account":account,"subject":if title.is_empty(){"Draft".to_owned()}else{format!("Draft: {title}")},"prompt":text(&value["ask"])?.trim(),"message":""}),
    )?;
    if let Some(envelope) = fields.get("envelope") {
        payload["envelope"] = envelope.clone();
    }
    validate_payload(&payload)
}

fn draft_fingerprint(draft: &Value) -> Result<String> {
    let fields: Vec<&str> = ["from", "to", "subject", "body"]
        .iter()
        .map(|key| draft[key].as_str().unwrap_or(""))
        .collect();
    let serialized = serde_json::to_string(&fields).map_err(|_| "agent_invalid_draft")?;
    // Match the existing UI-only change indicator, including JavaScript f64 multiplication.
    let mut hash = 2166136261u32;
    for code in serialized.encode_utf16() {
        let signed = (hash ^ code as u32) as i32;
        hash = ((signed as f64 * 16777619f64).rem_euclid(4294967296f64)) as u32;
    }
    Ok(hash.to_string())
}
pub fn read_job(store: &Store, id: &str) -> Result<Value> {
    check_id(id)?;
    let v = store
        .read_json(id, "job.json", INPUT_LIMIT)?
        .ok_or("agent_job_missing")?;
    if v["id"] != id {
        return Err("agent_job_identity");
    }
    for k in [
        "accountId",
        "subject",
        "messageId",
        "draftKey",
        "draftFingerprint",
    ] {
        text(&v[k])?;
    }
    if let Some(c) = v.get("conversationId") {
        check_id(text(c)?)?;
    }
    if let Some(p) = v.get("requestPreview") {
        let p = text(p)?;
        if p.chars().count() > 120 || p != p.split_whitespace().collect::<Vec<_>>().join(" ") {
            return Err("agent_invalid_preview");
        }
    }
    if !["draft", "message", "events"].contains(&v["kind"].as_str().unwrap_or(""))
        || !["queued", "running", "done", "failed", "cancelled"]
            .contains(&v["state"].as_str().unwrap_or(""))
    {
        return Err("agent_invalid_state");
    }
    for k in ["created", "updated"] {
        v[k].as_u64().ok_or("agent_invalid_time")?;
    }
    v["resultReady"].as_bool().ok_or("agent_invalid_result")?;
    let ids = v["messageIds"]
        .as_array()
        .filter(|a| a.len() <= 20)
        .ok_or("agent_invalid_messages")?;
    for id in ids {
        text(id)?;
    }
    if v.get("createdOrder").is_some_and(|x| x.as_u64().is_none())
        || v.get("pid")
            .is_some_and(|x| x.as_u64().is_none_or(|n| n <= 1 || n > i32::MAX as u64))
    {
        return Err("agent_invalid_process");
    }
    let provider = Provider::of_job(&v)?;
    if v.get("displayVersion").is_some_and(|version| version != 2)
        || v.get("stopUnconfirmed")
            .is_some_and(|value| !value.is_boolean())
    {
        return Err("agent_invalid_state");
    }
    if let Some(model) = v.get("model") {
        super::provider::validate_model(model.as_str().ok_or("agent_invalid_model")?)?;
    }
    for k in ["sessionId", "resume"] {
        if let Some(x) = v.get(k) {
            let s = text(x)?;
            if !s.is_empty() && !provider.session(s) {
                return Err("agent_invalid_session");
            }
        }
    }
    for key in ["error", "progress", "summary"] {
        if let Some(e) = v.get(key) {
            text(e)?;
        }
    }
    if let Some(events) = v.get("events") {
        if v["kind"] != "events" {
            return Err("agent_invalid_events");
        }
        super::events::validate(events)?;
    }
    Ok(v)
}
pub fn saved_display(store: &Store, id: &str) -> Result<Value> {
    let v = store
        .read_json(id, "display.json", 512 * 1024)?
        // Older cancelled jobs have no display record. Missing output is an
        // empty, incomplete answer; malformed or unsafe existing files still fail.
        .unwrap_or_else(|| json!({"transcript":[],"output":"","complete":false,"sessionId":""}));
    let o = v
        .as_object()
        .filter(|o| {
            o.len() == 4
                && ["transcript", "output", "complete", "sessionId"]
                    .iter()
                    .all(|k| o.contains_key(*k))
        })
        .ok_or("agent_invalid_display")?;
    let items = o["transcript"].as_array().ok_or("agent_invalid_display")?;
    ClaudeStream::new(items.clone())?;
    if text(&v["output"])?.len() > 65536 || v["complete"].as_bool().is_none() {
        return Err("agent_invalid_display");
    }
    let s = text(&v["sessionId"])?;
    if !s.is_empty() && !Provider::of_job(&read_job(store, id)?)?.session(s) {
        return Err("agent_invalid_session");
    }
    Ok(v)
}
fn active(v: &Value) -> bool {
    matches!(v["state"].as_str(), Some("queued" | "running"))
}
#[cfg(target_os = "macos")]
fn process_handle(v: &Value) -> Option<OwnedFd> {
    std::os::unix::net::UnixStream::connect(super::control::path(v["id"].as_str()?).ok()?)
        .ok()
        .map(Into::into)
}
#[cfg(target_os = "linux")]
fn process_handle(v: &Value) -> Option<OwnedFd> {
    let pid = v["pid"].as_i64()?;
    if pid <= 1 || pid > i32::MAX as i64 {
        return None;
    }
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return None;
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
    let executable = std::env::current_exe().ok()?;
    use std::io::Read;
    let mut args = Vec::new();
    std::fs::File::open(format!("/proc/{pid}/cmdline"))
        .ok()?
        .take(4097)
        .read_to_end(&mut args)
        .ok()?;
    if args.len() > 4096 {
        return None;
    }
    let expected = [
        executable.as_os_str().as_encoded_bytes(),
        b"agent-worker",
        v["id"].as_str()?.as_bytes(),
        b"",
    ]
    .join(&0);
    if args != expected && !legacy_worker_args(&args, &executable, v["id"].as_str()?) {
        return None;
    }
    Some(fd)
}
// Upgrade compatibility only: recognize an already-running worker from this
// checkout or this installed plugin. Never launch Python and never accept an
// executable/script path supplied by job metadata.
fn legacy_worker_args(args: &[u8], executable: &std::path::Path, id: &str) -> bool {
    use std::os::unix::fs::MetadataExt;
    let mut candidates =
        vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/agent-job.py")];
    if let Some(bin) = executable.parent()
        && bin.file_name().is_some_and(|name| name == "bin")
        && let Some(runtime) = bin.parent()
        && runtime.file_name().is_some_and(|name| name == "runtime")
        && let Some(plugin) = runtime.parent()
    {
        candidates.push(plugin.join("scripts/agent-job.py"));
    }
    candidates.into_iter().any(|candidate| {
        let Ok(metadata) = std::fs::symlink_metadata(&candidate) else {
            return false;
        };
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o022 != 0
        {
            return false;
        }
        let Ok(path) = candidate.canonicalize() else {
            return false;
        };
        args == [
            b"python3".as_slice(),
            path.as_os_str().as_encoded_bytes(),
            b"run",
            id.as_bytes(),
            b"",
        ]
        .join(&0)
    })
}
pub(super) fn refresh(store: &Store, id: &str) -> Result<Value> {
    let mut job = read_job(store, id)?;
    if (job["state"] == "queued" && now().saturating_sub(job["created"].as_u64().unwrap()) > 30)
        || (job["state"] == "running" && process_handle(&job).is_none())
    {
        if job["state"] == "running" {
            // A crashed worker cannot attest that its CLI stopped, and the
            // OpenCode broker revokes its lease asynchronously. No successor
            // may race either process in the same native session.
            job["stopUnconfirmed"] = json!(true);
        }
        job["state"] = json!("failed");
        job["error"] = json!("The AI worker stopped unexpectedly. Start a new request.");
        job["updated"] = json!(now());
        store.write_json(id, "job.json", &job)?;
    }
    let display = saved_display(store, id)?;
    let ready = job["state"] == "done"
        && display["complete"] == true
        && !display["output"].as_str().unwrap_or("").trim().is_empty()
        && display["sessionId"] == job["sessionId"];
    job["resultReady"] = json!(ready);
    job["canContinue"] = json!(
        !active(&job)
            && job["stopUnconfirmed"] != true
            && !display["transcript"].as_array().unwrap().is_empty()
            && (job["sessionId"].as_str().unwrap_or("").is_empty()
                || display["sessionId"].as_str().unwrap_or("").is_empty()
                || display["sessionId"] == job["sessionId"])
    );
    Ok(job)
}
struct HeadIndex {
    path: std::path::PathBuf,
    revision: [u64; 6],
    jobs: Vec<Value>,
}
static HEADS: std::sync::Mutex<Option<HeadIndex>> = std::sync::Mutex::new(None);

fn list(store: &Store) -> Result<Vec<Value>> {
    // The store lock serializes index reads with turn creation/deletion. Keep
    // only metadata in memory; a restart rebuilds it from the durable records.
    // Active heads are refreshed each poll, terminal displays only when paged.
    let revision = store.revision()?;
    let mut cached = HEADS.lock().map_err(|_| "agent_storage_unavailable")?;
    if cached
        .as_ref()
        .is_none_or(|index| index.path != store.path() || index.revision != revision)
    {
        *cached = Some(HeadIndex {
            path: store.path().to_owned(),
            revision,
            jobs: scan_heads(store)?,
        });
    }
    let index = cached.as_mut().unwrap();
    for job in &mut index.jobs {
        if active(job) {
            *job = refresh(store, job["id"].as_str().unwrap())?;
        }
    }
    Ok(index.jobs.clone())
}

fn scan_heads(store: &Store) -> Result<Vec<Value>> {
    let mut jobs = Vec::new();
    for id in store.ids()? {
        if let Some(next) = store.read_json(&id, "next.json", 128)? {
            let next = next.as_str().ok_or("agent_invalid_record")?;
            if store.contains(next)? {
                continue;
            }
        }
        jobs.push(read_job(store, &id)?);
    }
    jobs.sort_by_key(|j| {
        std::cmp::Reverse(
            j["createdOrder"].as_u64().unwrap_or(
                j["created"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_mul(1_000_000_000),
            ),
        )
    });
    let mut conversations = std::collections::HashSet::new();
    jobs.retain(|job| {
        let newest = conversations.insert(
            job["conversationId"]
                .as_str()
                .unwrap_or(job["id"].as_str().unwrap())
                .to_owned(),
        );
        newest || active(job)
    });
    Ok(jobs)
}
async fn default_provider() -> Result<Provider> {
    let out = crate::process::async_run::run(
        "omarchy-default-agent",
        &[],
        &[],
        Duration::from_secs(5),
        4096,
    )
    .await?;
    // Retain the legacy refusal identifier for older event-suggestion clients.
    if !out.success {
        return Err("agent_choose_claude");
    }
    Provider::parse(std::str::from_utf8(&out.stdout).unwrap_or("").trim())
        .ok_or("agent_choose_claude")
}
fn new_job(context: Value, mut provider: Provider, mut model: String) -> Result<Value> {
    let store = Store::open()?;
    let existing = list(&store)?;
    let mut history = vec![];
    let mut bootstrap = vec![];
    let mut resume = String::new();
    let mut conversation = String::new();
    let mut context = context;
    if let Some(parent) = context["parent"].as_str() {
        let parent = parent.to_owned();
        let job = refresh(&store, &parent)?;
        let conversation_id = job["conversationId"].as_str().unwrap_or(&parent);
        if existing.iter().any(|candidate| {
            active(candidate)
                && candidate["conversationId"]
                    .as_str()
                    .unwrap_or(candidate["id"].as_str().unwrap())
                    == conversation_id
        }) {
            return Err("agent_conversation_busy");
        }
        let head = existing.iter().find(|candidate| {
            candidate["conversationId"]
                .as_str()
                .unwrap_or(candidate["id"].as_str().unwrap())
                == conversation_id
        });
        if head.is_some_and(active) {
            return Err("agent_conversation_busy");
        }
        if head.is_some_and(|head| head["id"] != parent) {
            return Err("agent_parent_not_latest");
        }
        provider = Provider::of_job(&job)?;
        model = job["model"].as_str().unwrap_or("").to_owned();
        if job["canContinue"] != true {
            return Err("agent_parent_not_ready");
        }
        let display = saved_display(&store, &parent)?;
        // A stopped turn can have a native session without a complete answer.
        // If it stopped before creating one, start with the retained context
        // and transcript instead of silently dropping the interrupted request.
        resume = display["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .or_else(|| job["sessionId"].as_str())
            .unwrap_or("")
            .to_owned();
        conversation = job["conversationId"].as_str().unwrap_or(&parent).to_owned();
        // A native session owns the history and compaction. Until one exists,
        // retain earlier attempts as well as the parent's own display turn.
        if resume.is_empty() {
            if job["displayVersion"] == 2 {
                if let Some(previous) = store.read_json(&parent, "bootstrap.json", 512 * 1024)? {
                    bootstrap = previous.as_array().ok_or("agent_invalid_record")?.clone();
                }
            }
            // Legacy displays already contain their cumulative history.
            bootstrap.extend(display["transcript"].as_array().unwrap().iter().cloned());
            super::stream::transcript_check(&bootstrap)?;
        }
        let mut previous = store
            .read_json(&parent, "context.json", INPUT_LIMIT)?
            .ok_or("agent_context_missing")?;
        // Persisted continuation contexts inherit mail fields; validate the original projection independently.
        previous
            .as_object_mut()
            .ok_or("agent_invalid_context")?
            .remove("parent");
        validate_payload(&previous)?;
        if let Some(update) = context.get("mailUpdate") {
            if previous["accountId"] != update["accountId"]
                || previous["messageId"] != update["messageId"]
                || previous.get("messages").is_some()
            {
                return Err("agent_continuation_override");
            }
            for key in ["message", "threadMessages", "threadContext"] {
                previous
                    .as_object_mut()
                    .ok_or("agent_invalid_context")?
                    .remove(key);
                if let Some(value) = update.get(key) {
                    previous[key] = value.clone();
                }
            }
        }
        if let Some(update) = context.get("draftUpdate") {
            // A follow-up can refresh content, never redirect its ownership.
            let attaching = previous["messageId"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
                && update["messageId"] == previous["messageId"]
                && previous.get("messages").is_none()
                && !previous["draft"].is_object()
                && previous["draftKey"].as_str().unwrap_or("").is_empty();
            if update["accountId"] != previous["accountId"]
                || (!attaching
                    && (update["draftKey"] != previous["draftKey"]
                        || !previous["draft"].is_object()))
            {
                return Err("agent_continuation_override");
            }
            if attaching {
                previous["draftKey"] = update["draftKey"].clone();
            }
            previous["draft"] = update["draft"].clone();
            previous
                .as_object_mut()
                .ok_or("agent_invalid_context")?
                .remove("envelope");
            if let Some(envelope) = update.get("envelope") {
                previous["envelope"] = envelope.clone();
            }
            previous["draftFingerprint"] = draft_fingerprint(&previous["draft"])?.into();
        }
        previous["parent"] = json!(parent);
        previous["prompt"] = context["prompt"].clone();
        context = previous;
    }
    if context["messageId"].as_str().unwrap_or("").is_empty()
        && context.get("messages").is_none()
        && !context["draft"].is_object()
    {
        return Err("agent_context_required");
    }
    if serde_json::to_vec(&context)
        .map_err(|_| "agent_invalid_context")?
        .len()
        > INPUT_LIMIT
    {
        return Err("agent_context_too_large");
    }
    history.push(json!({"role":"user","text":context["prompt"]}));
    let parser = ClaudeStream::new(history)?;
    if existing.iter().filter(|v| active(v)).count() >= 4 {
        return Err("agent_active_limit");
    }
    let mut random = [0u8; 16];
    std::io::Read::read_exact(
        &mut std::fs::File::open("/dev/urandom").map_err(|_| "agent_random_failed")?,
        &mut random,
    )
    .map_err(|_| "agent_random_failed")?;
    let id = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    store.create(&id)?;
    let preview = context["prompt"]
        .as_str()
        .unwrap()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(120)
        .collect::<String>();
    let kind = if context["draft"].is_object() {
        "draft"
    } else if super::events::is_look(&context) {
        "events"
    } else {
        "message"
    };
    let order = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(u64::MAX as u128) as u64;
    let mut job = json!({
        "id": id,
        "conversationId": if conversation.is_empty() { id.clone() } else { conversation },
        "requestPreview": preview.trim_end(),
        "kind": kind,
        "messageIds": [],
        "state": "queued",
        "created": now(),
        "createdOrder": order,
        "updated": now(),
        "resultReady": false,
        "canContinue": false,
        "provider": provider.name(),
        "resume": resume,
        "progress": "Starting..."
    });
    job["model"] = json!(model);
    job["displayVersion"] = json!(2);
    if !resume.is_empty() {
        job["sessionId"] = json!(resume);
    }
    for k in [
        "accountId",
        "subject",
        "messageId",
        "draftKey",
        "draftFingerprint",
    ] {
        job[k] = context.get(k).cloned().unwrap_or(json!(""));
    }
    job["messageIds"] = if let Some(a) = context["messages"].as_array() {
        json!(a.iter().map(|m| m["messageId"].clone()).collect::<Vec<_>>())
    } else if !context["messageId"].as_str().unwrap_or("").is_empty() {
        json!([context["messageId"]])
    } else {
        json!([])
    };
    store.write_json(&id, "context.json", &context)?;
    store.write_json(&id, "display.json", &parser.display())?;
    if !bootstrap.is_empty() {
        store.write_json(&id, "bootstrap.json", &json!(bootstrap))?;
    }
    store.write_json(&id, "job.json", &job)?;
    if let Some(parent) = context["parent"].as_str() {
        store.write_json(parent, "next.json", &json!(id))?;
    }
    let exe = std::env::current_exe().map_err(|_| "agent_worker_unavailable")?;
    let mut command = std::process::Command::new(exe);
    command
        .args(["agent-worker", &id])
        .current_dir(store.path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    match command.spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(_) => {
            job["state"] = json!("failed");
            job["error"] = json!("The AI worker could not start.");
            store.write_json(&id, "job.json", &job)?;
        }
    }
    Ok(job)
}
pub async fn call(method: &str, params: &Value) -> Result<Value> {
    if method == "agent.providerStatus" {
        let selected = params
            .get("provider")
            .map(|v| v.as_str().ok_or("agent_invalid_provider"))
            .transpose()?
            .unwrap_or("");
        let provider = if selected.is_empty() {
            default_provider().await.ok()
        } else {
            Some(Provider::parse(selected).ok_or("agent_invalid_provider")?)
        };
        return Ok(
            json!({"available":provider.is_some(),"provider":provider.map(Provider::name).unwrap_or("")}),
        );
    }
    if method == "agent.jobsProjection" {
        return projection(params);
    }
    if method == "agent.jobStart" {
        let selected = params
            .get("provider")
            .map(|p| p.as_str().ok_or("agent_invalid_provider"))
            .transpose()?
            .unwrap_or("");
        let selected = if selected.is_empty() {
            None
        } else {
            Some(Provider::parse(selected).ok_or("agent_invalid_provider")?)
        };
        let model = params
            .get("model")
            .map(|m| m.as_str().ok_or("agent_invalid_model"))
            .transpose()?
            .unwrap_or("")
            .to_owned();
        super::provider::validate_model(&model)?;
        let raw = params.get("payload").ok_or("agent_context_required")?;
        let v = if let Some(s) = raw.as_str() {
            if s.len() > INPUT_LIMIT {
                return Err("agent_context_too_large");
            }
            serde_json::from_str(s).map_err(|_| "agent_invalid_context")?
        } else {
            raw.clone()
        };
        let context = if v.get("draftFields").is_some() {
            draft_payload(&v)?
        } else {
            validate_payload(&v)?
        };
        let provider = if context.get("parent").is_none() {
            match selected {
                Some(provider) => provider,
                None => default_provider().await?,
            }
        } else {
            if selected.is_some() || !model.is_empty() {
                return Err("agent_continuation_override");
            }
            Provider::Claude
        }; // new_job reads the parent's provider under the store lock.
        return tokio::task::spawn_blocking(move || new_job(context, provider, model))
            .await
            .map_err(|_| "agent_worker_failed")?;
    }
    let method = method.to_owned();
    let params = params.clone();
    tokio::task::spawn_blocking(move || {
        let store = Store::open()?;
        if method == "agent.jobsList" {
            let jobs = list(&store)?;
            let offset = params
                .get("offset")
                .map(|value| value.as_u64().ok_or("invalid_params"))
                .transpose()?
                .unwrap_or(0) as usize;
            let mut page: Vec<_> = jobs.iter().skip(offset).take(32).cloned().collect();
            return if params["paged"] == true {
                let more = offset.saturating_add(page.len()) < jobs.len();
                let watch = params
                    .get("watchIds")
                    .map(|value| {
                        value
                            .as_array()
                            .filter(|ids| ids.len() <= 4)
                            .ok_or("invalid_params")
                    })
                    .transpose()?;
                if let Some(watch) = watch {
                    for id in watch {
                        check_id(text(id)?)?;
                    }
                }
                // Paging history must not hide live work or its terminal update
                // from cancellation controls and pending-message dispatch.
                for job in &jobs {
                    if (active(job) || watch.is_some_and(|ids| ids.contains(&job["id"])))
                        && !page.iter().any(|row| row["id"] == job["id"])
                    {
                        page.push(job.clone());
                    }
                }
                let page = refresh_page(&store, page)?;
                Ok(json!({"jobs":page,"hasMore":more}))
            } else {
                Ok(json!(refresh_page(&store, page)?))
            };
        }
        let id = params["id"].as_str().ok_or("agent_id_required")?;
        check_id(id)?;
        let mut job = refresh(&store, id)?;
        match method.as_str() {
            "agent.jobShow" => super::history::page(
                &store,
                &job,
                params.get("before").map(text).transpose()?.unwrap_or(""),
            ),
            "agent.jobCancel" => {
                if active(&job) {
                    // Revoke proposal authority under the same lock used by MCP
                    // before delivering an asynchronous process signal.
                    store.write_json(id, "cancel.json", &json!(true))?;
                    if let Some(fd) = process_handle(&job) {
                        #[cfg(target_os = "macos")]
                        if unsafe { libc::write(fd.as_raw_fd(), b"stop".as_ptr().cast(), 4) } != 4 {
                            return Err("agent_cancel_failed");
                        }
                        #[cfg(target_os = "linux")]
                        if unsafe {
                            libc::syscall(
                                libc::SYS_pidfd_send_signal,
                                fd.as_raw_fd(),
                                libc::SIGTERM,
                                std::ptr::null::<libc::siginfo_t>(),
                                0,
                            )
                        } < 0
                        {
                            return Err("agent_cancel_failed");
                        }
                    } else {
                        job["state"] = json!("cancelled");
                        job["updated"] = json!(now());
                        store.write_json(id, "job.json", &job)?;
                    }
                }
                Ok(job)
            }
            "agent.jobForget" => {
                if active(&job) {
                    return Err("agent_job_active");
                }
                let conversation = job["conversationId"].as_str().unwrap_or(id);
                let mut ids = Vec::new();
                for id in store.ids()? {
                    let candidate = refresh(&store, &id)?;
                    if candidate["conversationId"].as_str().unwrap_or(&id) == conversation {
                        if active(&candidate) {
                            return Err("agent_job_active");
                        }
                        ids.push(id);
                    }
                }
                for id in ids {
                    store.remove(&id)?;
                }
                Ok(json!({}))
            }
            _ => Err("unknown_method"),
        }
    })
    .await
    .map_err(|_| "agent_worker_failed")?
}

fn refresh_page(store: &Store, page: Vec<Value>) -> Result<Vec<Value>> {
    page.into_iter()
        .map(|job| refresh(store, job["id"].as_str().unwrap()))
        .collect()
}

fn bounded_projection_jobs(jobs: &[Value]) -> Result<()> {
    if jobs.len() > 40 {
        return Err("agent_invalid_jobs");
    }
    let mut budget = 0usize;
    for job in jobs {
        let object = job.as_object().ok_or("agent_invalid_jobs")?;
        for (key, value) in object {
            match key.as_str() {
                "id" | "accountId" | "subject" | "messageId" | "draftKey" | "draftFingerprint"
                | "conversationId" | "requestPreview" | "kind" | "state" | "provider"
                | "resume" | "sessionId" | "error" | "progress" | "question" | "summary" => {
                    if text(value)?.len() > 16 * 1024 + 64 {
                        return Err("agent_invalid_jobs");
                    }
                }
                "created" | "createdOrder" | "updated" | "pid" | "displayVersion" => {
                    value.as_u64().ok_or("agent_invalid_jobs")?;
                }
                "resultReady" | "canContinue" | "stopUnconfirmed" => {
                    value.as_bool().ok_or("agent_invalid_jobs")?;
                }
                "model" => {
                    super::provider::validate_model(value.as_str().ok_or("agent_invalid_jobs")?)?;
                }
                "messageIds" => {
                    let ids = value
                        .as_array()
                        .filter(|ids| ids.len() <= 20)
                        .ok_or("agent_invalid_jobs")?;
                    for id in ids {
                        if text(id)?.len() > 4096 {
                            return Err("agent_invalid_jobs");
                        }
                    }
                }
                "events" => {
                    if job["kind"] != "events" {
                        return Err("agent_invalid_jobs");
                    }
                    super::events::validate(value).map_err(|_| "agent_invalid_jobs")?;
                }
                _ => return Err("agent_invalid_jobs"),
            }
        }
        let size = serde_json::to_vec(job)
            .map_err(|_| "agent_invalid_jobs")?
            .len();
        if size > 32 * 1024 {
            return Err("agent_invalid_jobs");
        }
        // Each row may occur in two message maps, a selected scope, its history,
        // its turn list, and the completion list. Reserve all copies before any
        // projection clone; never let an RPC-sized input multiply into memory.
        let ids = job["messageIds"].as_array().map_or(0, Vec::len)
            + usize::from(job["messageId"].as_str().is_some_and(|s| !s.is_empty()));
        budget = budget
            .checked_add(size.saturating_mul(2 * ids + 6))
            .ok_or("agent_invalid_jobs")?;
        if budget > 8 * 1024 * 1024 {
            return Err("agent_projection_too_large");
        }
    }
    Ok(())
}

/// Presentation projections from validated jobs; acknowledgement remains UI-owned.
pub fn projection(params: &Value) -> Result<Value> {
    let jobs = params["jobs"]
        .as_array()
        .filter(|v| v.len() <= 40)
        .ok_or("agent_invalid_jobs")?;
    bounded_projection_jobs(jobs)?;
    let before = params
        .get("before")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let seen = params
        .get("seenIds")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    bounded_projection_jobs(before)?;
    if before.len() > 40
        || seen.len() > 4096
        || seen
            .iter()
            .any(|id| id.as_str().is_none_or(|s| s.len() > 128))
    {
        return Err("agent_invalid_jobs");
    }
    let owner = params["accountId"].as_str().unwrap_or("");
    let mut accounts: std::collections::BTreeMap<String, serde_json::Map<String, Value>> =
        std::collections::BTreeMap::new();
    let order = |j: &Value| {
        j["createdOrder"].as_u64().unwrap_or(
            j["created"]
                .as_u64()
                .unwrap_or(0)
                .saturating_mul(1_000_000_000),
        )
    };
    let look = |j: &Value| j["kind"] == "events";
    let attention = |j: &Value| {
        !look(j)
            && !seen.contains(&j["id"])
            && (j["resultReady"] == true || matches!(j["state"].as_str(), Some("done" | "failed")))
    };
    // A look answers to the message it read, inside its account: the one
    // running, else the newest that finished. A look that failed or was
    // cancelled answered nothing and is not here, so the message may be
    // looked at again.
    let mut looks: std::collections::BTreeMap<String, serde_json::Map<String, Value>> =
        std::collections::BTreeMap::new();
    for j in jobs.iter().filter(|j| look(j)) {
        let (Some(account), Some(id)) = (
            j["accountId"].as_str().filter(|s| !s.is_empty()),
            j["messageId"].as_str().filter(|s| !s.is_empty()),
        ) else {
            continue;
        };
        if !active(j) && j["state"] != "done" {
            continue;
        }
        let map = looks.entry(account.to_owned()).or_default();
        if map
            .get(id)
            .is_none_or(|current| active(j) || (!active(current) && order(j) > order(current)))
        {
            map.insert(id.to_owned(), j.clone());
        }
    }
    for j in jobs.iter().filter(|j| !look(j)) {
        let Some(account) = j["accountId"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let map = accounts.entry(account.to_owned()).or_default();
        let mut ids = j["messageIds"].as_array().cloned().unwrap_or_default();
        if let Some(s) = j["messageId"].as_str().filter(|s| !s.is_empty())
            && !ids.contains(&json!(s))
        {
            ids.push(json!(s));
        }
        for id in ids {
            let Some(id) = id.as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            if map
                .get(id)
                .is_none_or(|current| active(j) || (!active(current) && order(j) > order(current)))
            {
                map.insert(id.to_owned(), j.clone());
            }
        }
    }
    let mut scopes: std::collections::BTreeMap<
        String,
        std::collections::BTreeMap<String, Vec<Value>>,
    > = std::collections::BTreeMap::new();
    for job in jobs.iter().filter(|j| !look(j)) {
        let Some(account) = job["accountId"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let key = if job["kind"] == "draft" {
            format!("draft:{}", job["draftKey"].as_str().unwrap_or(""))
        } else {
            let mut ids = job["messageIds"].as_array().cloned().unwrap_or_default();
            if let Some(id) = job["messageId"].as_str().filter(|s| !s.is_empty())
                && !ids.contains(&json!(id))
            {
                ids.push(json!(id));
            }
            ids.sort_by(|a, b| {
                a.as_str()
                    .unwrap_or("")
                    .encode_utf16()
                    .cmp(b.as_str().unwrap_or("").encode_utf16())
            });
            serde_json::to_string(&ids).map_err(|_| "agent_invalid_jobs")?
        };
        scopes
            .entry(account.to_owned())
            .or_default()
            .entry(key)
            .or_default()
            .push(job.clone());
    }
    let mut scope_projection = serde_json::Map::new();
    for (account, groups) in scopes {
        let mut mapped = serde_json::Map::new();
        for (key, mut entries) in groups {
            let chosen = entries
                .iter()
                .find(|j| active(j))
                .cloned()
                .or_else(|| entries.iter().max_by_key(|j| order(j)).cloned())
                .unwrap_or(Value::Null);
            entries.sort_by_key(|j| std::cmp::Reverse(order(j)));
            let mut conversations = std::collections::HashSet::new();
            let history = entries
                .iter()
                .filter(|j| {
                    conversations.insert(
                        j["conversationId"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .unwrap_or(j["id"].as_str().unwrap_or(""))
                            .to_owned(),
                    )
                })
                .cloned()
                .collect::<Vec<_>>();
            mapped.insert(key, json!({"job":chosen,"history":history,"jobs":entries}));
        }
        scope_projection.insert(account, Value::Object(mapped));
    }
    let map = accounts.get(owner).cloned().unwrap_or_default();
    let mut attention_map = serde_json::Map::new();
    for (id, j) in &map {
        if attention(j) {
            attention_map.insert(id.clone(), json!(true));
        }
    }
    let finished = jobs
        .iter()
        .filter(|j| !active(j) && before.iter().any(|old| old["id"] == j["id"] && active(old)))
        .cloned()
        .collect::<Vec<_>>();
    Ok(
        json!({"scopesByAccount":scope_projection,"attentionIds":jobs.iter().filter(|j|attention(j)).map(|j|j["id"].clone()).collect::<Vec<_>>(),"byAccount":accounts,"byMessage":map,"anyActive":jobs.iter().any(active),"attention":jobs.iter().any(attention),"attentionByMessage":attention_map,"activeIds":jobs.iter().filter(|j|active(j)).map(|j|j["id"].clone()).collect::<Vec<_>>(),"finishedIds":jobs.iter().filter(|j|!active(j)).map(|j|j["id"].clone()).collect::<Vec<_>>(),"newlyFinished":finished,"eventLooks":looks,"activeEventLooks":jobs.iter().filter(|j|look(j)&&active(j)).count()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_poll_reads_only_heads_and_invalidates_after_creation_or_removal() {
        struct Temp(std::path::PathBuf);
        impl Drop for Temp {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let temp = Temp(std::env::temp_dir().canonicalize().unwrap().join(format!(
                "omamail-head-index-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )));
        std::fs::create_dir(&temp.0).unwrap();
        let store = Store::open_at(&temp.0).unwrap();
        let make = |id: &str, conversation: &str, order: u64, state: &str| {
            store.create(id).unwrap();
            let job = json!({"id":id,"conversationId":conversation,"accountId":"synthetic",
                "subject":"Mail","messageId":"m","messageIds":["m"],"draftKey":"","draftFingerprint":"",
                "kind":"message","state":state,"created":now(),"updated":now(),"createdOrder":order,"resultReady":false});
            store.write_json(id, "job.json", &job).unwrap();
            job
        };
        let first = format!("{:032x}", 0);
        for n in 0..320 {
            let id = format!("{n:032x}");
            make(&id, &first, n, "done");
            if n > 0 {
                store
                    .write_json(&format!("{:032x}", n - 1), "next.json", &json!(id))
                    .unwrap();
            }
        }
        assert_eq!(list(&store).unwrap().len(), 1);
        store.reads.set(0);
        let page = refresh_page(&store, list(&store).unwrap()).unwrap();
        assert_eq!(page[0]["id"], format!("{:032x}", 319));
        assert!(
            store.reads.get() <= 4,
            "poll reread {} records",
            store.reads.get()
        );

        let independent = format!("{:032x}", 1000);
        let mut job = make(&independent, &independent, 1000, "queued");
        assert_eq!(list(&store).unwrap().len(), 2);
        job["state"] = json!("done");
        store.write_json(&independent, "job.json", &job).unwrap();
        assert_eq!(list(&store).unwrap()[0]["state"], "done");
        store.remove(&independent).unwrap();
        assert_eq!(list(&store).unwrap().len(), 1);

        // Cached metadata never bypasses validation of the displayed page.
        let head = format!("{:032x}", 319);
        store
            .write_json(&head, "job.json", &json!({"id":"forged"}))
            .unwrap();
        assert!(refresh_page(&store, list(&store).unwrap()).is_err());
    }
    #[test]
    fn context_rejects_overrides_controls_and_injected_ids() {
        let good = json!({"accountId":"hey:a@example.org","messageId":"1:2","message":"Unicode郵件\nquoted \\\" body","prompt":"Summarize"});
        assert!(validate_payload(&good).is_ok());
        for bad in [
            json!({"parent":"a".repeat(32),"prompt":"next","accountId":"other"}),
            json!({"parent":"../../outside","prompt":"next"}),
            json!({"messageId":"1","prompt":"secret\u{001b}"}),
            json!({"messageId":"1","prompt":"okay","command":"evil"}),
            json!({"messageId":"1","prompt":"okay","draft":{"shell":"evil"}}),
        ] {
            assert!(validate_payload(&bad).is_err());
        }
        assert!(validate_payload(&json!({"parent":"a".repeat(32),"prompt":"next"})).is_ok());
    }
    #[test]
    fn projection_is_account_bound_and_acknowledgement_is_not_persisted() {
        let active_job = json!({"id":"1","accountId":"a","messageId":"same","messageIds":["same","two"],"state":"running","created":1});
        let done = json!({"id":"2","accountId":"b","messageId":"same","state":"done","resultReady":true,"created":2});
        let params = json!({"jobs":[active_job,done],"accountId":"a","seenIds":["2"]});
        let p = projection(&params).unwrap();
        assert_eq!(p["byMessage"]["same"]["id"], "1");
        assert_eq!(p["byMessage"]["two"]["id"], "1");
        assert_eq!(p["byAccount"]["b"]["same"]["id"], "2");
        assert_eq!(p["attention"], false);
        assert_eq!(p["anyActive"], true);
        let mut after = params.clone();
        after["before"] = params["jobs"].clone();
        after["jobs"][0]["state"] = json!("failed");
        assert_eq!(
            projection(&after).unwrap()["newlyFinished"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn projection_refuses_amplifying_metadata_before_building_maps() {
        let many = json!({"id":"one","accountId":"a","messageIds":vec!["x";21]});
        assert!(projection(&json!({"jobs":[many],"accountId":"a"})).is_err());
        let extra =
            json!({"id":"one","accountId":"a","messageIds":["x"],"raw":"x".repeat(1024*1024)});
        assert!(projection(&json!({"jobs":[extra],"accountId":"a"})).is_err());
        let mut large = json!({"id":"one","accountId":"a","messageIds":vec!["x";20],"subject":"x".repeat(4096),"error":"x".repeat(4096),"progress":"x".repeat(4096)});
        assert!(projection(&json!({"jobs":vec![large.clone();32],"accountId":"a"})).is_err());
        large["subject"] = json!("x".repeat(16 * 1024 + 65));
        assert!(projection(&json!({"jobs":[large],"accountId":"a"})).is_err());
    }
    #[test]
    fn native_scope_history_keeps_latest_turn_and_active_selection() {
        let job = |id: &str, state: &str, order: u64, conversation: &str| json!({"id":id,"accountId":"a","kind":"message","messageIds":["2","1"],"messageId":"1","state":state,"createdOrder":order,"conversationId":conversation});
        let mut draft = job("d", "done", 6, "draft-conversation");
        draft["kind"] = json!("draft");
        draft["draftKey"] = json!("draft1");
        let p=projection(&json!({"jobs":[job("new","done",5,"c"),job("active","running",3,"other"),job("old","done",1,"c"),draft],"accountId":"a"})).unwrap();
        let group = &p["scopesByAccount"]["a"]["[\"1\",\"2\"]"];
        assert_eq!(group["job"]["id"], "active");
        assert_eq!(group["history"].as_array().unwrap().len(), 2);
        assert_eq!(group["history"][0]["id"], "new");
        assert_eq!(
            p["scopesByAccount"]["a"]["draft:draft1"]["jobs"][0]["id"],
            "d"
        );
    }
    #[test]
    fn native_draft_context_matches_original_ui_oracle() {
        use std::io::Write;
        let script = r#"const A=require('./ui/tests/load.js').load('tests/oracles/agent/Agent.js'); const p=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(A.draftPayload(p.draftFields,p.ask,p.account,p.accountId));"#;
        for fields in [
            json!({"draftKey":"k","from":"","to":"Ada <ada@example.org>","subject":" 郵件 مرحبا ","body":"Unicode 😀\nquotes \" \\"}),
            json!({"draftKey":"k","subject":" ","body":""}),
        ] {
            let input = json!({"draftFields":fields,"ask":" Rewrite ","account":"owner@example.org","accountId":"imap:owner@example.org"});
            let mut child = std::process::Command::new("node")
                .args(["-e", script])
                .current_dir(env!("CARGO_MANIFEST_DIR"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(serde_json::to_string(&input).unwrap().as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            let mut expected: Value = serde_json::from_slice(&output.stdout).unwrap();
            // The historical oracle predates recipient-complete draft snapshots.
            expected["draft"]["cc"] = json!("");
            expected["draft"]["bcc"] = json!("");
            assert_eq!(draft_payload(&input).unwrap(), expected);
        }
    }
    #[test]
    fn legacy_worker_compatibility_accepts_only_known_exact_script_argv() {
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("scripts/agent-job.py")
            .canonicalize()
            .unwrap();
        let exe = std::env::current_exe().unwrap();
        let id = "a".repeat(32);
        let valid = [
            b"python3".as_slice(),
            script.as_os_str().as_encoded_bytes(),
            b"run",
            id.as_bytes(),
            b"",
        ]
        .join(&0);
        assert!(legacy_worker_args(&valid, &exe, &id));
        for args in [
            [
                b"python3".as_slice(),
                b"/tmp/attacker/agent-job.py",
                b"run",
                id.as_bytes(),
                b"",
            ]
            .join(&0),
            [
                b"python3".as_slice(),
                script.as_os_str().as_encoded_bytes(),
                b"run",
                b"other-id",
                b"",
            ]
            .join(&0),
            [
                b"python3".as_slice(),
                script.as_os_str().as_encoded_bytes(),
                b"-c",
                id.as_bytes(),
                b"",
            ]
            .join(&0),
        ] {
            assert!(!legacy_worker_args(&args, &exe, &id));
        }
    }
    #[test]
    fn a_look_is_one_message_with_the_flag_and_nothing_else() {
        let look = json!({"accountId":"imap:a@example.org","messageId":"42:INBOX","account":"a@example.org","folder":"INBOX","subject":"Dinner","prompt":"Find the calendar events in this message.","message":"Dinner Thursday at 7pm?","events":true});
        assert!(validate_payload(&look).is_ok());
        for bad in [
            json!({"accountId":"a","messageId":"1","prompt":"p","message":"m","events":false}),
            json!({"accountId":"a","messageId":"1","prompt":"p","message":"m","events":"yes"}),
            json!({"accountId":"a","messageId":"","messages":[{"messageId":"1","message":"m"}],"prompt":"p","events":true}),
            json!({"accountId":"a","messageId":"1","prompt":"p","draft":{"body":"b"},"events":true}),
            json!({"parent":"a".repeat(32),"prompt":"next","events":true}),
        ] {
            assert!(validate_payload(&bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn a_look_is_found_by_its_message_and_draws_no_row() {
        let look = |id: &str, account: &str, message: &str, state: &str, order: u64| {
            json!({"id":id,"accountId":account,"kind":"events","messageId":message,"messageIds":[message],"state":state,"createdOrder":order,"created":order,
            "events":if state=="done"{json!([{"title":"Dinner","startMs":1_789_232_400_000i64,"endMs":1_789_239_600_000i64,"allDay":false}])}else{json!([])}})
        };
        let ask = json!({"id":"ask","accountId":"a","kind":"message","messageId":"42","messageIds":["42"],"state":"done","resultReady":true,"createdOrder":9});
        let jobs = json!([
            look("old", "a", "42", "done", 1),
            look("new", "a", "42", "done", 2),
            look("run", "a", "43", "running", 3),
            look("dead", "a", "44", "failed", 4),
            look("gone", "a", "45", "cancelled", 5),
            look("bobs", "b", "42", "done", 6),
            ask
        ]);
        let p = projection(&json!({"jobs":jobs,"accountId":"a","seenIds":[]})).unwrap();
        // The row's job is the ask, never the look, and only the ask glows.
        assert_eq!(p["byMessage"]["42"]["id"], "ask");
        assert_eq!(p["byMessage"].get("43"), None);
        assert_eq!(p["attentionIds"], json!(["ask"]));
        assert!(
            p["scopesByAccount"]["a"].get("[\"43\"]").is_none(),
            "a look has no scope"
        );
        // But it is polled while it runs, and it is counted.
        assert_eq!(p["anyActive"], true);
        assert_eq!(p["activeIds"], json!(["run"]));
        assert_eq!(p["activeEventLooks"], 1);
        // The newest finished look at a message, in its own account; a failed
        // or cancelled one answered nothing and leaves the message open.
        assert_eq!(p["eventLooks"]["a"]["42"]["id"], "new");
        assert_eq!(p["eventLooks"]["a"]["42"]["events"][0]["title"], "Dinner");
        assert_eq!(p["eventLooks"]["a"]["43"]["id"], "run");
        assert_eq!(p["eventLooks"]["a"].get("44"), None);
        assert_eq!(p["eventLooks"]["a"].get("45"), None);
        assert_eq!(p["eventLooks"]["b"]["42"]["id"], "bobs");
        // A running look outranks a finished one on the same message.
        let again = projection(&json!({"jobs":[look("new","a","42","done",2),look("later","a","42","running",7)],"accountId":"a"})).unwrap();
        assert_eq!(again["eventLooks"]["a"]["42"]["id"], "later");
        // The events record is validated before any map is built, and only
        // on a look.
        let mut ask_with_events = jobs[6].clone();
        ask_with_events["events"] = json!([]);
        assert!(projection(&json!({"jobs":[ask_with_events],"accountId":"a"})).is_err());
        let mut bad = look("x", "a", "1", "done", 1);
        bad["events"] = json!([{"title":"T","startMs":1,"shell":"rm"}]);
        assert!(projection(&json!({"jobs":[bad],"accountId":"a"})).is_err());
    }
    #[test]
    fn session_id_is_only_uuid() {
        assert!(session("12345678-1234-abcd-0123-123456789abc"));
        for bad in ["--resume", "12345678-1234-abcd-0123-123456789abc\n", ""] {
            assert!(!session(bad));
        }
    }
}
