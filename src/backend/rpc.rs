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

pub fn handle(frame: &[u8], session: &super::Session) -> (Option<Value>, bool) {
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
            let (response, end) = one(request.get(), session);
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
    one(raw.get(), session)
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

fn one(raw: &str, session: &super::Session) -> (Option<Value>, bool) {
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
    let result = session.dispatch(&request.method, &request.params);
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
