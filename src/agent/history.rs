//! Bounded UI pages, independent of the native agent's model context.
use super::{jobs, proposals, storage::Store};
use serde_json::{Value, json};

pub fn page(store: &Store, job: &Value, before: &str) -> Result<Value, &'static str> {
    let id = job["id"].as_str().ok_or("agent_invalid_id")?;
    let conversation = job["conversationId"].as_str().unwrap_or(id);
    let latest = jobs::saved_display(store, id)?;
    let mut cursor = if before.is_empty() { id } else { before }.to_owned();
    let mut chunks = Vec::new();
    let mut budget = 0;
    let mut visited = std::collections::HashSet::new();
    while !cursor.is_empty() && chunks.len() < 8 {
        if !visited.insert(cursor.clone()) {
            return Err("agent_invalid_history");
        }
        if !store.contains(&cursor)? {
            cursor.clear();
            break;
        }
        let turn = jobs::read_job(store, &cursor)?;
        if turn["accountId"] != job["accountId"]
            || turn["conversationId"].as_str().unwrap_or(&cursor) != conversation
        {
            return Err("agent_context_owner_mismatch");
        }
        let display = jobs::saved_display(store, &cursor)?;
        let legacy = turn["displayVersion"] != 2;
        let cards = if legacy {
            proposals::history(store, &cursor)?
        } else {
            proposals::turn(store, &cursor)?
        };
        let chunk = json!({"transcript":display["transcript"],"proposals":cards});
        let size = serde_json::to_vec(&chunk)
            .map_err(|_| "agent_invalid_history")?
            .len();
        if budget + size > 8 * 1024 * 1024 {
            if chunks.is_empty() {
                return Err("agent_proposal_limit");
            }
            break;
        }
        budget += size;
        chunks.push(chunk);
        if legacy {
            cursor.clear();
            break;
        }
        let context = store
            .read_json(&cursor, "context.json", jobs::INPUT_LIMIT)?
            .ok_or("agent_context_missing")?;
        cursor = context["parent"].as_str().unwrap_or("").to_owned();
    }
    let mut transcript = Vec::new();
    let mut cards = Vec::new();
    for chunk in chunks.into_iter().rev() {
        for card in chunk["proposals"].as_array().unwrap() {
            let mut card = card.clone();
            card["afterTurn"] =
                json!(transcript.len() + card["afterTurn"].as_u64().unwrap_or(0) as usize);
            cards.push(card);
        }
        transcript.extend(chunk["transcript"].as_array().unwrap().iter().cloned());
    }
    Ok(
        json!({"job":job,"output":latest["output"],"transcript":transcript,"proposals":cards,"previous":cursor}),
    )
}
