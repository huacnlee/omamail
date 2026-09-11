//! A small background lane warms the same caches used by interactive readers.
//! Provider reads remain read-only; no mark-seen operation is issued here.
use super::*;
use futures_util::{StreamExt, stream};
use tokio::sync::Semaphore;
// Automatic warmup stays small; an explicit reader still keeps the existing
// message/transport limits and can fetch larger messages normally.
const MAX_AUTOMATIC_BYTES: u64 = 2 * 1024 * 1024;

pub(super) type Live = Arc<Mutex<bool>>;
pub(super) type Warm = Arc<
    dyn Fn(String, u64, Live) -> BoxFuture<'static, Result<(), &'static str>>
        + Send
        + std::marker::Sync,
>;

pub(super) struct Job {
    pub fingerprint: String,
    pub complete: Arc<std::sync::atomic::AtomicBool>,
    live: Live,
    task: JoinHandle<()>,
    started_at: std::time::Instant,
}
impl Job {
    pub fn start(warm: Warm, account: String, limit: u64, fingerprint: String) -> Self {
        let live = Arc::new(Mutex::new(true));
        let complete = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let task = tokio::spawn({
            let live = live.clone();
            let complete = complete.clone();
            async move {
                // Let the mailbox notification and immediate interactive requests run first.
                tokio::time::sleep(Duration::from_millis(250)).await;
                if tokio::time::timeout(
                    Duration::from_secs(180),
                    warm(account, limit, live.clone()),
                )
                .await
                .is_ok_and(|r| r.is_ok())
                {
                    complete.store(true, std::sync::atomic::Ordering::Release);
                } else {
                    *live.lock().unwrap_or_else(|e| e.into_inner()) = false;
                }
            }
        });
        Self {
            fingerprint,
            complete,
            live,
            task,
            started_at: std::time::Instant::now(),
        }
    }
    pub fn finished(&self) -> bool {
        self.task.is_finished()
    }
    pub fn refresh_due(&self, interval: u64) -> bool {
        self.finished() && self.started_at.elapsed() >= Duration::from_secs(interval)
    }
}
impl Drop for Job {
    fn drop(&mut self) {
        // Writers hold this same short-lived lock around the final commit.
        // Thus no old generation can rename a cache file after cancellation returns.
        *self.live.lock().unwrap_or_else(|e| e.into_inner()) = false;
        self.task.abort();
    }
}
fn current(live: &Live) -> Result<(), &'static str> {
    if *live.lock().map_err(|_| "preload_cancelled")? {
        Ok(())
    } else {
        Err("preload_cancelled")
    }
}

async fn small_body<F, Fut>(
    account: &str,
    size: u64,
    read: F,
) -> Result<Option<Value>, &'static str>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<Value, &'static str>>,
{
    if size > MAX_AUTOMATIC_BYTES
        || (size == 0 && (account.starts_with("imap:") || account.starts_with("outlook:")))
    {
        return Ok(None);
    }
    let resource = match read().await {
        Ok(resource) => resource,
        Err("message_too_large" | "imap_response_too_large" | "gmail_response_too_large") => {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    if serde_json::to_vec(&resource)
        .map_err(|_| "preload_invalid_resource")?
        .len() as u64
        > MAX_AUTOMATIC_BYTES
    {
        return Ok(None);
    }
    Ok(Some(resource))
}

struct Provider {
    gmail: Arc<crate::providers::gmail::Session>,
    jmap: Arc<crate::providers::jmap::Session>,
    slots: Semaphore,
}
fn inbox(account: &str) -> &'static str {
    let provider = if account.starts_with("jmap:") {
        "jmap"
    } else if account.starts_with("hey:") {
        "hey"
    } else if account.starts_with("imap:") {
        "imap"
    } else if account.starts_with("outlook:") {
        "outlook"
    } else {
        "gmail"
    };
    crate::providers::domain::mailbox_query(provider, "inbox")
        .expect("every mail provider has an Inbox query")
}

impl Provider {
    async fn request(
        &self,
        account: &str,
        method: &str,
        params: Value,
        live: &Live,
    ) -> Result<Value, &'static str> {
        let _permit = self
            .slots
            .acquire()
            .await
            .map_err(|_| "preload_cancelled")?;
        current(live)?;
        tokio::time::timeout(Duration::from_secs(10), async {
            if account.starts_with("jmap:") {
                let result = self.jmap.call(method, &params).await?;
                Ok(result["data"].clone())
            } else if account.starts_with("hey:") {
                let program = crate::providers::hey_access::program()?;
                let mut params = params;
                params["program"] = json!(program);
                let checked = crate::providers::hey_access::checked_params(&params).await?;
                crate::providers::hey::call(method, &checked).await
            } else if account.starts_with("imap:") || account.starts_with("outlook:") {
                crate::providers::imap::call(method, &params).await
            } else {
                self.gmail.call(method, &params).await
            }
        })
        .await
        .map_err(|_| "preload_timeout")?
    }
    async fn page(&self, account: &str, limit: u64, live: &Live) -> Result<Value, &'static str> {
        let query = inbox(account);
        if account.starts_with("jmap:") {
            self.request(
                account,
                "jmap.list",
                json!({"accountId":account,"query":query,"maxResults":limit,"pageToken":""}),
                live,
            )
            .await
        } else if account.starts_with("hey:") {
            self.request(
                account,
                "hey.list",
                json!({"accountId":account,"query":query,"pageSize":limit,"pageToken":""}),
                live,
            )
            .await
        } else if account.starts_with("imap:") || account.starts_with("outlook:") {
            let result = self.request(account,"imap.list",json!({"accountId":account,"query":query,"limit":limit,"pageToken":"","progressive":false}),live).await?;
            if result["warning"].as_str().is_some_and(|v| !v.is_empty()) {
                return Err("preload_incomplete");
            }
            Ok(result["page"].clone())
        } else {
            self.request(
                account,
                "gmail.list",
                json!({"accountId":account,"query":query,"pageSize":limit,"pageToken":""}),
                live,
            )
            .await
        }
    }
    async fn read(
        &self,
        account: &str,
        id: &str,
        full: bool,
        live: &Live,
    ) -> Result<Value, &'static str> {
        if account.starts_with("jmap:") {
            self.request(
                account,
                "jmap.read",
                json!({"accountId":account,"id":id,"full":full}),
                live,
            )
            .await
        } else if account.starts_with("hey:") {
            self.request(
                account,
                "hey.read",
                json!({"accountId":account,"id":id}),
                live,
            )
            .await
        } else if account.starts_with("imap:") || account.starts_with("outlook:") {
            let result = self
                .request(
                    account,
                    "imap.messages",
                    json!({"accountId":account,"ids":[id],"full":full,"progressive":false}),
                    live,
                )
                .await?;
            result["messages"]
                .as_array()
                .and_then(|m| m.first())
                .cloned()
                .ok_or("preload_message_missing")
        } else {
            self.request(
                account,
                "gmail.read",
                json!({"accountId":account,"id":id,"full":full}),
                live,
            )
            .await
        }
    }
}
pub(super) fn production(
    gmail: Arc<crate::providers::gmail::Session>,
    jmap: Arc<crate::providers::jmap::Session>,
    queries: Arc<crate::cache::query::QueryCache>,
) -> Warm {
    let provider = Arc::new(Provider {
        gmail,
        jmap,
        slots: Semaphore::new(2),
    });
    Arc::new(move |account, limit, live| {
        let provider = provider.clone();
        let queries = queries.clone();
        Box::pin(async move {
            let page = provider.page(&account, limit, &live).await?;
            current(&live)?;
            let ids: Vec<String> = page["ids"]
                .as_array()
                .ok_or("preload_invalid_page")?
                .iter()
                .take(limit as usize)
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let mut seen = std::collections::HashSet::new();
            let ids: Vec<_> = ids
                .into_iter()
                .filter(|id| seen.insert(id.clone()))
                .collect();
            let previews = page["messages"].as_array().cloned().unwrap_or_default();
            let mut pending = Vec::new();
            for id in &ids {
                let id = id.clone();
                let provider = provider.clone();
                let account = account.clone();
                let live = live.clone();
                let held = previews.iter().find(|m| m["id"] == id).cloned();
                pending.push(async move {
                    let fetched = held.is_none();
                    let message = if let Some(resource) = held {
                        resource
                    } else {
                        provider.read(&account, &id, false, &live).await?
                    };
                    let summary = crate::message::content::summarize(
                        &message,
                        chrono::Utc::now().timestamp_millis(),
                    )?;
                    // HEY has no separate metadata read. Reuse its complete
                    // thread response instead of issuing the same read twice.
                    if fetched
                        && account.starts_with("hey:")
                        && serde_json::to_vec(&message)
                            .map_err(|_| "preload_invalid_resource")?
                            .len() as u64
                            <= MAX_AUTOMATIC_BYTES
                    {
                        crate::cache::resource::put_guarded(&account, &id, &message, live.clone())
                            .await?;
                    }
                    Ok::<_, &'static str>((summary, message["sizeEstimate"].as_u64().unwrap_or(0)))
                });
            }
            let summaries = stream::iter(pending)
                .buffered(2)
                .collect::<Vec<_>>()
                .await
                .into_iter()
                .collect::<Result<Vec<_>, _>>()?;
            let sizes: Vec<_> = summaries.iter().map(|(_, size)| *size).collect();
            let summaries: Vec<_> = summaries.into_iter().map(|(summary, _)| summary).collect();
            current(&live)?;
            queries.prefetch(&account,inbox(&account),limit,&json!({"summaries":summaries,"estimate":page["estimate"],"nextPageToken":page["nextPageToken"]}),live.clone()).await?;
            // Full resources are fetched one at a time per account. Across all
            // accounts only two preload network requests may consume transport slots.
            for (id, size) in ids.into_iter().zip(sizes) {
                current(&live)?;
                if crate::cache::resource::read(&account, &id).await?.is_some() {
                    continue;
                }
                let Some(resource) =
                    small_body(&account, size, || provider.read(&account, &id, true, &live))
                        .await?
                else {
                    continue;
                };
                current(&live)?;
                match crate::cache::resource::put_guarded(&account, &id, &resource, live.clone())
                    .await
                {
                    Ok(()) | Err("cache_body_too_large") => (),
                    Err(error) => return Err(error),
                }
                tokio::task::yield_now().await;
            }
            Ok(())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn large_or_unknown_imap_messages_never_invoke_full_read() {
        for (account, size) in [
            ("imap:a", 0),
            ("outlook:a", 0),
            ("a", MAX_AUTOMATIC_BYTES + 1),
            ("jmap:a", MAX_AUTOMATIC_BYTES + 1),
        ] {
            let result = small_body(account, size, || async {
                panic!("forbidden background full read")
            })
            .await
            .unwrap();
            assert!(result.is_none());
        }
        let resource = json!({"id":"small","payload":{"body":{"data":"aGk"}}});
        assert_eq!(
            small_body("imap:a", 100, || async { Ok(resource.clone()) })
                .await
                .unwrap(),
            Some(resource)
        );
    }
    #[tokio::test]
    async fn understated_or_transport_oversize_is_not_a_cacheable_result() {
        let large = json!({"id":"large","body":"x".repeat(MAX_AUTOMATIC_BYTES as usize)});
        assert_eq!(
            small_body("imap:a", 100, || async { Ok(large) })
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            small_body("imap:a", 100, || async { Err("message_too_large") })
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            small_body("imap:a", 100, || async { Err("imap_timeout") }).await,
            Err("imap_timeout")
        );
    }
    #[test]
    fn inbox_queries_match_provider_mailbox_contracts() {
        for (account, query) in [
            ("a", "in:inbox"),
            ("hey:a", "box:imbox"),
            ("jmap:a", "role:inbox"),
            ("imap:a", "folder:INBOX"),
            ("outlook:a", "folder:INBOX"),
        ] {
            assert_eq!(inbox(account), query);
        }
    }
}
