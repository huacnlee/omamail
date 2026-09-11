pub mod protocol;
mod rpc;
pub mod stdio;
pub mod upload;
use crate::{account, message};

#[derive(Default)]
pub struct Session {
    uploads: std::sync::Mutex<upload::Uploads>,
    gmail: crate::providers::gmail::Session,
}

impl Session {
    pub fn dispatch(&self, method: &str, params: &Value) -> Result<Value, &'static str> {
        if method.starts_with("gmail.") {
            return self.gmail.call(method, params);
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
            return message::parse(&bytes);
        }
        dispatch(method, params)
    }
}

use serde_json::{Value, json};

/// Both frontends use this dispatcher. Add domain operations here, never in CLI parsing.
pub fn dispatch(method: &str, params: &Value) -> Result<Value, &'static str> {
    if matches!(method, "hey.act" | "hey.send") {
        let checked = crate::providers::hey_access::checked_params(params)?;
        return crate::providers::hey_actions::call(method, &checked);
    }
    if matches!(method, "hey.status" | "hey.list" | "hey.read") {
        let checked = crate::providers::hey_access::checked_params(params)?;
        return crate::providers::hey::call(method, &checked);
    }
    if method == "message.parse" {
        return message::request(params);
    }
    if !params.is_object() || !params.as_object().unwrap().is_empty() {
        return Err("invalid_params");
    }
    match method {
        "system.info" => Ok(json!({
            "name": "omamail", "version": env!("CARGO_PKG_VERSION"),
            "protocol": 1, "methods": ["system.info", "system.quit", "accounts.list", "providers.list", "message.parse", "upload.begin", "upload.append", "upload.discard", "message.parseUpload", "hey.status", "hey.list", "hey.read", "hey.act", "hey.send", "gmail.list", "gmail.read", "gmail.attachment", "gmail.invalidate", "gmail.labels", "gmail.labelCounts", "gmail.profile", "gmail.sendAs"]
        })),
        "system.quit" => Ok(json!({"quitReady": true})),
        "accounts.list" => account::list(),
        "providers.list" => Ok(crate::providers::list()),
        _ => Err("unknown_method"),
    }
}
