use serde_json::{Value, json};

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

fn count(value: &Value) -> u64 {
    value.as_u64().unwrap_or_else(|| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
            .filter(|n| n.is_finite())
            .unwrap_or(0.0)
            .floor()
            .max(0.0) as u64
    })
}

fn display<'a>(id: &'a str, raw: &'a str) -> &'a str {
    match id {
        "INBOX" => "Inbox",
        "STARRED" => "Starred",
        "IMPORTANT" => "Important",
        "SENT" => "Sent",
        "DRAFT" => "Drafts",
        "SPAM" => "Spam",
        "TRASH" => "Trash",
        "UNREAD" => "Unread",
        "CATEGORY_PERSONAL" => "Personal",
        "CATEGORY_SOCIAL" => "Social",
        "CATEGORY_PROMOTIONS" => "Promotions",
        "CATEGORY_UPDATES" => "Updates",
        "CATEGORY_FORUMS" => "Forums",
        _ => raw,
    }
}

pub(super) fn normalize(method: &str, answer: Value) -> Value {
    match method {
        "gmail.labels" => Value::Array(answer["labels"].as_array().into_iter().flatten().filter_map(|label| {
            let id = text(&label["id"]);
            if id.is_empty() { return None; }
            let name = text(&label["name"]);
            let raw = if name.is_empty() {id} else {name};
            Some(json!({"id":id,"name":display(id,raw),"rawName":raw,"system":text(&label["type"])=="system",
                "unread":count(&label["messagesUnread"]),"total":count(&label["messagesTotal"]),"threadsUnread":count(&label["threadsUnread"])}))
        }).collect()),
        "gmail.labelCounts" => json!({"id":text(&answer["id"]),"unread":count(&answer["messagesUnread"]),"total":count(&answer["messagesTotal"]),"threadsUnread":count(&answer["threadsUnread"])}),
        "gmail.profile" => json!({"email":text(&answer["emailAddress"]),"messagesTotal":count(&answer["messagesTotal"]),"threadsTotal":count(&answer["threadsTotal"]),"historyId":text(&answer["historyId"])}),
        "gmail.sendAs" => Value::Array(answer["sendAs"].as_array().into_iter().flatten().filter_map(|entry| {
            let email = text(&entry["sendAsEmail"]).trim();
            let primary = entry["isPrimary"]==true;
            if email.is_empty() || (!primary && text(&entry["verificationStatus"]).eq_ignore_ascii_case("pending")) {return None;}
            Some(json!({"email":email,"displayName":text(&entry["displayName"]).trim(),"isPrimary":primary,"isDefault":entry["isDefault"]==true}))
        }).collect()),
        _ => answer,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn labels_keep_display_names_raw_names_and_nonnegative_counts() {
        assert_eq!(
            normalize(
                "gmail.labels",
                json!({"labels":[
                    {"id":"INBOX","name":"INBOX","type":"system","messagesUnread":7,"messagesTotal":120,"threadsUnread":5},
                    {"id":"Label_12","name":"Receipts","messagesUnread":-3,"messagesTotal":"9.8"},
                    {"name":"missing id"}
                ]})
            ),
            json!([
                {"id":"INBOX","name":"Inbox","rawName":"INBOX","system":true,"unread":7,"total":120,"threadsUnread":5},
                {"id":"Label_12","name":"Receipts","rawName":"Receipts","system":false,"unread":0,"total":9,"threadsUnread":0}
            ])
        );
    }

    #[test]
    fn counts_and_profile_match_frontend_field_names() {
        assert_eq!(
            normalize(
                "gmail.labelCounts",
                json!({"id":"INBOX","messagesUnread":3,"messagesTotal":40,"threadsUnread":2})
            ),
            json!({"id":"INBOX","unread":3,"total":40,"threadsUnread":2})
        );
        assert_eq!(
            normalize(
                "gmail.profile",
                json!({"emailAddress":"me@example.org","messagesTotal":5,"threadsTotal":2,"historyId":"9912"})
            ),
            json!({"email":"me@example.org","messagesTotal":5,"threadsTotal":2,"historyId":"9912"})
        );
    }

    #[test]
    fn send_as_excludes_pending_custom_aliases_not_primary_or_workspace() {
        assert_eq!(
            normalize(
                "gmail.sendAs",
                json!({"sendAs":[
                    {"sendAsEmail":" me@example.org ","displayName":" Me ","isPrimary":true,"verificationStatus":"pending"},
                    {"sendAsEmail":"waiting@example.org","verificationStatus":"PENDING"},
                    {"sendAsEmail":"work@example.org","isDefault":true},
                    {"displayName":"missing"}
                ]})
            ),
            json!([
                {"email":"me@example.org","displayName":"Me","isPrimary":true,"isDefault":false},
                {"email":"work@example.org","displayName":"","isPrimary":false,"isDefault":true}
            ])
        );
    }
}
