//! Mark every unread message in an account's Inbox read, one bounded step per
//! call.
//!
//! A step lists the first page of the Inbox's unread messages and marks them
//! read through the same planner and mutation `mail.act` uses. It takes no page
//! token: a message marked read leaves the query, so the next step's first page
//! is the next messages. A message the provider refuses stays and is listed again,
//! but the rest of its page still advances; when a step confirms nothing, it
//! reports a stall instead of letting the caller list the same page forever.
//!
//! One step per call keeps every request inside the backend's request
//! timeout however deep the mailbox is, and lets the caller show progress.
//!
//! A step needs IDs only. Gmail's listing reads every message it returns, and
//! 100 reads per step make Gmail rate-limit the account within a few steps, so
//! the Gmail lister asks for the bare listing. The other providers list as they
//! always do and the step keeps the IDs.
use super::action::{ActionLookup, ActionMutation, dry_run_result, execute_action, plan_action};
use super::list::provider_query;
use super::{Account, ActRequest, ClearUnreadRequest, Mailbox, Provider};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin};

/// Messages per step: one provider page, far below the 1,000 IDs an action plan takes.
pub(crate) const STEP_SIZE: u16 = 100;

/// The first `limit` IDs a provider query matches, newest first.
pub(crate) trait UnreadIds: Send + Sync {
    fn unread_ids<'a>(
        &'a self,
        account: &'a Account,
        provider_query: String,
        limit: u16,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>, &'static str>> + Send + 'a>>;
}

/// Every unread message in the Inbox. Gmail's Unread mailbox leaves the noisy
/// categories out, so Gmail gets the Inbox with `is:unread`; every other
/// provider's Unread mailbox already is the Inbox's unread messages.
fn inbox_unread_query(account: &Account) -> Result<String, &'static str> {
    if account.provider == Provider::Gmail {
        Ok(format!(
            "{} is:unread",
            provider_query(account, Mailbox::Inbox, "")?
        ))
    } else {
        provider_query(account, Mailbox::Unread, "")
    }
}

pub(crate) async fn step(
    request: &ClearUnreadRequest,
    lister: &impl UnreadIds,
    lookup: &impl ActionLookup,
    mutation: &impl ActionMutation,
) -> Result<Value, &'static str> {
    let query = inbox_unread_query(&request.account)?;
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
