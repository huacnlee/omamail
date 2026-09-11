//! Native reader pipeline. Raw resources and sender HTML never form UI requests.
use super::Session;
use crate::{cache, message};
use serde_json::{Value, json};
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
    resource: Arc<Value>,
    bytes: usize,
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
        resource: Arc<Value>,
    ) -> Result<String, &'static str> {
        let bytes = serde_json::to_vec(resource.as_ref())
            .map_err(|_| "invalid_message")?
            .len();
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
            resource,
            bytes,
        });
        Ok(key)
    }
    fn get(&mut self, account: &str, id: &str, key: &str) -> Result<Arc<Value>, &'static str> {
        let at = self
            .entries
            .iter()
            .position(|v| v.account == account && v.id == id && v.key == key)
            .ok_or("reader_source_expired")?;
        let entry = self.entries.remove(at).ok_or("reader_source_expired")?;
        let value = entry.resource.clone();
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
            let resource = self
                .reader
                .lock()
                .map_err(|_| "session_failed")?
                .get(&account, &id, key)?;
            let key = key.to_owned();
            let renders = self.renders.clone();
            return tokio::task::spawn_blocking(move || {
                projection(
                    resource.as_ref(),
                    &account,
                    &id,
                    &key,
                    now,
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
                let mut store_guard = store.lock().map_err(|_| "session_failed")?;
                let live_guard = job.live.lock().map_err(|_| "session_failed")?;
                if !*live_guard {
                    return Err("reader_cancelled");
                }
                let key = store_guard.put(&account, &id, resource.clone())?;
                drop(live_guard);
                drop(store_guard);
                let result = projection(
                    resource.as_ref(),
                    &account,
                    &id,
                    &key,
                    now,
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
#[allow(clippy::too_many_arguments)] // Explicit source identity, render policy, and cancellation boundary.
fn projection(
    resource: &Value,
    account: &str,
    id: &str,
    key: &str,
    now: i64,
    mut options: Value,
    renders: &Arc<Mutex<cache::render::RenderCache>>,
    live: Option<&Arc<Mutex<bool>>>,
) -> Result<Value, &'static str> {
    let mut prepared = message::content::prepare_for_render(resource, now)?;
    let source = prepared["html"].as_str().unwrap_or("");
    let html_body = prepared["body"]["source"] == "html";
    options["withPlainText"] = json!(html_body);
    options["withReader"] = json!(true);
    let rendered = super::content::render(
        &json!({"accountId":account,"messageId":id,"html":source,"options":options}),
        renders,
        live,
    )?;
    let has_html = !source.is_empty();
    prepared
        .as_object_mut()
        .ok_or("invalid_message")?
        .remove("html");
    if html_body && rendered["plainText"].is_object() {
        prepared["body"] = json!({"text":rendered["plainText"]["text"],"source":"html","bodyDirection":rendered["plainText"]["bodyDirection"]});
    }
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
    Ok(
        json!({"id":id,"threadId":resource["threadId"],"labelIds":resource["labelIds"],"readerKey":key,"hasHtml":has_html,"payload":{"mimeType":"multipart/mixed","headers":resource["payload"]["headers"],"parts":parts},"nativeSummary":prepared["summary"],"nativeContent":prepared,"nativeRender":rendered}),
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
        let key = store.put("a", "m", Arc::new(fixture())).unwrap();
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
}
