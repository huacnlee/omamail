//! Request-local, allowlisted context for legacy string errors. A scope belongs
//! to one RPC (including uploaded requests), never to a thread or a mailbox.
use serde_json::{Value, json};
use std::{cell::RefCell, future::Future};

tokio::task_local! {
    static FAILURE: RefCell<Option<(&'static str, Value)>>;
}

pub(crate) async fn capture(
    future: impl Future<Output = Result<Value, &'static str>>,
) -> (Result<Value, &'static str>, Option<Value>) {
    FAILURE
        .scope(RefCell::new(None), async {
            let result = future.await;
            let details = FAILURE
                .with(|slot| slot.take())
                .and_then(|(message, data)| {
                    (result.as_ref().err() == Some(&message)).then_some(data)
                });
            (result, details)
        })
        .await
}

pub(super) fn context(provider: &str, operation: &str, stage: &str) -> Value {
    let mut data = json!({});
    for (key, value, allowed) in [
        (
            "provider",
            provider,
            &["google", "microsoft", "caldav", "icloud"][..],
        ),
        (
            "operation",
            operation,
            &[
                "list",
                "get",
                "lookup",
                "instances",
                "create",
                "update",
                "delete",
                "move",
                "import",
                "saveInvitation",
                "attendance",
                "verify",
            ][..],
        ),
        (
            "stage",
            stage,
            &["validation", "authentication", "request", "response"][..],
        ),
    ] {
        if allowed.contains(&value) {
            data[key] = json!(value);
        }
    }
    data
}

pub(crate) fn local(
    params: &Value,
    operation: &str,
    stage: &str,
    message: &'static str,
) -> &'static str {
    record(
        message,
        context(
            params["source"]["kind"].as_str().unwrap_or(""),
            operation,
            stage,
        ),
    )
}

pub(super) fn record(message: &'static str, data: Value) -> &'static str {
    // Direct library callers keep their existing string errors. Only the RPC
    // boundary installs a scope and emits error.data; no global last-error slot.
    let _ = FAILURE.try_with(|slot| *slot.borrow_mut() = Some((message, data)));
    message
}

pub(super) fn reason(provider: &str, bytes: &[u8]) -> Option<&'static str> {
    let body: Value = serde_json::from_slice(bytes).ok()?;
    let value = match provider {
        "google" => body["error"]["errors"][0]["reason"].as_str()?,
        "microsoft" => body["error"]["code"].as_str()?,
        _ => return None,
    };
    // Never retain message, URL, request ID, account, location or arbitrary
    // server strings. Unknown reasons still retain the HTTP status and phase.
    const REASONS: &[&str] = &[
        "badRequest",
        "invalid",
        "invalidParameter",
        "required",
        "authError",
        "forbidden",
        "insufficientPermissions",
        "notFound",
        "duplicate",
        "conditionNotMet",
        "rateLimitExceeded",
        "userRateLimitExceeded",
        "quotaExceeded",
        "dailyLimitExceeded",
        "usageLimits",
        "backendError",
        "internalError",
        "timeRangeEmpty",
        "updatedMinTooLongAgo",
        "fullSyncRequired",
        "forbiddenForNonOrganizer",
        "participantIsNeitherOrganizerNorAttendee",
        "accessNotConfigured",
        "ErrorInvalidRequest",
        "ErrorInvalidProperty",
        "ErrorInvalidIdMalformed",
        "ErrorAccessDenied",
        "InvalidAuthenticationToken",
        "ErrorItemNotFound",
        "ErrorIrresolvableConflict",
        "TooManyRequests",
        "ErrorQuotaExceeded",
        "ErrorInternalServerError",
        "ErrorServiceUnavailable",
    ];
    REASONS.iter().copied().find(|reason| *reason == value)
}

fn field(provider: &str, bytes: &[u8]) -> Option<&'static str> {
    if provider != "google" {
        return None;
    }
    let body: Value = serde_json::from_slice(bytes).ok()?;
    // Some Google errors identify a field in location; others only use a
    // fixed message. Map exact known messages to field names, never log text.
    let location = body["error"]["errors"][0]["location"]
        .as_str()
        .unwrap_or("");
    const FIELDS: &[&str] = &[
        "start",
        "end",
        "start.dateTime",
        "end.dateTime",
        "start.timeZone",
        "end.timeZone",
        "recurrence",
        "iCalUID",
        "calendarId",
        "eventId",
        "timeMin",
        "timeMax",
    ];
    FIELDS
        .iter()
        .copied()
        .find(|field| *field == location)
        .or_else(|| match body["error"]["message"].as_str()? {
            "Invalid time zone definition for start time." => Some("start.timeZone"),
            "Invalid time zone definition for end time." => Some("end.timeZone"),
            "Missing start time." => Some("start"),
            "Missing end time." => Some("end"),
            "Invalid recurrence rule." => Some("recurrence"),
            _ => None,
        })
}

pub(super) async fn http(
    mut response: reqwest::Response,
    mut data: Value,
    message: &'static str,
) -> &'static str {
    data["httpStatus"] = json!(response.status().as_u16());
    // Diagnostics are best effort: a huge, malformed, or stalled error body
    // must not hide the original HTTP failure or extend the request indefinitely.
    let parsed = tokio::time::timeout(std::time::Duration::from_secs(1), async {
        const LIMIT: usize = 16 * 1024;
        if response.content_length().is_some_and(|n| n > LIMIT as u64) {
            return None;
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.ok()? {
            if chunk.len() > LIMIT - bytes.len() {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        let provider = data["provider"].as_str().unwrap_or("");
        Some((reason(provider, &bytes), field(provider, &bytes)))
    })
    .await
    .ok()
    .flatten();
    if let Some((reason, field)) = parsed {
        if let Some(reason) = reason {
            data["reason"] = json!(reason);
        }
        if let Some(field) = field {
            data["field"] = json!(field);
        }
    }
    record(message, data)
}

#[cfg(test)]
mod tests;
