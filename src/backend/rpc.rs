use serde::{Deserialize, Deserializer};
use serde_json::{Value, json, value::RawValue};

#[derive(Default)]
enum Id {
    #[default]
    Missing,
    Present(Value),
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Value::deserialize(d).map(Self::Present)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    jsonrpc: String,
    #[serde(default)]
    id: Id,
    method: String,
    #[serde(default = "empty_params")]
    params: Value,
}

fn empty_params() -> Value {
    json!({})
}

pub fn error(id: Value, code: i32, message: &str) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "error":{"code":code,"message":message}})
}

pub async fn handle(
    frame: &[u8],
    session: &super::Session,
    deadline: tokio::time::Instant,
) -> (Option<Value>, bool) {
    let raw: Box<RawValue> = match serde_json::from_slice(frame) {
        Ok(raw) => raw,
        Err(_) => return (Some(error(Value::Null, -32700, "Parse error")), false),
    };
    if raw.get().starts_with('[') {
        let batch: Vec<Box<RawValue>> = serde_json::from_str(raw.get()).unwrap();
        if batch.is_empty() || batch.len() > 128 {
            return (Some(error(Value::Null, -32600, "Invalid Request")), false);
        }
        let mut responses = Vec::new();
        let mut quit = false;
        for request in batch {
            let (response, end) = one(request.get(), session, deadline).await;
            quit |= end;
            if let Some(response) = response {
                responses.push(response);
            }
        }
        return (
            (!responses.is_empty()).then_some(Value::Array(responses)),
            quit,
        );
    }
    one(raw.get(), session, deadline).await
}

// Detect the control barrier without executing any domain operation. Batch
// shutdown drains earlier frames, then completes its entire batch before exit.
pub fn requests_quit(frame: &[u8]) -> bool {
    let Ok(raw) = serde_json::from_slice::<Box<RawValue>>(frame) else {
        return false;
    };
    fn is_quit(raw: &str) -> bool {
        serde_json::from_str::<Request>(raw).is_ok_and(|request| {
            request.jsonrpc == "2.0"
                && request.method == "system.quit"
                && request.params == json!({})
                && matches!(
                    request.id,
                    Id::Missing | Id::Present(Value::Null | Value::String(_) | Value::Number(_))
                )
        })
    }
    if raw.get().starts_with('[') {
        let Ok(batch) = serde_json::from_str::<Vec<Box<RawValue>>>(raw.get()) else {
            return false;
        };
        batch.len() <= 128 && batch.iter().any(|item| is_quit(item.get()))
    } else {
        is_quit(raw.get())
    }
}

async fn one(
    raw: &str,
    session: &super::Session,
    deadline: tokio::time::Instant,
) -> (Option<Value>, bool) {
    let request: Request = match serde_json::from_str(raw) {
        Ok(request) => request,
        Err(_) => return (Some(error(Value::Null, -32600, "Invalid Request")), false),
    };
    if request.jsonrpc != "2.0"
        || !matches!(
            &request.id,
            Id::Missing | Id::Present(Value::Null | Value::String(_) | Value::Number(_))
        )
    {
        return (Some(error(Value::Null, -32600, "Invalid Request")), false);
    }
    // An expired queued request must not start a side effect: timeout_at polls
    // its future before checking the clock.
    let result = if tokio::time::Instant::now() >= deadline {
        Err("request_timed_out")
    } else if request.method.starts_with("gmail.")
        || (request.method == "request.upload"
            && request.params["method"]
                .as_str()
                .is_some_and(|method| method.starts_with("gmail.")))
    {
        tokio::time::timeout_at(deadline, session.dispatch(&request.method, &request.params))
            .await
            .unwrap_or(Err("request_timed_out"))
    } else {
        // Legacy process operations have their own deadlines. Dropping a
        // spawn_blocking join cannot cancel a running send; await it so quit
        // remains a completion barrier and never reports a false cancellation.
        session.dispatch(&request.method, &request.params).await
    };
    let quit = request.method == "system.quit" && result.is_ok();
    let Id::Present(id) = request.id else {
        return (None, quit);
    };
    let response = match result {
        Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
        Err("unknown_method") => error(id, -32601, "Method not found"),
        Err("invalid_params") => error(id, -32602, "Invalid params"),
        Err(code) => error(id, -32000, code),
    };
    (Some(response), quit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn expired_upload_request_does_not_reserve_capacity() {
        let session = crate::backend::Session::default();
        let frame = br#"{"jsonrpc":"2.0","id":1,"method":"upload.begin","params":{"size":0}}"#;
        let deadline = tokio::time::Instant::now() - Duration::from_secs(1);
        let (response, quit) = handle(frame, &session, deadline).await;
        assert!(!quit);
        assert_eq!(response.unwrap()["error"]["message"], "request_timed_out");
        // An expired call must leave every upload slot available, not merely
        // return a timeout after executing the immediate upload future.
        for _ in 0..8 {
            assert!(
                session
                    .dispatch("upload.begin", &json!({"size":0}))
                    .await
                    .is_ok()
            );
        }
        assert_eq!(
            session.dispatch("upload.begin", &json!({"size":0})).await,
            Err("upload_capacity_exceeded")
        );
    }

    #[tokio::test]
    async fn uploaded_gmail_deadline_includes_waiting_for_decode_capacity() {
        let session = crate::backend::Session::default();
        let upload = session
            .dispatch("upload.begin", &json!({"size":2}))
            .await
            .unwrap()["upload"]
            .clone();
        session
            .dispatch(
                "upload.append",
                &json!({"upload":upload,"offset":0,"data":"e30"}),
            )
            .await
            .unwrap();
        // Occupy both decode permits. The uploaded request must expire while
        // waiting, before consuming its bytes or starting provider work.
        let permits = session.upload_jobs.acquire_many(2).await.unwrap();
        let frame = serde_json::to_vec(&json!({"jsonrpc":"2.0","id":"bounded",
            "method":"request.upload","params":{"method":"gmail.send","upload":upload}}))
        .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(20);
        let response =
            tokio::time::timeout(Duration::from_secs(1), handle(&frame, &session, deadline)).await;
        drop(permits);
        let (response, quit) = response.expect("uploaded Gmail request ignored its RPC deadline");
        assert!(!quit);
        let response = response.unwrap();
        assert_eq!(response["id"], "bounded");
        assert_eq!(response["error"]["message"], "request_timed_out");
        assert_eq!(
            session
                .dispatch("upload.discard", &json!({"upload":upload}))
                .await
                .unwrap(),
            json!({"discarded":true}),
            "timed-out queued work must not consume the upload"
        );
    }

    #[test]
    fn blocking_dispatch_is_awaited_after_rpc_deadline() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (release, released) = std::sync::mpsc::channel();
            let (entered, started) = tokio::sync::oneshot::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                entered.send(()).unwrap();
                released.recv().unwrap();
            });
            started.await.unwrap();
            let session = crate::backend::Session::default();
            // Unknown methods use the same blocking dispatch path as the HEY
            // process adapter, without invoking a real provider or changing PATH.
            let frame = br#"{"jsonrpc":"2.0","id":1,"method":"unknown"}"#;
            let deadline = tokio::time::Instant::now() + Duration::from_millis(20);
            let request = handle(frame, &session, deadline);
            tokio::pin!(request);
            let early = tokio::select! {
                biased;
                response = &mut request => Some(response),
                _ = tokio::time::sleep(Duration::from_millis(60)) => None,
            };
            // Always release the thread before asserting so a regression does
            // not hang Runtime::drop with an unfinished blocking operation.
            release.send(()).unwrap();
            blocker.await.unwrap();
            assert!(early.is_none(), "RPC detached a queued blocking operation");
            let (response, quit) = request.await;
            assert!(!quit);
            assert_eq!(response.unwrap()["error"]["code"], -32601);
        });
    }
}
