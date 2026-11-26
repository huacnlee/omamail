use serde_json::{Map, Value, json};
pub(super) const ROLES: &[&str] = &["inbox", "archive", "sent", "drafts", "junk", "trash"];
pub(super) fn string(v: &Value) -> &str {
    v.as_str().unwrap_or("").trim()
}
pub(super) fn roles(boxes: &[Value]) -> Value {
    let mut map = Map::new();
    for role in ROLES {
        let exact = boxes
            .iter()
            .find(|b| string(&b["role"]).eq_ignore_ascii_case(role));
        let found = exact.or_else(|| {
            boxes.iter().find(|b| {
                if !string(&b["parentId"]).is_empty() {
                    return false;
                }
                let name = string(&b["name"]).to_lowercase();
                match *role {
                    "sent" => ["sent", "sent mail", "sent items", "sent messages"]
                        .contains(&name.as_str()),
                    "trash" => ["trash", "deleted", "deleted items", "deleted messages"]
                        .contains(&name.as_str()),
                    "drafts" => ["draft", "drafts"].contains(&name.as_str()),
                    "archive" => ["archive", "all mail"].contains(&name.as_str()),
                    "junk" => [
                        "junk",
                        "junkemail",
                        "junk email",
                        "junk-email",
                        "junke-mail",
                        "junk e-mail",
                        "junk-e-mail",
                        "spam",
                        "bulk mail",
                    ]
                    .contains(&name.as_str()),
                    _ => false,
                }
            })
        });
        map.insert(
            (*role).into(),
            json!(found.map(|b| string(&b["id"])).unwrap_or("")),
        );
    }
    Value::Object(map)
}
pub(super) fn filter(query: &str, roles: &Value) -> Result<Value, &'static str> {
    let query = query.trim();
    let (kind, value) = query
        .split_once(':')
        .filter(|(kind, _)| ["role", "mailbox", "text"].contains(kind))
        .unwrap_or(("text", query));
    let value = value.trim();
    let (kind, value) = if value.is_empty() {
        ("role", "inbox")
    } else {
        (kind, value)
    };
    if kind == "text" {
        let exclude: Vec<_> = ["junk", "trash"]
            .iter()
            .map(|k| string(&roles[k]))
            .filter(|s| !s.is_empty())
            .collect();
        return Ok(if exclude.is_empty() {
            json!({"text":value})
        } else {
            json!({"operator":"AND","conditions":[{"text":value},{"inMailboxOtherThan":exclude}]})
        });
    }
    if kind == "mailbox" {
        return Ok(json!({"inMailbox":value.split_whitespace().next().unwrap_or("")}));
    }
    let mut words = value.split_whitespace();
    let role = words.next().unwrap_or("inbox").to_lowercase();
    let id = string(&roles[&role]);
    if id.is_empty() {
        return Err("jmap_missing_mailbox");
    }
    let mut filter = json!({"inMailbox":id});
    match words.next().unwrap_or("").to_lowercase().as_str() {
        "unseen" => filter["notKeyword"] = json!("$seen"),
        "flagged" => filter["hasKeyword"] = json!("$flagged"),
        _ => {}
    }
    Ok(filter)
}
pub(super) fn query(
    account: &str,
    filter: Value,
    limit: usize,
    token: &str,
    by_position: bool,
) -> Value {
    let page = token
        .split_once('|')
        .and_then(|(n, id)| n.parse::<u64>().ok().map(|n| (n, id)))
        .unwrap_or((0, ""));
    let mut args = json!({"accountId":account,"filter":filter,"sort":[{"property":"receivedAt","isAscending":false}],"collapseThreads":true,"limit":limit,"calculateTotal":true});
    if !page.1.is_empty() && !by_position {
        args["anchor"] = json!(page.1);
        args["anchorOffset"] = json!(1);
    } else {
        args["position"] = json!(page.0);
    }
    args
}
pub(super) fn page(args: &Value, limit: usize) -> Value {
    let ids: Vec<_> = args["ids"]
        .as_array()
        .into_iter()
        .flatten()
        .map(string)
        .filter(|s| !s.is_empty())
        .collect();
    let position = args["position"].as_u64().unwrap_or(0);
    let end = position.saturating_add(ids.len() as u64);
    let total = args["total"].as_u64();
    let more = total.map(|total| end < total).unwrap_or(ids.len() >= limit);
    let token = if more {
        ids.last()
            .map(|id| format!("{end}|{id}"))
            .unwrap_or_default()
    } else {
        String::new()
    };
    json!({"ids":ids,"threadIds":[],"nextPageToken":token,"estimate":total.unwrap_or(end.saturating_add(u64::from(ids.len()>=limit)))})
}
pub(super) fn labels(boxes: &[Value]) -> Value {
    let roles = roles(boxes);
    let mut result = Vec::new();
    for b in boxes {
        let id = string(&b["id"]);
        if id.is_empty() {
            continue;
        }
        let mut parts = vec![string(&b["name"])];
        let mut seen = vec![id];
        let mut current = b;
        for _ in 0..32 {
            let parent = string(&current["parentId"]);
            if parent.is_empty() || seen.contains(&parent) {
                break;
            }
            seen.push(parent);
            let Some(found) = boxes.iter().find(|b| string(&b["id"]) == parent) else {
                break;
            };
            parts.insert(0, string(&found["name"]));
            current = found;
        }
        let mut label = counts(b);
        label["name"] = json!(parts.join(" / "));
        label["rawName"] = json!(id);
        label["system"] = json!(ROLES.iter().any(|role| string(&roles[role]) == id));
        result.push((b["sortOrder"].as_u64().unwrap_or(0), label));
    }
    result.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| string(&a.1["name"]).cmp(string(&b.1["name"])))
    });
    json!(result.into_iter().map(|(_, v)| v).collect::<Vec<_>>())
}
pub(super) fn counts(b: &Value) -> Value {
    json!({"id":string(&b["id"]),"unread":b["unreadEmails"].as_u64().unwrap_or(0),"total":b["totalEmails"].as_u64().unwrap_or(0),"threadsUnread":b["unreadThreads"].as_u64().unwrap_or(0)})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hostile_page_position_never_overflows() {
        let result = page(&json!({"position":u64::MAX,"ids":["a"]}), 1);
        assert_eq!(result["estimate"], u64::MAX);
    }
    #[test]
    fn filters_and_anchor_recovery_keep_mailbox_semantics() {
        let roles = json!({"inbox":"I","junk":"J","trash":"T"});
        assert_eq!(
            filter("role:inbox unseen", &roles).unwrap(),
            json!({"inMailbox":"I","notKeyword":"$seen"})
        );
        assert!(filter("role:archive", &roles).is_err());
        assert_eq!(
            filter("text:hello", &roles).unwrap(),
            json!({"operator":"AND","conditions":[{"text":"hello"},{"inMailboxOtherThan":["J","T"]}]})
        );
        assert_eq!(
            query("a", json!({}), 25, "25|anchor", false)["anchor"],
            "anchor"
        );
        assert_eq!(query("a", json!({}), 25, "25|anchor", true)["position"], 25);
        assert_eq!(
            page(&json!({"ids":["a","b"],"position":2,"total":6}), 2)["nextPageToken"],
            "4|b"
        );
    }
}
