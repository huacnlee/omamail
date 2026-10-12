//! `m365.saveDraft` and `m365.deleteDraft`, in the shapes IMAP's take and answer.
//!
//! A draft is saved as Microsoft documents "create a message in MIME format": `POST /me/messages`,
//! `Content-Type: text/plain`, the MIME message as base64; Graph keeps it in Drafts. A save that
//! names the draft it replaces (`draftId`) deletes that one only after the new one exists, and a
//! failure to delete it is a warning on a saved draft, never a failed save. A save whose answer was
//! lost after it was written (the connection, a deadline, a 5xx) may have made a draft nobody knows
//! the id of: it is `m365_draft_unconfirmed`, and it is never repeated.
//!
//! A delete reads the item first and refuses (`m365_not_a_draft`) one that is not a draft, so an id
//! from anywhere else cannot remove a received or sent message; then `DELETE /me/messages/{id}`.

use std::time::Duration;

use serde_json::{Value, json};
use tokio::time::{Instant, timeout};

use super::cancel::{self, guarded};
use super::graph::{Fault, Graph, MESSAGE_TOO_LARGE};
use super::model::Roles;
use super::{ids, params, send};

const NOT_A_DRAFT: &str = "m365_not_a_draft";
const UNCONFIRMED: &str = "m365_draft_unconfirmed";
const CLEANUP: Duration = Duration::from_secs(5);
/// The upload ends this long before the call does, which leaves the old copy's removal a moment.
const GRACE: Duration = Duration::from_secs(1);
const OLD_COPY_KEPT: &str = "The updated draft was saved, but the old copy could not be removed";

/// `m365.saveDraft {accountId, raw, draftId?}` answers `{saved, warning, id}`; `id` is the new draft's,
/// or empty when Graph's answer did not say it. Not cancelled: the save and the old copy's removal
/// answer together inside the call's deadline, below the desktop's wait. The upload's clock grows with
/// the draft's size, and the removal has five seconds or what is left, whichever is less.
pub(super) async fn save(request: &Value) -> Result<Value, &'static str> {
    let map = params::object(request, &["accountId", "raw", "draftId"])?;
    let account = params::account(map)?;
    let mime = send::decode(params::text(map, "raw")?)?;
    let replaced = params::optional(map, "draftId")?
        .filter(|id| !id.is_empty())
        .map(ids::decode)
        .transpose()?;
    let graph = Graph::new(account);
    let limit = cancel::limit(cancel::DEADLINE);
    let end = Instant::now() + limit;
    let id = graph
        .create_draft(&mime, limit.saturating_sub(GRACE))
        .await
        .map_err(save_error)?;
    let mut warning = "";
    if let Some(old) = replaced {
        let removed = async {
            let roles = graph.roles(false).await?;
            remove(&graph, &roles, &old).await
        };
        let left = end.saturating_duration_since(Instant::now()).min(CLEANUP);
        if !matches!(timeout(left, removed).await, Ok(Ok(()))) {
            warning = OLD_COPY_KEPT;
        }
    }
    Ok(json!({"saved": true, "warning": warning, "id": id.unwrap_or_default()}))
}

/// What a failed save proves. A refusal for its size is one whatever the status (as on a send); one
/// that may have reached Graph with no answer that says what came of it (a lost connection or a
/// deadline after it was written, any other 5xx) may have left a draft behind.
fn save_error(fault: Fault) -> &'static str {
    if fault.code == MESSAGE_TOO_LARGE {
        return MESSAGE_TOO_LARGE;
    }
    if fault.sent && (fault.status == 0 || fault.status >= 500) {
        UNCONFIRMED
    } else {
        fault.code
    }
}

/// `m365.deleteDraft {accountId, id}` answers `{}`.
pub(super) async fn delete(request: &Value) -> Result<Value, &'static str> {
    let map = params::object(request, &["accountId", "id"])?;
    let account = params::account(map)?;
    let graph_id = ids::decode(params::message_id(map, "id")?)?;
    guarded(account, None, async {
        let graph = Graph::new(account);
        let roles = graph.roles(false).await?;
        remove(&graph, &roles, &graph_id).await?;
        Ok(json!({}))
    })
    .await
}

async fn remove(graph: &Graph, roles: &Roles, graph_id: &str) -> Result<(), &'static str> {
    if !graph.is_draft(graph_id, roles).await? {
        return Err(NOT_A_DRAFT);
    }
    graph.delete(graph_id).await
}
