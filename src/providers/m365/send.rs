//! `m365.send` and `m365.sendAs`.
//!
//! The message goes out as Microsoft documents "send a message in MIME format": `POST /me/sendMail`,
//! `Content-Type: text/plain`, the whole MIME message as base64, answered `202 Accepted`; Graph files
//! the copy in Sent Items itself. A Bcc header travels inside the MIME as composed. Microsoft's page
//! says nothing about Bcc in MIME; on one work tenant it was observed (not documented) that the blind
//! recipient got the message and the To recipient's copy had no Bcc header and did not name them.
//!
//! What a failure proves (the outbox treats the first three as "definitely refused", the rest as
//! "unknown: check Sent"): `m365_send_not_attempted` is nothing written (the account, the token, the
//! connection, a certificate) or a 401 or 429, which Microsoft sends instead of acting;
//! `m365_send_rejected` is Microsoft's own refusal (400, 403, 404, ...); `m365_message_too_large` is a
//! message over the ceiling, refused before any I/O, or one Microsoft refused for its size (a 413 or
//! `ErrorMessageSizeExceeded`); `m365_send_failed` is everything else (a lost connection or a deadline
//! after the request went out, a 5xx), and the message is never repeated.
//!
//! The upload's clock grows with the message (`Graph::upload_clock`) up to what the caller waits: a
//! call from the desktop answers inside its 30 seconds (`cancel::DEADLINE`), the outbox, which waits
//! a minute for a delivery and its draft's removal, gives it `QUEUED`.

use std::time::Duration;

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};

use super::cancel::{self, guarded_for};
use super::graph::{Fault, Graph, MESSAGE_TOO_LARGE};
use super::params;

const NOT_ATTEMPTED: &str = "m365_send_not_attempted";
const REJECTED: &str = "m365_send_rejected";
const FAILED: &str = "m365_send_failed";
const TOO_LARGE: &str = MESSAGE_TOO_LARGE;
/// The outbox's wait for one delivery is a minute, five seconds of which remove the draft after it.
const QUEUED: Duration = Duration::from_secs(50);
/// The upload ends this long before its call does: a clock that ran out before the request was
/// written then says so, where the call's own deadline could not.
const GRACE: Duration = Duration::from_secs(1);

/// The message bytes of a `raw` member, which must be exactly what `URL_SAFE_NO_PAD` would write: no
/// padding, whitespace, other alphabet or stray trailing bits.
pub(super) fn decode(raw: &str) -> Result<Vec<u8>, &'static str> {
    let max = crate::message::MAX_MESSAGE;
    if raw.len() > max.div_ceil(3) * 4 {
        return Err(TOO_LARGE);
    }
    let bytes = URL_SAFE_NO_PAD.decode(raw).map_err(|_| "invalid_params")?;
    if bytes.is_empty() || URL_SAFE_NO_PAD.encode(&bytes) != raw {
        return Err("invalid_params");
    }
    if bytes.len() > max {
        return Err(TOO_LARGE);
    }
    Ok(bytes)
}

pub(super) fn classify(fault: Fault) -> &'static str {
    if fault.code == TOO_LARGE || fault.status == 413 {
        return TOO_LARGE;
    }
    match (fault.status, fault.sent) {
        (0, false) => NOT_ATTEMPTED,
        (0, true) => FAILED,
        (400 | 403 | 404 | 405 | 409 | 415 | 422, _) => REJECTED,
        (401 | 429, _) => NOT_ATTEMPTED,
        _ => FAILED,
    }
}

/// `m365.send`, asked by the desktop.
pub(super) async fn send(request: &Value) -> Result<Value, &'static str> {
    deliver(request, cancel::DEADLINE).await
}

/// `m365.send` for the outbox, which waits longer for a delivery than the desktop does.
pub(crate) async fn send_queued(request: &Value) -> Result<Value, &'static str> {
    deliver(request, QUEUED).await
}

async fn deliver(request: &Value, wait: Duration) -> Result<Value, &'static str> {
    let map = params::object(request, &["accountId", "raw"])?;
    let account = params::account(map)?;
    let mime = decode(params::text(map, "raw")?)?;
    let graph = Graph::new(account);
    let limit = cancel::limit(wait);
    let sent = guarded_for(account, limit, async {
        let budget = limit.saturating_sub(GRACE);
        Ok(graph.send_mail(&mime, budget).await.map_err(classify))
    })
    .await;
    match sent {
        Ok(Ok(())) => Ok(json!({"sent": true, "warning": ""})),
        Ok(Err(code)) => Err(code),
        // The guard's own deadline fired: the request may have gone out.
        Err(_) => Err(FAILED),
    }
}

/// `m365.sendAs`: the mailbox's own address, the only identity there is; no network, no credential.
pub(super) fn send_as(request: &Value) -> Result<Value, &'static str> {
    let map = params::object(request, &["accountId"])?;
    let account = params::account(map)?;
    Ok(json!([{
        "email": account.strip_prefix("m365:").unwrap_or(account),
        "displayName": "",
        "isPrimary": true,
        "isDefault": true,
    }]))
}
