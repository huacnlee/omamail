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
use super::action::{ActionLookup, ActionMutation, dry_run_result, execute_action, plan_action};
use super::list::{ListAdapter, list_with};
use super::{ActRequest, ClearUnreadRequest, ListRequest, Mailbox};
use serde_json::{Value, json};

/// The most `mail.list` returns in one page.
pub(crate) const STEP_SIZE: u16 = 100;

pub(crate) async fn step(
    request: &ClearUnreadRequest,
    list: &impl ListAdapter,
    lookup: &impl ActionLookup,
    mutation: &impl ActionMutation,
) -> Result<Value, &'static str> {
    let page = list_with(
        ListRequest {
            account: request.account.clone(),
            mailbox: Mailbox::Unread,
            query: String::new(),
            limit: STEP_SIZE,
            page_token: String::new(),
        },
        list,
    )
    .await?;
    let ids = page["messages"]
        .as_array()
        .ok_or("mail_list_incomplete")?
        .iter()
        .map(|message| {
            message["id"]
                .as_str()
                .map(str::to_owned)
                .ok_or("mail_list_incomplete")
        })
        .collect::<Result<Vec<_>, _>>()?;
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
