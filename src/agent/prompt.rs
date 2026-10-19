//! Native sessions retain their prefix. Append only changed context and the ask.
use serde_json::{Value, json};

fn attachment_metadata(context: &Value) -> Value {
    json!(context["envelope"]["attachments"].as_array().map(|items|items.iter().map(|item|
        json!({"filename":item["filename"],"mimeType":item["mimeType"],"size":item["size"]})).collect::<Vec<_>>()).unwrap_or_default())
}

pub(super) fn turn(
    context: &Value,
    previous: Option<&Value>,
    history: &[Value],
    resumed: bool,
) -> Value {
    if resumed {
        let mut turn = json!({"prompt":context["prompt"]});
        if let Some(previous) = previous {
            if attachment_metadata(context) != attachment_metadata(previous) {
                turn["attachmentMetadata"] = attachment_metadata(context);
            }
            for key in ["draft", "message", "messages", "threadContext"] {
                if context.get(key) != previous.get(key) {
                    if let Some(value) = context.get(key) {
                        turn[key] = value.clone();
                    }
                }
            }
            if let Some(messages) = context["threadMessages"].as_array() {
                let known = previous["threadMessages"].as_array();
                let added: Vec<_> = messages
                    .iter()
                    .filter(|message| !known.is_some_and(|known| known.contains(message)))
                    .cloned()
                    .collect();
                if !added.is_empty() {
                    turn["threadMessages"] = json!(added);
                }
            }
        } else {
            // An explicitly removed comparison record must not erase refreshed
            // context. This is a context update, never a replay of chat history.
            for key in [
                "draft",
                "message",
                "messages",
                "threadMessages",
                "threadContext",
            ] {
                if let Some(value) = context.get(key) {
                    turn[key] = value.clone();
                }
            }
            turn["attachmentMetadata"] = attachment_metadata(context);
        }
        return turn;
    }
    let mut supplied = context.clone();
    if let Some(object) = supplied.as_object_mut() {
        for key in ["parent", "draftFingerprint", "draftKey", "envelope"] {
            object.remove(key);
        }
    }
    if context.get("parent").is_some() {
        supplied["conversation"] = json!(history);
    }
    if context["envelope"].is_object() {
        supplied["attachmentMetadata"] = attachment_metadata(context);
        if !context["draft"].is_object() {
            let envelope = &context["envelope"];
            supplied["replyDefaults"] = json!({"from":envelope["from"],"to":envelope["to"],"cc":envelope["cc"],"bcc":envelope["bcc"],"subject":envelope["subject"],"body":envelope["body"]});
        }
        supplied["replyDefaults"]["historyIncluded"] = json!(
            context["envelope"]["replyQuote"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        );
    }
    supplied
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_followup_omits_unchanged_mail_and_draft() {
        let before =
            json!({"prompt":"Draft a reply", "message":"original mail", "draft":{"body":"Hello"}});
        let mut after = before.clone();
        after["prompt"] = json!("Why that wording?");
        assert_eq!(
            turn(&after, Some(&before), &[], true),
            json!({"prompt":"Why that wording?"})
        );
        after["draft"]["body"] = json!("Manually edited");
        assert_eq!(
            turn(&after, Some(&before), &[], true),
            json!({"prompt":"Why that wording?", "draft":{"body":"Manually edited"}})
        );
        after["draft"]["body"] = json!("");
        assert_eq!(turn(&after, Some(&before), &[], true)["draft"]["body"], "");
    }

    #[test]
    fn unconfirmed_previous_turn_resupplies_context_without_chat_replay() {
        let context = json!({"prompt":"Continue", "message":"Updated mail", "threadMessages":[{"id":"new","body":"New reply"}], "draft":{"body":"Current draft"}});
        let supplied = turn(
            &context,
            None,
            &[json!({"role":"user","text":"Old question"})],
            true,
        );
        assert_eq!(supplied["message"], context["message"]);
        assert_eq!(supplied["threadMessages"], context["threadMessages"]);
        assert_eq!(supplied["draft"], context["draft"]);
        assert!(supplied.get("conversation").is_none());
    }

    #[test]
    fn restart_restores_latest_context_and_transcript_without_compacting() {
        let context = json!({"parent":"previous", "draftKey":"private-owner", "draftFingerprint":"42", "prompt":"Continue", "message":"mail", "draft":{"body":"latest"}});
        let history = vec![json!({"role":"user","text":"Earlier question"})];
        let supplied = turn(&context, None, &history, false);
        assert_eq!(supplied["conversation"], json!(history));
        assert_eq!(supplied["draft"]["body"], "latest");
        assert_eq!(supplied["message"], "mail");
        assert!(supplied.get("parent").is_none());
        assert!(supplied.get("draftKey").is_none());
    }
}
