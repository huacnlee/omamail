//! The wire format of `omamail serve`: newline-delimited JSON-RPC 2.0, with
//! large responses split into `transport.chunk` notifications and large
//! requests sent through `upload.*`. Pure functions, so they are tested
//! without a process. The rules mirror `docs/BACKEND.md` and
//! `src/backend/protocol.rs`.

use serde_json::{Value, json};

/// A frame, newline included, may not exceed this many bytes.
pub const MAX_FRAME: usize = 1024 * 1024;
/// A chunked response never has more chunks than this.
pub const MAX_CHUNKS: u32 = 1025;
/// Nor more UTF-16 code units than this.
pub const MAX_RESPONSE_UNITS: u64 = 64 * 1024 * 1024;
/// Parameters longer than this many characters go through `upload.*`
/// (the QML client's threshold, `ui/backend/Upload.js`).
pub const UPLOAD_THRESHOLD: usize = 200_000;
/// The protocol this client speaks (`protocolVersion` of `backend-api.json`).
pub const PROTOCOL_VERSION: u64 = 1;

/// A request frame for `method`, newline included.
pub fn request(id: &str, method: &str, params: &Value) -> String {
    let mut line =
        json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string();
    line.push('\n');
    line
}

/// An error the backend answered, or one this client made.
#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}

/// What one line from the backend means.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// The answer to request `id`.
    Response {
        id: String,
        result: Result<Value, RpcError>,
    },
    /// A notification the backend pushed (`mail.updated`, `transport.chunk`, ...).
    Notification { method: String, params: Value },
    /// A line that is neither: logged and dropped.
    Invalid,
}

/// Reads one line (without its newline) or one reassembled response.
pub fn parse(line: &str) -> Vec<Incoming> {
    match serde_json::from_str::<Value>(line) {
        Ok(Value::Array(batch)) => batch.into_iter().map(classify).collect(),
        Ok(value) => vec![classify(value)],
        Err(_) => vec![Incoming::Invalid],
    }
}

fn classify(value: Value) -> Incoming {
    if value["jsonrpc"] != "2.0" {
        return Incoming::Invalid;
    }
    if let Some(method) = value["method"].as_str() {
        if value.get("id").is_none() {
            return Incoming::Notification {
                method: method.to_owned(),
                params: value["params"].clone(),
            };
        }
        return Incoming::Invalid;
    }
    let id = match &value["id"] {
        Value::String(id) => id.clone(),
        _ => return Incoming::Invalid,
    };
    if let Some(error) = value.get("error") {
        let code = error["code"].as_i64().unwrap_or(-32603);
        let message = error["message"]
            .as_str()
            .unwrap_or("backend_error")
            .to_owned();
        return Incoming::Response {
            id,
            result: Err(RpcError::new(code, message)),
        };
    }
    match value.get("result") {
        Some(result) => Incoming::Response {
            id,
            result: Ok(result.clone()),
        },
        None => Incoming::Invalid,
    }
}

/// Reassembles one `transport.chunk` transfer at a time. Chunks must arrive
/// in order with the same `transfer`, `total` and `size`; anything else
/// drops the partial transfer, as the QML client does.
#[derive(Debug, Default)]
pub struct Chunks {
    current: Option<Transfer>,
}

#[derive(Debug)]
struct Transfer {
    id: String,
    total: u32,
    size: u64,
    next: u32,
    data: String,
}

/// What a chunk did.
#[derive(Debug, PartialEq)]
pub enum ChunkStep {
    /// More chunks are expected.
    Pending,
    /// The whole response, to parse with [`parse`].
    Complete(String),
    /// The chunk broke the rules; the partial transfer is gone.
    Rejected(&'static str),
}

impl Chunks {
    /// Takes the `params` of one `transport.chunk` notification.
    pub fn push(&mut self, params: &Value) -> ChunkStep {
        let (Some(id), Some(index), Some(total), Some(size), Some(data)) = (
            params["transfer"].as_str(),
            params["index"].as_u64(),
            params["total"].as_u64(),
            params["size"].as_u64(),
            params["data"].as_str(),
        ) else {
            self.current = None;
            return ChunkStep::Rejected("chunk_invalid");
        };
        if total == 0 || total > u64::from(MAX_CHUNKS) || size > MAX_RESPONSE_UNITS {
            self.current = None;
            return ChunkStep::Rejected("chunk_limits");
        }
        let total = total as u32;
        if index == 0 {
            self.current = Some(Transfer {
                id: id.to_owned(),
                total,
                size,
                next: 0,
                data: String::new(),
            });
        }
        let Some(transfer) = self.current.as_mut() else {
            return ChunkStep::Rejected("chunk_out_of_order");
        };
        if transfer.id != id
            || transfer.total != total
            || transfer.size != size
            || u64::from(transfer.next) != index
        {
            self.current = None;
            return ChunkStep::Rejected("chunk_out_of_order");
        }
        transfer.data.push_str(data);
        transfer.next += 1;
        let units = transfer.data.encode_utf16().count() as u64;
        if units > size {
            self.current = None;
            return ChunkStep::Rejected("chunk_too_large");
        }
        if transfer.next < transfer.total {
            return ChunkStep::Pending;
        }
        let transfer = self.current.take().expect("a transfer in progress");
        if units != transfer.size {
            return ChunkStep::Rejected("chunk_size_mismatch");
        }
        ChunkStep::Complete(transfer.data)
    }

    /// Drops a partial transfer (a disconnect, the assembly deadline).
    pub fn reset(&mut self) {
        self.current = None;
    }

    pub fn in_progress(&self) -> bool {
        self.current.is_some()
    }
}

/// The base64url (no padding) pieces of `bytes` for `upload.append`, each
/// at most `chunk` bytes before encoding.
pub fn upload_pieces(bytes: &[u8], chunk: usize) -> Vec<(usize, String)> {
    let chunk = chunk.max(1);
    bytes
        .chunks(chunk)
        .enumerate()
        .map(|(i, piece)| (i * chunk, base64url(piece)))
        .collect()
}

fn base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for group in bytes.chunks(3) {
        let n = (u32::from(group[0]) << 16)
            | (u32::from(*group.get(1).unwrap_or(&0)) << 8)
            | u32::from(*group.get(2).unwrap_or(&0));
        let chars = group.len() + 1;
        for i in 0..chars {
            out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// The versions this build of the UI was made for, from the repository's
/// `backend-version` and `backend-api.json`.
#[derive(Debug, Clone, PartialEq)]
pub struct Pins {
    pub version: String,
    pub api_version: u64,
    pub latest_api_version: u64,
    pub unreleased: Vec<String>,
}

impl Pins {
    /// The pins compiled into this build.
    pub fn compiled() -> Self {
        let api: Value =
            serde_json::from_str(include_str!("../../../backend-api.json")).unwrap_or(Value::Null);
        Self {
            version: include_str!("../../../backend-version").trim().to_owned(),
            api_version: api["releasedApiVersion"].as_u64().unwrap_or(0),
            latest_api_version: api["apiVersion"].as_u64().unwrap_or(0),
            unreleased: api["unreleased"]["methods"]
                .as_array()
                .or_else(|| api["unreleased"].as_array())
                .map(|m| {
                    m.iter()
                        .filter_map(|m| m.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// What `system.info` said, once accepted.
#[derive(Debug, Clone, PartialEq)]
pub struct BackendInfo {
    pub version: String,
    pub api_version: u64,
    pub methods: Vec<String>,
}

impl BackendInfo {
    /// Whether the checkout knows a newer API than the connected binary.
    pub fn needs_update(&self, pins: &Pins) -> bool {
        pins.latest_api_version > self.api_version
    }
}

/// The handshake rule of `ui/backend/Compatibility.js`: the exact pinned
/// version, protocol 1, and the released API or exactly one step past it.
pub fn accept(info: &Value, pins: &Pins) -> Result<BackendInfo, RpcError> {
    if info["protocol"].as_u64() != Some(PROTOCOL_VERSION) {
        return Err(RpcError::new(-32010, "backend_protocol_mismatch"));
    }
    let version = info["version"].as_str().unwrap_or_default();
    if pins.version.is_empty() || version != pins.version {
        return Err(RpcError::new(-32011, "backend_version_mismatch"));
    }
    let api = info["apiVersion"].as_u64().unwrap_or(0);
    let step = if pins.latest_api_version == pins.api_version + 1 {
        pins.latest_api_version
    } else {
        pins.api_version
    };
    if pins.api_version == 0 || (api != pins.api_version && api != step) {
        return Err(RpcError::new(-32011, "backend_api_mismatch"));
    }
    let methods = info["methods"]
        .as_array()
        .map(|m| {
            m.iter()
                .filter_map(|m| m.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Ok(BackendInfo {
        version: version.to_owned(),
        api_version: api,
        methods,
    })
}

/// The refusal for a method only the unreleased API step has, asked of a
/// binary without it (`-32012 backend_needs_update`).
pub fn unreleased_refusal(method: &str, info: &BackendInfo, pins: &Pins) -> Option<RpcError> {
    (info.needs_update(pins) && pins.unreleased.iter().any(|m| m == method))
        .then(|| RpcError::new(-32012, "backend_needs_update"))
}

/// How long a request may wait for its answer (`ui/backend/Backend.qml`).
pub fn deadline_ms(method: &str, params: &Value) -> u64 {
    let account = params["accountId"]
        .as_str()
        .or_else(|| params["account"].as_str())
        .unwrap_or("");
    let m365_body = matches!(method, "m365.read" | "m365.attachment")
        || (method == "m365.messages" && params["full"] == true)
        || (method == "reader.open" && account.starts_with("m365:"));
    if m365_body { 90_000 } else { 30_000 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_are_one_line_with_string_ids() {
        let line = request("ui-1", "system.info", &json!({}));
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let value: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(value["id"], "ui-1");
        assert_eq!(value["jsonrpc"], "2.0");
    }

    #[test]
    fn responses_errors_and_notifications_are_told_apart() {
        assert_eq!(
            parse(r#"{"jsonrpc":"2.0","id":"a","result":{"ok":true}}"#),
            vec![Incoming::Response {
                id: "a".into(),
                result: Ok(json!({"ok": true}))
            }]
        );
        assert_eq!(
            parse(
                r#"{"jsonrpc":"2.0","id":"b","error":{"code":-32000,"message":"mail_account_unknown"}}"#
            ),
            vec![Incoming::Response {
                id: "b".into(),
                result: Err(RpcError::new(-32000, "mail_account_unknown"))
            }]
        );
        assert_eq!(
            parse(r#"{"jsonrpc":"2.0","method":"mail.updated","params":{"accountId":"x"}}"#),
            vec![Incoming::Notification {
                method: "mail.updated".into(),
                params: json!({"accountId": "x"})
            }]
        );
        assert_eq!(parse("not json"), vec![Incoming::Invalid]);
        assert_eq!(
            parse(r#"{"jsonrpc":"2.0","id":null,"result":1}"#),
            vec![Incoming::Invalid]
        );
    }

    fn chunk(transfer: &str, index: u64, total: u64, size: u64, data: &str) -> Value {
        json!({"transfer": transfer, "index": index, "total": total, "size": size, "data": data})
    }

    #[test]
    fn chunks_reassemble_in_order() {
        let whole = r#"{"jsonrpc":"2.0","id":"c","result":"héllo"}"#;
        let units = whole.encode_utf16().count() as u64;
        let (a, b) = whole.split_at(20);
        let mut chunks = Chunks::default();
        assert_eq!(chunks.push(&chunk("1", 0, 2, units, a)), ChunkStep::Pending);
        assert_eq!(
            chunks.push(&chunk("1", 1, 2, units, b)),
            ChunkStep::Complete(whole.to_owned())
        );
        assert!(!chunks.in_progress());
        assert_eq!(
            parse(whole),
            vec![Incoming::Response {
                id: "c".into(),
                result: Ok(json!("héllo"))
            }]
        );
    }

    #[test]
    fn chunks_out_of_order_or_inconsistent_are_rejected() {
        let mut chunks = Chunks::default();
        assert_eq!(
            chunks.push(&chunk("1", 1, 2, 4, "ab")),
            ChunkStep::Rejected("chunk_out_of_order")
        );
        assert_eq!(chunks.push(&chunk("1", 0, 2, 4, "ab")), ChunkStep::Pending);
        assert_eq!(
            chunks.push(&chunk("2", 1, 2, 4, "cd")),
            ChunkStep::Rejected("chunk_out_of_order")
        );
        assert!(!chunks.in_progress());
        assert_eq!(
            chunks.push(&chunk("3", 0, 2000, 4, "ab")),
            ChunkStep::Rejected("chunk_limits")
        );
        assert_eq!(
            chunks.push(&chunk("4", 0, 1, 3, "abcd")),
            ChunkStep::Rejected("chunk_too_large")
        );
        assert_eq!(
            chunks.push(&chunk("5", 0, 1, 5, "abcd")),
            ChunkStep::Rejected("chunk_size_mismatch")
        );
    }

    #[test]
    fn uploads_are_split_into_base64url_pieces() {
        assert_eq!(base64url(b""), "");
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"fo"), "Zm8");
        assert_eq!(base64url(b"foo"), "Zm9v");
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
        let pieces = upload_pieces(b"foobar!", 3);
        assert_eq!(
            pieces,
            vec![(0, "Zm9v".into()), (3, "YmFy".into()), (6, "IQ".into())]
        );
    }

    fn pins() -> Pins {
        Pins {
            version: "0.12.0".into(),
            api_version: 10,
            latest_api_version: 11,
            unreleased: vec!["mail.new".into()],
        }
    }

    #[test]
    fn handshake_follows_the_compatibility_rules() {
        let info = |version: &str, api: u64| json!({"version": version, "protocol": 1, "apiVersion": api, "methods": ["system.info", "mail.list"]});
        let accepted = accept(&info("0.12.0", 10), &pins()).unwrap();
        assert_eq!(accepted.methods, vec!["system.info", "mail.list"]);
        assert!(accepted.needs_update(&pins()));
        assert_eq!(
            unreleased_refusal("mail.new", &accepted, &pins()),
            Some(RpcError::new(-32012, "backend_needs_update"))
        );
        assert_eq!(unreleased_refusal("mail.list", &accepted, &pins()), None);
        let step = accept(&info("0.12.0", 11), &pins()).unwrap();
        assert!(!step.needs_update(&pins()));
        assert_eq!(
            accept(&info("0.12.0", 12), &pins()).unwrap_err().message,
            "backend_api_mismatch"
        );
        assert_eq!(
            accept(&info("0.12.0", 9), &pins()).unwrap_err().message,
            "backend_api_mismatch"
        );
        assert_eq!(
            accept(&info("0.11.3", 10), &pins()).unwrap_err().message,
            "backend_version_mismatch"
        );
        let mut other = info("0.12.0", 10);
        other["protocol"] = json!(2);
        assert_eq!(
            accept(&other, &pins()).unwrap_err().message,
            "backend_protocol_mismatch"
        );
    }

    #[test]
    fn the_compiled_pins_match_the_repository() {
        let pins = Pins::compiled();
        assert!(!pins.version.is_empty());
        assert!(pins.api_version > 0);
        assert!(pins.latest_api_version >= pins.api_version);
    }

    #[test]
    fn microsoft_body_reads_wait_longer() {
        assert_eq!(
            deadline_ms("reader.open", &json!({"accountId": "m365:me"})),
            90_000
        );
        assert_eq!(
            deadline_ms("reader.open", &json!({"accountId": "gmail:me"})),
            30_000
        );
        assert_eq!(deadline_ms("m365.messages", &json!({"full": true})), 90_000);
    }
}
