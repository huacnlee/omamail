//! Read-only, account-bound AI context preparation. No job is launched here.
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;
type Result<T> = std::result::Result<T, &'static str>;
const MAX_TEXT: usize = 200_000;
const CONCURRENCY: usize = 4;
type Key = (String, String);
type Active = HashMap<Key, (u64, watch::Sender<bool>)>;

#[derive(Default)]
pub struct Contexts {
    active: Mutex<Active>,
    cancelled_before_start: Mutex<HashMap<Key, Instant>>,
    serial: AtomicU64,
}
struct Registration<'a> {
    contexts: &'a Contexts,
    key: (String, String),
    serial: u64,
}
impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.contexts.active.lock()
            && active
                .get(&self.key)
                .is_some_and(|(s, _)| *s == self.serial)
        {
            active.remove(&self.key);
        }
    }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn bounded(value: &Value, key: &str, max: usize) -> Result<String> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or("agent_context_invalid")
}
struct Request {
    account: String,
    id: String,
    ids: Vec<String>,
    summaries: Vec<Value>,
    prompt: String,
    folder: String,
}
impl Request {
    fn parse(p: &Value) -> Result<Self> {
        let object = p.as_object().ok_or("agent_context_invalid")?;
        if object.keys().any(|k| {
            ![
                "accountId",
                "requestId",
                "ids",
                "summaries",
                "prompt",
                "folder",
            ]
            .contains(&k.as_str())
        }) || serde_json::to_vec(p)
            .map_err(|_| "agent_context_invalid")?
            .len()
            > 2 * 1024 * 1024
        {
            return Err("agent_context_invalid");
        }
        let account = bounded(p, "accountId", 1024)?;
        let id = bounded(p, "requestId", 128)?;
        let ids = p["ids"]
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 20)
            .ok_or("agent_context_invalid")?;
        let mut chosen = Vec::new();
        for value in ids {
            let s = value
                .as_str()
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 4096
                        && s.trim() == *s
                        && !s.chars().any(char::is_control)
                })
                .ok_or("agent_context_invalid")?;
            if chosen.iter().any(|v| v == s) {
                return Err("agent_context_invalid");
            }
            chosen.push(s.to_owned());
        }
        let summaries = p["summaries"]
            .as_array()
            .filter(|v| v.len() == chosen.len())
            .ok_or("agent_context_invalid")?
            .clone();
        for (row, id) in summaries.iter().zip(&chosen) {
            if !row.is_object() || text(row, "id") != id {
                return Err("agent_context_invalid");
            }
        }
        let prompt = p["prompt"]
            .as_str()
            .filter(|s| {
                !s.trim().is_empty()
                    && s.len() <= 1024 * 1024
                    && !s
                        .chars()
                        .any(|c| c.is_control() && !matches!(c, '\t' | '\r' | '\n'))
            })
            .ok_or("agent_context_invalid")?
            .trim()
            .to_owned();
        let folder = p["folder"]
            .as_str()
            .filter(|s| s.len() <= 4096 && !s.chars().any(char::is_control))
            .ok_or("agent_context_invalid")?
            .to_owned();
        Ok(Self {
            account,
            id,
            ids: chosen,
            summaries,
            prompt,
            folder,
        })
    }
}
impl Contexts {
    pub async fn call(
        &self,
        method: &str,
        p: &Value,
        session: &crate::backend::Session,
    ) -> Result<Value> {
        if method == "agent.contextCancel" {
            if p.as_object().is_none_or(|o| o.len() != 2) {
                return Err("agent_context_invalid");
            }
            let key = (
                bounded(p, "accountId", 1024)?,
                bounded(p, "requestId", 128)?,
            );
            let mut active = self.active.lock().map_err(|_| "agent_context_failed")?;
            let entry = active.remove(&key);
            if entry.is_none() {
                let mut cancelled = self
                    .cancelled_before_start
                    .lock()
                    .map_err(|_| "agent_context_failed")?;
                cancelled.retain(|_, at| at.elapsed() < Duration::from_secs(120));
                if cancelled.len() >= 64 && !cancelled.contains_key(&key) {
                    return Err("agent_context_busy");
                }
                cancelled.insert(key, Instant::now());
            }
            if let Some((_, cancel)) = entry {
                let _ = cancel.send(true);
                return Ok(json!({"cancelled":true}));
            }
            return Ok(json!({"cancelled":false}));
        }
        if method != "agent.context" {
            return Err("unknown_method");
        }
        let request = Request::parse(p)?;
        let key = (request.account.clone(), request.id.clone());
        let (cancel, mut cancelled) = watch::channel(false);
        let serial = self.serial.fetch_add(1, Ordering::Relaxed);
        {
            let mut active = self.active.lock().map_err(|_| "agent_context_failed")?;
            let mut cancelled = self
                .cancelled_before_start
                .lock()
                .map_err(|_| "agent_context_failed")?;
            cancelled.retain(|_, at| at.elapsed() < Duration::from_secs(120));
            if cancelled.contains_key(&key) {
                return Err("agent_context_cancelled");
            }
            if active.len() >= 8 || active.contains_key(&key) {
                return Err("agent_context_busy");
            }
            active.insert(key.clone(), (serial, cancel));
        }
        let _registration = Registration {
            contexts: self,
            key,
            serial,
        };
        let work = async {
            let account = request.account.clone();
            let owner = tokio::task::spawn_blocking(move || {
                let list = crate::account::list()?;
                list["accounts"]
                    .as_array()
                    .and_then(|rows| rows.iter().find(|row| text(row, "id") == account))
                    .cloned()
                    .ok_or("agent_context_account_missing")
            })
            .await
            .map_err(|_| "agent_context_failed")??;
            validate_ids(text(&owner, "provider"), &request.ids)?;
            let rows = collect(&request.ids, &request.summaries, |id| {
                session.fetch_resource(&request.account, id)
            })
            .await?;
            Ok(
                json!({"payload":build(&rows,text(&owner,"email"),text(&owner,"provider"),&request.folder,&request.prompt,&request.account)?}),
            )
        };
        let result = bounded_work(&mut cancelled, Duration::from_secs(60), work).await;
        // Completion and acknowledged cancellation linearize under the same
        // lock. A cancelled entry cannot subsequently return a usable payload.
        let mut active = self.active.lock().map_err(|_| "agent_context_failed")?;
        if !active
            .get(&_registration.key)
            .is_some_and(|(current, _)| *current == serial)
        {
            return Err("agent_context_cancelled");
        }
        active.remove(&_registration.key);
        result
    }
}
async fn bounded_work<T>(
    cancelled: &mut watch::Receiver<bool>,
    deadline: Duration,
    work: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        biased;
        _=cancelled.changed()=>Err("agent_context_cancelled"),
        result=tokio::time::timeout(deadline,work)=>{
            if *cancelled.borrow() {Err("agent_context_cancelled")} else {result.map_err(|_|"agent_context_timeout")?}
        }
    }
}

fn validate_ids(provider: &str, ids: &[String]) -> Result<()> {
    for id in ids {
        let valid = match provider {
            "imap" | "outlook" => id.split_once(':').is_some_and(|(uid, folder)| {
                uid.parse::<u32>().is_ok_and(|n| n > 0) && !folder.is_empty()
            }),
            "hey" => id.split_once(':').is_some_and(|(a, b)| {
                !a.is_empty()
                    && !b.is_empty()
                    && a.bytes().all(|b| b.is_ascii_digit())
                    && b.bytes().all(|b| b.is_ascii_digit())
            }),
            "gmail" => id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "jmap" => id.len() <= 1024,
            _ => false,
        };
        if !valid {
            return Err("agent_context_invalid");
        }
    }
    Ok(())
}
async fn collect<'a, F, Fut>(
    ids: &'a [String],
    summaries: &'a [Value],
    fetch: F,
) -> Result<Vec<Value>>
where
    F: Fn(&'a str) -> Fut,
    Fut: Future<Output = Result<Value>>,
{
    let mut pending = stream::iter(ids.iter().enumerate().map(|(index, id)| {
        let future = fetch(id);
        let previous = summaries[index].clone();
        let id = id.clone();
        async move {
            let resource = future.await?;
            let row = tokio::task::spawn_blocking(move || {
                let prepared = crate::message::content::prepare(
                    &resource,
                    chrono::Utc::now().timestamp_millis(),
                )?;
                let mut row = crate::account::model::apply(
                    &json!({"operation":"detailSummary","args":[previous,prepared["summary"]]}),
                )?;
                row["id"] = json!(id);
                row["bodyText"] = prepared["body"]["text"].clone();
                Ok::<_, &'static str>(row)
            })
            .await
            .map_err(|_| "agent_context_failed")??;
            Ok::<_, &'static str>((index, row))
        }
    }))
    .buffer_unordered(CONCURRENCY);
    let mut rows = vec![Value::Null; ids.len()];
    let mut chars = 0usize;
    while let Some(result) = pending.next().await {
        let (index, row) = result?;
        chars += message_text(&row, text(&row, "bodyText"))
            .encode_utf16()
            .count();
        if chars > MAX_TEXT {
            return Err("agent_context_too_large");
        }
        rows[index] = row;
    }
    Ok(rows)
}
fn address_line(rows: &Value) -> String {
    rows.as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| {
            let email = text(row, "email");
            let name = if text(row, "name").is_empty() {
                text(row, "display")
            } else {
                text(row, "name")
            };
            if email.is_empty() {
                if name.is_empty() {
                    None
                } else {
                    Some(name.into())
                }
            } else if !name.is_empty() && name != email {
                Some(format!("{name} <{email}>"))
            } else {
                Some(email.into())
            }
        })
        .collect::<Vec<String>>()
        .join(", ")
}
pub fn message_text(row: &Value, body: &str) -> String {
    let from = &row["from"];
    let email = text(from, "email");
    let name = if text(from, "name").is_empty() {
        text(from, "display")
    } else {
        text(from, "name")
    };
    let mut lines = vec![format!(
        "From: {}",
        if !name.is_empty() && name != email {
            format!("{name} <{email}>")
        } else {
            email.into()
        }
    )];
    for (key, label) in [("to", "To"), ("cc", "Cc")] {
        let value = address_line(&row[key]);
        if !value.is_empty() {
            lines.push(format!("{label}: {value}"));
        }
    }
    if !text(row, "fullTime").is_empty() {
        lines.push(format!("Date: {}", text(row, "fullTime")));
    }
    lines.push(format!("Subject: {}", text(row, "subject")));
    if !text(row, "messageId").is_empty() {
        lines.push(format!("Message-ID: {}", text(row, "messageId")));
    }
    lines.push(String::new());
    lines.push(body.into());
    lines.join("\n")
}
pub fn build(
    rows: &[Value],
    account: &str,
    provider: &str,
    folder: &str,
    prompt: &str,
    account_id: &str,
) -> Result<Value> {
    if rows.is_empty() || rows.len() > 20 {
        return Err("agent_context_invalid");
    }
    let texts: Vec<_> = rows
        .iter()
        .map(|r| message_text(r, text(r, "bodyText")))
        .collect();
    if texts
        .iter()
        .map(|s| s.encode_utf16().count())
        .sum::<usize>()
        > MAX_TEXT
    {
        return Err("agent_context_too_large");
    }
    let payload = if rows.len() == 1 {
        let row = &rows[0];
        let id = text(row, "id");
        let folder = if provider == "imap" {
            id.split_once(':').map(|(_, f)| f).unwrap_or(folder)
        } else {
            folder
        };
        json!({"messageId":id,"accountId":account_id,"account":account,"folder":folder,"subject":text(row,"subject"),"prompt":prompt.trim(),"message":texts[0]})
    } else {
        json!({"messageId":"","messages":rows.iter().zip(texts).map(|(r,t)|json!({"messageId":r["id"],"message":t})).collect::<Vec<_>>(),"accountId":account_id,"account":account,"folder":folder,"subject":format!("{} messages",rows.len()),"prompt":prompt.trim(),"message":""})
    };
    super::jobs::validate_payload(&payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use std::{
        io::Write,
        sync::{Arc, atomic::AtomicUsize},
    };
    fn resource(id: &str, body: &str) -> Value {
        json!({"id":id,"payload":{"mimeType":"text/plain","headers":[{"name":"Subject","value":format!("Subject {id}")}],"body":{"data":URL_SAFE_NO_PAD.encode(body)}}})
    }
    fn request() -> Value {
        json!({"accountId":"imap:test@example.org","requestId":"request-1","ids":["1:INBOX"],"summaries":[{"id":"1:INBOX","subject":"First"}],"prompt":"Read","folder":"inbox"})
    }
    #[test]
    fn payload_matches_original_js_for_one_and_many_messages() {
        let rows = [
            json!({"id":"1:INBOX","subject":"مرحبا","from":{"name":"Ada","email":"ada@example.org"},"to":[{"name":"Bob","email":"bob@example.org"}],"messageId":"<one@example.org>","bodyText":"First body\nمرحبا"}),
            json!({"id":"2:Archive","subject":"Second","bodyText":"Second body"}),
        ];
        for count in [1, 2] {
            let rows = &rows[..count];
            let actual = build(
                rows,
                "test@example.org",
                "imap",
                "inbox",
                " Read ",
                "imap:test@example.org",
            )
            .unwrap();
            let script = r#"const M=require('./ui/tests/load.js').load('tests/oracles/agent/Agent.js');const rows=JSON.parse(require('fs').readFileSync(0,'utf8'));const line=rows.length===1?M.payload(rows[0],rows[0].bodyText,'test@example.org',M.folderOf(rows[0].id,'inbox','imap'),' Read ','imap:test@example.org'):M.selectionPayload(rows,'test@example.org','inbox',' Read ','imap:test@example.org');process.stdout.write(line)"#;
            let mut child = std::process::Command::new("node")
                .args(["-e", script])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(serde_json::to_string(rows).unwrap().as_bytes())
                .unwrap();
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            assert_eq!(
                actual,
                serde_json::from_slice::<Value>(&output.stdout).unwrap()
            );
        }
    }
    #[tokio::test]
    async fn concurrent_reads_are_bounded_and_return_original_selection_order() {
        let ids: Vec<_> = (0..10).map(|i| format!("id{i}")).collect();
        let summaries: Vec<_> = ids.iter().map(|id| json!({"id":id})).collect();
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let rows = collect(&ids, &summaries, |id| {
            let active = active.clone();
            let peak = peak.clone();
            async move {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                let delay = if id == "id0" { 40 } else { 5 };
                tokio::time::sleep(Duration::from_millis(delay)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(resource(id, &format!("body {id}")))
            }
        })
        .await
        .unwrap();
        assert_eq!(peak.load(Ordering::SeqCst), CONCURRENCY);
        assert_eq!(
            rows.iter().map(|r| text(r, "id")).collect::<Vec<_>>(),
            ids.iter().map(String::as_str).collect::<Vec<_>>()
        );
        assert_eq!(rows[0]["bodyText"], "body id0");
    }
    struct Live(Arc<AtomicUsize>);
    impl Drop for Live {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn cancellation_and_deadline_drop_all_inflight_reads() {
        let ids: Vec<_> = (0..8).map(|i| format!("id{i}")).collect();
        let summaries: Vec<_> = ids.iter().map(|id| json!({"id":id})).collect();
        let active = Arc::new(AtomicUsize::new(0));
        let work = collect(&ids, &summaries, |_| {
            let active = active.clone();
            async move {
                active.fetch_add(1, Ordering::SeqCst);
                let _live = Live(active);
                std::future::pending::<Result<Value>>().await
            }
        });
        let (_tx, mut rx) = watch::channel(false);
        assert_eq!(
            bounded_work(&mut rx, Duration::from_millis(30), work)
                .await
                .unwrap_err(),
            "agent_context_timeout"
        );
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn oversized_context_fails_without_returning_partial_payload() {
        let ids = vec!["one".into(), "two".into()];
        let summaries = vec![json!({"id":"one"}), json!({"id":"two"})];
        assert_eq!(
            collect(&ids, &summaries, |id| async move {
                Ok(resource(id, &"😀".repeat(60_000)))
            })
            .await
            .unwrap_err(),
            "agent_context_too_large"
        );
    }
    #[tokio::test]
    async fn invalid_batch_is_refused_before_registering_work() {
        let contexts = Contexts::default();
        let session = crate::backend::Session::default();
        for bad in ["2:INBOX\r", "2:INBOX\n", "2:INBOX\r\n", "2:INBOX\0"] {
            let mut p = request();
            p["ids"] = json!(["1:INBOX", bad]);
            p["summaries"] = json!([{"id":"1:INBOX"},{"id":bad}]);
            assert_eq!(
                contexts
                    .call("agent.context", &p, &session)
                    .await
                    .unwrap_err(),
                "agent_context_invalid"
            );
        }
        assert!(contexts.active.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn cancel_is_account_scoped_and_old_cleanup_cannot_remove_new_request() {
        let contexts = Contexts::default();
        let session = crate::backend::Session::default();
        let key = ("imap:test@example.org".into(), "req".into());
        let (tx, mut rx) = watch::channel(false);
        contexts.active.lock().unwrap().insert(key.clone(), (1, tx));
        assert_eq!(
            contexts
                .call(
                    "agent.contextCancel",
                    &json!({"accountId":"other@example.org","requestId":"req"}),
                    &session
                )
                .await
                .unwrap()["cancelled"],
            false
        );
        assert!(!*rx.borrow());
        assert_eq!(
            contexts
                .call(
                    "agent.contextCancel",
                    &json!({"accountId":key.0,"requestId":key.1}),
                    &session
                )
                .await
                .unwrap()["cancelled"],
            true
        );
        rx.changed().await.unwrap();
        assert!(*rx.borrow());
        let (tx, _) = watch::channel(false);
        contexts.active.lock().unwrap().insert(key.clone(), (2, tx));
        drop(Registration {
            contexts: &contexts,
            key: key.clone(),
            serial: 1,
        });
        assert_eq!(contexts.active.lock().unwrap()[&key].0, 2);
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;
    #[tokio::test]
    async fn acknowledged_cancel_wins_over_simultaneously_ready_payload() {
        let (tx, mut rx) = watch::channel(false);
        tx.send(true).unwrap();
        let result = bounded_work(&mut rx, Duration::from_secs(1), async {
            Ok(json!({"payload":"must not escape"}))
        })
        .await;
        assert_eq!(result.unwrap_err(), "agent_context_cancelled");
    }
}

#[cfg(test)]
mod cancellation_inflight_tests {
    use super::*;
    use std::sync::{Arc, atomic::AtomicUsize};
    struct Live(Arc<AtomicUsize>);
    impl Drop for Live {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    #[tokio::test]
    async fn cancellation_drops_every_started_read_before_returning() {
        let ids: Vec<_> = (0..8).map(|i| format!("id{i}")).collect();
        let summaries: Vec<_> = ids.iter().map(|id| json!({"id":id})).collect();
        let active = Arc::new(AtomicUsize::new(0));
        let work = collect(&ids, &summaries, |_| {
            let active = active.clone();
            async move {
                active.fetch_add(1, Ordering::SeqCst);
                let _live = Live(active);
                std::future::pending::<Result<Value>>().await
            }
        });
        let (tx, mut rx) = watch::channel(false);
        let trigger = async {
            while active.load(Ordering::SeqCst) < CONCURRENCY {
                tokio::task::yield_now().await;
            }
            tx.send(true).unwrap();
        };
        let (result, ()) =
            tokio::join!(bounded_work(&mut rx, Duration::from_secs(1), work), trigger);
        assert_eq!(result.unwrap_err(), "agent_context_cancelled");
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }
}

#[cfg(test)]
mod queued_cancel_tests {
    use super::*;
    #[tokio::test]
    async fn cancel_before_uploaded_context_dispatch_prevents_registration() {
        let contexts = Contexts::default();
        let session = crate::backend::Session::default();
        contexts
            .call(
                "agent.contextCancel",
                &json!({"accountId":"imap:test@example.org","requestId":"queued"}),
                &session,
            )
            .await
            .unwrap();
        let request = json!({"accountId":"imap:test@example.org","requestId":"queued","ids":["1:INBOX"],"summaries":[{"id":"1:INBOX"}],"prompt":"Read","folder":"inbox"});
        assert_eq!(
            contexts
                .call("agent.context", &request, &session)
                .await
                .unwrap_err(),
            "agent_context_cancelled"
        );
        assert!(contexts.active.lock().unwrap().is_empty());
    }
}
