//! Shared mailbox list rules. JSON calls are batched to avoid per-row IPC.
use super::unified::{rows, text, time};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

fn block(row: &Value) -> Value {
    let b = &row["thread"];
    if !b.is_object() {
        return Value::Null;
    }
    let ids: Vec<_> = rows(&b["memberIds"])
        .iter()
        .map(|v| text(v).trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    json!({"id":text(&b["id"]).trim(),"count":ids.len(),"memberIds":ids,"unread":b["unread"] == true,"flagged":b["flagged"] == true})
}
pub fn action_scope(action: &str) -> &'static str {
    if [
        "archive",
        "unarchive",
        "trash",
        "untrash",
        "spam",
        "markRead",
        "markUnread",
        "unstar",
    ]
    .contains(&action)
    {
        "conversation"
    } else {
        "message"
    }
}
pub fn action_targets(row: &Value, action: &str) -> Value {
    let b = block(row);
    if action_scope(action) == "conversation" && !rows(&b["memberIds"]).is_empty() {
        return b["memberIds"].clone();
    }
    let own = text(&row["id"]);
    if own.is_empty() {
        json!([])
    } else {
        json!([own])
    }
}
fn target(action: &str) -> &str {
    action.strip_prefix("label:").unwrap_or("")
}
pub fn capability(action: &str) -> &'static str {
    match action {
        "archive" | "unarchive" => "archive",
        "star" | "unstar" => "star",
        "spam" => "spam",
        a if !target(a).is_empty() => "move",
        _ => "",
    }
}
fn system(label: &str) -> bool {
    [
        "INBOX",
        "UNREAD",
        "STARRED",
        "IMPORTANT",
        "SENT",
        "DRAFT",
        "TRASH",
        "SPAM",
        "CHAT",
    ]
    .contains(&label)
        || label.starts_with("CATEGORY_")
}
pub fn changes(action: &str, source: &str) -> Value {
    let (add, remove): (Vec<&str>, Vec<&str>) = match action {
        "markRead" => (vec![], vec!["UNREAD"]),
        "markUnread" => (vec!["UNREAD"], vec![]),
        "star" => (vec!["STARRED"], vec![]),
        "unstar" => (vec![], vec!["STARRED"]),
        "archive" => (vec![], vec!["INBOX"]),
        "unarchive" => (
            vec!["INBOX"],
            if source.is_empty() || system(source) {
                vec![]
            } else {
                vec![source]
            },
        ),
        "spam" => (vec!["SPAM"], vec!["INBOX"]),
        a if !target(a).is_empty() => {
            let mut remove = vec!["INBOX"];
            if !source.is_empty() && source != target(a) && source != "INBOX" {
                remove.push(source);
            }
            (vec![target(a)], remove)
        }
        _ => return Value::Null,
    };
    json!({"add":add,"remove":remove})
}
fn with_thread(summary: &Value, thread: &Value) -> Value {
    if !summary.is_object() {
        return summary.clone();
    }
    let mut out = summary.clone();
    if thread.is_object() {
        out["thread"] = thread.clone();
    }
    let b = block(&out);
    out["unread"] = json!(rows(&out["labelIds"]).contains(&json!("UNREAD")) || b["unread"] == true);
    out["starred"] =
        json!(rows(&out["labelIds"]).contains(&json!("STARRED")) || b["flagged"] == true);
    out
}
fn thread_action(row: &Value, action: &str) -> Value {
    let mut b = block(row);
    if b.is_null() {
        return b;
    }
    match action {
        "markRead" => b["unread"] = json!(false),
        "markUnread" => b["unread"] = json!(true),
        "unstar" => b["flagged"] = json!(false),
        _ => {}
    }
    b
}
fn member_label(row: &Value, label: &str) -> bool {
    if row["labelIds"].is_array() {
        rows(&row["labelIds"]).contains(&json!(label))
    } else {
        row[if label == "UNREAD" {
            "unread"
        } else {
            "starred"
        }] == true
    }
}
fn thread_members(row: &Value, members: &Value) -> Value {
    let mut b = block(row);
    if b.is_null() {
        return b;
    }
    let mut unknown = false;
    let mut unread = false;
    let mut flagged = false;
    for id in rows(&b["memberIds"]) {
        let m = &members[text(id)];
        if !m.is_object() {
            unknown = true;
        } else {
            unread |= member_label(m, "UNREAD");
            flagged |= member_label(m, "STARRED");
        }
    }
    b["unread"] = json!(unread || (unknown && b["unread"] == true));
    b["flagged"] = json!(flagged || (unknown && b["flagged"] == true));
    b
}
pub fn label_change(summary: &Value, action: &str, source: &str, thread: &Value) -> Value {
    let change = changes(action, source);
    if !summary.is_object() || change.is_null() {
        return summary.clone();
    }
    let mut labels = rows(&summary["labelIds"]).to_vec();
    for removed in rows(&change["remove"]) {
        if let Some(at) = labels.iter().position(|l| l == removed) {
            labels.remove(at);
        }
    }
    for added in rows(&change["add"]) {
        if !labels.contains(added) {
            labels.push(added.clone());
        }
    }
    let mut out = summary.clone();
    for (flag, label) in [
        ("inInbox", "INBOX"),
        ("inTrash", "TRASH"),
        ("inSpam", "SPAM"),
        ("isSent", "SENT"),
        ("isDraft", "DRAFT"),
    ] {
        out[flag] = json!(labels.contains(&json!(label)));
    }
    out["labelIds"] = json!(labels);
    with_thread(&out, thread)
}
pub fn survives(
    key: &str,
    action: &str,
    query: &str,
    labels: bool,
    source: &str,
    row: &Value,
) -> bool {
    let key = if key.is_empty() { "inbox" } else { key };
    let b = block(row);
    if !rows(&b["memberIds"]).is_empty() {
        if action == "markRead" && key == "unread" {
            return b["unread"] == true;
        }
        if action == "unstar" && key == "starred" {
            return b["flagged"] == true;
        }
    }
    match action {
        "trash" => key == "trash",
        "untrash" => key != "trash",
        "unarchive" => {
            labels
                && (query.is_empty()
                    || (!source.is_empty() && rows(&changes(action, source)["remove"]).is_empty()))
        }
        a if !target(a).is_empty() && !query.is_empty() => false,
        "archive" => key != "inbox" && key != "unread",
        a if !target(a).is_empty() => key != "inbox" && key != "unread",
        "markRead" => key != "unread",
        "unstar" => key != "starred",
        _ => true,
    }
}
fn index(list: &Value, id: &Value) -> Option<usize> {
    rows(list)
        .iter()
        .position(|r| r.is_object() && r["id"] == *id)
}
fn holds(row: &Value, id: &str) -> bool {
    !id.is_empty()
        && (text(&row["id"]) == id
            || rows(&block(row)["memberIds"])
                .iter()
                .any(|v| text(v) == id.trim()))
}
fn row_index(list: &Value, id: &Value) -> Option<usize> {
    index(list, id).or_else(|| rows(list).iter().position(|r| holds(r, &text(id))))
}
fn replace(list: &Value, row: &Value) -> Value {
    json!(
        rows(list)
            .iter()
            .map(
                |r| if r.is_object() && row.is_object() && r["id"] == row["id"] {
                    row
                } else {
                    r
                }
            )
            .collect::<Vec<_>>()
    )
}
fn remove(list: &Value, id: &Value) -> Value {
    json!(
        rows(list)
            .iter()
            .filter(|r| !r.is_object() || r["id"] != *id)
            .collect::<Vec<_>>()
    )
}
fn restore(list: &Value, row: &Value, order: &Value, fallback: &Value) -> Value {
    let mut out = rows(list).to_vec();
    let pos = index(order, &row["id"]);
    let mut at = None;
    if let Some(pos) = pos {
        for follower in &rows(order)[pos + 1..] {
            if let Some(found) = index(list, &follower["id"]) {
                at = Some(found);
                break;
            }
        }
        if at.is_none() {
            for previous in rows(order)[..pos].iter().rev() {
                if let Some(found) = index(list, &previous["id"]) {
                    at = Some(found + 1);
                    break;
                }
            }
        }
    }
    let at = at.unwrap_or_else(|| {
        pos.unwrap_or(fallback.as_u64().unwrap_or(0) as usize)
            .min(out.len())
    });
    out.insert(at, row.clone());
    json!(out)
}
fn detail(previous: &Value, summary: &Value) -> Value {
    if summary.is_null() {
        return previous.clone();
    }
    if !previous.is_object() {
        return summary.clone();
    }
    let mut out = summary.clone();
    if !out.is_object() {
        return out;
    }
    if out["subject"] == "(no subject)" && !text(&previous["subject"]).is_empty() {
        out["subject"] = previous["subject"].clone();
        if out.get("subjectDirection").is_some() || previous.get("subjectDirection").is_some() {
            out["subjectDirection"] = json!(crate::message::direction::resolve_subject(
                &text(&out["subject"]),
                crate::message::direction::AUTO
            ));
        }
    }
    if text(&out["from"]["name"]).is_empty() && text(&out["from"]["email"]).is_empty() {
        copy_field(&mut out, previous, "from");
    }
    if text(&out["snippet"]).is_empty() {
        copy_field(&mut out, previous, "snippet");
    }
    if out["date"].is_null() && !previous["date"].is_null() {
        for k in ["date", "time", "fullTime"] {
            copy_field(&mut out, previous, k);
        }
    }
    if out["thread"]["count"] == 0 && previous["thread"]["count"].as_u64().unwrap_or(0) > 0 {
        out["thread"] = previous["thread"].clone();
    }
    out
}
fn copy_field(out: &mut Value, source: &Value, key: &str) {
    if let Some(value) = source.get(key) {
        out[key] = value.clone();
    } else {
        out.as_object_mut().unwrap().remove(key);
    }
}
fn merge(cached: &Value, live: &Value) -> Value {
    let mut known = HashMap::new();
    let mut out: Vec<Value> = Vec::new();
    for row in rows(cached).iter().chain(rows(live)) {
        let id = text(&row["id"]);
        if id.is_empty() {
            continue;
        }
        if let Some(at) = known.get(&id) {
            out[*at] = row.clone();
        } else {
            known.insert(id, out.len());
            out.push(row.clone());
        }
    }
    out.sort_by_key(|r| std::cmp::Reverse(time(r)));
    json!(out)
}
fn replay(row: &Value, entry: &Value) -> Value {
    let descriptor = entry
        .get("apply")
        .filter(|v| v.is_object())
        .unwrap_or(entry);
    let action = text(&descriptor["action"]);
    let thread = if descriptor["conversation"] == true {
        thread_action(row, &action)
    } else {
        descriptor["thread"].clone()
    };
    label_change(row, &action, &text(&descriptor["sourceLabelId"]), &thread)
}
fn rebase(entries: &Value, token: &Value) -> Value {
    let values = rows(entries);
    let Some(at) = values.iter().position(|e| e["token"] == *token) else {
        return Value::Null;
    };
    let mut out = values[..at].to_vec();
    let mut summary = values[at]["before"].clone();
    for entry in &values[at + 1..] {
        let mut next = entry.clone();
        next["before"] = summary.clone();
        summary = replay(&summary, entry);
        out.push(next);
    }
    json!({"entries":out,"summary":summary})
}

fn fuzzy(query: &str, hay: &str) -> i64 {
    let needle: Vec<u16> = query
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .encode_utf16()
        .collect();
    let hay: Vec<u16> = hay.to_lowercase().encode_utf16().collect();
    if needle.is_empty() {
        return 1;
    }
    let boundary =
        |at: usize| at == 0 || !(hay[at - 1] <= 127 && (hay[at - 1] as u8).is_ascii_alphanumeric());
    if let Some(at) = hay.windows(needle.len()).position(|v| v == needle) {
        return 1000 - at as i64 + if boundary(at) { 200 } else { 0 };
    }
    let mut score = 0;
    let mut from = 0;
    let mut last = None;
    for letter in needle {
        let Some(at) = hay[from..]
            .iter()
            .position(|v| *v == letter)
            .map(|v| v + from)
        else {
            return 0;
        };
        score += 10;
        if last == Some(at.wrapping_sub(1)) {
            score += 8;
        }
        if boundary(at) {
            score += 12;
        }
        last = Some(at);
        from = at + 1;
    }
    score
}

pub fn apply(p: &Value) -> Result<Value, &'static str> {
    if p["operation"] == "batch" {
        let calls = rows(&p["calls"]);
        if calls.len() > 128 || calls.iter().any(|c| c["operation"] == "batch") {
            return Err("model_batch_invalid");
        }
        return calls
            .iter()
            .map(apply)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array);
    }
    if p["operation"] == "action" {
        return action(p);
    }
    let args = rows(&p["args"]);
    // Declarative rebase copies a baseline into later entries. Check the
    // worst-case expansion before cloning that baseline repeatedly.
    let operation = text(&p["operation"]);
    let replay_entries = if operation == "rebaseIntents" {
        args.first().unwrap_or(&Value::Null)
    } else if operation == "intentsSettled" {
        args.first()
            .unwrap_or(&Value::Null)
            .get(text(args.get(1).unwrap_or(&Value::Null)))
            .unwrap_or(&Value::Null)
    } else {
        &Value::Null
    };
    let entry_count = rows(replay_entries).len();
    if entry_count > 128
        || (entry_count > 0
            && serde_json::to_vec(replay_entries)
                .map_err(|_| "model_invalid")?
                .len()
                .saturating_mul(entry_count)
                .saturating_mul(2)
                > 16 * 1024 * 1024)
    {
        return Err("model_output_too_large");
    }
    if args.iter().any(|a| rows(a).len() > 100_000) {
        return Err("model_too_many_rows");
    }
    let a = |n: usize| args.get(n).unwrap_or(&Value::Null);
    let s = |n| text(a(n));
    Ok(match text(&p["operation"]).as_str() {
        "fuzzyScore" => json!(fuzzy(&s(0), &s(1))),
        "filterRows" => {
            let typed = s(1);
            let typed = typed.trim();
            let mut kept = Vec::new();
            for (i, row) in rows(a(0)).iter().enumerate() {
                if !row.is_object() {
                    continue;
                }
                let hay = ["name", "label", "email"]
                    .iter()
                    .map(|k| text(&row[k]))
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>()
                    .join(" ");
                let score = if typed.is_empty() {
                    1
                } else {
                    fuzzy(typed, &hay)
                };
                if score <= 0 {
                    continue;
                }
                let mut copy = row.clone();
                copy["sourceIndex"] = json!(i);
                copy["score"] = json!(score);
                kept.push(copy);
            }
            if !typed.is_empty() {
                kept.sort_by_key(|r| std::cmp::Reverse(r["score"].as_i64().unwrap_or(0)));
            }
            json!(kept)
        }
        "railLabels" => {
            let mut kept: Vec<_> = rows(a(0))
                .iter()
                .filter(|r| r.is_object() && r["system"] != true)
                .cloned()
                .collect();
            kept.sort_by_key(|r| (text(&r["name"]).to_lowercase(), text(&r["id"])));
            json!(kept)
        }
        "actionScope" => json!(action_scope(&s(0))),
        "actionCapability" => json!(capability(&s(0))),
        "labelTarget" => json!(target(&s(0))),
        "isSystemLabelId" => json!(system(&s(0))),
        "actionTargets" => action_targets(a(0), &s(1)),
        "labelChangesFor" => changes(&s(0), &s(1)),
        "threadAfterAction" => thread_action(a(0), &s(1)),
        "threadAfterMemberChange" => thread_members(a(0), a(1)),
        "rowWithThread" => with_thread(a(0), a(1)),
        "applyLabelChange" => label_change(a(0), &s(1), &s(2), a(3)),
        "survivesAction" => json!(survives(&s(0), &s(1), &s(2), *a(3) == true, &s(4), a(5))),
        "rowHoldsMember" => json!(holds(a(0), &s(1))),
        "rowIndexForMember" => json!(row_index(a(0), a(1)).map(|i| i as i64).unwrap_or(-1)),
        "indexById" => json!(index(a(0), a(1)).map(|i| i as i64).unwrap_or(-1)),
        "messageById" => index(a(0), a(2))
            .map(|i| rows(a(0))[i].clone())
            .or_else(|| index(a(1), a(2)).map(|i| rows(a(1))[i].clone()))
            .unwrap_or(Value::Null),
        "removeById" => remove(a(0), a(1)),
        "replaceById" => replace(a(0), a(1)),
        "restoreRow" => restore(a(0), a(1), a(2), a(3)),
        "listAfterRestore" => {
            if a(1).is_null() {
                a(0).clone()
            } else if index(a(0), &a(1)["id"]).is_some() {
                replace(a(0), a(1))
            } else if *a(2) == true && *a(3) != true {
                restore(a(0), a(1), a(4), a(5))
            } else {
                a(0).clone()
            }
        }
        "previewAfterRestore" => {
            if *a(2) == true {
                if index(a(0), &a(1)["id"]).is_some() {
                    replace(a(0), a(1))
                } else {
                    restore(a(0), a(1), a(3), a(4))
                }
            } else {
                remove(a(0), &a(1)["id"])
            }
        }
        "restoreRows" => {
            let mut out = a(0).clone();
            for (i, row) in rows(a(1)).iter().enumerate() {
                if !rows(a(2)).contains(&row["id"]) {
                    continue;
                }
                if index(&out, &row["id"]).is_some() {
                    out = replace(&out, row);
                } else {
                    let at = rows(a(1))[i + 1..]
                        .iter()
                        .find_map(|r| index(&out, &r["id"]))
                        .unwrap_or(rows(&out).len());
                    let mut list = rows(&out).to_vec();
                    list.insert(at, row.clone());
                    out = json!(list);
                }
            }
            out
        }
        "detailSummary" => detail(a(0), a(1)),
        "sameSummaries" => json!(a(0) == a(1)),
        "mergeSearchResults" => merge(a(0), a(1)),
        "searchProgress" => {
            let live = merge(a(1), a(2));
            json!({"visible":merge(a(0),&live),"live":live})
        }
        "searchFinish" => {
            let settled = apply(&json!({"operation":"settledSearchResults","args":args}))?;
            let missing =
                apply(&json!({"operation":"missingSearchSummaryIds","args":[a(2),a(3)]}))?;
            json!({"settled":settled,"missing":missing})
        }
        "settledSearchResults" => {
            let known: HashMap<_, _> = rows(a(1))
                .iter()
                .chain(rows(a(2)))
                .filter(|r| !text(&r["id"]).is_empty())
                .map(|r| (text(&r["id"]), r))
                .collect();
            let mut budget = 16usize * 1024 * 1024;
            let mut sizes = HashMap::new();
            let mut page = Vec::new();
            for wanted in rows(a(3)) {
                let key = text(wanted);
                let Some(row) = known.get(&key).copied() else {
                    continue;
                };
                let bytes = *sizes.entry(key).or_insert_with(|| {
                    serde_json::to_vec(row)
                        .map(|b| b.len() + 1)
                        .unwrap_or(usize::MAX)
                });
                budget = budget.checked_sub(bytes).ok_or("model_output_too_large")?;
                page.push(row);
            }
            let page = json!(page);
            if *a(4) == true {
                merge(a(0), &page)
            } else {
                page
            }
        }
        "missingSearchSummaryIds" => {
            let known: HashSet<_> = rows(a(0)).iter().map(|r| text(&r["id"])).collect();
            json!(
                rows(a(1))
                    .iter()
                    .filter(|id| !text(id).is_empty() && !known.contains(&text(id)))
                    .collect::<Vec<_>>()
            )
        }
        "unreadCount" => json!(rows(a(0)).iter().filter(|r| r["unread"] == true).count()),
        "newestDate" => json!(rows(a(0)).iter().map(time).max().unwrap_or(0)),
        "newArrivals" => {
            let floor = a(3).as_i64().unwrap_or(0);
            json!(
                rows(a(0))
                    .iter()
                    .filter(|r| *a(2) == true
                        && r["unread"] == true
                        && r["inInbox"] == true
                        && a(1)[text(&r["id"])] != true
                        && (time(r) == 0 || time(r) >= floor))
                    .collect::<Vec<_>>()
            )
        }
        "withoutIntent" => json!(
            rows(a(0))
                .iter()
                .filter(|e| e.is_object() && e["token"] != *a(1))
                .collect::<Vec<_>>()
        ),
        "rebaseIntents" => rebase(a(0), a(1)),
        "anyIntentRemoved" => json!(rows(a(0)).iter().any(|e| e["removed"] == true)),
        "intentsWith" => {
            let mut out = a(0).as_object().cloned().unwrap_or_default();
            let mut entries = rows(&out.get(&s(1)).cloned().unwrap_or(Value::Null)).to_vec();
            entries.push(a(2).clone());
            out.insert(s(1), json!(entries));
            Value::Object(out)
        }
        "intentsSettled" => {
            let mut out = a(0).as_object().cloned().unwrap_or_default();
            let held = out.get(&s(1)).cloned().unwrap_or(json!([]));
            let mut outcome = if *a(3) == true {
                rebase(&held, a(2))
            } else {
                Value::Null
            };
            if outcome.is_null() {
                outcome = json!({"entries":rows(&held).iter().filter(|e| e["token"]!=*a(2)).collect::<Vec<_>>(),"summary":a(4)});
            }
            if rows(&outcome["entries"]).is_empty() {
                out.remove(&s(1));
            } else {
                out.insert(s(1), outcome["entries"].clone());
            }
            json!({"intents":out,"outcome":outcome})
        }
        "settledListsHeld" => {
            let mut out = a(0).as_object().cloned().unwrap_or_default();
            let held = out.get(&s(1));
            let entry = json!({"messages":held.map(|h| &h["messages"]).unwrap_or(a(2)),"previews":held.map(|h| &h["previews"]).unwrap_or(a(3)),"pending":held.and_then(|h| h["pending"].as_u64()).unwrap_or(0).saturating_add(1)});
            out.insert(s(1), entry);
            Value::Object(out)
        }
        "settledListsReleased" => {
            let mut out = a(0).as_object().cloned().unwrap_or_default();
            if let Some(held) = out.get_mut(&s(1)) {
                let count = held["pending"].as_u64().unwrap_or(0);
                if count <= 1 {
                    out.remove(&s(1));
                } else {
                    held["pending"] = json!(count - 1);
                }
            }
            Value::Object(out)
        }
        _ => return Err("model_operation_unsupported"),
    })
}

fn action(p: &Value) -> Result<Value, &'static str> {
    action_view(p, p, false)
}

/// Borrow the current snapshot and return only changed-row effects for the
/// transaction engine. It need not copy entire lists for every row in a batch.
pub(super) fn action_view(
    p: &Value,
    view: &Value,
    effects_only: bool,
) -> Result<Value, &'static str> {
    let action = text(&p["action"]);
    let needs = capability(&action);
    if !needs.is_empty() && p["capabilities"][needs] != true {
        return Ok(json!({"refused":true,"capability":needs}));
    }
    let id = &p["messageId"];
    let messages = &view["messages"];
    let previews = &view["previewMessages"];
    let before = row_index(messages, id)
        .map(|i| &rows(messages)[i])
        .or_else(|| row_index(previews, id).map(|i| &rows(previews)[i]))
        .ok_or("model_message_missing")?;
    let member = before["id"] != *id
        || p["memberOnly"] == true
        || p["oneMessage"] == true
        || p["quiet"] == true;
    let targets = if member {
        json!([id])
    } else {
        action_targets(before, &action)
    };
    let source = text(&p["sourceLabelId"]);
    if changes(&action, &source).is_null() && !["trash", "untrash"].contains(&action.as_str()) {
        return Err("model_action_unsupported");
    }
    let mut members = if effects_only {
        let mut picked = serde_json::Map::new();
        let thread = block(before);
        for id in rows(&targets)
            .iter()
            .chain(rows(&thread["memberIds"]))
            .chain(std::iter::once(&before["id"]))
        {
            let key = text(id);
            if let Some(held) = view["memberSummaries"].get(&key) {
                picked.insert(key, held.clone());
            }
        }
        picked
    } else {
        view["memberSummaries"]
            .as_object()
            .cloned()
            .unwrap_or_default()
    };
    for target in rows(&targets) {
        if let Some(row) = members.get_mut(&text(target)) {
            *row = label_change(row, &action, &source, &Value::Null);
        }
    }
    let own = if rows(&targets).contains(&before["id"]) {
        label_change(before, &action, &source, &Value::Null)
    } else {
        before.clone()
    };
    let member_existed = members.contains_key(&text(&before["id"]));
    members.insert(text(&before["id"]), own.clone());
    let thread = if !member && action_scope(&action) == "conversation" {
        thread_action(before, &action)
    } else {
        thread_members(before, &json!(members))
    };
    let updated = if !member && action_scope(&action) == "conversation" {
        label_change(before, &action, &source, &thread)
    } else {
        with_thread(&own, &thread)
    };
    if member_existed {
        members.insert(text(&before["id"]), updated.clone());
    } else {
        members.remove(&text(&before["id"]));
    }
    let survives = survives(
        &text(&p["mailboxKey"]),
        &action,
        &text(&p["rawQuery"]),
        p["hasLabels"] == true,
        &source,
        &updated,
    );
    let keep_open = p["quiet"] == true && holds(before, &text(&view["selectedId"]));
    let removed = !survives && !keep_open;
    if effects_only {
        return Ok(
            json!({"refused":false,"capability":needs,"rowId":before["id"],"before":before,"updated":updated,"targets":targets,"change":changes(&action,&source),"removed":removed,"survives":survives,"keepOpen":keep_open,"memberSummaries":members}),
        );
    }
    Ok(
        json!({"refused":false,"capability":needs,"rowId":before["id"],"before":before,"updated":updated,"targets":targets,"change":changes(&action,&source),"removed":removed,"survives":survives,"keepOpen":keep_open,"memberSummaries":members,"messages":if removed {remove(messages,&before["id"])} else {replace(messages,&updated)},"previewMessages":if updated["unread"]==true {replace(previews,&updated)} else {remove(previews,&before["id"])}}),
    )
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
