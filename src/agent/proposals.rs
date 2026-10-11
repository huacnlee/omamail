//! A proposal is content, never routing or permission to edit/send mail.
use serde_json::{Value, json};

pub const MAX_PROPOSALS: usize = 16;
pub const MAX_BYTES: usize = 256 * 1024;
const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;

pub fn envelope(value: &Value, account: &Value, draft: &Value) -> Result<(), &'static str> {
    let object = value.as_object().ok_or("agent_invalid_envelope")?;
    if &value["accountId"] != account || (!draft.is_null() && &value["draftKey"] != draft) {
        return Err("agent_context_owner_mismatch");
    }
    for key in [
        "from",
        "to",
        "cc",
        "bcc",
        "subject",
        "body",
        "replyTo",
        "threadId",
        "inReplyTo",
        "draftId",
        "accountId",
    ] {
        super::jobs::text(value.get(key).ok_or("agent_invalid_envelope")?)?;
    }
    for (key, value) in object {
        if key == "attachments" {
            if !value
                .as_array()
                .is_some_and(|a| a.len() <= 100 && a.iter().all(Value::is_object))
            {
                return Err("agent_invalid_envelope");
            }
        } else if [
            "from",
            "to",
            "cc",
            "bcc",
            "subject",
            "body",
            "replyTo",
            "threadId",
            "inReplyTo",
            "draftId",
            "accountId",
            "draftKey",
            "replyMessageId",
            "replyQuote",
        ]
        .contains(&key.as_str())
        {
            super::jobs::text(value)?;
        } else {
            return Err("agent_invalid_envelope");
        }
    }
    if !object.contains_key("attachments") {
        return Err("agent_invalid_envelope");
    }
    Ok(())
}

pub fn history(store: &super::storage::Store, id: &str) -> Result<Value, &'static str> {
    collect(store, id, true)
}

pub fn turn(store: &super::storage::Store, id: &str) -> Result<Value, &'static str> {
    collect(store, id, false)
}

fn collect(store: &super::storage::Store, id: &str, history: bool) -> Result<Value, &'static str> {
    let mut current = id.to_owned();
    let mut visited = Vec::new();
    let mut result = Vec::new();
    let mut budget = 0;
    while store.contains(&current)?
        && !visited.contains(&current)
        && (history || visited.is_empty())
    {
        visited.push(current.clone());
        let job = super::jobs::read_job(store, &current)?;
        let context = store
            .read_json(&current, "context.json", super::jobs::INPUT_LIMIT)?
            .ok_or("agent_context_missing")?;
        let proposals = store
            .read_json(&current, "proposals.json", MAX_BYTES)?
            .unwrap_or_else(|| json!([]));
        let list = proposals
            .as_array()
            .filter(|a| a.len() <= MAX_PROPOSALS)
            .ok_or("agent_invalid_proposal")?;
        // Traverse newest turns first, but reverse proposals within each turn
        // too: the final reversal must preserve tool invocation order.
        for (index, proposal) in list.iter().enumerate().rev() {
            validate(&json!({"subject":proposal["subject"],"body":proposal["body"]}))?;
            if proposal["id"] != format!("{current}-{index}")
                || proposal["jobId"] != current
                || proposal["accountId"] != job["accountId"]
                || proposal["draftKey"] != job["draftKey"]
                || proposal["messageId"] != job["messageId"]
            {
                return Err("agent_invalid_proposal");
            }
            let mut item = proposal.clone();
            item["applicable"] = json!(job["resultReady"] == true);
            if let Some(saved) = context.get("envelope") {
                envelope(saved, &job["accountId"], &context["draftKey"])?;
                item["envelope"] = saved.clone();
            }
            // The projection includes app-owned attachments, so account for the
            // complete item, not just the model's small subject/body record.
            budget += serde_json::to_vec(&item)
                .map_err(|_| "agent_invalid_proposal")?
                .len();
            if budget > MAX_HISTORY_BYTES {
                return Err("agent_proposal_limit");
            }
            result.push(item);
        }
        let Some(parent) = context["parent"].as_str() else {
            break;
        };
        current = parent.to_owned();
    }
    result.reverse();
    Ok(json!(result))
}

pub fn tool() -> Value {
    json!({"name":"propose_draft", "description":"Propose an email subject and the new reply body for the owner to review. This only creates a preview; it never changes the editor or sends mail. Answer questions normally and use this tool only when a draft is useful. Retain the supplied signature and reply subject unless asked otherwise. When replyDefaults.historyIncluded is true, do not reproduce quoted history: Omamail retains it separately and adds it when the owner applies or sends the reply. For existing drafts, preserve the supplied text unless asked otherwise.",
        "inputSchema":{"type":"object", "properties":{
            "subject":{"type":"string","maxLength":4096},
            "body":{"type":"string","maxLength":65536}},
            "required":["subject","body"], "additionalProperties":false},
        "annotations":{"readOnlyHint":false,"destructiveHint":false,"openWorldHint":false}})
}

pub fn validate(arguments: &Value) -> Result<Value, &'static str> {
    let object = arguments.as_object().ok_or("agent_invalid_proposal")?;
    if object.len() != 2 || !object.contains_key("subject") || !object.contains_key("body") {
        return Err("agent_invalid_proposal");
    }
    let subject = super::jobs::text(&arguments["subject"])?;
    let body = super::jobs::text(&arguments["body"])?;
    if subject.len() > 4096
        || subject.chars().any(char::is_control)
        || body.len() > 65536
        || body.trim().is_empty()
    {
        return Err("agent_invalid_proposal");
    }
    Ok(json!({"subject":subject,"body":body}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_cannot_select_recipients_or_forge_headers() {
        for args in [
            json!({"subject":"Hello\r\nBcc: other@example.org","body":"text"}),
            json!({"subject":"Hello", "body":"text", "to":"other@example.org"}),
            json!({"subject":"Hello", "body":"text", "jobId":"other-job"}),
            json!({"subject":"Hello", "body":"bad\u{0}"}),
            json!({"subject":"Hello", "body":" "}),
        ] {
            assert!(validate(&args).is_err());
        }
        let valid =
            json!({"subject":"Re: مرحبا \\\"", "body":"Hello\r\n\r\nA quoted \\\"value\\\"."});
        assert_eq!(validate(&valid).unwrap(), valid);
    }
}
