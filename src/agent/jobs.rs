//! Durable background assistant admission and lifecycle. Mail never crosses argv.
use super::{
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
pub fn validate_payload(value: &Value) -> Result<Value> {
    let o = value.as_object().ok_or("agent_invalid_context")?;
    if serde_json::to_vec(value)
        .map_err(|_| "agent_invalid_context")?
        .len()
        > INPUT_LIMIT
    {
        return Err("agent_context_too_large");
    }
    if o.contains_key("parent") && (o.len() != 2 || !o.contains_key("prompt")) {
        return Err("agent_continuation_override");
    }
    for (k, v) in o {
        match k.as_str() {
            "messages" => {
                let entries = v
                    .as_array()
                    .filter(|a| !a.is_empty() && a.len() <= 20)
                    .ok_or("agent_invalid_messages")?;
                for e in entries {
                    let e = e
                        .as_object()
                        .filter(|a| {
                            a.len() == 2 && a.contains_key("messageId") && a.contains_key("message")
                        })
                        .ok_or("agent_invalid_messages")?;
                    for v in e.values() {
                        text(v)?;
                    }
                }
            }
            "draft" => {
                let d = v.as_object().ok_or("agent_invalid_draft")?;
                for (k, v) in d {
                    if !["to", "subject", "body", "from"].contains(&k.as_str()) {
                        return Err("agent_invalid_draft");
                    }
                    text(v)?;
                }
            }
            "accountId" | "account" | "messageId" | "subject" | "prompt" | "message"
            | "draftKey" | "draftFingerprint" | "parent" | "folder" => {
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
    let serialized =
        serde_json::to_string(&[&from, &to, &subject, &body]).map_err(|_| "agent_invalid_draft")?;
    // Match the existing UI-only change indicator, including JavaScript f64 multiplication.
    let mut hash = 2166136261u32;
    for code in serialized.encode_utf16() {
        let signed = (hash ^ code as u32) as i32;
        hash = ((signed as f64 * 16777619f64).rem_euclid(4294967296f64)) as u32;
    }
    let account = text(&value["account"])?;
    let owner = text(&value["accountId"])?;
    let title = subject.trim();
    validate_payload(
        &json!({"messageId":"","accountId":owner,"draftKey":get("draftKey")?,"draftFingerprint":hash.to_string(),"draft":{"from":if from.is_empty(){account}else{&from},"to":to,"subject":subject,"body":body},"account":account,"subject":if title.is_empty(){"Draft".to_owned()}else{format!("Draft: {title}")},"prompt":text(&value["ask"])?.trim(),"message":""}),
    )
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
    if !["draft", "message"].contains(&v["kind"].as_str().unwrap_or(""))
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
    if v.get("provider").is_some_and(|x| x != "claude") {
        return Err("agent_invalid_provider");
    }
    for k in ["sessionId", "resume"] {
        if let Some(x) = v.get(k) {
            let s = text(x)?;
            if !s.is_empty() && !session(s) {
                return Err("agent_invalid_session");
            }
        }
    }
    for key in ["error", "progress"] {
        if let Some(e) = v.get(key) {
            text(e)?;
        }
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
    if !s.is_empty() && !session(s) {
        return Err("agent_invalid_session");
    }
    Ok(v)
}
fn active(v: &Value) -> bool {
    matches!(v["state"].as_str(), Some("queued" | "running"))
}
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
fn refresh(store: &Store, id: &str) -> Result<Value> {
    let mut job = read_job(store, id)?;
    if (job["state"] == "queued" && now().saturating_sub(job["created"].as_u64().unwrap()) > 30)
        || (job["state"] == "running" && process_handle(&job).is_none())
    {
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
    job["canContinue"] = json!(ready && job["sessionId"].as_str().is_some_and(session));
    Ok(job)
}
fn list(store: &Store) -> Result<Vec<Value>> {
    let mut jobs = store
        .ids()?
        .into_iter()
        .map(|id| refresh(store, &id))
        .collect::<Result<Vec<_>>>()?;
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
    Ok(jobs)
}
async fn default_provider() -> Result<()> {
    let out = crate::process::async_run::run(
        "omarchy-default-agent",
        &[],
        &[],
        Duration::from_secs(5),
        4096,
    )
    .await?;
    if !out.success || std::str::from_utf8(&out.stdout).unwrap_or("").trim() != "claude" {
        return Err("agent_choose_claude");
    }
    Ok(())
}
fn new_job(context: Value) -> Result<Value> {
    let store = Store::open()?;
    let existing = list(&store)?;
    let mut history = vec![];
    let mut resume = String::new();
    let mut conversation = String::new();
    let mut context = context;
    if let Some(parent) = context["parent"].as_str() {
        let parent = parent.to_owned();
        let job = refresh(&store, &parent)?;
        if job["canContinue"] != true {
            return Err("agent_parent_not_ready");
        }
        resume = job["sessionId"].as_str().unwrap_or("").to_owned();
        conversation = job["conversationId"].as_str().unwrap_or(&parent).to_owned();
        history = saved_display(&store, &parent)?["transcript"]
            .as_array()
            .unwrap()
            .clone();
        let mut previous = store
            .read_json(&parent, "context.json", INPUT_LIMIT)?
            .ok_or("agent_context_missing")?;
        // Persisted continuation contexts inherit mail fields; validate the original projection independently.
        previous
            .as_object_mut()
            .ok_or("agent_invalid_context")?
            .remove("parent");
        validate_payload(&previous)?;
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
    let mut retained = existing.len();
    for old in existing.iter().rev() {
        if retained < 32 {
            break;
        }
        if !active(old) {
            store.remove(old["id"].as_str().unwrap())?;
            retained -= 1;
        }
    }
    let mut random = [0u8; 16];
    let got = unsafe { libc::getrandom(random.as_mut_ptr().cast(), random.len(), 0) };
    if got != 16 {
        return Err("agent_random_failed");
    }
    let id = random
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    store.create(&id)?;
    let mut job = json!({"id":id,"conversationId":if conversation.is_empty(){id.clone()}else{conversation},"requestPreview":context["prompt"].as_str().unwrap().split_whitespace().collect::<Vec<_>>().join(" ").chars().take(120).collect::<String>().trim_end(),"kind":if context["draft"].is_object(){"draft"}else{"message"},"messageIds":[],"state":"queued","created":now(),"createdOrder":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos().min(u64::MAX as u128)as u64,"updated":now(),"resultReady":false,"canContinue":false,"provider":"claude","resume":resume,"progress":"Starting..."});
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
    store.write_json(&id, "job.json", &job)?;
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
    if method == "agent.jobsProjection" {
        return projection(params);
    }
    if method == "agent.jobStart" {
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
        if context.get("parent").is_none() {
            default_provider().await?;
        }
        return tokio::task::spawn_blocking(move || new_job(context))
            .await
            .map_err(|_| "agent_worker_failed")?;
    }
    let method = method.to_owned();
    let params = params.clone();
    tokio::task::spawn_blocking(move || {
        let store = Store::open()?;
        if method == "agent.jobsList" {
            return Ok(json!(list(&store)?));
        }
        let id = params["id"].as_str().ok_or("agent_id_required")?;
        check_id(id)?;
        let mut job = refresh(&store, id)?;
        match method.as_str() {
            "agent.jobShow" => {
                let d = saved_display(&store, id)?;
                Ok(json!({"job":job,"output":d["output"],"transcript":d["transcript"]}))
            }
            "agent.jobCancel" => {
                if active(&job) {
                    if let Some(fd) = process_handle(&job) {
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
                store.remove(id)?;
                Ok(json!({}))
            }
            _ => Err("unknown_method"),
        }
    })
    .await
    .map_err(|_| "agent_worker_failed")?
}

fn bounded_projection_jobs(jobs: &[Value]) -> Result<()> {
    if jobs.len() > 32 {
        return Err("agent_invalid_jobs");
    }
    let mut budget = 0usize;
    for job in jobs {
        let object = job.as_object().ok_or("agent_invalid_jobs")?;
        for (key, value) in object {
            match key.as_str() {
                "id" | "accountId" | "subject" | "messageId" | "draftKey" | "draftFingerprint"
                | "conversationId" | "requestPreview" | "kind" | "state" | "provider"
                | "resume" | "sessionId" | "error" | "progress" | "question" => {
                    if text(value)?.len() > 16 * 1024 + 64 {
                        return Err("agent_invalid_jobs");
                    }
                }
                "created" | "createdOrder" | "updated" | "pid" => {
                    value.as_u64().ok_or("agent_invalid_jobs")?;
                }
                "resultReady" | "canContinue" => {
                    value.as_bool().ok_or("agent_invalid_jobs")?;
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
        .filter(|v| v.len() <= 32)
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
    if before.len() > 32
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
    let attention = |j: &Value| {
        !seen.contains(&j["id"])
            && (j["resultReady"] == true || matches!(j["state"].as_str(), Some("done" | "failed")))
    };
    for j in jobs {
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
    for job in jobs {
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
        json!({"scopesByAccount":scope_projection,"attentionIds":jobs.iter().filter(|j|attention(j)).map(|j|j["id"].clone()).collect::<Vec<_>>(),"byAccount":accounts,"byMessage":map,"anyActive":jobs.iter().any(active),"attention":jobs.iter().any(attention),"attentionByMessage":attention_map,"activeIds":jobs.iter().filter(|j|active(j)).map(|j|j["id"].clone()).collect::<Vec<_>>(),"finishedIds":jobs.iter().filter(|j|!active(j)).map(|j|j["id"].clone()).collect::<Vec<_>>(),"newlyFinished":finished}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
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
            let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
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
    fn session_id_is_only_uuid() {
        assert!(session("12345678-1234-abcd-0123-123456789abc"));
        for bad in ["--resume", "12345678-1234-abcd-0123-123456789abc\n", ""] {
            assert!(!session(bad));
        }
    }
}
