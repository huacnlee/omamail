//! A bounded SSE parser and reconnect loop, independent of QML's lifetime/timers.
use super::*;
const MAX_EVENT: usize = 65536;

#[derive(Default)]
pub(super) struct Parser {
    block: Vec<u8>,
    line: Vec<u8>,
    cr: bool,
}
impl Parser {
    pub(super) fn push(&mut self, byte: u8) -> Result<Option<String>, &'static str> {
        if byte == b'\n' && self.cr {
            self.cr = false;
            return Ok(None);
        }
        self.cr = byte == b'\r';
        if byte == b'\r' || byte == b'\n' {
            if self.line.is_empty() {
                let bytes = std::mem::take(&mut self.block);
                return String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|_| "jmap_invalid_event");
            }
            self.block.append(&mut self.line);
            self.block.push(b'\n');
        } else {
            self.line.push(byte);
        }
        if self.block.len() + self.line.len() > MAX_EVENT {
            return Err("jmap_event_too_large");
        }
        Ok(None)
    }
}
pub(super) async fn run(client: Client, request: Request, sender: mpsc::Sender<Value>) {
    run_scoped(client, request, sender, None).await;
}
pub(super) async fn run_scoped(
    client: Client,
    request: Request,
    sender: mpsc::Sender<Value>,
    scope: Option<(String, std::sync::Arc<mailbox::Context>)>,
) {
    let mut failures = 0u32;
    loop {
        if let Some((_, context)) = &scope
            && mailbox::active(context).is_err()
        {
            return;
        }
        let started = tokio::time::Instant::now();
        let mut state = ConnectionState {
            heard: false,
            ping_seconds: 30,
        };
        let result = connection(&client, request.clone(), &sender, &mut state, &scope).await;
        if matches!(result, Err("jmap_unauthorized")) {
            if let Some((_, context)) = &scope {
                context
                    .rejected
                    .store(true, std::sync::atomic::Ordering::Release);
            }
            let _ = sender.send(json!({"kind":"rejected"})).await;
            return;
        }
        if sender.is_closed() {
            return;
        }
        if result == Err("jmap_resumed") {
            failures = 0;
            tokio::task::yield_now().await;
            continue;
        }
        let settled = state.heard && started.elapsed() >= Duration::from_secs(state.ping_seconds);
        let (delay, next) = retry_delay(settled, result.is_ok(), failures);
        failures = next;
        tokio::select! { _ = tokio::time::sleep(Duration::from_secs(delay)) => {}, _ = sender.closed() => return }
    }
}
struct ConnectionState {
    heard: bool,
    ping_seconds: u64,
}
fn retry_delay(settled: bool, clean: bool, failures: u32) -> (u64, u32) {
    if settled && clean {
        return (0, 0);
    }
    let failures = if settled { 0 } else { failures };
    (
        (1u64 << failures.min(9)).min(300),
        failures.saturating_add(1),
    )
}
async fn connection(
    client: &Client,
    request: Request,
    sender: &mpsc::Sender<Value>,
    state: &mut ConnectionState,
    scope: &Option<(String, std::sync::Arc<mailbox::Context>)>,
) -> Result<(), &'static str> {
    let mut response = tokio::time::timeout(Duration::from_secs(20), build(client, request).send())
        .await
        .map_err(|_| "jmap_timeout")?
        .map_err(network_error)?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("jmap_unauthorized");
    }
    if !response.status().is_success() {
        return Err("jmap_network_failed");
    }
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_none_or(|v| {
            !v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("text/event-stream")
        })
    {
        return Err("jmap_invalid_event");
    }
    sender
        .send(json!({"kind":"connected"}))
        .await
        .map_err(|_| "jmap_stream_closed")?;
    let mut parser = Parser::default();
    let mut ping_seconds = 30;
    let mut next_event = tokio::time::Instant::now() + Duration::from_secs(60);
    let mut resume_clock = tokio::time::interval(Duration::from_secs(30));
    let mut last_wall = std::time::SystemTime::now();
    loop {
        let chunk = tokio::select! {
            result=tokio::time::timeout_at(next_event,response.chunk())=>result.map_err(|_|"jmap_timeout")?.map_err(network_error)?,
            _=resume_clock.tick()=>{
                if let Some((_,context))=scope {mailbox::active(context)?;}
                let now=std::time::SystemTime::now();
                if now.duration_since(last_wall).is_ok_and(|elapsed|elapsed>Duration::from_secs(60)){return Err("jmap_resumed");}
                last_wall=now;
                continue;
            }
        };
        let Some(chunk) = chunk else {
            return Ok(());
        };
        for byte in chunk {
            if let Some(block) = parser.push(byte)? {
                if block.is_empty() {
                    continue;
                }
                state.heard = true;
                if let Some(seconds) = ping_interval(&block) {
                    ping_seconds = seconds;
                }
                state.ping_seconds = ping_seconds;
                next_event = tokio::time::Instant::now() + Duration::from_secs(ping_seconds * 2);
                let event = if let Some((account, context)) = scope {
                    let known = context.known.lock().map_err(|_| "session_failed")?;
                    change_plan(&block, account, &known)
                        .map(|plan| json!({"kind":"change","plan":plan}))
                } else {
                    Some(json!({"kind":"event","block":block}))
                };
                if let Some(event) = event {
                    sender.send(event).await.map_err(|_| "jmap_stream_closed")?;
                }
            }
        }
    }
}
fn change_plan(
    block: &str,
    account: &str,
    known: &serde_json::Map<String, Value>,
) -> Option<Value> {
    let mut event = "";
    let mut data = String::new();
    for line in block.lines() {
        if let Some(v) = line.strip_prefix("event:") {
            event = v.strip_prefix(' ').unwrap_or(v);
        }
        if let Some(v) = line.strip_prefix("data:") {
            data.push_str(v.strip_prefix(' ').unwrap_or(v));
            data.push('\n');
        }
    }
    if event != "state" {
        return None;
    }
    let value: Value = serde_json::from_str(&data).ok()?;
    let changes = value["changed"][account].as_object()?;
    let changed = |kind: &str| {
        changes
            .get(kind)
            .and_then(Value::as_str)
            .is_some_and(|state| {
                !state.trim().is_empty()
                    && known.get(kind).and_then(Value::as_str) != Some(state.trim())
            })
    };
    let mail = changed("Email");
    let boxes = changed("Mailbox");
    (mail || boxes).then(|| json!({"mail":mail,"mailboxes":boxes}))
}
fn ping_interval(block: &str) -> Option<u64> {
    let mut event = "";
    let mut data = String::new();
    for line in block.lines() {
        if let Some(value) = line.strip_prefix("event:") {
            event = value.trim();
        }
        if let Some(value) = line.strip_prefix("data:") {
            data.push_str(value.trim_start());
            data.push('\n');
        }
    }
    if event != "ping" {
        return None;
    }
    let value: Value = serde_json::from_str(&data).ok()?;
    value
        .get("interval")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0)
        .map(|v| v.min(3600))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_events_ignore_other_accounts_and_own_write_echoes() {
        let block =
            "event: state\ndata: {\"changed\":{\"a\":{\"Email\":\"e1\",\"Mailbox\":\"m2\"}}}\n";
        let known = serde_json::from_value(json!({"Email":"e1","Mailbox":"m1"})).unwrap();
        assert_eq!(
            change_plan(block, "a", &known),
            Some(json!({"mail":false,"mailboxes":true}))
        );
        assert_eq!(change_plan(block, "other", &known), None);
        let echoed = serde_json::from_value(json!({"Email":"e1","Mailbox":"m2"})).unwrap();
        assert_eq!(change_plan(block, "a", &echoed), None);
    }
    #[test]
    fn transient_closes_back_off_but_settled_clean_stream_reconnects_immediately() {
        let (delay, failures) = retry_delay(false, true, 0);
        assert_eq!((delay, failures), (1, 1));
        assert_eq!(retry_delay(false, true, failures), (2, 2));
        assert_eq!(retry_delay(true, true, 8), (0, 0));
        assert_eq!(retry_delay(true, false, 8), (1, 1));
        assert_eq!(retry_delay(false, false, 10), (300, 11));
    }
}
