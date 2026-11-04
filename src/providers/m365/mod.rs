//! Microsoft 365 mail over Microsoft Graph: the `m365.*` RPC surface. Read
//! [the provider notes](../../../docs/providers/m365.md) before changing it.

mod actions;
mod cancel;
mod drafts;
mod graph;
mod ids;
mod mailbox;
mod model;
mod params;
mod read;
mod send;
mod signin;
mod verify;

#[cfg(test)]
mod tests;

use serde_json::Value;

pub(crate) use actions::planned_action_availability;
pub(crate) use send::send_queued;
pub(crate) use verify::check;

/// Dispatches every `m365.*` method. Each handler's future is boxed: they are large, and the backend's
/// workers have small stacks (see `backend::Session::dispatch`).
pub async fn call(method: &str, params: &Value) -> Result<Value, &'static str> {
    match method {
        "m365.signInBegin" => Box::pin(signin::begin(params)).await,
        "m365.signInPoll" => Box::pin(signin::poll(params)).await,
        "m365.signOut" => Box::pin(signin::sign_out(params)).await,
        "m365.verify" => Box::pin(verify::verify(params)).await,
        "m365.list" => Box::pin(read::list(params)).await,
        "m365.messages" => Box::pin(read::messages(params)).await,
        "m365.read" => Box::pin(read::read(params)).await,
        "m365.attachment" => Box::pin(read::attachment(params)).await,
        "m365.modify" | "m365.trash" | "m365.untrash" => {
            Box::pin(actions::run(method, params)).await
        }
        "m365.send" => Box::pin(send::send(params)).await,
        "m365.saveDraft" => Box::pin(drafts::save(params)).await,
        "m365.deleteDraft" => Box::pin(drafts::delete(params)).await,
        "m365.sendAs" => send::send_as(params),
        "m365.invalidate" => invalidate(params).await,
        "m365.cancel" => {
            let map = params::object(params, &["accountId", "requestToken"])?;
            let token = params::request_token(map)?.ok_or("invalid_params")?;
            Ok(cancel::cancel(params::account(map)?, token))
        }
        _ => Err("method_not_found"),
    }
}

/// `m365.invalidate {accountId}`: forgets the tokens and what was remembered of the mailbox. The
/// keyring is not touched. The tokens are forgotten under the refresh lane, waited for at most
/// `signin::LANE_WAIT`.
async fn invalidate(params: &Value) -> Result<Value, &'static str> {
    let map = params::object(params, &["accountId"])?;
    let account = params::account(map)?;
    mailbox::forget(account);
    read::forget(account, None);
    signin::within_lane_wait(crate::auth::invalidate(account)).await?;
    Ok(serde_json::json!({"invalidated": true}))
}

/// Validates a message id before any lookup or mutation.
pub(crate) fn validate_message_id(id: &str) -> Result<(), &'static str> {
    ids::validate_message_id(id)
}

/// An Omamail message id for a Graph id, for tests of code that takes ids.
#[cfg(test)]
pub(crate) fn encode_id_for_test(graph_id: &str) -> String {
    ids::encode(graph_id).unwrap()
}
