//! Normalize once, then preview or consume that exact plan for execution.
use super::types::opaque_id;
use super::{Account, ActRequest, Provider};
use serde_json::{Value, json};
use std::{collections::HashSet, future::Future, pin::Pin};

const MAX_TARGETS: usize = 2_000;
type LookupFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, &'static str>> + Send + 'a>>;

#[derive(Debug, Eq, PartialEq)]
pub(crate) struct ActionPlan {
    pub account: Account,
    pub operation: String,
    pub requested_ids: Vec<String>,
    pub target_ids: Vec<String>,
    pub add_label_ids: Vec<String>,
    pub remove_label_ids: Vec<String>,
    /// Opaque provider facts reviewed by the planner, such as destination IDs.
    pub provider_context: Value,
}

#[derive(Clone, Debug)]
pub(crate) struct ActionAvailability {
    pub refusals: Value,
    /// Canonical destination names whose live account state permits planning.
    pub mailboxes: Value,
    /// A provider action may be direct (for example HEY spam) rather than a
    /// move to a listable mailbox. Missing entries retain mailbox semantics.
    pub mailbox_required: Value,
    /// Opaque, freshly-read provider context for the matching `rows` lookup.
    pub rows_context: Value,
}

/// Supplies only bounded, read-only action context. Implementations must not
/// call provider mutation adapters or change cache/account/outbox state.
pub(crate) trait ActionLookup: Send + Sync {
    fn availability<'a>(
        &'a self,
        account: &'a Account,
        operation: &'a str,
    ) -> LookupFuture<'a, ActionAvailability>;

    fn rows<'a>(
        &'a self,
        account: &'a Account,
        ids: &'a [String],
        availability: &'a ActionAvailability,
        operation: &'a str,
    ) -> LookupFuture<'a, Vec<Value>>;
}

/// Returns only confirmed successful IDs. Unknown outcomes are failures for
/// reporting purposes; they must never trigger an automatic retry.
pub(crate) trait ActionMutation: Send + Sync {
    fn execute<'a>(
        &'a self,
        plan: &'a ActionPlan,
    ) -> Pin<Box<dyn Future<Output = Vec<String>> + Send + 'a>>;
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

/// Validation only: retain the exact opaque spelling used in the request and
/// provider acknowledgements. Reuse the same pure parsers as native execution.
pub(crate) fn validate_message_id(provider: Provider, id: &str) -> Result<(), &'static str> {
    opaque_id(id)?;
    match provider {
        Provider::Gmail => crate::providers::gmail::validate_message_id(id),
        Provider::Jmap => crate::providers::jmap::validate_action_id(id),
        Provider::Hey => crate::providers::hey_actions::message_id(id).map(|_| ()),
        Provider::Imap | Provider::Outlook => crate::providers::imap::message_id(id).map(|_| ()),
    }
    .map_err(|_| "invalid_params")
}

fn requested_ids(provider: Provider, ids: &[String]) -> Result<Vec<String>, &'static str> {
    if ids.is_empty() || ids.len() > 1_000 {
        return Err("invalid_params");
    }
    for id in ids {
        validate_message_id(provider, id)?;
    }
    let mut unique = Vec::with_capacity(ids.len());
    let mut seen = HashSet::new();
    for id in ids {
        if seen.insert(id.as_str()) {
            unique.push(id.to_owned());
        }
    }
    Ok(unique)
}

fn row_for<'a>(rows: &'a [Value], id: &str) -> Result<&'a Value, &'static str> {
    rows.iter()
        .find(|row| row["id"].as_str() == Some(id))
        .ok_or("mail_action_target_unknown")
}

fn append_targets(
    provider: Provider,
    row: &Value,
    action: &str,
    targets: &mut Vec<String>,
    seen: &mut HashSet<String>,
) -> Result<(), &'static str> {
    let expanded = crate::account::model::action_targets_checked(row, action)?;
    for target in &expanded {
        validate_message_id(provider, target).map_err(|_| "mail_action_invalid_target")?;
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
    let unique_requested = requested_ids(request.account.provider, &request.ids)?;
    let action = domain_action(&request.operation)?;
    let availability = lookup
        .availability(&request.account, &request.operation)
        .await?;
    let capability = crate::account::model::capability(action);
    if !capability.is_empty()
        && !crate::providers::can(
            request.account.provider.id(),
            capability,
            &availability.refusals,
        )
    {
        return Err("mail_action_unavailable");
    }
    if let Some(mailbox) = crate::account::model::action_mailbox(action)
        && availability.mailbox_required[&request.operation] != false
        && !availability.mailboxes[mailbox].as_bool().unwrap_or(false)
    {
        return Err("mail_action_destination_unavailable");
    }
    let change = crate::account::model::action_changes(action);
    let add_label_ids = label_ids(&change, "add")?;
    let remove_label_ids = label_ids(&change, "remove")?;
    let rows = lookup
        .rows(
            &request.account,
            &unique_requested,
            &availability,
            &request.operation,
        )
        .await?;
    let mut target_ids = Vec::new();
    let mut seen = HashSet::new();
    for id in &unique_requested {
        append_targets(
            request.account.provider,
            row_for(&rows, id)?,
            action,
            &mut target_ids,
            &mut seen,
        )?;
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
        provider_context: availability.rows_context,
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

#[cfg(test)]
pub(crate) async fn dry_run(
    request: &ActRequest,
    lookup: &impl ActionLookup,
) -> Result<Value, &'static str> {
    let plan = plan_action(request, lookup).await?;
    Ok(dry_run_result(&plan))
}

pub(crate) async fn execute_action(plan: ActionPlan, mutation: &impl ActionMutation) -> Value {
    let confirmed = mutation.execute(&plan).await;
    let (succeeded, failed): (Vec<_>, Vec<_>) = plan
        .target_ids
        .iter()
        .partition(|id| confirmed.contains(id));
    json!({
        "dryRun":false,"executed":true,"operation":plan.operation,"accountId":plan.account.id,
        "requestedIds":plan.requested_ids,"targetIds":plan.target_ids,
        "succeededIds":succeeded,"failedIds":failed,
    })
}

pub(crate) async fn act(
    request: &ActRequest,
    lookup: &impl ActionLookup,
    mutation: &impl ActionMutation,
) -> Result<Value, &'static str> {
    let plan = plan_action(request, lookup).await?;
    if request.execute {
        Ok(execute_action(plan, mutation).await)
    } else {
        Ok(dry_run_result(&plan))
    }
}
