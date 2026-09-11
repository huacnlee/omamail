//! Execute only the registered account's native provider send, exactly once.
use serde_json::{Value, json};
use std::time::Duration;
pub async fn send(
    job: &Value,
    gmail: &crate::providers::gmail::Session,
    jmap: &crate::providers::jmap::Session,
) -> Result<Value, &'static str> {
    let account = super::text(job, "accountId")?.to_owned();
    let provider = super::text(job, "provider")?.to_owned();
    let registry = tokio::task::spawn_blocking(crate::account::list)
        .await
        .map_err(|_| "outbox_account_unavailable")?
        .map_err(|_| "outbox_account_unavailable")?;
    if !registry["accounts"].as_array().is_some_and(|accounts| {
        accounts.iter().any(|entry| {
            entry["id"] == account && entry["provider"] == provider && entry["pending"] != true
        })
    }) {
        return Err("outbox_account_unavailable");
    }
    let payload = job["payload"].as_object().ok_or("outbox_invalid_payload")?;
    if payload
        .keys()
        .any(|key| !["raw", "threadId", "draftId", "attachments", "sendId"].contains(&key.as_str()))
    {
        return Err("outbox_invalid_payload");
    }
    let raw = payload
        .get("raw")
        .and_then(Value::as_str)
        .filter(|raw| !raw.is_empty())
        .ok_or("outbox_invalid_payload")?;
    let mut params = json!({"accountId":account,"raw":raw});
    if matches!(provider.as_str(), "gmail" | "jmap" | "hey")
        && let Some(thread) = payload.get("threadId")
    {
        params["threadId"] = thread.clone();
    }
    let draft = payload.get("draftId").and_then(Value::as_str).unwrap_or("");
    if draft.len() > 1024 || draft.chars().any(char::is_control) {
        return Err("outbox_invalid_payload");
    }
    if provider == "jmap" && !draft.is_empty() {
        params["draftId"] = json!(draft);
    }
    let mut answer = match provider.as_str() {
        "gmail" => gmail.call("gmail.send", &params).await?,
        "imap" | "outlook" => crate::providers::imap::call("imap.send", &params).await?,
        "jmap" => jmap.call("jmap.send", &params).await?,
        "hey" => {
            params["program"] = json!(crate::providers::hey_access::program()?);
            if let Some(attachments) = payload.get("attachments") {
                params["attachments"] = attachments.clone();
            }
            let checked = crate::providers::hey_access::checked_params(&params).await?;
            crate::providers::hey_actions::call("hey.send", &checked).await?
        }
        _ => return Err("outbox_invalid_provider"),
    };
    if !answer.is_object() {
        answer = json!({});
    }
    if !draft.is_empty() {
        // JMAP destroys the source draft in its successful submission flow.
        // A failed cleanup cannot turn confirmed delivery into a retryable send.
        let cleanup = async {
            let params = json!({"accountId":account,"id":draft});
            match provider.as_str() {
                "gmail" => gmail.call("gmail.deleteDraft", &params).await.map(|_| ()),
                "imap" | "outlook" => crate::providers::imap::call("imap.deleteDraft", &params)
                    .await
                    .map(|_| ()),
                "jmap" if answer["draftRemoved"] == true => Ok(()),
                _ => Err("outbox_draft_cleanup_unavailable"),
            }
        };
        if tokio::time::timeout(Duration::from_secs(5), cleanup).await == Ok(Ok(())) {
            answer["draftRemoved"] = json!(true);
        } else {
            answer["warning"] = json!("Sent, but the original draft could not be removed");
        }
    }
    Ok(answer)
}
