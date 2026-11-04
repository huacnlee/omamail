//! Reading mail: `m365.list`, `m365.messages`, `m365.read` and `m365.attachment`.
//!
//! A listing answers its page and the header-only rows together (`ids[i]` is `rows[i].id`) and keeps
//! the rows for a minute, so the `m365.messages` that follows for the same ids asks Graph nothing.
//! A full read is never cached (a message is up to 24 MiB). A message that is not there does not fail
//! a request that asked for others: it is left out and the answer says `"partial"`; the request fails
//! only when it got nothing and the reason was not "not found".

use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use futures_util::StreamExt as _;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

use super::cancel::{guarded, guarded_read};
use super::graph::{Graph, NOT_FOUND};
use super::mailbox::{MAX_MIME, MAX_PAGE, unseal};
use super::model::{self, Roles};
use super::{ids, params};

const ROW_TTL: Duration = Duration::from_secs(60);
const MAX_ROWS: usize = 256;
const MAX_MESSAGES: usize = 100;

type CachedRow = (String, String, Instant, Value);
static ROWS: LazyLock<Mutex<VecDeque<CachedRow>>> = LazyLock::new(Default::default);
/// Parsing a hostile 24 MiB message costs hundreds of MiB while its tree exists: two at a time.
static PARSING: Semaphore = Semaphore::const_new(2);

fn remember(account: &str, row: &Value) {
    let Some(id) = row["id"].as_str() else { return };
    let mut rows = ROWS.lock().unwrap_or_else(PoisonError::into_inner);
    rows.retain(|(a, i, at, _)| !(a == account && i == id) && at.elapsed() < ROW_TTL);
    if rows.len() >= MAX_ROWS {
        rows.pop_front();
    }
    rows.push_back((
        account.to_owned(),
        id.to_owned(),
        Instant::now(),
        row.clone(),
    ));
}

fn recall(account: &str, id: &str) -> Option<Value> {
    ROWS.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .find(|(a, i, at, _)| a == account && i == id && at.elapsed() < ROW_TTL)
        .map(|(.., row)| row.clone())
}

/// Drops the remembered rows of `account` (all of them, or only those of `ids`).
pub(super) fn forget(account: &str, ids: Option<&[String]>) {
    ROWS.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .retain(|(a, i, ..)| a != account || ids.is_some_and(|ids| !ids.contains(i)));
}

pub(super) async fn list(request: &Value) -> Result<Value, &'static str> {
    let map = params::object(
        request,
        &["accountId", "query", "limit", "pageToken", "requestToken"],
    )?;
    let account = params::account(map)?;
    let query = model::parse(params::text(map, "query")?)?;
    let limit = params::bounded(map, "limit", 1, MAX_PAGE as u64)?;
    // Judged before the network is touched: a forged token never reaches a request.
    let cursor = params::optional(map, "pageToken")?
        .filter(|token| !token.is_empty())
        .map(|token| unseal(token, &query))
        .transpose()?;
    let token = params::request_token(map)?;
    guarded(account, token, async {
        let graph = Graph::new(account);
        let roles = graph.roles(false).await?;
        let page = graph.page(&roles, &query, limit, cursor).await?;
        page.rows.iter().for_each(|row| remember(account, row));
        Ok(json!({
            "page": {"ids": page.ids, "nextPageToken": page.next, "estimate": page.estimate},
            "rows": page.rows,
        }))
    })
    .await
}

pub(super) async fn messages(request: &Value) -> Result<Value, &'static str> {
    let map = params::object(request, &["accountId", "ids", "full", "requestToken"])?;
    let account = params::account(map)?;
    let wanted = params::message_ids(map, MAX_MESSAGES)?;
    let full = params::flag(map, "full")?;
    let token = params::request_token(map)?;
    let run = async {
        let graph = Graph::new(account);
        let roles = graph.roles(false).await?;
        let (graph, roles) = (&graph, &roles);
        let results: Vec<Result<Value, &'static str>> = futures_util::stream::iter(wanted)
            .map(move |id| async move {
                if full {
                    full_message(graph, roles, &id).await
                } else {
                    header_row(graph, roles, &id).await
                }
            })
            // Full messages are up to 24 MiB each: two at a time, as parses are.
            .buffered(if full { 2 } else { 4 })
            .collect()
            .await;
        let (mut messages, mut cause, mut left_out) = (Vec::new(), None, false);
        for result in results {
            match result {
                Ok(message) => messages.push(message),
                Err(code) => {
                    left_out = true;
                    if code != NOT_FOUND {
                        cause.get_or_insert(code);
                    }
                }
            }
        }
        // A failure is the answer only when nothing came back and "not found" is not why.
        if let (true, Some(cause)) = (messages.is_empty(), cause) {
            return Err(cause);
        }
        let warning = if left_out {
            json!("partial")
        } else {
            Value::Null
        };
        Ok(json!({"messages": messages, "warning": warning, "continuation": null}))
    };
    if full {
        guarded_read(account, token, run).await
    } else {
        guarded(account, token, run).await
    }
}

async fn header_row(graph: &Graph, roles: &Roles, id: &str) -> Result<Value, &'static str> {
    if let Some(row) = recall(&graph.account, id) {
        return Ok(row);
    }
    let message = graph.header(&ids::decode(id)?).await?;
    let row = model::row(&message, roles)?;
    remember(&graph.account, &row);
    Ok(row)
}

/// The resource of one message: its header properties and its MIME, asked for together, the MIME
/// parsed on a blocking thread behind the gate.
async fn full_message(graph: &Graph, roles: &Roles, id: &str) -> Result<Value, &'static str> {
    let graph_id = ids::decode(id)?;
    let (message, mime) = tokio::try_join!(graph.header(&graph_id), graph.mime(&graph_id))?;
    let size = mime.len();
    let payload = parse(mime).await?;
    Ok(model::full(&message, roles, id.to_owned(), payload, size))
}

async fn parse(mime: Vec<u8>) -> Result<Value, &'static str> {
    let permit = PARSING.acquire().await.map_err(|_| "worker_failed")?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        crate::message::parse_up_to(&mime, MAX_MIME)
    })
    .await
    .map_err(|_| "worker_failed")?
    .map_err(|code| match code {
        "message_too_large" | "too_many_mime_parts" => "m365_message_too_large",
        _ => "m365_invalid_response",
    })
}

/// `m365.read`: only complete messages are read here; header-only rows come from `m365.messages`.
pub(super) async fn read(request: &Value) -> Result<Value, &'static str> {
    let map = params::object(request, &["accountId", "id", "full"])?;
    let account = params::account(map)?;
    let id = params::message_id(map, "id")?;
    if !params::flag(map, "full")? {
        return Err("invalid_params");
    }
    guarded_read(account, None, async {
        let graph = Graph::new(account);
        let roles = graph.roles(false).await?;
        full_message(&graph, &roles, id).await
    })
    .await
}

/// `m365.attachment`: the bytes of one MIME part as `{data}` (unpadded base64url). The message is
/// read again and the part taken from its parse, so the id is the one a resource of that message named.
pub(super) async fn attachment(request: &Value) -> Result<Value, &'static str> {
    let map = params::object(request, &["accountId", "messageId", "attachmentId"])?;
    let account = params::account(map)?;
    let message = ids::decode(params::message_id(map, "messageId")?)?;
    let part = params::attachment_id(map, "attachmentId")?;
    guarded_read(account, None, async {
        let payload = parse(Graph::new(account).mime(&message).await?).await?;
        let mut stack = vec![&payload];
        while let Some(found) = stack.pop() {
            if found["body"]["attachmentId"] == part {
                return Ok(json!({"data": found["body"]["data"]}));
            }
            stack.extend(found["parts"].as_array().into_iter().flatten());
        }
        Err("m365_attachment_not_found")
    })
    .await
}
