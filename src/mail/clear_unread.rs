//! Mark an account's Unread mailbox read, one bounded step per call.
//!
//! A step lists the first page of Unread and marks those messages read through
//! the same planner and mutation `mail.act` uses. It takes no page token: a
//! message marked read leaves the query, so the next step's first page is the
//! next messages. A message the provider refuses stays and is listed again,
//! but the rest of its page still advances; when a step confirms nothing, it
//! reports a stall instead of letting the caller list the same page forever.
//!
//! One step per call keeps every request inside the backend's request
//! timeout however deep the mailbox is, and lets the caller show progress.
//!
//! The step lists IDs only. It marks messages nobody looks at, and a listing
//! that reads each message it returns (Gmail's does) costs a provider read per
//! message: a few steps of that and Gmail rate-limits the account.
use super::action::{ActionLookup, ActionMutation, dry_run_result, execute_action, plan_action};
use super::list::provider_query;
use super::{Account, ActRequest, ClearUnreadRequest, Mailbox};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin};

/// The most `mail.list` returns in one page.
pub(crate) const STEP_SIZE: u16 = 100;

/// The first `limit` IDs a provider query matches, newest first, without
/// reading the messages.
pub(crate) trait UnreadIds: Send + Sync {
    fn unread_ids<'a>(
        &'a self,
        account: &'a Account,
        provider_query: String,
        limit: u16,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, &'static str>> + Send + 'a>>;
}

pub(crate) async fn step(
    request: &ClearUnreadRequest,
    lister: &impl UnreadIds,
    lookup: &impl ActionLookup,
    mutation: &impl ActionMutation,
) -> Result<Value, &'static str> {
    let query = provider_query(&request.account, Mailbox::Unread, "")?;
    let ids = lister
        .unread_ids(&request.account, query, STEP_SIZE)
        .await?;
    if ids.is_empty() {
        return Ok(json!({"done":true,"marked":0,"failed":0}));
    }
    let plan = plan_action(
        &ActRequest {
            account: request.account.clone(),
            operation: "read".into(),
            ids,
            execute: request.execute,
        },
        lookup,
    )
    .await?;
    if !request.execute {
        let mut preview = dry_run_result(&plan);
        preview["done"] = json!(false);
        return Ok(preview);
    }
    let result = execute_action(plan, mutation).await;
    let count = |field: &str| result[field].as_array().map_or(0, Vec::len);
    let marked = count("succeededIds");
    if marked == 0 {
        return Err("mail_clear_unread_stalled");
    }
    Ok(json!({"done":false,"marked":marked,"failed":count("failedIds")}))
}
