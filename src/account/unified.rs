//! Merge account snapshots once per update, with an account-qualified stable order.
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub(super) fn rows(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub(super) fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}
pub(super) fn time(v: &Value) -> i64 {
    let date = v
        .get("date")
        .filter(|d| !d.is_null())
        .unwrap_or(&v["dateMs"]);
    let parsed = date.as_i64().or_else(|| {
        date.as_str().and_then(|s| {
            s.parse::<i64>()
                .ok()
                .or_else(|| {
                    chrono::DateTime::parse_from_rfc3339(s)
                        .ok()
                        .map(|d| d.timestamp_millis())
                })
                .or_else(|| {
                    chrono::DateTime::parse_from_rfc2822(s)
                        .ok()
                        .map(|d| d.timestamp_millis())
                })
        })
    });
    parsed.filter(|n| *n > 0).unwrap_or_else(|| {
        v["internalDate"]
            .as_i64()
            .or_else(|| v["internalDate"].as_str().and_then(|s| s.parse().ok()))
            .unwrap_or(0)
    })
}
pub fn id(account: &str, message: &str) -> String {
    if account.is_empty() || message.is_empty() {
        String::new()
    } else {
        format!("{account}\u{1f}{message}")
    }
}
pub fn compose_thread(account: &str, value: &Value) -> Value {
    let mut out = value.clone();
    if value["memberIds"].is_array() {
        out["memberIds"] = json!(
            rows(&value["memberIds"])
                .iter()
                .map(|v| id(account, &text(v)))
                .collect::<Vec<_>>()
        );
    }
    out
}
pub fn compose_members(account: &str, value: &Value) -> Value {
    let mut out = json!({});
    if let Some(values) = value.as_object() {
        for (key, row) in values {
            let mut copy = row.clone();
            if row.is_object() {
                copy["sourceId"] = json!(text(&row["id"]));
                copy["id"] = json!(id(account, &text(&row["id"])));
                if row["thread"].is_object() {
                    copy["thread"] = compose_thread(account, &row["thread"]);
                }
            }
            out[id(account, key)] = copy;
        }
    }
    out
}
pub fn merge(sources: &Value) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut merged = Vec::new();
    let mut floor = 0;
    for source in rows(sources) {
        let account = text(&source["id"]);
        if account.is_empty() {
            continue;
        }
        let messages = rows(&source["messages"]);
        if source["hasMore"] == true
            && let Some(last) = messages.last()
        {
            floor = floor.max(time(last));
        }
        for row in messages {
            let own = text(&row["id"]);
            if own.is_empty() || !row.is_object() {
                continue;
            }
            let key = id(&account, &own);
            if !seen.insert(key.clone()) {
                continue;
            }
            let mut copy = row.clone();
            copy["sourceId"] = json!(own);
            copy["id"] = json!(key);
            copy["accountId"] = json!(account);
            copy["sourceLabel"] = json!(
                source["label"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Mailbox")
            );
            if row["thread"].is_object() {
                copy["thread"] = compose_thread(&account, &row["thread"]);
            }
            merged.push((time(&copy), format!("{} {}", account, key), copy));
        }
    }
    merged.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    merged
        .into_iter()
        .take_while(|r| floor <= 0 || r.0 >= floor)
        .map(|r| r.2)
        .collect()
}
pub fn apply(p: &Value) -> Result<Value, &'static str> {
    // Prefixes are repeated in every composed row and thread member. Count the
    // projected representation before allocating any expanded identifiers.
    let mut budget = 16usize * 1024 * 1024;
    for source in rows(&p["sources"]) {
        if !source["id"].is_null() {
            let account = source["id"].as_str().ok_or("model_account_invalid")?;
            if account.len() > 8192 || account.chars().any(char::is_control) {
                return Err("model_account_invalid");
            }
        }
        let account_bytes = serde_json::to_vec(&source["id"])
            .map_err(|_| "model_invalid")?
            .len();
        let label_bytes = serde_json::to_vec(&source["label"])
            .map_err(|_| "model_invalid")?
            .len();
        for row in rows(&source["messages"]) {
            let own_bytes = serde_json::to_vec(&row["id"])
                .map_err(|_| "model_invalid")?
                .len();
            let bytes = serde_json::to_vec(row)
                .map_err(|_| "model_invalid")?
                .len()
                .saturating_add(
                    account_bytes
                        .saturating_mul(rows(&row["thread"]["memberIds"]).len().saturating_add(3)),
                )
                .saturating_add(label_bytes)
                .saturating_add(own_bytes)
                .saturating_add(256);
            budget = budget.checked_sub(bytes).ok_or("model_output_too_large")?;
        }
    }
    let abilities = rows(&p["abilities"]);
    let states = rows(&p["states"]);
    if rows(&p["sources"])
        .iter()
        .map(|s| rows(&s["messages"]).len())
        .sum::<usize>()
        > 100_000
    {
        return Err("model_too_many_rows");
    }
    let mut capabilities = HashMap::new();
    for row in abilities {
        if let Some(fields) = row.as_object() {
            for (key, value) in fields {
                if value.is_boolean() {
                    capabilities.insert(key.clone(), abilities.iter().all(|a| a[key] == true));
                }
            }
        }
    }
    let mailboxes: Vec<_> = abilities
        .first()
        .map(|first| {
            rows(&first["mailboxes"])
                .iter()
                .filter(|m| {
                    !text(&m["key"]).is_empty()
                        && abilities.iter().all(|a| {
                            rows(&a["mailboxes"])
                                .iter()
                                .any(|other| other["key"] == m["key"])
                        })
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let total: u64 = rows(&p["summaries"])
        .iter()
        .map(|s| {
            s["unread"]
                .as_f64()
                .or_else(|| s["unread"].as_str().and_then(|v| v.parse().ok()))
                .unwrap_or(0.0)
                .max(0.0)
                .floor() as u64
        })
        .fold(0, u64::saturating_add);
    let error = states
        .iter()
        .find_map(|s| {
            let e = s["error"].as_str().unwrap_or("").trim();
            if e.is_empty() {
                None
            } else {
                let label = s["label"].as_str().unwrap_or("").trim();
                Some(if label.is_empty() {
                    e.into()
                } else {
                    format!("{label}: {e}")
                })
            }
        })
        .unwrap_or_default();
    Ok(
        json!({"messages":merge(&p["sources"]),"totalUnread":total,"mailboxes":mailboxes,"capabilities":capabilities,"loading":states.iter().any(|s| s["loading"] == true),"serverSearchLoading":states.iter().any(|s| s["serverSearchLoading"] == true),"hasMore":states.iter().any(|s| s["hasMore"] == true),"loaded":!states.is_empty() && states.iter().all(|s| s["loaded"] == true || (s["loading"] != true && !s["error"].as_str().unwrap_or("").trim().is_empty())),"error":error}),
    )
}
