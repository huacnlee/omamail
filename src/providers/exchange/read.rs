//! Reading mail: `exchange.list`, `exchange.messages`, `exchange.read` and `exchange.attachment`.
//!
//! A listing answers the page and its header-only rows together (`ids[i]` is `rows[i].id`). A
//! message that is not there does not fail a request that asked for others: it is left out and the
//! reply says `"partial"`; the request fails only when nothing came back and the reason was not
//! "not found". Every handler is read-only and runs through `account::read`; the shared MIME parse
//! runs on a blocking thread.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::FutureExt;
use serde_json::{Value, json};

use super::ews::{Client, Folders, Item, MAX_IDS, MAX_MIME_IDS};
use super::query::Query;
use super::{INVALID, account::read as run, fields, message_ids, resource, text, token};

const NOT_FOUND: &str = "exchange_message_not_found";
const TOO_LARGE: &str = "exchange_response_too_large";

pub async fn list(params: &Value) -> Result<Value, &'static str> {
    let map = fields(
        params,
        &["accountId", "query", "limit", "pageToken", "requestToken"],
    )?;
    let query = Query::parse(text(map, "query")?)?;
    let limit = map
        .get("limit")
        .and_then(Value::as_u64)
        .filter(|n| (1..=100).contains(n))
        .ok_or(INVALID)? as usize;
    let page = match map.get("pageToken") {
        None | Some(Value::Null) => None,
        Some(Value::String(token)) if token.len() <= 32 * 1024 => {
            Some(token.clone()).filter(|t| !t.is_empty())
        }
        Some(_) => return Err(INVALID),
    };
    run(&super::account(map)?, token(map)?, move |client| {
        async move {
            let found = client.list(&query, limit, page.as_deref()).await?;
            let folders = client.folders().await?;
            // A row that cannot be shown is left out with its id, so the two lists stay in step.
            let rows: Vec<Value> = found.items.iter().filter_map(|item| resource::row(item, &folders).ok()).collect();
            let ids: Vec<&Value> = rows.iter().map(|row| &row["id"]).collect();
            Ok(json!({
                "page": {"ids": ids, "threadIds": [], "nextPageToken": found.next.unwrap_or_default(), "estimate": found.estimate},
                "rows": rows,
                "warning": null,
            }))
        }
        .boxed()
    })
    .await
}

pub async fn messages(params: &Value) -> Result<Value, &'static str> {
    let map = fields(params, &["accountId", "ids", "full", "requestToken"])?;
    let ids = message_ids(map, "ids", 100)?;
    let full = map.get("full").and_then(Value::as_bool).ok_or(INVALID)?;
    run(&super::account(map)?, token(map)?, move |client| {
        async move { fetch(client, &ids, full).await }.boxed()
    })
    .await
}

async fn fetch(client: &mut Client, ids: &[String], full: bool) -> Result<Value, &'static str> {
    let folders = client.folders().await?;
    let (mut messages, mut left_out, mut cause) = (Vec::new(), false, None);
    for chunk in ids.chunks(if full { MAX_MIME_IDS } else { MAX_IDS }) {
        let items = match client.items(chunk, full).await {
            // Messages share one response ceiling: those that did not fit together are read alone.
            Err(TOO_LARGE) if full && chunk.len() > 1 => {
                let mut items = Vec::with_capacity(chunk.len());
                for id in chunk {
                    items.push(match client.items(std::slice::from_ref(id), true).await {
                        Ok(mut one) => one.pop().unwrap_or(Err(NOT_FOUND)),
                        Err(code) => Err(code),
                    });
                }
                items
            }
            other => other?,
        };
        for built in build(items, &folders, full).await? {
            match built {
                Ok(message) => messages.push(message),
                Err(code) => {
                    left_out = true;
                    if code != NOT_FOUND {
                        cause.get_or_insert(code);
                    }
                }
            }
        }
    }
    match cause {
        Some(code) if messages.is_empty() => Err(code),
        _ => Ok(
            json!({"messages": messages, "warning": if left_out { json!("partial") } else { Value::Null }, "continuation": null}),
        ),
    }
}

/// Items as resources; a full message is parsed MIME of up to 24 MiB, so away from the async workers.
async fn build(
    items: Vec<Result<Item, &'static str>>,
    folders: &Folders,
    full: bool,
) -> Result<Vec<Result<Value, &'static str>>, &'static str> {
    let folders = folders.clone();
    tokio::task::spawn_blocking(move || {
        items
            .into_iter()
            .map(|item| {
                item.and_then(|item| {
                    if full {
                        resource::message(&item, &folders)
                    } else {
                        resource::row(&item, &folders)
                    }
                })
            })
            .collect()
    })
    .await
    .map_err(|_| "worker_failed")
}

pub async fn read(params: &Value) -> Result<Value, &'static str> {
    let map = fields(params, &["accountId", "id", "full"])?;
    let id = text(map, "id")?.to_owned();
    super::ids::validate(&id)?;
    if map.get("full").and_then(Value::as_bool) != Some(true) {
        return Err(INVALID);
    }
    let found = run(&super::account(map)?, None, move |client| {
        async move { fetch(client, &[id], true).await }.boxed()
    })
    .await?;
    found["messages"][0]
        .as_object()
        .map(|_| found["messages"][0].clone())
        .ok_or(NOT_FOUND)
}

/// The decoded bytes of one MIME part as `{data}` (unpadded base64url): the message is read again
/// and the part taken from its parse, so the id is the one a resource of that message named.
pub async fn attachment(params: &Value) -> Result<Value, &'static str> {
    let map = fields(params, &["accountId", "messageId", "attachmentId"])?;
    let message = text(map, "messageId")?.to_owned();
    super::ids::validate(&message)?;
    // `part:` and dot-separated part numbers, as `message::parse` writes them.
    let part = text(map, "attachmentId")?.to_owned();
    let numbers = part.strip_prefix("part:").ok_or(INVALID)?;
    if part.len() > 64
        || !(numbers.is_empty()
            || numbers
                .split('.')
                .all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
    {
        return Err(INVALID);
    }
    run(&super::account(map)?, None, move |client| {
        async move {
            let item = client
                .items(&[message], true)
                .await?
                .pop()
                .ok_or(NOT_FOUND)??;
            let bytes = tokio::task::spawn_blocking(move || {
                resource::attachment(item.mime.as_deref().unwrap_or_default(), &part)
            })
            .await
            .map_err(|_| "worker_failed")??;
            Ok(json!({"data": URL_SAFE_NO_PAD.encode(bytes)}))
        }
        .boxed()
    })
    .await
}
