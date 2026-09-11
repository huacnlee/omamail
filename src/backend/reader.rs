//! Native reader pipeline. Raw resources and sender HTML never form UI requests.
use super::Session;
use crate::{cache, message};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Notify;
const MAX_BYTES: usize = 64 * 1024 * 1024;
#[derive(Default)]
pub(super) struct ReaderStore {
    entries: VecDeque<Entry>,
    bytes: usize,
    sequence: u64,
    jobs: HashMap<(String, String), Job>,
    cancelled: VecDeque<Cancelled>,
}
struct Cancelled {
    key: (String, String),
    at: Instant,
}
struct Entry {
    account: String,
    id: String,
    key: String,
    prepared: Arc<Prepared>,
    bytes: usize,
}
struct Prepared {
    source: String,
    base: Value,
    source_hash: [u8; 32],
    fallback: Option<(Arc<Value>, i64)>,
}
impl Prepared {
    fn bytes(&self) -> Result<usize, &'static str> {
        if let Some((resource, _)) = &self.fallback {
            return Ok(serde_json::to_vec(resource.as_ref())
                .map_err(|_| "invalid_message")?
                .len());
        }
        Ok(self.source.len()
            + serde_json::to_vec(&self.base)
                .map_err(|_| "invalid_message")?
                .len())
    }
}
#[derive(Clone)]
struct Job {
    live: Arc<Mutex<bool>>,
    cancelled: Arc<Notify>,
}
impl Job {
    fn current(&self) -> Result<(), &'static str> {
        if *self.live.lock().map_err(|_| "session_failed")? {
            Ok(())
        } else {
            Err("reader_cancelled")
        }
    }
}
impl ReaderStore {
    fn put(
        &mut self,
        account: &str,
        id: &str,
        prepared: Arc<Prepared>,
    ) -> Result<String, &'static str> {
        let bytes = prepared.bytes()?;
        if bytes > MAX_BYTES {
            return Err("reader_resource_too_large");
        }
        while self.bytes + bytes > MAX_BYTES
            || self.entries.len() >= 64
            || self.entries.iter().filter(|v| v.account == account).count() >= 12
        {
            let at = self
                .entries
                .iter()
                .position(|v| v.account == account)
                .unwrap_or(0);
            if let Some(old) = self.entries.remove(at) {
                self.bytes -= old.bytes;
            } else {
                break;
            }
        }
        self.sequence = self.sequence.checked_add(1).ok_or("session_failed")?;
        let key = self.sequence.to_string();
        self.bytes += bytes;
        self.entries.push_back(Entry {
            account: account.into(),
            id: id.into(),
            key: key.clone(),
            prepared,
            bytes,
        });
        Ok(key)
    }
    fn get(&mut self, account: &str, id: &str, key: &str) -> Result<Arc<Prepared>, &'static str> {
        let at = self
            .entries
            .iter()
            .position(|v| v.account == account && v.id == id && v.key == key)
            .ok_or("reader_source_expired")?;
        let entry = self.entries.remove(at).ok_or("reader_source_expired")?;
        let value = entry.prepared.clone();
        self.entries.push_back(entry);
        Ok(value)
    }
}
struct Registration {
    store: Arc<Mutex<ReaderStore>>,
    key: (String, String),
    live: Arc<Mutex<bool>>,
}
impl Drop for Registration {
    fn drop(&mut self) {
        if let Ok(mut live) = self.live.lock() {
            *live = false;
        }
        if let Ok(mut store) = self.store.lock() {
            store.jobs.remove(&self.key);
        }
    }
}
fn field<'a>(p: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    p[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096 && !s.chars().any(char::is_control))
        .ok_or("invalid_params")
}
async fn registered(account: &str) -> Result<String, &'static str> {
    let list = tokio::task::spawn_blocking(crate::account::list)
        .await
        .map_err(|_| "worker_failed")??;
    list["accounts"]
        .as_array()
        .and_then(|rows| rows.iter().find(|v| v["id"] == account))
        .and_then(|v| v["provider"].as_str())
        .map(str::to_owned)
        .ok_or("reader_account_unknown")
}
impl Session {
    /// Internal full-resource read shared with AI context; never an IPC result.
    pub(crate) async fn fetch_resource(
        &self,
        account: &str,
        id: &str,
    ) -> Result<Value, &'static str> {
        cache::validate_params(&json!({"accountId":account,"id":id}), true)?;
        let provider = registered(account).await?;
        let value = match provider.as_str() {
            "gmail" => {
                self.gmail
                    .call(
                        "gmail.read",
                        &json!({"accountId":account,"id":id,"full":true}),
                    )
                    .await?
            }
            "jmap" => self
                .jmap
                .call(
                    "jmap.read",
                    &json!({"accountId":account,"id":id,"full":true}),
                )
                .await?["data"]
                .clone(),
            "hey" => {
                let program = crate::providers::hey_access::program()?;
                let params = crate::providers::hey_access::checked_params(
                    &json!({"accountId":account,"id":id,"program":program}),
                )
                .await?;
                crate::providers::hey::call("hey.read", &params).await?
            }
            "imap" | "outlook" => {
                let response = crate::providers::imap::call(
                    "imap.messages",
                    &json!({"accountId":account,"ids":[id],"full":true,"progressive":false}),
                )
                .await?;
                response["messages"]
                    .as_array()
                    .and_then(|v| v.iter().find(|v| v["id"] == id))
                    .cloned()
                    .ok_or("reader_message_missing")?
            }
            _ => return Err("reader_provider_unknown"),
        };
        if value["id"] != id || !value["payload"].is_object() {
            return Err("reader_message_mismatch");
        }
        Ok(value)
    }
    pub(super) async fn reader_call(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<Value, &'static str> {
        let account = field(params, "accountId")?.to_lowercase();
        if method == "reader.cancel" {
            let request = field(params, "requestId")?;
            let mut store = self.reader.lock().map_err(|_| "session_failed")?;
            let key = (account, request.into());
            if let Some(job) = store.jobs.get(&key) {
                *job.live.lock().map_err(|_| "session_failed")? = false;
                job.cancelled.notify_one();
            }
            store
                .cancelled
                .retain(|item| item.at.elapsed() < Duration::from_secs(60));
            if !store.cancelled.iter().any(|item| item.key == key) {
                if store.cancelled.len() >= 256 {
                    store.cancelled.pop_front();
                }
                store.cancelled.push_back(Cancelled {
                    key,
                    at: Instant::now(),
                });
            }
            return Ok(json!({"cancelled":true}));
        }
        let id = field(params, "id")?.to_owned();
        cache::validate_params(&json!({"accountId":account,"id":id}), true)?;
        let now = params
            .get("now")
            .and_then(Value::as_i64)
            .ok_or("invalid_params")?;
        let options = params
            .get("options")
            .filter(|v| v.is_object())
            .cloned()
            .ok_or("invalid_params")?;
        if method == "reader.render" {
            registered(&account).await?;
            let key = field(params, "readerKey")?;
            let prepared = self
                .reader
                .lock()
                .map_err(|_| "session_failed")?
                .get(&account, &id, key)?;
            let key = key.to_owned();
            let renders = self.renders.clone();
            return tokio::task::spawn_blocking(move || {
                render_prepared(
                    prepared.as_ref(),
                    &account,
                    &id,
                    &key,
                    options,
                    &renders,
                    None,
                )
            })
            .await
            .map_err(|_| "worker_failed")?;
        }
        if method != "reader.open" {
            return Err("unknown_method");
        }
        let request = field(params, "requestId")?.to_owned();
        let cache_only = params
            .get("cacheOnly")
            .and_then(Value::as_bool)
            .ok_or("invalid_params")?;
        let job = Job {
            live: Arc::new(Mutex::new(true)),
            cancelled: Arc::new(Notify::new()),
        };
        let key = (account.clone(), request);
        {
            let mut store = self.reader.lock().map_err(|_| "session_failed")?;
            store
                .cancelled
                .retain(|item| item.at.elapsed() < Duration::from_secs(60));
            if store.cancelled.iter().any(|item| item.key == key) {
                return Err("reader_cancelled");
            }
            if store.jobs.len() >= 64 || store.jobs.contains_key(&key) {
                return Err("reader_request_limit");
            }
            store.jobs.insert(key.clone(), job.clone());
        }
        let _registration = Registration {
            store: self.reader.clone(),
            key,
            live: job.live.clone(),
        };
        let operation = async {
            registered(&account).await?;
            job.current()?;
            let resource = if cache_only {
                cache::resource::read(&account, &id).await?
            } else {
                Some(self.fetch_resource(&account, &id).await?)
            };
            job.current()?;
            let Some(resource) = resource else {
                return Ok(Value::Null);
            };
            if !cache_only {
                // Persistence failure does not discard a valid live read. Guarded
                // writes cannot land after an explicit reader cancellation.
                let _ =
                    cache::resource::put_guarded(&account, &id, &resource, job.live.clone()).await;
            }
            let renders = self.renders.clone();
            let store = self.reader.clone();
            let resource = Arc::new(resource);
            let job = job.clone();
            tokio::task::spawn_blocking(move || {
                job.current()?;
                let prepared = Arc::new(prepare_for_store(resource.clone(), &id, now)?);
                let mut store_guard = store.lock().map_err(|_| "session_failed")?;
                let live_guard = job.live.lock().map_err(|_| "session_failed")?;
                if !*live_guard {
                    return Err("reader_cancelled");
                }
                let key = store_guard.put(&account, &id, prepared.clone())?;
                drop(live_guard);
                drop(store_guard);
                let result = render_prepared(
                    prepared.as_ref(),
                    &account,
                    &id,
                    &key,
                    options,
                    &renders,
                    Some(&job.live),
                )?;
                let mut result = result;
                if let Ok(body) =
                    cache::call("cache.bodyRead", &json!({"accountId":account,"id":id}))
                    && body["invite"].is_object()
                {
                    result["cachedInvite"] = body["invite"].clone();
                }
                job.current()?;
                Ok(result)
            })
            .await
            .map_err(|_| "worker_failed")?
        };
        let result = tokio::select! {result=tokio::time::timeout(Duration::from_secs(25),operation)=>result.unwrap_or(Err("reader_timeout")),_=job.cancelled.notified()=>Err("reader_cancelled")};
        if result.is_err() {
            *job.live.lock().map_err(|_| "session_failed")? = false;
        }
        result
    }
}
fn prepare(resource: &Value, id: &str, now: i64) -> Result<Prepared, &'static str> {
    let mut prepared = message::content::prepare_for_render(resource, now)?;
    let source = prepared
        .as_object_mut()
        .ok_or("invalid_message")?
        .remove("html")
        .and_then(|v| {
            if let Value::String(source) = v {
                Some(source)
            } else {
                None
            }
        })
        .unwrap_or_default();
    let has_html = !source.is_empty();
    // Only calendar material and header metadata cross for existing invitation /
    // unsubscribe views. MIME body and file octets remain in the native store.
    fn calendars(
        part: &Value,
        depth: usize,
        left: &mut usize,
        out: &mut Vec<Value>,
    ) -> Result<(), &'static str> {
        if depth > 32 || *left == 0 {
            return Err("too_many_mime_parts");
        }
        *left -= 1;
        if part["mimeType"]
            .as_str()
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("text/calendar")
        {
            let mut leaf = serde_json::Map::new();
            for field in ["partId", "mimeType", "filename", "headers", "body"] {
                if let Some(value) = part.get(field) {
                    leaf.insert(field.into(), value.clone());
                }
            }
            out.push(Value::Object(leaf));
            return Ok(());
        }
        if let Some(parts) = part["parts"].as_array() {
            for part in parts {
                calendars(part, depth + 1, left, out)?;
            }
        }
        Ok(())
    }
    let mut parts = Vec::new();
    calendars(&resource["payload"], 0, &mut 4096, &mut parts)?;
    Ok(Prepared {
        source_hash: Sha256::digest(source.as_bytes()).into(),
        fallback: None,
        source,
        base: json!({"id":id,"threadId":resource["threadId"],"labelIds":resource["labelIds"],"hasHtml":has_html,"payload":{"mimeType":"multipart/mixed","headers":resource["payload"]["headers"],"parts":parts},"nativeSummary":prepared["summary"],"nativeContent":prepared}),
    })
}

fn prepare_for_store(resource: Arc<Value>, id: &str, now: i64) -> Result<Prepared, &'static str> {
    prepare_for_store_bounded(resource, id, now, MAX_BYTES)
}
fn prepare_for_store_bounded(
    resource: Arc<Value>,
    id: &str,
    now: i64,
    limit: usize,
) -> Result<Prepared, &'static str> {
    // Preserve the existing accepted resource limit. A pathological charset
    // expansion can make prepared text larger than its original resource; keep
    // that rare entry in its old bounded form instead of rejecting valid mail.
    if serde_json::to_vec(resource.as_ref())
        .map_err(|_| "invalid_message")?
        .len()
        > limit
    {
        return Err("reader_resource_too_large");
    }
    let prepared = prepare(resource.as_ref(), id, now)?;
    if prepared.bytes()? <= limit {
        return Ok(prepared);
    }
    Ok(Prepared {
        source: String::new(),
        base: Value::Null,
        source_hash: [0; 32],
        fallback: Some((resource, now)),
    })
}

fn render_prepared(
    prepared: &Prepared,
    account: &str,
    id: &str,
    key: &str,
    mut options: Value,
    renders: &Arc<Mutex<cache::render::RenderCache>>,
    live: Option<&Arc<Mutex<bool>>>,
) -> Result<Value, &'static str> {
    if let Some((resource, now)) = &prepared.fallback {
        return render_prepared(
            &prepare(resource.as_ref(), id, *now)?,
            account,
            id,
            key,
            options,
            renders,
            live,
        );
    }
    let html_body = prepared.base["nativeContent"]["body"]["source"] == "html";
    options["withPlainText"] = json!(html_body);
    options["withReader"] = json!(true);
    // Original keeps the sender's sanitized layout; Reader is rebuilt separately.
    options["preserveFormatting"] = json!(true);
    let mut revision = Sha256::new();
    revision.update(prepared.source_hash);
    revision.update(serde_json::to_vec(&options).map_err(|_| "invalid_params")?);
    let revision = format!("{:x}", revision.finalize());
    let mut rendered = super::content::render(
        &json!({"accountId":account,"messageId":id,"html":prepared.source,"options":options}),
        renders,
        live,
    )?;
    // QML draws both sanitized document trees. Serialized HTML copies are
    // redundant and must not cross the process boundary a second time.
    rendered
        .as_object_mut()
        .ok_or("invalid_message")?
        .remove("html");
    if let Some(reader) = rendered["reader"].as_object_mut() {
        reader.remove("html");
    }
    rendered["revision"] = json!(revision);
    let mut result = prepared.base.clone();
    if html_body && rendered["plainText"].is_object() {
        result["nativeContent"]["body"] = json!({"text":rendered["plainText"]["text"],"source":"html","bodyDirection":rendered["plainText"]["bodyDirection"]});
    }
    result["readerKey"] = json!(key);
    result["nativeRender"] = rendered;
    Ok(result)
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn projection(
    resource: &Value,
    account: &str,
    id: &str,
    key: &str,
    now: i64,
    options: Value,
    renders: &Arc<Mutex<cache::render::RenderCache>>,
    live: Option<&Arc<Mutex<bool>>>,
) -> Result<Value, &'static str> {
    render_prepared(
        &prepare(resource, id, now)?,
        account,
        id,
        key,
        options,
        renders,
        live,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    fn fixture() -> Value {
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            "<p>Hello</p><script>EVIL_SCRIPT</script><img src=\"https://example.org/pixel\">",
        );
        json!({"id":"m","payload":{"mimeType":"multipart/mixed","headers":[{"name":"Subject","value":"Hello"}],"parts":[
            {"mimeType":"text/html","body":{"data":encoded}},
            {"mimeType":"application/octet-stream","filename":"file.bin","body":{"data":"RklMRV9TRUNSRVQ","attachmentId":"attachment"}},
            {"mimeType":"text/calendar","body":{"data":"QkVHSU46VkNBTEVOREFS"},"parts":[{"mimeType":"application/octet-stream","body":{"data":"NESTED_SECRET"}}]}
        ]}})
    }
    #[test]
    fn projection_keeps_display_and_locators_without_sender_html_or_files() {
        let result = projection(
            &fixture(),
            "a@example.org",
            "m",
            "1",
            0,
            json!({}),
            &Default::default(),
            None,
        )
        .unwrap();
        assert!(result["nativeContent"].get("html").is_none());
        let text = result.to_string();
        assert!(!text.contains("RklMRV9TRUNSRVQ"));
        assert!(!text.contains("NESTED_SECRET"));
        assert!(!text.contains("EVIL_SCRIPT"));
        assert_eq!(result["readerKey"], "1");
        assert_eq!(
            result["payload"]["parts"][0]["body"]["data"],
            "QkVHSU46VkNBTEVOREFS"
        );
        assert!(result["nativeRender"]["document"].is_object());
    }
    #[test]
    fn opaque_sources_are_bound_to_account_and_message() {
        let mut store = ReaderStore::default();
        let key = store
            .put("a", "m", Arc::new(prepare(&fixture(), "m", 0).unwrap()))
            .unwrap();
        assert!(store.get("b", "m", &key).is_err());
        assert!(store.get("a", "other", &key).is_err());
        assert!(store.get("a", "m", &key).is_ok());
    }
    #[test]
    fn dropped_request_invalidates_workers_and_clears_registration() {
        let store = Arc::new(Mutex::new(ReaderStore::default()));
        let job = Job {
            live: Arc::new(Mutex::new(true)),
            cancelled: Arc::new(Notify::new()),
        };
        let key = ("a".into(), "request".into());
        store.lock().unwrap().jobs.insert(key.clone(), job.clone());
        drop(Registration {
            store: store.clone(),
            key,
            live: job.live.clone(),
        });
        assert_eq!(job.current(), Err("reader_cancelled"));
        assert!(store.lock().unwrap().jobs.is_empty());
        assert!(
            projection(
                &fixture(),
                "a",
                "m",
                "1",
                0,
                json!({}),
                &Default::default(),
                Some(&job.live)
            )
            .is_err()
        );
    }
    #[tokio::test]
    async fn cancel_before_open_refuses_before_registry_or_provider_read() {
        let session = Session::default();
        session
            .reader_call(
                "reader.cancel",
                &json!({"accountId":"synthetic@example.org","requestId":"early"}),
            )
            .await
            .unwrap();
        let result = session.reader_call("reader.open", &json!({"accountId":"synthetic@example.org","id":"m","requestId":"early","cacheOnly":false,"now":0,"options":{}})).await;
        assert_eq!(result, Err("reader_cancelled"));
        assert!(session.reader.lock().unwrap().jobs.is_empty());
    }
    #[test]
    fn cancelled_render_cannot_commit_to_shared_cache() {
        let cache = Arc::new(Mutex::new(cache::render::RenderCache::default()));
        let live = Arc::new(Mutex::new(false));
        let params = json!({"accountId":"a","messageId":"m","html":"<p>hello</p>","options":{}});
        assert_eq!(
            super::super::content::render(&params, &cache, Some(&live)),
            Err("reader_cancelled")
        );
        assert!(
            cache
                .lock()
                .unwrap()
                .get("a", "m", "<p>hello</p>", &json!({"options":{}}))
                .is_none()
        );
    }
    #[test]
    fn deferred_html_read_matches_rendered_body_and_preserves_summary() {
        let resource = fixture();
        let original = message::content::prepare(&resource, 0).unwrap();
        let deferred = message::content::prepare_for_render(&resource, 0).unwrap();
        assert_eq!(original["summary"], deferred["summary"]);
        assert_eq!(original["attachments"], deferred["attachments"]);
        assert_eq!(deferred["body"]["text"], "");
        let rendered = projection(
            &resource,
            "a",
            "m",
            "k",
            0,
            json!({}),
            &Default::default(),
            None,
        )
        .unwrap();
        assert_eq!(
            rendered["nativeContent"]["body"]["text"],
            rendered["nativeRender"]["plainText"]["text"]
        );
        assert_eq!(
            rendered["nativeContent"]["body"]["bodyDirection"],
            rendered["nativeRender"]["plainText"]["bodyDirection"]
        );
        assert_eq!(rendered["nativeSummary"], original["summary"]);
        let plain = json!({"id":"m","payload":{"mimeType":"text/plain","headers":[],"body":{"data":"SGVsbG8"}}});
        assert_eq!(
            message::content::prepare(&plain, 0).unwrap(),
            message::content::prepare_for_render(&plain, 0).unwrap()
        );
    }
    #[test]
    fn prepared_original_preserves_sender_layout_without_styling_reader() {
        let mut prepared = prepare(&fixture(), "m", 0).unwrap();
        prepared.source = "<center><table bgcolor=\"#234567\"><tr><td><p align=\"center\">Heading</p></td></tr></table></center>".into();
        let result = render_prepared(
            &prepared,
            "a",
            "m",
            "key",
            json!({}),
            &Default::default(),
            None,
        )
        .unwrap();
        let original: message::html::Node =
            serde_json::from_value(result["nativeRender"]["document"].clone()).unwrap();
        let reader: message::html::Node =
            serde_json::from_value(result["nativeRender"]["reader"]["document"].clone()).unwrap();
        let original = message::html::serialize(&original).unwrap();
        let reader = message::html::serialize(&reader).unwrap();
        assert!(original.contains("<center><table bgcolor=\"#234567\">"));
        assert!(original.contains("align=\"center\""));
        assert_eq!(reader, "<p>Heading</p>");
    }
    #[test]
    fn compact_render_preserves_both_documents_and_every_policy_field() {
        let prepared = prepare(&fixture(), "m", 0).unwrap();
        let options = json!({"withPlainText":true,"withReader":true});
        let mut old = super::super::content::render(
            &json!({"accountId":"a","messageId":"m","html":prepared.source,"options":options}),
            &Default::default(),
            None,
        )
        .unwrap();
        old.as_object_mut().unwrap().remove("html");
        old["reader"].as_object_mut().unwrap().remove("html");
        let mut current = render_prepared(
            &prepared,
            "a",
            "m",
            "key",
            options,
            &Default::default(),
            None,
        )
        .unwrap()["nativeRender"]
            .take();
        assert!(current.get("html").is_none());
        assert!(current["reader"].get("html").is_none());
        current.as_object_mut().unwrap().remove("revision");
        assert_eq!(old, current);
    }
    #[test]
    fn prepared_cache_discards_file_octets_and_reuses_prepared_identity() {
        let mut resource = fixture();
        resource["payload"]["parts"][1]["body"]["data"] = json!("A".repeat(2 * 1024 * 1024));
        let prepared = Arc::new(prepare_for_store(Arc::new(resource), "m", 0).unwrap());
        assert!(prepared.fallback.is_none());
        assert!(prepared.bytes().unwrap() < 10000);
        let mut store = ReaderStore::default();
        let key = store.put("a", "m", prepared.clone()).unwrap();
        assert!(Arc::ptr_eq(&prepared, &store.get("a", "m", &key).unwrap()));
    }
    #[test]
    fn prepared_expansion_keeps_old_resource_bound_and_render_parity() {
        let resource = Arc::new(
            json!({"id":"m","payload":{"mimeType":"text/plain","headers":[],"body":{"data":"SGVsbG8"}}}),
        );
        let old_bytes = serde_json::to_vec(resource.as_ref()).unwrap().len();
        let prepared = prepare_for_store_bounded(resource.clone(), "m", 0, old_bytes).unwrap();
        assert!(prepared.fallback.is_some());
        assert_eq!(prepared.bytes().unwrap(), old_bytes);
        let rendered = render_prepared(
            &prepared,
            "a",
            "m",
            "k",
            json!({}),
            &Default::default(),
            None,
        )
        .unwrap();
        assert_eq!(
            rendered,
            projection(
                resource.as_ref(),
                "a",
                "m",
                "k",
                0,
                json!({}),
                &Default::default(),
                None
            )
            .unwrap()
        );
        assert!(prepare_for_store_bounded(resource, "m", 0, old_bytes - 1).is_err());
    }
    #[test]
    fn revision_tracks_every_render_policy_and_source_without_instance_keys() {
        let prepared = prepare(&fixture(), "m", 0).unwrap();
        let render = |p: &Prepared, key: &str, options: Value| {
            render_prepared(p,"a","m",key,options,&Default::default(),None).unwrap()["nativeRender"]["revision"].clone()
        };
        let first = render(&prepared, "first", json!({}));
        assert_eq!(first, render(&prepared, "second", json!({})));
        assert_ne!(
            first,
            render(&prepared, "first", json!({"allowRemoteImages":true}))
        );
        assert_ne!(
            first,
            render(&prepared, "first", json!({"keepColors":true}))
        );
        let mut resource = fixture();
        resource["payload"]["parts"][0]["body"]["data"] =
            json!(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode("<p>Different</p>"));
        assert_ne!(
            first,
            render(&prepare(&resource, "m", 0).unwrap(), "first", json!({}))
        );
    }
}
