mod content;
mod reader;
mod methods;
pub mod protocol;
mod rpc;
pub mod stdio;
pub mod upload;
use crate::{account, message};

pub struct Session {
    uploads: std::sync::Mutex<upload::Uploads>,
    reader: std::sync::Arc<std::sync::Mutex<reader::ReaderStore>>,
    agent_context: crate::agent::context::Contexts,
    upload_jobs: tokio::sync::Semaphore,
    gmail: std::sync::Arc<crate::providers::gmail::Session>,
    mail: crate::sync::Sync,
    auth: crate::auth::Session,
    jmap: std::sync::Arc<crate::providers::jmap::Session>,
    outbox: crate::outbox::Outbox,
    queries: std::sync::Arc<crate::cache::query::QueryCache>,
    renders: std::sync::Arc<std::sync::Mutex<crate::cache::render::RenderCache>>,
    intents: std::sync::Arc<crate::account::intents::IntentStore>,
}

impl Default for Session {
    fn default() -> Self {
        let gmail = std::sync::Arc::new(crate::providers::gmail::Session::default());
        let jmap = std::sync::Arc::new(crate::providers::jmap::Session::default());
        let sender_gmail = gmail.clone();
        let sender_jmap = jmap.clone();
        let outbox = crate::outbox::Outbox::new(std::sync::Arc::new(move |job| {
            let gmail = sender_gmail.clone();
            let jmap = sender_jmap.clone();
            Box::pin(async move { crate::outbox::delivery::send(&job, &gmail, &jmap).await })
        }));
        let queries = std::sync::Arc::new(crate::cache::query::QueryCache::default());
        Self {
            uploads: Default::default(),
            reader: Default::default(),
            agent_context: Default::default(),
            upload_jobs: tokio::sync::Semaphore::new(2),
            mail: crate::sync::Sync::new(gmail.clone(), jmap.clone(), queries.clone()),
            gmail,
            auth: Default::default(),
            jmap,
            outbox,
            queries,
            renders: Default::default(),
            intents: Default::default(),
        }
    }
}

impl Session {
    // Keep provider state machines behind heap indirection. Uploaded requests
    // re-enter this dispatcher; embedding every provider future here overflowed
    // the worker stack in the real Quickshell large-request integration test.
    pub async fn dispatch(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        if matches!(method, "system.info" | "system.quit" | "providers.list") {
            return dispatch(method, params);
        }
        if matches!(method, "reader.open" | "reader.render" | "reader.cancel") {
            return Box::pin(self.reader_call(method, params)).await;
        }
        if matches!(method, "agent.context" | "agent.contextCancel") {
            return Box::pin(self.agent_context.call(method, params, self)).await;
        }
        if matches!(method, "account.identities" | "account.conversation") {
            let method = method.to_owned();
            let params = params.clone();
            return tokio::task::spawn_blocking(move || {
                if method == "account.identities" {
                    crate::account::senders::request(&params)
                } else {
                    crate::account::conversation::request(&params)
                }
            }).await.map_err(|_| "worker_failed")?;
        }
        if matches!(method, "providers.resolve" | "providers.snapshot") {
            if method == "providers.resolve" {
                return crate::providers::domain::resolve(params);
            }
            if params != &json!({}) { return Err("invalid_params"); }
            return Ok(crate::providers::domain::snapshot());
        }
        if matches!(method, "agent.jobsList" | "agent.jobsProjection" | "agent.jobStart" | "agent.jobShow" | "agent.jobCancel" | "agent.jobForget") {
            return Box::pin(crate::agent::jobs::call(method, params)).await;
        }
        if method.starts_with("outbox.") {
            return Box::pin(self.outbox.call(method, params)).await;
        }
        if method == "model.intent" {
            let intents = self.intents.clone();
            let params = params.clone();
            return tokio::task::spawn_blocking(move || intents.call(&params))
                .await
                .map_err(|_| "worker_failed")?;
        }
        if method.starts_with("message.") && method != "message.parseUpload" {
            let method = method.to_owned();
            let params = params.clone();
            let renders = self.renders.clone();
            return tokio::task::spawn_blocking(move || content::call(&method, &params, &renders))
                .await
                .map_err(|_| "worker_failed")?;
        }
        if method.starts_with("cache.query") {
            let value = Box::pin(self.queries.call(method, params)).await?;
            if matches!(method, "cache.queryClear" | "cache.queryBind") {
                self.renders
                    .lock()
                    .map_err(|_| "session_failed")?
                    .invalidate(params["accountId"].as_str().unwrap_or(""), None);
            }
            return Ok(value);
        }
        if method == "attachment.forget" {
            let params = params.clone();
            return tokio::task::spawn_blocking(move || crate::attachment::forget(&params))
                .await
                .map_err(|_| "worker_failed")?;
        }
        if matches!(method, "accounts.read" | "accounts.save") {
            let method = method.to_owned();
            let params = params.clone();
            return tokio::task::spawn_blocking(move || account::call(&method, &params))
                .await
                .map_err(|_| "worker_failed")?;
        }
        if matches!(method, "compose.recoveryRead" | "compose.recoverySave") {
            let method = method.to_owned();
            let params = params.clone();
            return tokio::task::spawn_blocking(move || crate::compose::call(&method, &params))
                .await
                .map_err(|_| "worker_failed")?;
        }
        if matches!(method, "model.unified" | "model.apply") {
            let method = method.to_owned();
            let params = params.clone();
            return tokio::task::spawn_blocking(move || {
                if method == "model.unified" {
                    crate::account::unified::apply(&params)
                } else {
                    crate::account::model::apply(&params)
                }
            })
            .await
            .map_err(|_| "worker_failed")?;
        }
        if method.starts_with("hey.") {
            let checked = crate::providers::hey_access::checked_params(params).await?;
            return if matches!(method, "hey.act" | "hey.send" | "hey.saveDraft") {
                Box::pin(crate::providers::hey_actions::call(method, &checked)).await
            } else {
                Box::pin(crate::providers::hey::call(method, &checked)).await
            };
        }
        if method == "auth.token" && params["provider"] == "gmail" {
            let fields = params.as_object().ok_or("invalid_params")?;
            if fields
                .keys()
                .any(|key| !["provider", "accountId", "resource"].contains(&key.as_str()))
                || fields.get("resource").is_some_and(|value| value != "mail")
            {
                return Err("invalid_params");
            }
            let account = params["accountId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("invalid_params")?;
            let token = self.gmail.access_token(account).await?;
            // A saved grant marker is not evidence of the scopes on a refreshed token.
            // Scope is optional on restore; initial sign-in validates the actual response.
            return Ok(json!({"access_token":token,"expires_in":60}));
        }
        if method.starts_with("auth.") {
            return Box::pin(self.auth.call(method, params)).await;
        }
        if method.starts_with("jmap.") {
            return Box::pin(self.jmap.call(method, params)).await;
        }
        if method.starts_with("imap.") || method == "smtp.send" {
            return Box::pin(crate::providers::imap::call(method, params)).await;
        }
        if method == "outlook.graphSend" {
            return Box::pin(self.auth.call(method, params)).await;
        }
        if method == "attachment.read" {
            let params = params.clone();
            return tokio::task::spawn_blocking(move || crate::attachment::read(&params))
                .await
                .map_err(|_| "worker_failed")?;
        }
        if method == "attachment.store" {
            let params = params.clone();
            return tokio::task::spawn_blocking(move || {
                let bytes =
                    crate::attachment::decode(params["data"].as_str().ok_or("invalid_params")?)?;
                crate::attachment::store(&params, &bytes)
            })
            .await
            .map_err(|_| "worker_failed")?;
        }
        if method == "attachment.storeUpload" {
            let mut fields = params.as_object().cloned().ok_or("invalid_params")?;
            if fields
                .keys()
                .any(|key| !["upload", "filename", "open"].contains(&key.as_str()))
            {
                return Err("invalid_params");
            }
            let upload = fields.remove("upload").ok_or("invalid_params")?;
            let params = Value::Object(fields);
            let bytes = self
                .uploads
                .lock()
                .map_err(|_| "session_failed")?
                .take(&json!({"upload":upload}))?;
            return tokio::task::spawn_blocking(move || crate::attachment::store(&params, &bytes))
                .await
                .map_err(|_| "worker_failed")?;
        }
        if method == "contacts.suggest" {
            if params != &json!({}) {
                return Err("invalid_params");
            }
            return tokio::task::spawn_blocking(crate::contacts::suggest)
                .await
                .map_err(|_| "worker_failed")?;
        }
        if matches!(method, "public.image" | "public.unsubscribe") {
            let fields = params.as_object().ok_or("invalid_params")?;
            if fields.len() != 1 {
                return Err("invalid_params");
            }
            let url = fields
                .get("url")
                .and_then(Value::as_str)
                .ok_or("invalid_params")?;
            return if method == "public.image" {
                Ok(json!({"data":crate::public_http::image(url).await?}))
            } else {
                Ok(json!({"status":crate::public_http::unsubscribe(url).await?}))
            };
        }
        if method.starts_with("gmail.") {
            return Box::pin(self.gmail.call(method, params)).await;
        }
        if method.starts_with("mail.") {
            return Box::pin(self.mail.call(method, params)).await;
        }
        if method == "request.upload" {
            let fields = params.as_object().ok_or("invalid_params")?;
            if fields.len() != 2 {
                return Err("invalid_params");
            }
            let target = fields
                .get("method")
                .and_then(Value::as_str)
                .ok_or("invalid_params")?;
            if target == "request.upload"
                || target == "system.quit"
                || target.starts_with("upload.")
            {
                return Err("invalid_params");
            }
            let _permit = self
                .upload_jobs
                .acquire()
                .await
                .map_err(|_| "session_failed")?;
            let upload = fields.get("upload").ok_or("invalid_params")?;
            let bytes = self
                .uploads
                .lock()
                .map_err(|_| "session_failed")?
                .take(&json!({"upload":upload}))?;
            let params: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid_params")?;
            return Box::pin(self.dispatch(target, &params)).await;
        }
        if method == "calendar.request" {
            let token = match params["source"]["kind"].as_str() {
                Some("google") => Some(
                    self.gmail
                        .access_token(
                            params["source"]["accountId"]
                                .as_str()
                                .ok_or("invalid_params")?,
                        )
                        .await?,
                ),
                Some("microsoft") => Some(
                    crate::auth::access_token(
                        "outlook",
                        params["source"]["accountId"]
                            .as_str()
                            .ok_or("invalid_params")?,
                        "graph",
                    )
                    .await?,
                ),
                Some("caldav") => None,
                _ => None,
            };
            return Box::pin(crate::calendar::call(params, token.as_deref())).await;
        }
        if method == "cache.bodyPutUpload" {
            let mut params = params.as_object().cloned().ok_or("invalid_params")?;
            if params
                .keys()
                .any(|key| !["accountId", "id", "upload"].contains(&key.as_str()))
            {
                return Err("invalid_params");
            }
            let upload = params.remove("upload").ok_or("invalid_params")?;
            let params = Value::Object(params);
            crate::cache::validate_params(&params, true)?;
            let bytes = self
                .uploads
                .lock()
                .map_err(|_| "session_failed")?
                .take(&json!({"upload":upload}))?;
            return tokio::task::spawn_blocking(move || crate::cache::put_upload(&params, &bytes))
                .await
                .map_err(|_| "worker_failed")?;
        }
        if matches!(
            method,
            "cache.resourceRead"
                | "cache.resourcePut"
                | "cache.resourceClear"
                | "cache.bodyRead"
                | "cache.bodyPut"
                | "cache.bodyTouch"
                | "cache.bodyClear"
                | "cache.storeRead"
                | "cache.storePut"
                | "cache.calendarRead"
                | "cache.calendarPut"
        ) {
            let method = method.to_owned();
            let params = params.clone();
            let renders = self.renders.clone();
            return tokio::task::spawn_blocking(move || {
                let value = crate::cache::call(&method, &params)?;
                if matches!(method.as_str(), "cache.bodyClear" | "cache.resourceClear") {
                    renders
                        .lock()
                        .map_err(|_| "session_failed")?
                        .invalidate(params["accountId"].as_str().unwrap_or(""), None);
                }
                Ok(value)
            })
            .await
            .map_err(|_| "worker_failed")?;
        }
        if method.starts_with("upload.") {
            return self
                .uploads
                .lock()
                .map_err(|_| "session_failed")?
                .call(method, params);
        }
        if method == "message.parseUpload" {
            let bytes = self
                .uploads
                .lock()
                .map_err(|_| "session_failed")?
                .take(params)?;
            return tokio::task::spawn_blocking(move || message::parse(&bytes))
                .await
                .map_err(|_| "worker_failed")?;
        }
        let method = method.to_owned();
        let params = params.clone();
        tokio::task::spawn_blocking(move || dispatch(&method, &params))
            .await
            .map_err(|_| "worker_failed")?
    }
}

pub(crate) fn runtime() -> std::io::Result<tokio::runtime::Runtime> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(8)
        .enable_all()
        .build()
}

use serde_json::{Value, json};

/// Both frontends use this dispatcher. Add domain operations here, never in CLI parsing.
pub fn dispatch(method: &str, params: &Value) -> Result<Value, &'static str> {
    if method == "message.parse" {
        return message::request(params);
    }
    if !params.is_object() || !params.as_object().unwrap().is_empty() {
        return Err("invalid_params");
    }
    match method {
        "system.info" => Ok(json!({
            "name": "omamail", "version": env!("CARGO_PKG_VERSION"),
            "protocol": 1, "apiVersion": 1, "methods": methods::ALL
        })),
        "system.quit" => Ok(json!({"quitReady": true})),
        "accounts.list" => account::list(),
        "providers.list" => Ok(crate::providers::list()),
        _ => Err("unknown_method"),
    }
}

#[cfg(test)]
mod api_contract_tests {
    use super::*;

    #[test]
    fn advertised_api_matches_versioned_contract() {
        let contract: Value = serde_json::from_str(include_str!("../../backend-api.json")).unwrap();
        let info = dispatch("system.info", &json!({})).unwrap();
        assert_eq!(info["apiVersion"], contract["apiVersion"]);
        assert_eq!(info["protocol"], contract["protocolVersion"]);
        assert_eq!(info["methods"], contract["methods"]);
    }
}

#[cfg(test)]
mod cache_lifecycle_tests {
    use super::*;
    #[tokio::test]
    async fn successful_clear_invalidates_only_its_account_and_refused_clear_preserves_cache() {
        let root = std::env::temp_dir().join(format!(
            "omamail-backend-cache-clear-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let session = Session {
            queries: std::sync::Arc::new(crate::cache::query::QueryCache::at(root.clone())),
            ..Default::default()
        };
        for account in ["one@example.org", "two@example.org"] {
            session
                .renders
                .lock()
                .unwrap()
                .put(account, "id", "html", &json!({}), json!({"html":"safe"}))
                .unwrap();
        }
        let restored = session
            .dispatch(
                "cache.queryRestore",
                &json!({"accountId":"one@example.org"}),
            )
            .await
            .unwrap();
        assert!(
            session
                .dispatch(
                    "cache.queryClear",
                    &json!({"accountId":"one@example.org","generation":0})
                )
                .await
                .is_err()
        );
        assert!(
            session
                .renders
                .lock()
                .unwrap()
                .get("one@example.org", "id", "html", &json!({}))
                .is_some()
        );
        session
            .dispatch(
                "cache.queryClear",
                &json!({"accountId":"one@example.org","generation":restored["generation"]}),
            )
            .await
            .unwrap();
        assert!(
            session
                .renders
                .lock()
                .unwrap()
                .get("one@example.org", "id", "html", &json!({}))
                .is_none()
        );
        assert!(
            session
                .renders
                .lock()
                .unwrap()
                .get("two@example.org", "id", "html", &json!({}))
                .is_some()
        );
        session.queries.shutdown().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
