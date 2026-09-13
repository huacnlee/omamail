//! Read-only normalization for mail actions. Execution deliberately lives in a
//! later layer so an API or CLI preview cannot mutate a mailbox by accident.
use super::types::opaque_id;
use super::{Account, ActRequest};
use serde_json::{Value, json};
use std::{collections::HashSet, future::Future, pin::Pin};

const MAX_TARGETS: usize = 2_000;

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct ActionPlan {
    pub account: Account,
    pub operation: String,
    pub requested_ids: Vec<String>,
    pub target_ids: Vec<String>,
    pub add_label_ids: Vec<String>,
    pub remove_label_ids: Vec<String>,
}

/// Supplies only bounded, read-only action context. Implementations must not
/// call provider mutation adapters or change cache/account/outbox state.
pub(crate) trait ActionLookup: Send + Sync {
    fn refusals(&self, account: &Account) -> Result<Value, &'static str>;

    fn rows<'a>(
        &'a self,
        account: &'a Account,
        ids: &'a [String],
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Value>, &'static str>> + Send + 'a>>;
}

pub(crate) fn domain_action(operation: &str) -> Result<&'static str, &'static str> {
    crate::account::model::domain_action(operation)
}

fn label_ids(change: &Value, name: &str) -> Result<Vec<String>, &'static str> {
    change[name]
        .as_array()
        .ok_or("mail_action_invalid_change")?
        .iter()
        .map(|label| {
            label
                .as_str()
                .filter(|label| !label.is_empty() && !label.chars().any(char::is_control))
                .map(str::to_owned)
                .ok_or("mail_action_invalid_change")
        })
        .collect()
}

fn requested_ids(ids: &[String]) -> Result<(), &'static str> {
    if ids.is_empty() || ids.len() > 1_000 {
        return Err("invalid_params");
    }
    for id in ids {
        opaque_id(id)?;
    }
    Ok(())
}

fn row_for<'a>(rows: &'a [Value], id: &str) -> Result<&'a Value, &'static str> {
    rows.iter()
        .find(|row| row["id"].as_str() == Some(id))
        .ok_or("mail_action_target_unknown")
}

fn append_targets(
    row: &Value,
    action: &str,
    targets: &mut Vec<String>,
    seen: &mut HashSet<String>,
) -> Result<(), &'static str> {
    let expanded = crate::account::model::action_targets(row, action);
    for target in expanded.as_array().ok_or("mail_action_invalid_target")? {
        let target = target.as_str().ok_or("mail_action_invalid_target")?;
        opaque_id(target).map_err(|_| "mail_action_invalid_target")?;
        if seen.insert(target.to_owned()) {
            if targets.len() == MAX_TARGETS {
                return Err("mail_action_target_limit");
            }
            targets.push(target.to_owned());
        }
    }
    Ok(())
}

pub(crate) async fn plan_action(
    request: &ActRequest,
    lookup: &impl ActionLookup,
) -> Result<ActionPlan, &'static str> {
    if request.execute {
        return Err("mail_action_execute_unsupported");
    }
    requested_ids(&request.ids)?;
    let action = domain_action(&request.operation)?;
    let refusals = lookup.refusals(&request.account)?;
    let capability = crate::account::model::capability(action);
    if !capability.is_empty()
        && !crate::providers::can(request.account.provider.id(), capability, &refusals)
    {
        return Err("mail_action_unavailable");
    }
    if let Some(mailbox) = crate::account::model::action_mailbox(action)
        && crate::providers::domain::query_mailbox(request.account.provider.id(), mailbox).is_none()
    {
        return Err("mail_mailbox_unavailable");
    }
    let change = crate::account::model::action_changes(action);
    let add_label_ids = label_ids(&change, "add")?;
    let remove_label_ids = label_ids(&change, "remove")?;
    let rows = lookup.rows(&request.account, &request.ids).await?;
    let mut target_ids = Vec::new();
    let mut seen = HashSet::new();
    for id in &request.ids {
        append_targets(row_for(&rows, id)?, action, &mut target_ids, &mut seen)?;
    }
    if target_ids.is_empty() {
        return Err("mail_action_target_unknown");
    }
    Ok(ActionPlan {
        account: request.account.clone(),
        operation: request.operation.clone(),
        requested_ids: request.ids.clone(),
        target_ids,
        add_label_ids,
        remove_label_ids,
    })
}

pub(crate) fn dry_run_result(plan: &ActionPlan) -> Value {
    json!({
        "dryRun":true,
        "executed":false,
        "operation":plan.operation,
        "accountId":plan.account.id,
        "requestedIds":plan.requested_ids,
        "targetIds":plan.target_ids,
    })
}

pub(crate) async fn dry_run(
    request: &ActRequest,
    lookup: &impl ActionLookup,
) -> Result<Value, &'static str> {
    let plan = plan_action(request, lookup).await?;
    Ok(dry_run_result(&plan))
}
