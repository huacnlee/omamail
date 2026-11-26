//! HEY reads through the official executable. No private HTTP endpoints.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::time::Duration;

fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.trim().into(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}
fn valid(value: &str) -> bool {
    value.len() <= 8192 && !value.chars().any(char::is_control)
}
fn number(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}
fn envelope(bytes: &[u8]) -> Result<Value, &'static str> {
    let result: Value = serde_json::from_slice(bytes).map_err(|_| "HEY returned invalid JSON")?;
    if !result.is_object() || result["ok"] != true {
        return Err("HEY refused the request");
    }
    Ok(result)
}
async fn run(args: &[String]) -> Result<Value, &'static str> {
    let output = crate::process::async_run::run(
        &super::hey_access::program()?,
        args,
        b"",
        Duration::from_secs(60),
        16 * 1024 * 1024,
    )
    .await?;
    if !output.success {
        return Err("HEY refused the request");
    }
    envelope(&output.stdout)
}
fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| (*s).into()).collect()
}

struct Query {
    kind: String,
    argument: String,
    unseen: bool,
}
fn query(raw: &str) -> Result<Query, &'static str> {
    let raw = raw.trim();
    let (kind, argument, unseen) = if raw == "drafts:" {
        ("drafts", "".into(), false)
    } else if let Some(label) = raw.strip_prefix("label:") {
        if !number(label.trim()) {
            return Err("Invalid HEY label");
        }
        ("label", label.trim().into(), false)
    } else if let Some(search) = raw.strip_prefix("search:") {
        // CLI flag parsers can interpret positional strings beginning with '-'.
        if search.trim().starts_with('-') {
            return Err("HEY search cannot start with a flag");
        }
        ("search", search.trim().into(), false)
    } else {
        let mut words = raw
            .strip_prefix("box:")
            .unwrap_or("imbox")
            .split_whitespace();
        let box_name = words.next().unwrap_or("imbox").to_lowercase();
        let unseen = words.any(|s| s.eq_ignore_ascii_case("unseen"));
        if box_name == "trash" {
            ("trash", "".into(), unseen)
        } else {
            (
                "box",
                if [
                    "imbox",
                    "feedbox",
                    "asidebox",
                    "laterbox",
                    "trailbox",
                    "bubblebox",
                ]
                .contains(&box_name.as_str())
                {
                    box_name
                } else {
                    "imbox".into()
                },
                unseen,
            )
        }
    };
    Ok(Query {
        kind: kind.into(),
        argument,
        unseen,
    })
}
fn command(q: &Query, cursor: &str) -> Vec<String> {
    let mut args = match q.kind.as_str() {
        "drafts" => strings(&["draft", "list", "--json"]),
        "trash" => strings(&["search", "--in", "trash", "--json"]),
        "label" => strings(&["label", &q.argument, "--json"]),
        "search" => strings(&["search", &q.argument, "--json"]),
        _ => strings(&["box", &q.argument, "--json"]),
    };
    if q.unseen && q.kind == "box" {
        args.extend(strings(&["--limit", "100"]));
    }
    if !cursor.is_empty() {
        args.extend(strings(&["--page", cursor]));
    }
    args
}
fn header(headers: &mut Vec<Value>, name: &str, value: String) {
    if !value.is_empty() {
        headers.push(json!({"name": name, "value": value}));
    }
}
fn address(contact: &Value) -> String {
    let email = text(&contact["email_address"]);
    let name = text(&contact["name"]);
    if name.is_empty() {
        email
    } else {
        format!(
            "\"{}\" <{}>",
            name.replace('\\', "\\\\").replace('"', "\\\""),
            email
        )
    }
}
fn resource(id: &str, row: &Value, body: &str, draft: bool, search: bool, box_name: &str) -> Value {
    let mut headers = vec![];
    let sender = if !text(&row["creator"]["email_address"]).is_empty() {
        &row["creator"]
    } else {
        &row["contacts"][0]
    };
    let mut sender = sender.clone();
    if !text(&row["alternative_sender_name"]).is_empty() {
        if !sender.is_object() {
            sender = json!({});
        }
        sender["name"] = row["alternative_sender_name"].clone();
    }
    header(&mut headers, "From", address(&sender));
    if let Some(to) = row["addressed_contacts"].as_array() {
        header(
            &mut headers,
            "To",
            to.iter()
                .map(address)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", "),
        );
    }
    for (key, name) in [("to", "To"), ("cc", "Cc"), ("bcc", "Bcc")] {
        if draft && let Some(values) = row[key].as_array() {
            header(
                &mut headers,
                name,
                values.iter().map(text).collect::<Vec<_>>().join(", "),
            );
        }
    }
    let subject = if row.get("subject").is_some() {
        text(&row["subject"])
    } else {
        text(&row["name"])
    };
    header(&mut headers, "Subject", subject);
    let date = ["active_at", "updated_at", "created_at"]
        .iter()
        .map(|k| text(&row[*k]))
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    header(&mut headers, "Date", date.clone());
    let mut labels = vec![];
    if !draft && !search && row["seen"] != true {
        labels.push("UNREAD");
    }
    if box_name == "imbox" {
        labels.push("INBOX");
    }
    if draft {
        labels.push("DRAFT");
    }
    header(
        &mut headers,
        "Content-Type",
        "text/plain; charset=utf-8".into(),
    );
    let stamp = chrono::DateTime::parse_from_rfc3339(&date)
        .map(|d| d.timestamp_millis())
        .ok()
        .or_else(|| {
            mailparse::dateparse(&date)
                .ok()
                .and_then(|v| v.checked_mul(1000))
        })
        .filter(|v| *v > 0)
        .map(|v| v.to_string())
        .unwrap_or_default();
    let topic = if draft {
        ""
    } else {
        id.split_once(':').map(|(_, v)| v).unwrap_or("")
    };
    json!({"id":id,"threadId":topic,
        "thread":{"id":topic,"count":0,"memberIds":[],"unread":labels.contains(&"UNREAD"),"flagged":false},
        "labelIds":labels,"internalDate":stamp,
        "sizeEstimate":body.len(),"snippet":text(&row["summary"]),
        "payload":{"mimeType":"text/plain","headers":headers,"body":{"size":body.len(),"data":URL_SAFE_NO_PAD.encode(body)},"parts":[]}})
}
fn listing(q: &Query, data: &Value) -> Vec<Value> {
    let empty = vec![];
    let entries = data
        .as_array()
        .or_else(|| data["postings"].as_array())
        .unwrap_or(&empty);
    entries
        .iter()
        .filter_map(|entry| {
            if q.unseen && entry["seen"] == true {
                return None;
            }
            let posting = text(&entry["id"]);
            if !number(&posting) {
                return None;
            }
            if q.kind == "drafts" {
                return Some(resource(
                    &format!("draft:{posting}"),
                    entry,
                    "",
                    true,
                    false,
                    "",
                ));
            }
            let search = data.is_array();
            if q.unseen && search {
                return None;
            }
            let topic = if search {
                text(&entry["topic_id"])
            } else {
                text(&entry["app_url"])
                    .split_once("/topics/")
                    .map(|(_, s)| s.chars().take_while(char::is_ascii_digit).collect())
                    .unwrap_or_default()
            };
            if !number(&topic) {
                return None;
            }
            let mut row = entry.clone();
            if search {
                let newest = entry["messages"]
                    .as_array()
                    .and_then(|a| a.last())
                    .unwrap_or(&Value::Null);
                for key in [
                    "creator",
                    "alternative_sender_name",
                    "summary",
                    "created_at",
                ] {
                    row[key] = newest[key].clone();
                }
                row["seen"] = json!(true);
            }
            Some(resource(
                &format!("{posting}:{topic}"),
                &row,
                "",
                false,
                search,
                &text(&data["kind"]),
            ))
        })
        .collect()
}

// A thread response contains bodies, not the posting's subject, unread state,
// or box. The UI may retain those fields from its listing, but a standalone
// read must not invent them. Entry IDs are not routable posting:topic IDs.
fn read_resource(id: &str, data: &Value, draft: bool) -> Result<Value, &'static str> {
    if draft {
        if !data.is_object() {
            return Err("Invalid HEY draft");
        }
        return Ok(resource(
            id,
            data,
            data["body"].as_str().unwrap_or(""),
            true,
            false,
            "",
        ));
    }
    let body = data
        .as_array()
        .ok_or("Invalid HEY thread")?
        .iter()
        .map(|v| text(&v["body"]))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n───\n\n");
    Ok(resource(id, &Value::Null, &body, false, true, ""))
}

// Optional flags are negotiated only on an explicit unknown-flag refusal of a read.
// Mutations are never retried.
async fn read_thread(id: &str, topic: &str) -> Result<Value, &'static str> {
    static DROPPED: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> = std::sync::OnceLock::new();
    let dropped = DROPPED.get_or_init(Default::default);
    let mut args = strings(&["threads", topic, "--json", "--html", "--allow-partial"]);
    args.retain(|arg| {
        !dropped
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(arg)
    });
    loop {
        let out = crate::process::async_run::run(
            &super::hey_access::program()?,
            &args,
            b"",
            Duration::from_secs(20),
            16 * 1024 * 1024,
        )
        .await?;
        let html = String::from_utf8_lossy(&out.stdout);
        let start = html.trim_start().to_ascii_lowercase();
        if out.success && (start.starts_with("<!doctype html") || start.starts_with("<html")) {
            let mut message = resource(id, &Value::Null, &html, false, true, "");
            message["payload"]["mimeType"] = json!("text/html");
            message["payload"]["headers"] =
                json!([{"name":"Content-Type","value":"text/html; charset=utf-8"}]);
            return Ok(message);
        }
        if out.success
            && let Ok(answer) = envelope(&out.stdout)
        {
            return read_resource(id, &answer["data"], false);
        }
        let diagnostics = format!("{}\n{}", html, String::from_utf8_lossy(&out.stderr));
        let missing = ["--html", "--allow-partial"].into_iter().find(|flag| {
            args.iter().any(|arg| arg == flag)
                && diagnostics.contains(&format!("unknown flag: {flag}"))
        });
        if let Some(flag) = missing {
            args.retain(|arg| arg != flag);
            dropped
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(flag.into());
        } else {
            return Err("HEY refused the request");
        }
    }
}

async fn login(method: &str) -> Result<Value, &'static str> {
    type Job = tokio::task::JoinHandle<Result<bool, &'static str>>;
    static JOB: std::sync::OnceLock<tokio::sync::Mutex<Option<Job>>> = std::sync::OnceLock::new();
    let mut job = JOB.get_or_init(Default::default).lock().await;
    if method == "hey.loginCancel" {
        if let Some(handle) = job.take() {
            handle.abort();
            let _ = handle.await;
        }
        return Ok(json!({"running":false}));
    }
    if method == "hey.loginStart" && job.is_none() {
        let program = super::hey_access::program()?;
        *job = Some(tokio::spawn(async move {
            Ok(crate::process::async_run::run(
                &program,
                &strings(&["auth", "login"]),
                b"",
                Duration::from_secs(180),
                1024 * 1024,
            )
            .await?
            .success)
        }));
    }
    if job.as_ref().is_some_and(|handle| handle.is_finished()) {
        let result = job
            .take()
            .unwrap()
            .await
            .map_err(|_| "HEY login interrupted")??;
        return if result {
            Ok(json!({"running":false,"ok":true}))
        } else {
            Err("HEY sign-in did not finish")
        };
    }
    Ok(json!({"running":job.is_some()}))
}

async fn list_request(q: &Query, cursor: &str) -> Result<Value, &'static str> {
    if q.kind != "drafts" {
        return run(&command(q, cursor)).await;
    }
    let program = super::hey_access::program()?;
    let output = crate::process::async_run::run(
        &program,
        &command(q, cursor),
        b"",
        Duration::from_secs(20),
        16 * 1024 * 1024,
    )
    .await?;
    if output.success
        && let Ok(answer) = envelope(&output.stdout)
    {
        return Ok(answer);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let diagnostic = format!("{} {}", stdout, String::from_utf8_lossy(&output.stderr));
    // The initial published CLI calls the read-only index `drafts`.
    // No mutation is ever retried on a usage error.
    if diagnostic.contains("unknown command")
        && (diagnostic.contains("\\\"draft\\\"") || diagnostic.contains("\"draft\""))
    {
        if !cursor.is_empty() {
            return Err("This HEY version cannot page drafts");
        }
        return run(&strings(&["drafts", "--json", "--all"])).await;
    }
    Err("HEY drafts require a newer official CLI")
}

pub async fn call(method: &str, params: &Value) -> Result<Value, &'static str> {
    let fields = params.as_object().ok_or("Invalid HEY parameters")?;
    let allowed: &[&str] = match method {
        "hey.status" | "hey.probe" | "hey.profile" | "hey.sendAs" | "hey.labels"
        | "hey.loginStart" | "hey.loginPoll" | "hey.loginCancel" | "hey.logout" => &[],
        "hey.list" => &["query", "pageToken", "pageSize"],
        "hey.read" => &["id"],
        _ => return Err("Unknown HEY method"),
    };
    if fields.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err("Unknown HEY parameter");
    }
    for (key, value) in fields {
        if key != "pageSize" && !value.as_str().is_some_and(valid) {
            return Err("Invalid HEY parameter");
        }
    }
    if method == "hey.probe" {
        return Ok(json!({"program":super::hey_access::program().unwrap_or_default()}));
    }
    if matches!(
        method,
        "hey.loginStart" | "hey.loginPoll" | "hey.loginCancel"
    ) {
        return login(method).await;
    }
    if method == "hey.logout" {
        let _ = login("hey.loginCancel").await;
        let output = crate::process::async_run::run(
            &super::hey_access::program()?,
            &strings(&["auth", "logout"]),
            b"",
            Duration::from_secs(20),
            1024 * 1024,
        )
        .await?;
        return if output.success {
            Ok(json!({"ok":true}))
        } else {
            Err("HEY logout did not finish")
        };
    }
    if method == "hey.profile" || method == "hey.sendAs" {
        let answer = run(&strings(&["accounts", "list", "--json"])).await?;
        let email = answer["data"]
            .as_array()
            .ok_or("Invalid HEY accounts")?
            .iter()
            .filter(|row| row["id"] != "all")
            .filter_map(|row| row["email"].as_str())
            .find(|email| !email.trim().is_empty())
            .ok_or("Invalid HEY identity")?;
        return Ok(if method == "hey.sendAs" {
            json!([{ "email":email, "displayName":"", "isPrimary":true, "isDefault":true }])
        } else {
            json!({"email":email,"messagesTotal":0,"threadsTotal":0,"historyId":""})
        });
    }
    if method == "hey.labels" {
        let answer = run(&strings(&["labels", "--json", "--all"])).await?;
        let rows = answer["data"].as_array().ok_or("Invalid HEY labels")?;
        return Ok(Value::Array(rows.iter().filter_map(|row| {
            let id = text(&row["id"]); let name = text(&row["name"]);
            if id.is_empty() || name.is_empty() { return None; }
            Some(json!({"id":id,"name":name,"rawName":id,"system":false,"unread":0,"total":0,"threadsUnread":0}))
        }).collect()));
    }
    if method == "hey.status" {
        let answer = run(&strings(&["auth", "status", "--json"])).await?;
        return Ok(
            json!({"authenticated":answer["data"]["authenticated"] == true && answer["data"]["expired"] != true}),
        );
    }
    if method == "hey.read" {
        let id = text(&params["id"]);
        let (posting, topic) = id.split_once(':').ok_or("Invalid HEY message id")?;
        if !number(topic) || (posting != "draft" && !number(posting)) {
            return Err("Invalid HEY message id");
        }
        let draft = posting == "draft";
        if !draft {
            return read_thread(&id, topic).await;
        }
        let answer = run(&strings(&["draft", "show", topic, "--json"])).await?;
        return read_resource(&id, &answer["data"], true);
    }
    let q = query(&text(&params["query"]))?;
    let token = text(&params["pageToken"]);
    let (offset, cursor) = if token.is_empty() {
        (0, "")
    } else {
        let (offset, cursor) = token.split_once('|').ok_or("Invalid HEY page token")?;
        (
            offset
                .parse::<usize>()
                .map_err(|_| "Invalid HEY page token")?,
            cursor,
        )
    };
    if cursor.starts_with('-') {
        return Err("Invalid HEY page cursor");
    }
    let size = match params.get("pageSize") {
        None => 25,
        Some(v) => v
            .as_u64()
            .filter(|v| (1..=100).contains(v))
            .ok_or("Invalid HEY page size")? as usize,
    };
    let answer = list_request(&q, cursor).await?;
    let rows = listing(&q, &answer["data"]);
    let total = rows.len();
    let next = if offset.saturating_add(size) < total {
        format!("{}|{}", offset + size, cursor)
    } else if q.unseen {
        String::new()
    } else {
        let next = match q.kind.as_str() {
            "search" | "trash" if total > 0 => cursor
                .parse::<u64>()
                .unwrap_or(1)
                .checked_add(1)
                .ok_or("Invalid HEY page cursor")?
                .to_string(),
            "search" | "trash" => String::new(),
            "drafts" => text(&answer["meta"]["next_page"]),
            _ => text(&answer["data"]["next_page"]),
        };
        if next.is_empty() {
            next
        } else {
            format!("0|{next}")
        }
    };
    let visible: Vec<Value> = rows.into_iter().skip(offset).take(size).collect();
    Ok(
        json!({"ids":visible.iter().map(|v|v["id"].clone()).collect::<Vec<_>>(),"messages":visible,"threadIds":[],"nextPageToken":next,"estimate":total}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detail_matches_legacy_text_join_without_inventing_posting_metadata() {
        let message = read_resource(
            "123:456",
            &json!([
                {"id":1,"body":" First "}, {"id":2,"body":"  "},
                {"id":3,"body":"Second"}
            ]),
            false,
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(message["payload"]["body"]["data"].as_str().unwrap())
                .unwrap(),
            "First\n\n───\n\nSecond".as_bytes()
        );
        assert_eq!(message["labelIds"], json!([]));
        assert_eq!(
            message["thread"],
            json!({"id":"456","count":0,"memberIds":[],"unread":false,"flagged":false})
        );
        assert_eq!(message["internalDate"], "");
        assert_eq!(message["snippet"], "");
        assert_eq!(
            message["payload"]["headers"],
            json!([{"name":"Content-Type","value":"text/plain; charset=utf-8"}])
        );
        assert!(read_resource("123:456", &json!({}), false).is_err());
        assert!(read_resource("draft:456", &json!([]), true).is_err());
    }
    #[test]
    fn normal_pages_keep_cursor_and_unseen_scan_is_bounded() {
        assert_eq!(
            command(&query("box:imbox").unwrap(), "cursor"),
            strings(&["box", "imbox", "--json", "--page", "cursor"])
        );
        assert_eq!(
            command(&query("box:imbox unseen").unwrap(), ""),
            strings(&["box", "imbox", "--json", "--limit", "100"])
        );
    }
    #[test]
    fn posting_uses_two_ids_and_missing_seen_is_unread() {
        let rows = listing(
            &query("box:imbox").unwrap(),
            &json!({"kind":"imbox","postings":[{"id":123,"app_url":"https://app.hey.com/topics/456","name":"Subject"}]}),
        );
        assert_eq!(rows[0]["id"], "123:456");
        assert_eq!(rows[0]["labelIds"], json!(["UNREAD", "INBOX"]));
    }
    #[tokio::test]
    async fn invalid_inputs_fail_before_process() {
        assert!(call("hey.read", &json!({"id":"1:--help"})).await.is_err());
        assert!(
            call("hey.status", &json!({"program":"evil"}))
                .await
                .is_err()
        );
        assert!(
            call("hey.list", &json!({"query":"search:--help"}))
                .await
                .is_err()
        );
        assert!(envelope(br#"{"ok":false,"error":"secret"}"#).is_err());
    }
    #[test]
    fn search_uses_newest_sender_without_claiming_unread() {
        let rows = listing(
            &query("search:dentist").unwrap(),
            &json!([{"id":1,"topic_id":2,"subject":"Appointment","messages":[{"summary":"older"},{"summary":"newest","creator":{"name":"Doctor","email_address":"doctor@example.org"}}]}]),
        );
        assert_eq!(rows[0]["snippet"], "newest");
        assert_eq!(rows[0]["labelIds"], json!([]));
        assert_eq!(
            rows[0]["payload"]["headers"][0]["value"],
            "\"Doctor\" <doctor@example.org>"
        );
    }
    #[test]
    fn thread_body_is_base64url_and_drafts_preserve_recipients() {
        let body = "Hello\n世界";
        let message = resource(
            "draft:42",
            &json!({"to":["a@example.org"],"cc":["b@example.org"],"subject":"Draft"}),
            body,
            true,
            false,
            "",
        );
        assert_eq!(message["labelIds"], json!(["DRAFT"]));
        assert_eq!(message["threadId"], "");
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(message["payload"]["body"]["data"].as_str().unwrap())
                .unwrap(),
            body.as_bytes()
        );
        assert_eq!(message["payload"]["body"]["size"], body.len());
        assert_eq!(message["payload"]["headers"][0]["value"], "a@example.org");
    }
    #[test]
    fn dates_and_unknown_conversation_members_match_resource_contract() {
        let message = resource(
            "1:2",
            &json!({"active_at":"2026-01-01T08:00:00+08:00"}),
            "",
            false,
            false,
            "imbox",
        );
        assert_eq!(message["internalDate"], "1767225600000");
        assert_eq!(message["payload"]["mimeType"], "text/plain");
        assert_eq!(message["thread"]["memberIds"], json!([]));
        assert_eq!(message["thread"]["count"], 0);
    }
}
