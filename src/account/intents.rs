//! Ordered declarative optimistic edits. A late refusal removes only its own effects.
use super::model;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
type Result<T> = std::result::Result<T, &'static str>;
const MAX_CONTEXTS: usize = 32;
const MAX_EDITS: usize = 128;
const MAX_VIEW: usize = 4 * 1024 * 1024;
#[derive(Default)]
pub struct IntentStore {
    state: Mutex<State>,
}
#[derive(Default)]
struct State {
    contexts: HashMap<(String, String), Context>,
    generations: HashMap<String, u64>,
    serial: u64,
}
#[derive(Clone)]
struct Context {
    generation: u64,
    base: Value,
    view: Value,
    edits: Vec<Edit>,
    bytes: usize,
    view_bytes: usize,
}
#[derive(Clone)]
struct Edit {
    token: u64,
    descriptor: Value,
    items: Vec<Item>,
    settled: bool,
    bytes: usize,
}
#[derive(Clone)]
struct Item {
    id: String,
    row: String,
    failed: bool,
    targets: Vec<Value>,
}
fn field(p: &Value, k: &str) -> Result<String> {
    let s = p[k].as_str().ok_or("intent_invalid")?;
    if s.is_empty() || s.len() > 8192 || s.contains('\0') {
        return Err("intent_invalid");
    }
    Ok(s.to_owned())
}
fn list(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
fn id(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn invoke(operation: &str, args: Value) -> Result<Value> {
    model::apply(&json!({"operation":operation,"args":args}))
}
fn validate_view(view: &Value) -> Result<()> {
    if !view.is_object() || !view["messages"].is_array() || !view["previewMessages"].is_array() {
        return Err("intent_view_invalid");
    }
    if serde_json::to_vec(view)
        .map_err(|_| "intent_view_invalid")?
        .len()
        > MAX_VIEW
    {
        return Err("intent_limit");
    }
    Ok(())
}
fn descriptor(p: &Value) -> Value {
    let mut out = json!({});
    for k in [
        "action",
        "quiet",
        "memberOnly",
        "oneMessage",
        "mailboxKey",
        "rawQuery",
        "hasLabels",
        "sourceLabelId",
        "capabilities",
        "opaqueQuery",
    ] {
        out[k] = p[k].clone();
    }
    out["readerThread"] = p["view"]["selectedThread"].clone();
    if p["allRead"] == true {
        out["action"] = json!("markRead");
    }
    out
}
fn same_descriptor(a: &Value, b: &Value) -> bool {
    let mut a = a.clone();
    let mut b = b.clone();
    a.as_object_mut().unwrap().remove("readerThread");
    b.as_object_mut().unwrap().remove("readerThread");
    a == b
}
fn selected(view: &mut Value, current: &Value) {
    if current.get("selectedId").is_none() {
        return;
    }
    let wanted = current["selectedId"].clone();
    if view["selectedId"] == wanted {
        return;
    }
    view["selectedId"] = wanted.clone();
    view["selectedMessage"] = if id(&wanted).is_empty() {
        Value::Null
    } else {
        let found = invoke(
            "messageById",
            json!([view["messages"], view["previewMessages"], wanted]),
        )
        .unwrap_or(Value::Null);
        let summary = if found.is_object() {
            found
        } else {
            view["memberSummaries"]
                .get(id(&wanted))
                .cloned()
                .unwrap_or(Value::Null)
        };
        let mut detail = current["selectedMessage"].clone();
        if !detail.is_object() {
            detail = summary.clone();
        }
        if detail.is_object() && summary.is_object() {
            for key in [
                "labelIds", "unread", "starred", "inInbox", "inTrash", "inSpam", "isSent",
                "isDraft", "thread",
            ] {
                if let Some(value) = summary.get(key) {
                    detail[key] = value.clone();
                }
            }
        }
        detail
    };
}
fn apply_one(view: &mut Value, desc: &Value, message: &str) -> Result<Value> {
    let mut p = desc.clone();
    p["operation"] = json!("action");
    p["messageId"] = json!(message);
    let outcome = match model::action_view(&p, view, true) {
        Ok(v) => v,
        Err("model_message_missing") => {
            let change = model::changes(id(&desc["action"]), id(&desc["sourceLabelId"]));
            if change.is_null()
                || !list(&desc["readerThread"]["memberIds"]).contains(&json!(message))
            {
                return Err("model_message_missing");
            }
            if let Some(held) = view["memberSummaries"].get(message).cloned() {
                view["memberSummaries"][message] =
                    model::label_change(&held, id(&desc["action"]), "", &Value::Null);
            }
            if view["selectedId"] == message && view["selectedMessage"].is_object() {
                view["selectedMessage"] = model::label_change(
                    &view["selectedMessage"],
                    id(&desc["action"]),
                    "",
                    &Value::Null,
                );
            }
            return Ok(
                json!({"rowId":message,"targets":[message],"change":change,"removed":false,"survives":true,"detached":true}),
            );
        }
        Err(e) => return Err(e),
    };
    if outcome["refused"] == true {
        return Ok(outcome);
    }
    let selected_id = view["selectedId"].clone();
    let before = &outcome["before"];
    let row = id(&outcome["rowId"]);
    let member_existed = view["memberSummaries"].get(row).is_some();
    for (key, removed) in [
        ("messages", outcome["removed"] == true),
        ("previewMessages", outcome["updated"]["unread"] != true),
    ] {
        if let Some(list) = view[key].as_array_mut() {
            if removed {
                list.retain(|entry| entry["id"] != outcome["rowId"]);
            } else {
                for entry in list {
                    if entry["id"] == outcome["rowId"] {
                        *entry = outcome["updated"].clone();
                    }
                }
            }
        }
    }
    if !view["memberSummaries"].is_object() {
        view["memberSummaries"] = json!({});
    }
    if let Some(updates) = outcome["memberSummaries"].as_object() {
        for (key, value) in updates {
            view["memberSummaries"][key] = value.clone();
        }
    }
    if member_existed {
        view["memberSummaries"][row] = outcome["updated"].clone();
    }
    let action = id(&desc["action"]);
    let before_unread = before["unread"] == true;
    let unread = outcome["updated"]["unread"] == true;
    let count = view["inboxUnread"].as_u64().unwrap_or(0);
    if action == "markRead" && before_unread && !unread {
        view["inboxUnread"] = json!(count.saturating_sub(1));
    }
    if action == "markUnread" && !before_unread && unread {
        view["inboxUnread"] = json!(count.saturating_add(1));
    }
    let holds = invoke("rowHoldsMember", json!([before, selected_id]))? == true;
    if holds {
        if outcome["removed"] == true {
            view["selectedId"] = json!("");
            view["selectedMessage"] = Value::Null;
        } else if selected_id == outcome["rowId"] && view["selectedMessage"].is_object() {
            view["selectedMessage"] = model::label_change(
                &view["selectedMessage"],
                action,
                id(&desc["sourceLabelId"]),
                &outcome["updated"]["thread"],
            );
        } else if list(&outcome["targets"]).contains(&selected_id)
            && view["selectedMessage"].is_object()
        {
            view["selectedMessage"] = model::label_change(
                &view["selectedMessage"],
                action,
                id(&desc["sourceLabelId"]),
                &Value::Null,
            );
        }
    }
    Ok(outcome)
}
fn replay(context: &Context) -> Result<Value> {
    let mut view = context.base.clone();
    for edit in &context.edits {
        for item in edit.items.iter().filter(|i| !i.failed) {
            match apply_one(&mut view, &edit.descriptor, &item.id) {
                Ok(_) => (),
                Err("model_message_missing") => (),
                Err(e) => return Err(e),
            }
        }
    }
    Ok(view)
}
impl IntentStore {
    pub fn call(&self, p: &Value) -> Result<Value> {
        let account = field(p, "accountId")?;
        let operation = id(&p["operation"]);
        let mut state = self.state.lock().map_err(|_| "intent_unavailable")?;
        if operation == "reset" {
            if !state.generations.contains_key(&account) && state.generations.len() >= 1024 {
                return Err("intent_limit");
            }
            let generation = state
                .generations
                .get(&account)
                .copied()
                .unwrap_or(0)
                .checked_add(1)
                .ok_or("intent_limit")?;
            state.contexts.retain(|(a, _), _| a != &account);
            state.generations.insert(account, generation);
            return Ok(json!({"generation":generation,"cleared":true}));
        }
        if operation == "clear" {
            let generation = state.generations.get(&account).copied().unwrap_or(0);
            if p["generation"].as_u64().ok_or("intent_invalid")? != generation {
                return Err("intent_stale");
            }
            state.contexts.retain(|(a, q), _| {
                a != &account || p["query"].as_str().is_some_and(|wanted| wanted != q)
            });
            return Ok(json!({"cleared":true,"generation":generation}));
        }
        let query = field(p, "query")?;
        let key = (account.clone(), query);
        let generation = p["generation"].as_u64().ok_or("intent_invalid")?;
        let prior = state.generations.get(&account).copied().unwrap_or(0);
        if state.generations.contains_key(&account) && generation != prior {
            return Err("intent_stale");
        }
        if operation == "coalesce" {
            let newer = p["token"].as_u64().ok_or("intent_invalid")?;
            let older = p["intoToken"].as_u64().ok_or("intent_invalid")?;
            let mut context = state.contexts.get(&key).ok_or("intent_unknown")?.clone();
            if context.generation != generation {
                return Err("intent_stale");
            }
            let old = context
                .edits
                .iter()
                .position(|e| e.token == older)
                .ok_or("intent_unknown")?;
            let new = context
                .edits
                .iter()
                .position(|e| e.token == newer)
                .ok_or("intent_unknown")?;
            let ids: Vec<_> = context.edits[old]
                .items
                .iter()
                .map(|i| i.id.as_str())
                .collect();
            if old >= new
                || context.edits[old].settled
                || context.edits[new].settled
                || !same_descriptor(
                    &context.edits[old].descriptor,
                    &context.edits[new].descriptor,
                )
                || ids
                    != context.edits[new]
                        .items
                        .iter()
                        .map(|i| i.id.as_str())
                        .collect::<Vec<_>>()
                || context.edits[old + 1..new]
                    .iter()
                    .any(|e| e.items.iter().any(|i| ids.contains(&i.id.as_str())))
            {
                return Err("intent_coalesce_invalid");
            }
            let removed = context.edits.remove(new);
            context.bytes = context.bytes.saturating_sub(removed.bytes);
            let mut view = replay(&context)?;
            selected(&mut view, &context.view);
            let bytes = serde_json::to_vec(&view)
                .map_err(|_| "intent_view_invalid")?
                .len();
            if bytes > MAX_VIEW {
                return Err("intent_limit");
            }
            context.bytes = context.bytes.saturating_sub(context.view_bytes) + bytes;
            let other_bytes: usize = state
                .contexts
                .iter()
                .filter(|(k, _)| **k != key)
                .map(|(_, c)| c.bytes)
                .sum();
            if other_bytes.saturating_add(context.bytes) > 32 * 1024 * 1024 {
                return Err("intent_limit");
            }
            context.view_bytes = bytes;
            context.view = view.clone();
            state.contexts.insert(key, context);
            return Ok(json!({"view":view,"token":older,"generation":generation}));
        }
        if operation == "settle" {
            if serde_json::to_vec(&p["view"])
                .map_err(|_| "intent_view_invalid")?
                .len()
                > MAX_VIEW
            {
                return Err("intent_limit");
            }
            let token = p["token"].as_u64().ok_or("intent_invalid")?;
            let mut context = state.contexts.get(&key).ok_or("intent_unknown")?.clone();
            if context.generation != generation {
                return Err("intent_stale");
            }
            let edit = context
                .edits
                .iter_mut()
                .find(|e| e.token == token)
                .ok_or("intent_unknown")?;
            if edit.settled {
                return Err("intent_already_settled");
            }
            let failed = list(&p["failedIds"]);
            if failed
                .iter()
                .any(|f| !edit.items.iter().any(|i| json!(i.row) == *f))
            {
                return Err("intent_invalid");
            }
            edit.settled = true;
            for item in &mut edit.items {
                item.failed = failed.contains(&json!(item.row));
            }
            let targets: Vec<_> = edit
                .items
                .iter()
                .filter(|i| !i.failed)
                .flat_map(|i| i.targets.clone())
                .collect();
            let mut view = replay(&context)?;
            selected(
                &mut view,
                if p["view"].is_object() {
                    &p["view"]
                } else {
                    &context.view
                },
            );
            let bytes = serde_json::to_vec(&view)
                .map_err(|_| "intent_view_invalid")?
                .len();
            if bytes > MAX_VIEW {
                return Err("intent_limit");
            }
            context.bytes = context.bytes.saturating_sub(context.view_bytes) + bytes;
            let other_bytes: usize = state
                .contexts
                .iter()
                .filter(|(k, _)| **k != key)
                .map(|(_, c)| c.bytes)
                .sum();
            if other_bytes.saturating_add(context.bytes) > 32 * 1024 * 1024 {
                return Err("intent_limit");
            }
            context.view_bytes = bytes;
            context.view = view.clone();
            // Settled successors remain ordered until every predecessor settles.
            if context.edits.iter().all(|e| e.settled) {
                state.contexts.remove(&key);
            } else {
                state.contexts.insert(key, context);
            }
            return Ok(json!({"view":view,"targets":targets,"generation":generation}));
        }
        if operation != "begin" {
            return Err("intent_invalid");
        }
        validate_view(&p["view"])?;
        if !state.generations.contains_key(&account) && state.generations.len() >= 1024 {
            return Err("intent_limit");
        }
        if !state.contexts.contains_key(&key) && state.contexts.len() >= MAX_CONTEXTS {
            return Err("intent_limit");
        }
        if state
            .contexts
            .get(&key)
            .is_some_and(|c| c.edits.len() >= MAX_EDITS)
        {
            return Err("intent_limit");
        }
        let desc = descriptor(p);
        let action = id(&desc["action"]);
        let capability = model::capability(action);
        if !capability.is_empty() && desc["capabilities"][capability] != true {
            return Ok(json!({"refused":true,"capability":capability}));
        }
        if model::changes(action, id(&desc["sourceLabelId"])).is_null()
            && !matches!(action, "trash" | "untrash")
        {
            return Err("intent_invalid");
        }
        let mut ids = if p["allRead"] == true {
            list(&p["view"]["messages"])
                .into_iter()
                .filter(|r| r["unread"] == true)
                .map(|r| r["id"].clone())
                .collect()
        } else {
            list(&p["ids"])
        };
        if ids.len() > 1000 || ids.iter().any(|v| id(v).is_empty() || id(v).len() > 8192) {
            return Err("intent_invalid");
        }
        let mut seen = HashSet::new();
        ids.retain(|v| seen.insert(id(v).to_owned()));
        let context = state.contexts.get(&key);
        let mut view = context
            .map(|c| c.view.clone())
            .unwrap_or_else(|| p["view"].clone());
        let mut base = context
            .map(|c| c.base.clone())
            .unwrap_or_else(|| p["view"].clone());
        if let Some(members) = p["view"]["memberSummaries"].as_object() {
            for (key, member) in members {
                if base["memberSummaries"].get(key).is_none() {
                    if !base["memberSummaries"].is_object() {
                        base["memberSummaries"] = json!({});
                    }
                    if !view["memberSummaries"].is_object() {
                        view["memberSummaries"] = json!({});
                    }
                    base["memberSummaries"][key] = member.clone();
                    view["memberSummaries"][key] = member.clone();
                }
            }
        }
        view["selectedThread"] = p["view"]["selectedThread"].clone();
        selected(&mut view, &p["view"]);
        let mut items = Vec::new();
        let mut targets = Vec::new();
        let mut targets_of = json!({});
        let mut rows = Vec::new();
        let mut removed = Vec::new();
        let mut invalidates = desc["opaqueQuery"] == true;
        for message in ids {
            let outcome = match apply_one(&mut view, &desc, id(&message)) {
                Ok(v) => v,
                Err("model_message_missing") => continue,
                Err(e) => return Err(e),
            };
            let row = id(&outcome["rowId"]).to_owned();
            if row.is_empty() {
                continue;
            }
            if !rows.contains(&json!(row)) {
                rows.push(json!(row));
            }
            let mut own = list(&targets_of[&row]);
            for target in list(&outcome["targets"]) {
                if !own.contains(&target) {
                    own.push(target.clone());
                }
                if !targets.contains(&target) {
                    targets.push(target);
                }
            }
            targets_of[&row] = json!(own);
            if outcome["removed"] == true && !removed.contains(&json!(row)) {
                removed.push(json!(row));
            }
            invalidates |= outcome["survives"] == false;
            items.push(Item {
                id: id(&message).to_owned(),
                row,
                failed: false,
                targets: list(&outcome["targets"]),
            });
        }
        if items.is_empty() {
            return Ok(json!({"refused":true,"capability":"","targets":[],"rows":[]}));
        }
        let view_bytes = serde_json::to_vec(&view)
            .map_err(|_| "intent_view_invalid")?
            .len();
        if view_bytes > MAX_VIEW {
            return Err("intent_limit");
        }
        let edit_bytes = serde_json::to_vec(&desc)
            .map_err(|_| "intent_invalid")?
            .len()
            + items
                .iter()
                .map(|i| {
                    i.id.len()
                        + i.row.len()
                        + serde_json::to_vec(&i.targets).map_or(MAX_VIEW, |v| v.len())
                })
                .sum::<usize>();
        let base_bytes = serde_json::to_vec(&base)
            .map_err(|_| "intent_view_invalid")?
            .len();
        if base_bytes > MAX_VIEW {
            return Err("intent_limit");
        }
        let context_bytes = state
            .contexts
            .get(&key)
            .map(|c| c.edits.iter().map(|e| e.bytes).sum::<usize>() + base_bytes)
            .unwrap_or(base_bytes)
            + view_bytes
            + edit_bytes;
        let total = state
            .contexts
            .iter()
            .filter(|(k, _)| **k != key)
            .map(|(_, c)| c.bytes)
            .sum::<usize>();
        if total.saturating_add(context_bytes) > 32 * 1024 * 1024 {
            return Err("intent_limit");
        }
        state.serial = state.serial.checked_add(1).ok_or("intent_limit")?;
        state.generations.insert(account, generation);
        let token = state.serial;
        let context = state.contexts.entry(key).or_insert_with(|| Context {
            generation,
            base: p["view"].clone(),
            view: p["view"].clone(),
            edits: Vec::new(),
            bytes: 0,
            view_bytes: 0,
        });
        context.base = base;
        context.view = view.clone();
        context.bytes = context_bytes;
        context.view_bytes = view_bytes;
        context.edits.push(Edit {
            token,
            descriptor: desc.clone(),
            items,
            settled: false,
            bytes: edit_bytes,
        });
        Ok(
            json!({"token":token,"generation":generation,"view":view,"targets":targets,"targetsOf":targets_of,"rows":rows,"expanded":targets.len()>rows.len(),"change":model::changes(action,id(&desc["sourceLabelId"])),"invalidatesPage":invalidates,"removedIds":removed,"refused":false,"capability":capability}),
        )
    }
}
#[cfg(test)]
mod tests;
