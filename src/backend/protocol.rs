use futures_util::{StreamExt, stream::FuturesUnordered};
use std::io::{self, BufRead, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{Notify, mpsc};

use serde_json::Value;

pub const MAX_FRAME: usize = 1024 * 1024;
pub const MAX_RESPONSE: usize = 64 * 1024 * 1024;
const RESPONSE_CHUNK: usize = 64 * 1024;
static NEXT_TRANSFER: AtomicU64 = AtomicU64::new(1);

const MAX_IN_FLIGHT: usize = 32;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);

/// Wakes the dispatcher independently of request capacity or output pressure.
#[derive(Default)]
pub(super) struct Cancellation {
    flag: AtomicBool,
    notify: Notify,
}

impl Cancellation {
    pub(super) fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.flag.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}

struct Frame {
    bytes: Vec<u8>,
    deadline: tokio::time::Instant,
}

/// Pipes retain dedicated blocking readers/writers; networking runs as bounded
/// async futures, so a slow request does not occupy a network worker thread.
pub fn serve(input: impl BufRead, mut output: impl Write + Send) -> io::Result<()> {
    serve_with_cancel(input, &mut output, Arc::new(Cancellation::default()))
}

pub(super) fn serve_with_cancel(
    input: impl BufRead,
    mut output: impl Write + Send,
    cancel_pending: Arc<Cancellation>,
) -> io::Result<()> {
    let runtime = super::runtime()?;
    let session = super::Session::default();
    let (sender, receiver) = mpsc::channel::<Frame>(16);
    let (responses, mut completed) = mpsc::channel::<Value>(2);
    let end = std::thread::scope(|scope| -> io::Result<End> {
        let writer = scope.spawn(|| -> io::Result<()> {
            while let Some(value) = completed.blocking_recv() {
                reply(&mut output, value)?;
            }
            Ok(())
        });
        let dispatcher = scope.spawn(|| {
            runtime.block_on(process_frames(
                receiver,
                responses,
                &session,
                cancel_pending.clone(),
            ))
        });
        let result = read_frames(input, |bytes| {
            sender
                .blocking_send(Frame {
                    bytes,
                    deadline: tokio::time::Instant::now() + REQUEST_TIMEOUT,
                })
                .map_err(|_| io::Error::other("dispatcher stopped"))
        });
        // An input error means the peer can no longer receive responses (the
        // stdio layer reports a closed output pipe as a BrokenPipe read error),
        // so accepted work is cancelled instead of drained: a drained export
        // could commit a file the client can never read. A clean EOF or a quit
        // drains.
        if result.is_err() {
            cancel_pending.cancel();
        }
        drop(sender);
        let dispatched = dispatcher
            .join()
            .map_err(|_| io::Error::other("dispatcher failed"))?;
        let written = writer
            .join()
            .map_err(|_| io::Error::other("writer failed"))?;
        dispatched?;
        written?;
        result
    })?;
    // Quit is a barrier: drain every accepted frame and write its response first.
    match end {
        End::Eof => Ok(()),
        End::Reply(response) => reply(&mut output, response),
        End::Quit(frame) => {
            let deadline = tokio::time::Instant::now() + REQUEST_TIMEOUT;
            if let (Some(response), _) =
                runtime.block_on(super::rpc::handle(&frame, &session, deadline))
            {
                reply(&mut output, response)?;
            }
            Ok(())
        }
    }
}

async fn process_frames(
    receiver: mpsc::Receiver<Frame>,
    responses: mpsc::Sender<Value>,
    session: &super::Session,
    cancel_pending: Arc<Cancellation>,
) -> io::Result<()> {
    // Subscribe before accepting frames: the initial watch check may finish
    // before its RPC response, but its notification must still reach the writer.
    let mut notifications = session.mail.subscribe();
    let mut outbox_notifications = session.outbox.subscribe();
    let mut gmail_notifications = session.gmail.subscribe();
    let dispatch = async {
        let scheduler = schedule(
            receiver,
            responses.clone(),
            cancel_pending.clone(),
            |frame| async move {
                super::rpc::handle(&frame.bytes, session, frame.deadline)
                    .await
                    .0
            },
        );
        tokio::pin!(scheduler);
        loop {
            tokio::select! {
                result = &mut scheduler => break result,
                event = outbox_notifications.recv() => {
                    if let Ok(event) = event
                        && responses.send(event).await.is_err() {
                        break Err(io::Error::other("output closed"));
                    }
                }
                event = gmail_notifications.recv() => {
                    if let Ok(event) = event
                        && responses.send(event).await.is_err() {
                        break Err(io::Error::other("output closed"));
                    }
                }
                event = notifications.recv() => {
                    if let Ok(event) = event
                        && session.mail.is_current(&event)
                        && responses.send(event.value).await.is_err() {
                        break Err(io::Error::other("output closed"));
                    }
                }
            }
        }
    };
    let result = tokio::select! {
        biased;
        _ = cancel_pending.cancelled() => Ok(()),
        result = dispatch => result,
    };
    // No watch can write after the accepted requests drain or after quit.
    session.mail.shutdown().await;
    session.gmail.shutdown();
    let outbox_result = session.outbox.shutdown().await;
    let cache_result = session.queries.shutdown().await;
    outbox_result.map_err(io::Error::other)?;
    cache_result.map_err(io::Error::other)?;
    result
}

async fn schedule<F, Fut>(
    receiver: mpsc::Receiver<Frame>,
    responses: mpsc::Sender<Value>,
    cancel_pending: Arc<Cancellation>,
    handle: F,
) -> io::Result<()>
where
    F: Fn(Frame) -> Fut,
    Fut: std::future::Future<Output = Option<Value>>,
{
    tokio::select! {
        biased;
        _ = cancel_pending.cancelled() => Ok(()),
        result = drain(receiver, responses, handle) => result,
    }
}

async fn drain<F, Fut>(
    mut receiver: mpsc::Receiver<Frame>,
    responses: mpsc::Sender<Value>,
    handle: F,
) -> io::Result<()>
where
    F: Fn(Frame) -> Fut,
    Fut: std::future::Future<Output = Option<Value>>,
{
    let mut pending = FuturesUnordered::new();
    let mut closed = false;
    loop {
        tokio::select! {
            frame = receiver.recv(), if !closed && pending.len() < MAX_IN_FLIGHT => {
                match frame {
                    Some(frame) => pending.push(handle(frame)),
                    None => closed = true,
                }
            }
            response = pending.next(), if !pending.is_empty() => {
                if let Some(Some(value)) = response {
                    responses.send(value).await.map_err(|_| io::Error::other("output closed"))?;
                }
            }
            else => return Ok(()),
        }
    }
}

enum End {
    Eof,
    Reply(Value),
    Quit(Vec<u8>),
}

fn read_frames(
    mut input: impl BufRead,
    mut submit: impl FnMut(Vec<u8>) -> io::Result<()>,
) -> io::Result<End> {
    loop {
        let mut frame = Vec::new();
        loop {
            let chunk = input.fill_buf()?;
            if chunk.is_empty() {
                if frame.is_empty() {
                    return Ok(End::Eof);
                }
                return Ok(End::Reply(super::rpc::error(
                    Value::Null,
                    -32700,
                    "Truncated frame",
                )));
            }
            let count = chunk
                .iter()
                .position(|b| *b == b'\n')
                .map_or(chunk.len(), |n| n + 1);
            if frame.len() + count > MAX_FRAME {
                return Ok(End::Reply(super::rpc::error(
                    Value::Null,
                    -32001,
                    "Frame too large",
                )));
            }
            let complete = chunk[count - 1] == b'\n';
            frame.extend_from_slice(&chunk[..count]);
            input.consume(count);
            if complete {
                break;
            }
        }
        if super::rpc::requests_quit(&frame) {
            return Ok(End::Quit(frame));
        }
        submit(frame)?;
    }
}

fn reply(output: &mut impl Write, value: Value) -> io::Result<()> {
    // Refuse before writing any partial response. The serializer itself is
    // bounded; building a huge temporary JSON string would defeat the ceiling.
    let mut encoded = BoundedResponse(Vec::new());
    if serde_json::to_writer(&mut encoded, &value).is_err() {
        let refused = |item: &Value| {
            super::rpc::error(
                item.get("id").cloned().unwrap_or(Value::Null),
                -32001,
                "Response too large",
            )
        };
        let error = match &value {
            Value::Array(items) => Value::Array(items.iter().map(refused).collect()),
            _ => refused(&value),
        };
        return reply(output, error);
    }
    if encoded.0.len() < MAX_FRAME {
        output.write_all(&encoded.0)?;
        output.write_all(b"\n")?;
    } else {
        let text = std::str::from_utf8(&encoded.0)
            .map_err(|_| io::Error::other("invalid response encoding"))?;
        let mut chunks = Vec::new();
        let mut rest = text;
        while !rest.is_empty() {
            let mut end = rest.len().min(RESPONSE_CHUNK);
            while !rest.is_char_boundary(end) {
                end -= 1;
            }
            chunks.push(&rest[..end]);
            rest = &rest[end..];
        }
        let transfer = NEXT_TRANSFER.fetch_add(1, Ordering::Relaxed).to_string();
        let size = text.encode_utf16().count();
        for (index, data) in chunks.iter().enumerate() {
            // At most six output bytes per data byte after JSON escaping,
            // plus a small fixed envelope, well below MAX_FRAME.
            serde_json::to_writer(
                &mut *output,
                &serde_json::json!({
                    "jsonrpc":"2.0", "method":"transport.chunk",
                    "params":{"transfer":transfer, "index":index,
                        "total":chunks.len(), "size":size, "data":data}
                }),
            )?;
            output.write_all(b"\n")?;
        }
    }
    output.flush()
}

struct BoundedResponse(Vec<u8>);

impl Write for BoundedResponse {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_RESPONSE - self.0.len() {
            return Err(io::Error::other("response too large"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn small_response_stays_standard_json_rpc() {
        let value = json!({"jsonrpc":"2.0","id":"one","result":"ok"});
        let mut output = Vec::new();
        reply(&mut output, value.clone()).unwrap();
        assert_eq!(output.iter().filter(|b| **b == b'\n').count(), 1);
        assert_eq!(serde_json::from_slice::<Value>(&output).unwrap(), value);
    }

    #[test]
    fn large_response_roundtrips_unicode_escaping_and_batches() {
        let value = json!([
            {"jsonrpc":"2.0","id":"large","result":"📨\n\"\\\u{0000}مرحبا".repeat(100_000)},
            {"jsonrpc":"2.0","id":2,"result":true}
        ]);
        let mut output = Vec::new();
        reply(&mut output, value.clone()).unwrap();
        let lines: Vec<_> = output
            .split(|b| *b == b'\n')
            .filter(|l| !l.is_empty())
            .collect();
        assert!(lines.len() > 1);
        let mut reconstructed = String::new();
        let mut transfer = None;
        for (index, line) in lines.iter().enumerate() {
            assert!(line.len() < MAX_FRAME);
            let frame: Value = serde_json::from_slice(line).unwrap();
            assert_eq!(frame["method"], "transport.chunk");
            assert!(frame.get("id").is_none());
            let params = &frame["params"];
            assert_eq!(params["index"], index);
            assert_eq!(params["total"], lines.len());
            if let Some(ref transfer) = transfer {
                assert_eq!(transfer, &params["transfer"]);
            } else {
                transfer = Some(params["transfer"].clone());
            }
            reconstructed.push_str(params["data"].as_str().unwrap());
            if index + 1 == lines.len() {
                assert_eq!(params["size"], reconstructed.encode_utf16().count());
            }
        }
        assert_eq!(
            serde_json::from_str::<Value>(&reconstructed).unwrap(),
            value
        );
    }

    #[test]
    fn response_above_thirty_two_mebibytes_reaches_client_budget() {
        let value =
            json!({"jsonrpc":"2.0","id":"large-valid","result":"x".repeat(33 * 1024 * 1024)});
        let mut output = Vec::new();
        reply(&mut output, value).unwrap();
        let mut size = 0;
        let mut total = 0;
        for line in output
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
        {
            let frame: Value = serde_json::from_slice(line).unwrap();
            assert_eq!(frame["method"], "transport.chunk");
            size += frame["params"]["data"].as_str().unwrap().len();
            total += 1;
            assert!(frame["params"]["total"].as_u64().unwrap() <= 1025);
        }
        assert!(size > 32 * 1024 * 1024);
        assert!(total > 512);
    }

    #[test]
    fn maximum_unicode_response_fits_extended_chunk_count() {
        let value =
            json!({"jsonrpc":"2.0","id":"unicode","result":"€".repeat((MAX_RESPONSE-100)/3)});
        let mut output = Vec::new();
        reply(&mut output, value).unwrap();
        let mut count = 0;
        let mut bytes = 0;
        let mut units = 0;
        for line in output
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
        {
            assert!(line.len() < MAX_FRAME);
            let frame: Value = serde_json::from_slice(line).unwrap();
            assert_eq!(frame["method"], "transport.chunk");
            let p = &frame["params"];
            assert_eq!(p["index"], count);
            assert_eq!(p["total"], 1025);
            let data = p["data"].as_str().unwrap();
            assert!(data.len() <= RESPONSE_CHUNK);
            bytes += data.len();
            units += data.encode_utf16().count();
            count += 1;
            if count == 1025 {
                assert_eq!(p["size"], units);
            }
        }
        assert_eq!(count, 1025);
        assert!(bytes <= MAX_RESPONSE);
        assert!(bytes > MAX_RESPONSE - 200);
    }

    #[test]
    fn over_limit_response_emits_only_correlated_errors() {
        let value = json!([
            {"jsonrpc":"2.0","id":"large","result":"x".repeat(MAX_RESPONSE)},
            {"jsonrpc":"2.0","id":2,"result":true}
        ]);
        let mut output = Vec::new();
        reply(&mut output, value).unwrap();
        let response: Value = serde_json::from_slice(&output).unwrap();
        assert_eq!(response[0]["id"], "large");
        assert_eq!(response[1]["id"], 2);
        assert_eq!(response[0]["error"]["message"], "Response too large");
        assert_eq!(response[1]["error"]["code"], -32001);
        assert!(output.len() < 512);
    }
}

#[cfg(test)]
mod scheduling_tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize},
    };
    use tokio::sync::Semaphore;

    #[tokio::test]
    async fn watch_notifications_share_response_writer_and_eof_stops_tasks() {
        let gate = Arc::new(Semaphore::new(0));
        let mail = crate::sync::Sync::for_test(Arc::new({
            let gate = gate.clone();
            move |_, _| {
                let gate = gate.clone();
                Box::pin(async move {
                    gate.acquire().await.unwrap().forget();
                    Ok(serde_json::json!({"estimate":2,"messages":[]}))
                })
            }
        }));
        let session = super::super::Session {
            mail,
            ..Default::default()
        };
        session.mail.watch_for_test("one").await;
        let (sender, receiver) = mpsc::channel(2);
        let (responses, mut output) = mpsc::channel(2);
        let dispatcher = process_frames(
            receiver,
            responses,
            &session,
            Arc::new(Cancellation::default()),
        );
        let client = async {
            sender
                .send(Frame {
                    bytes: br#"{"jsonrpc":"2.0","id":1,"method":"system.info","params":{}}"#
                        .to_vec(),
                    deadline: tokio::time::Instant::now() + REQUEST_TIMEOUT,
                })
                .await
                .unwrap();
            let reply = output.recv().await.unwrap();
            assert_eq!(reply["id"], 1);
            gate.add_permits(1);
            let notification = tokio::time::timeout(Duration::from_secs(2), output.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(notification["method"], "mail.updated");
            assert_eq!(notification["params"]["estimate"], 2);
            drop(sender);
            assert!(
                output.recv().await.is_none(),
                "EOF must close the shared writer"
            );
        };
        let (result, ()) = tokio::join!(dispatcher, client);
        result.unwrap();
        assert_eq!(
            session
                .mail
                .call("mail.snapshot", &serde_json::json!({"accountId":"one"}))
                .await,
            Err("mail_watch_unknown")
        );
    }

    #[tokio::test]
    async fn slow_requests_overlap_and_fast_reply_overtakes_them() {
        let (sender, receiver) = mpsc::channel(32);
        let (responses, mut output) = mpsc::channel(32);
        let gate = Arc::new(Semaphore::new(0));
        for id in 0..8 {
            sender
                .send(Frame {
                    bytes: vec![id],
                    deadline: tokio::time::Instant::now(),
                })
                .await
                .unwrap();
        }
        drop(sender);
        let started = Arc::new(AtomicUsize::new(0));
        let task = tokio::spawn({
            let gate = gate.clone();
            let started = started.clone();
            schedule(
                receiver,
                responses,
                Arc::new(Cancellation::default()),
                move |frame| {
                    let gate = gate.clone();
                    let started = started.clone();
                    async move {
                        started.fetch_add(1, Ordering::SeqCst);
                        if frame.bytes[0] != 7 {
                            gate.acquire().await.unwrap().forget();
                        }
                        Some(Value::from(frame.bytes[0]))
                    }
                },
            )
        });
        let first = tokio::time::timeout(Duration::from_secs(2), output.recv())
            .await
            .unwrap();
        assert_eq!(first, Some(Value::from(7)));
        assert_eq!(started.load(Ordering::SeqCst), 8);
        gate.add_permits(7);
        task.await.unwrap().unwrap();
        let mut remaining = Vec::new();
        while let Some(value) = output.recv().await {
            remaining.push(value.as_u64().unwrap());
        }
        remaining.sort();
        assert_eq!(remaining, (0..7).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn concurrency_is_bounded_and_eof_drains_every_request() {
        let (sender, receiver) = mpsc::channel(64);
        let (responses, mut output) = mpsc::channel(64);
        let gate = Arc::new(Semaphore::new(0));
        let (entered, mut entries) = mpsc::unbounded_channel();
        for id in 0..33 {
            sender
                .send(Frame {
                    bytes: vec![id],
                    deadline: tokio::time::Instant::now(),
                })
                .await
                .unwrap();
        }
        drop(sender);
        let task = tokio::spawn({
            let gate = gate.clone();
            schedule(
                receiver,
                responses,
                Arc::new(Cancellation::default()),
                move |frame| {
                    let gate = gate.clone();
                    let entered = entered.clone();
                    async move {
                        entered.send(()).unwrap();
                        gate.acquire().await.unwrap().forget();
                        Some(Value::from(frame.bytes[0]))
                    }
                },
            )
        });
        for _ in 0..MAX_IN_FLIGHT {
            tokio::time::timeout(Duration::from_secs(2), entries.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(30), entries.recv())
                .await
                .is_err()
        );
        gate.add_permits(33);
        task.await.unwrap().unwrap();
        let mut count = 0;
        while output.recv().await.is_some() {
            count += 1;
        }
        assert_eq!(count, 33);
    }

    #[tokio::test]
    async fn disconnect_cancels_a_full_request_window() {
        let (sender, receiver) = mpsc::channel(MAX_IN_FLIGHT);
        let (responses, mut output) = mpsc::channel(MAX_IN_FLIGHT);
        let cancel_pending = Arc::new(Cancellation::default());
        let (started, mut entries) = mpsc::unbounded_channel();
        let dropped = Arc::new(AtomicUsize::new(0));
        let mut task = tokio::spawn({
            let dropped = dropped.clone();
            schedule(receiver, responses, cancel_pending.clone(), move |_frame| {
                struct Marker(Arc<AtomicUsize>);
                impl Drop for Marker {
                    fn drop(&mut self) {
                        self.0.fetch_add(1, Ordering::SeqCst);
                    }
                }
                let marker = Marker(dropped.clone());
                let started = started.clone();
                async move {
                    let _marker = marker;
                    started.send(()).unwrap();
                    std::future::pending::<Option<Value>>().await
                }
            })
        });
        for _ in 0..MAX_IN_FLIGHT {
            sender
                .send(Frame {
                    bytes: vec![1],
                    deadline: tokio::time::Instant::now() + REQUEST_TIMEOUT,
                })
                .await
                .unwrap();
        }
        for _ in 0..MAX_IN_FLIGHT {
            entries.recv().await.unwrap();
        }
        cancel_pending.cancel();
        drop(sender);
        let result = tokio::time::timeout(Duration::from_millis(200), &mut task).await;
        if result.is_err() {
            task.abort();
        }
        result
            .expect("disconnect must cancel even with every request slot occupied")
            .unwrap()
            .unwrap();
        assert_eq!(dropped.load(Ordering::SeqCst), MAX_IN_FLIGHT);
        assert!(output.recv().await.is_none());
    }

    #[tokio::test]
    async fn disconnect_cancels_while_response_queue_is_full() {
        let (sender, receiver) = mpsc::channel(2);
        let (responses, mut output) = mpsc::channel(1);
        let cancel_pending = Arc::new(Cancellation::default());
        let (finished, mut entries) = mpsc::unbounded_channel();
        let mut task = tokio::spawn(schedule(
            receiver,
            responses,
            cancel_pending.clone(),
            move |_frame| {
                let finished = finished.clone();
                async move {
                    finished.send(()).unwrap();
                    Some(Value::Null)
                }
            },
        ));
        for _ in 0..2 {
            sender
                .send(Frame {
                    bytes: vec![1],
                    deadline: tokio::time::Instant::now() + REQUEST_TIMEOUT,
                })
                .await
                .unwrap();
            entries.recv().await.unwrap();
        }
        cancel_pending.cancel();
        drop(sender);
        let result = tokio::time::timeout(Duration::from_millis(200), &mut task).await;
        if result.is_err() {
            task.abort();
        }
        result
            .expect("disconnect must interrupt blocked response delivery")
            .unwrap()
            .unwrap();
        assert_eq!(output.recv().await, Some(Value::Null));
        assert!(output.recv().await.is_none());
    }

    #[tokio::test]
    async fn disconnect_cancels_accepted_work_instead_of_draining_it() {
        let (sender, receiver) = mpsc::channel(16);
        let (responses, mut output) = mpsc::channel(16);
        let dropped = Arc::new(AtomicBool::new(false));
        sender
            .send(Frame {
                bytes: vec![1],
                deadline: tokio::time::Instant::now() + REQUEST_TIMEOUT,
            })
            .await
            .unwrap();
        let cancel_pending = Arc::new(Cancellation::default());
        let (started, mut entries) = mpsc::unbounded_channel();
        let task = tokio::spawn({
            let dropped = dropped.clone();
            schedule(receiver, responses, cancel_pending.clone(), move |_frame| {
                struct Marker(Arc<AtomicBool>);
                impl Drop for Marker {
                    fn drop(&mut self) {
                        self.0.store(true, Ordering::SeqCst);
                    }
                }
                // Created in the closure and moved into the future, so it is
                // dropped whenever the future is dropped -- even before first
                // poll.
                let marker = Marker(dropped.clone());
                let started = started.clone();
                async move {
                    let _marker = marker;
                    started.send(()).unwrap();
                    std::future::pending::<Option<Value>>().await
                }
            })
        });
        entries.recv().await.unwrap();
        cancel_pending.cancel();
        drop(sender);
        task.await.unwrap().unwrap();
        assert!(
            dropped.load(Ordering::SeqCst),
            "accepted work must be dropped, not drained, on disconnect"
        );
        assert!(
            output.recv().await.is_none(),
            "no response may be written after a disconnect"
        );
    }
}
