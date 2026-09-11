use std::io::{self, BufRead, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, mpsc};

use serde_json::Value;

pub const MAX_FRAME: usize = 1024 * 1024;
pub const MAX_RESPONSE: usize = 32 * 1024 * 1024;
const RESPONSE_CHUNK: usize = 64 * 1024;
static NEXT_TRANSFER: AtomicU64 = AtomicU64::new(1);

/// Bound bytes while reading, before JSON allocation. An oversized frame closes
/// the stream: draining an attacker-controlled unterminated frame could hang forever.
pub fn serve(input: impl BufRead, mut output: impl Write + Send) -> io::Result<()> {
    let output = Mutex::new(&mut output);
    let session = super::Session::default();
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(16);
    let receiver = Mutex::new(receiver);
    std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for _ in 0..4 {
            let receiver = &receiver;
            let output = &output;
            let session = &session;
            workers.push(scope.spawn(move || -> io::Result<()> {
                loop {
                    let frame = receiver.lock().unwrap().recv();
                    let Ok(frame) = frame else {
                        return Ok(());
                    };
                    let (response, _) = super::rpc::handle(&frame, session);
                    if let Some(response) = response {
                        reply(&mut **output.lock().unwrap(), response)?;
                    }
                }
            }));
        }
        let result = read_frames(input, |frame| {
            sender
                .send(frame)
                .map_err(|_| io::Error::other("workers stopped"))
        });
        drop(sender);
        for worker in workers {
            worker
                .join()
                .map_err(|_| io::Error::other("worker failed"))??;
        }
        // EOF, a framing failure or quit drains accepted jobs before responding.
        match result? {
            End::Eof => Ok(()),
            End::Reply(response) => reply(&mut **output.lock().unwrap(), response),
            End::Quit(frame) => {
                if let (Some(response), _) = super::rpc::handle(&frame, &session) {
                    reply(&mut **output.lock().unwrap(), response)?;
                }
                Ok(())
            }
        }
    })
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
