//! Microsoft 365 connection diagnostics. Provider payloads and credentials
//! stay inside Rust; the public result is deliberately capability booleans.

use serde_json::{Value, json};
use std::{future::Future, time::Duration};

async fn within_graph_deadline<F>(future: F, deadline: Duration) -> (bool, bool)
where
    F: Future<Output = (bool, bool)>,
{
    tokio::time::timeout(deadline, future)
        .await
        .unwrap_or((false, false))
}

fn account_id(params: &Value) -> Result<&str, &'static str> {
    let fields = params.as_object().ok_or("invalid_params")?;
    if fields.len() != 1 || fields.keys().any(|key| key != "accountId") {
        return Err("invalid_params");
    }
    let account = fields
        .get("accountId")
        .and_then(Value::as_str)
        .filter(|value| value.starts_with("outlook:") && value.len() <= 1024)
        .ok_or("invalid_params")?;
    if account.chars().any(char::is_control) {
        return Err("invalid_params");
    }
    Ok(account)
}

pub async fn connection_check(params: &Value) -> Result<Value, &'static str> {
    let account = account_id(params)?.to_owned();
    let settings_account = account.clone();
    let configured = tokio::task::spawn_blocking(move || {
        crate::auth::settings("outlook", &settings_account).is_ok()
    })
    .await
    .map_err(|_| "worker_failed")?;
    if !configured {
        return Ok(json!({"mail":false,"graph":false,"calendar":false}));
    }
    // Each provider state machine is large enough to overflow the backend
    // worker's stack when nested in one combined future. Separate Tokio tasks
    // keep their state on the heap and let the independent probes overlap.
    let mail_account = account.clone();
    let mail = tokio::spawn(async move {
        crate::providers::imap::call("imap.check", &json!({"accountId":mail_account}))
            .await
            .is_ok()
    });
    let graph_account = account.clone();
    let graph_and_calendar = tokio::spawn(async move {
        // The frontend expires ordinary RPCs after 30 seconds. Bound the
        // entire Graph chain, including token-lock and keyring waits, rather
        // than only the final HTTP request.
        within_graph_deadline(
            async move {
                let Ok(token) = crate::auth::access_token("outlook", &graph_account, "graph").await
                else {
                    return (false, false);
                };
                let request = json!({
                    "source": {
                        "id": "microsoft-connection-check",
                        "kind": "microsoft",
                        "accountId": graph_account
                    },
                    "operation": "list",
                    "start": "2000-01-01T00:00:00.000Z",
                    "end": "2000-01-01T00:00:01.000Z"
                });
                let calendar = crate::calendar::call(&request, Some(&token)).await.is_ok();
                (true, calendar)
            },
            Duration::from_secs(27),
        )
        .await
    });
    let (mail, graph_and_calendar) = tokio::join!(mail, graph_and_calendar);
    let mail = mail.unwrap_or(false);
    let (graph, calendar) = graph_and_calendar.unwrap_or((false, false));
    Ok(json!({"mail":mail,"graph":graph,"calendar":calendar}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_check_accepts_only_one_outlook_account_id() {
        assert_eq!(
            account_id(&json!({"accountId":"outlook:person@example.org"})),
            Ok("outlook:person@example.org")
        );
        for value in [
            json!({}),
            json!({"accountId":"imap:person@example.org"}),
            json!({"accountId":"outlook:person@example.org","extra":true}),
            json!({"accountId":17}),
        ] {
            assert_eq!(account_id(&value), Err("invalid_params"));
        }
    }

    #[tokio::test]
    async fn graph_deadline_covers_the_entire_probe() {
        let started = std::time::Instant::now();
        let result = within_graph_deadline(
            std::future::pending::<(bool, bool)>(),
            Duration::from_millis(20),
        )
        .await;
        assert_eq!(result, (false, false));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
