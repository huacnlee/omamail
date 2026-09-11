//! Conversation membership, bounded summaries, and one rail projection per update.
use super::unified::{rows, text};
use serde_json::{Value, json};
const MAX_REMEMBERED: usize = 500;
fn trim(v: &Value) -> String {
    text(v).trim().to_owned()
}
fn block(v: &Value) -> Value {
    if !v.is_object() {
        return Value::Null;
    }
    let ids: Vec<_> = rows(&v["memberIds"])
        .iter()
        .map(trim)
        .filter(|id| !id.is_empty())
        .collect();
    json!({"id":trim(&v["id"]),"memberIds":ids,"count":ids.len(),"unread":v["unread"]==true,"flagged":v["flagged"]==true})
}
fn holds(thread: &Value, id: &str) -> bool {
    rows(&thread["memberIds"]).contains(&json!(id.trim()))
}
fn has(summary: &Value, label: &str) -> bool {
    if let Some(labels) = summary["labelIds"].as_array() {
        return labels.contains(&json!(label));
    }
    summary[if label == "UNREAD" {
        "unread"
    } else {
        "starred"
    }] == true
}
fn merge(existing: &Value, additions: &Value, kept: &Value) -> Value {
    let mut out = json!({});
    if let Some(source) = existing.as_object() {
        for (id, summary) in source {
            if source.len() < MAX_REMEMBERED || rows(kept).iter().any(|v| trim(v) == *id) {
                out[id] = summary.clone();
            }
        }
    }
    if let Some(extra) = additions.as_object() {
        for (id, summary) in extra {
            let id = id.trim();
            if !id.is_empty() && !summary.is_null() && summary != false {
                out[id] = summary.clone();
            }
        }
    }
    out
}
fn viewed(key: &str, searching: bool) -> &str {
    if searching {
        ""
    } else if key == "unread" || key == "starred" {
        "inbox"
    } else {
        key
    }
}
fn mailbox(summary: &Value, view: &str, boxes: &Value) -> String {
    let key = [
        ("TRASH", "trash"),
        ("SPAM", "spam"),
        ("DRAFT", "drafts"),
        ("SENT", "sent"),
        ("INBOX", "inbox"),
    ]
    .into_iter()
    .find(|(label, _)| rows(&summary["labelIds"]).contains(&json!(label)))
    .map(|(_, key)| key)
    .unwrap_or("");
    if key.is_empty() || key == view {
        return String::new();
    }
    rows(boxes)
        .iter()
        .find(|b| trim(&b["key"]) == key)
        .map(|b| text(&b["label"]))
        .unwrap_or_default()
}
fn project(thread: Value, summaries: Value, p: &Value) -> Result<Value, &'static str> {
    let mut budget = serde_json::to_vec(&thread)
        .map_err(|_| "invalid_params")?
        .len()
        + serde_json::to_vec(&summaries)
            .map_err(|_| "invalid_params")?
            .len();
    let ids = rows(&thread["memberIds"]);
    let open = trim(&p["selectedId"]);
    let key = trim(&p["mailboxKey"]);
    let view = viewed(&key, p["searching"] == true);
    let missing: Vec<_> = ids
        .iter()
        .filter(|id| !summaries.get(trim(id)).is_some_and(Value::is_object))
        .cloned()
        .collect();
    let mut stops = Vec::new();
    let mut navigation = json!({});
    let mut unread = 0;
    let reversed: Vec<_> = ids.iter().rev().cloned().collect();
    for (index, id) in reversed.iter().enumerate() {
        let name = trim(id);
        let summary = &summaries[&name];
        let known = summary.is_object();
        let sender = if trim(&summary["from"]["display"]).is_empty() {
            trim(&summary["from"]["email"])
        } else {
            trim(&summary["from"]["display"])
        };
        let member_unread = has(summary, "UNREAD");
        if member_unread {
            unread += 1;
        }
        let stop = json!({"id":id,"known":known,"open":name==open,"sender":sender,"time":text(&summary["time"]),"fullTime":text(&summary["fullTime"]),"unread":member_unread,"flagged":has(summary,"STARRED"),"mailbox":mailbox(summary,view,&p["mailboxes"])});
        budget = budget.saturating_add(
            serde_json::to_vec(&stop)
                .map_err(|_| "invalid_params")?
                .len(),
        );
        if budget > 8 * 1024 * 1024 {
            return Err("conversation_limit");
        }
        stops.push(stop);
        let previous = index
            .checked_sub(1)
            .and_then(|i| reversed.get(i))
            .cloned()
            .unwrap_or(json!(""));
        let next = reversed.get(index + 1).cloned().unwrap_or(json!(""));
        let destinations =
            json!({"previous":previous,"next":next,"neighbor":if index>0{previous}else{next}});
        budget = budget.saturating_add(
            name.len()
                + serde_json::to_vec(&destinations)
                    .map_err(|_| "invalid_params")?
                    .len(),
        );
        if budget > 8 * 1024 * 1024 {
            return Err("conversation_limit");
        }
        navigation[&name] = destinations;
    }
    let count = ids.len();
    let caption = if count < 2 {
        String::new()
    } else if unread > 0 {
        format!("{count} messages · {unread} unread")
    } else {
        format!("{count} messages")
    };
    let rail = p["conversations"] == true && count >= 2;
    Ok(
        json!({"thread":thread,"summaries":summaries,"missing":missing,"showsRail":rail,"viewedMailboxKey":view,"stops":stops,"caption":caption,"navigation":navigation,"memberIds":ids,"first":reversed.first().cloned().unwrap_or(json!("")),"last":reversed.last().cloned().unwrap_or(json!(""))}),
    )
}
pub fn request(p: &Value) -> Result<Value, &'static str> {
    if serde_json::to_vec(p).map_err(|_| "invalid_params")?.len() > 8 * 1024 * 1024 {
        return Err("conversation_limit");
    }
    let mut thread = block(&p["thread"]);
    let mut summaries = if p["summaries"].is_object() {
        p["summaries"].clone()
    } else {
        json!({})
    };
    if rows(&thread["memberIds"]).len() > 2000 || summaries.as_object().unwrap().len() > 2000 {
        return Err("conversation_limit");
    }
    match p["operation"].as_str().unwrap_or("project") {
        "project" => (),
        "select" => {
            if !holds(&thread, &trim(&p["selectedId"])) {
                let next = block(&p["summary"]["thread"]);
                thread = if rows(&next["memberIds"]).len() >= 2 {
                    next
                } else {
                    Value::Null
                };
            }
        }
        "merge" => summaries = merge(&summaries, &p["additions"], &thread["memberIds"]),
        "seed" => {
            let mut extra = json!({});
            for id in rows(&thread["memberIds"]) {
                let name = trim(id);
                if summaries.get(&name).is_some_and(Value::is_object) {
                    continue;
                }
                if let Some(row) = rows(&p["messages"])
                    .iter()
                    .chain(rows(&p["previewMessages"]))
                    .find(|r| r["id"] == *id)
                {
                    extra[&name] = row.clone();
                }
            }
            summaries = merge(&summaries, &extra, &thread["memberIds"]);
        }
        _ => return Err("invalid_params"),
    }
    if rows(&thread["memberIds"]).len() > 2000 || summaries.as_object().unwrap().len() > 2000 {
        return Err("conversation_limit");
    }
    let result = project(thread, summaries, p)?;
    if serde_json::to_vec(&result)
        .map_err(|_| "invalid_params")?
        .len()
        > 8 * 1024 * 1024
    {
        return Err("conversation_limit");
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    fn base() -> Value {
        json!({"thread":{"id":"t","memberIds":["a","b","c"],"count":99},"selectedId":"c","summaries":{"a":{"id":"a","labelIds":["DRAFT","INBOX"],"from":{"display":"Ada"}},"c":{"id":"c","labelIds":["INBOX","UNREAD"],"starred":true}},"conversations":true,"mailboxKey":"unread","mailboxes":[{"key":"drafts","label":"Drafts"},{"key":"inbox","label":"Inbox"}]})
    }
    #[test]
    fn rail_projection_matches_legacy_oracle_with_member_flags_and_missing_stops() {
        let mut search = base();
        search["searching"] = json!(true);
        let fixtures = json!([base(),search,{"thread":null,"summaries":{},"conversations":true},{"thread":{"memberIds":["only"]},"summaries":{},"conversations":true}]);
        let mut node=Command::new("node").args(["-e",r#"const C=require('./ui/tests/load').load('tests/oracles/Conversation.js');let p=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(p.map(x=>{let t=C.blockOf(x.thread),v=C.viewedMailboxKey(x.mailboxKey,x.searching),n={};for(let id of (t?t.memberIds:[]))n[id]={previous:C.memberStep(t,id,-1),next:C.memberStep(t,id,1),neighbor:C.neighbourStop(t,id)};return {thread:t,showsRail:C.drawsRail(x.conversations,t),viewedMailboxKey:v,stops:C.stops(t,x.summaries,x.selectedId,v,x.mailboxes),caption:C.caption(t,x.summaries),missing:C.missingMemberIds(t,x.summaries),navigation:n};})));"#]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        node.stdin
            .take()
            .unwrap()
            .write_all(fixtures.to_string().as_bytes())
            .unwrap();
        let output = node.wait_with_output().unwrap();
        assert!(output.status.success());
        let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
        for (index, fixture) in rows(&fixtures).iter().enumerate() {
            let result = request(fixture).unwrap();
            for (key, value) in expected[index].as_object().unwrap() {
                assert_eq!(&result[key], value, "{index}: {key}");
            }
        }
    }
    #[test]
    fn selection_retains_thread_and_seed_avoids_refetching_known_members() {
        let mut p = base();
        p["operation"] = json!("select");
        p["selectedId"] = json!("b");
        p["summary"] = json!({"id":"b"});
        let selected = request(&p).unwrap();
        assert_eq!(selected["thread"]["memberIds"], json!(["a", "b", "c"]));
        p["operation"] = json!("seed");
        p["messages"] = json!([{"id":"b","labelIds":[]}]);
        let seeded = request(&p).unwrap();
        assert_eq!(seeded["missing"], json!([]));
        assert!(seeded["summaries"]["b"].is_object());
        p["operation"] = json!("select");
        p["selectedId"] = json!("outside");
        assert!(request(&p).unwrap()["thread"].is_null());
    }
    #[test]
    fn bounded_member_merge_preserves_current_conversation() {
        let mut p = base();
        p["operation"] = json!("merge");
        for n in 0..MAX_REMEMBERED {
            p["summaries"][format!("old{n}")] = json!({"id":format!("old{n}")});
        }
        p["additions"] = json!({" b ":{"id":"b"}});
        let result = request(&p).unwrap();
        assert_eq!(result["summaries"].as_object().unwrap().len(), 3);
        assert_eq!(result["missing"], json!([]));
        assert!(
            !result["summaries"]
                .as_object()
                .unwrap()
                .contains_key("old0")
        );
    }
}

#[cfg(test)]
mod expansion_tests {
    use super::*;
    #[test]
    fn repeated_members_cannot_amplify_one_large_sender_into_unbounded_stops() {
        let params = json!({"thread":{"memberIds":vec!["a";2000]},"summaries":{"a":{"from":{"display":"x".repeat(4*1024*1024)}}},"conversations":true});
        assert_eq!(request(&params), Err("conversation_limit"));
    }
}
