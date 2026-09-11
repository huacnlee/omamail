//! Durable editor recovery. Stored attachment metadata never authorizes file IO.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
const MAX_BYTES: usize = 16 * 1024 * 1024;
static SERIAL: AtomicU64 = AtomicU64::new(0);
type Result<T> = std::result::Result<T, &'static str>;
struct RecoveryLock(File);
impl Drop for RecoveryLock {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
fn text(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(false) => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) if n.as_f64() == Some(0.0) => String::new(),
        Value::Bool(true) => "true".into(),
        Value::Number(n) => n.to_string(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(v) => v
            .iter()
            .map(|x| {
                if x.is_null() {
                    String::new()
                } else if x == false {
                    "false".into()
                } else if let Value::Number(n) = x {
                    n.to_string()
                } else {
                    text(x)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}
fn empty() -> Value {
    json!({"active":false,"returnView":"","draft":null,"parked":[]})
}
fn draft(value: &Value) -> Result<Value> {
    let mut out = json!({});
    for key in [
        "to",
        "cc",
        "bcc",
        "replyTo",
        "subject",
        "body",
        "placedBody",
        "accountId",
        "sourceDraftId",
        "threadId",
        "inReplyTo",
        "fromEmail",
    ] {
        out[key] = json!(text(&value[key]));
    }
    if let Some(id) = value.get("pendingSendId") {
        let id = id.as_str().ok_or("recovery_invalid_send_id")?;
        if id.len() > 1024 || id.chars().any(char::is_control) {
            return Err("recovery_invalid_send_id");
        }
        if !id.is_empty() {
            out["pendingSendId"] = json!(id);
        }
    }
    if value["deliveryUnknown"] == true {
        out["deliveryUnknown"] = json!(true);
    }
    let mode = text(&value["mode"]);
    out["mode"] = json!(if mode.is_empty() {
        "new".to_owned()
    } else {
        mode
    });
    for key in [
        "bodyWasEdited",
        "ccVisible",
        "bccVisible",
        "replyToVisible",
        "fromWasChosen",
    ] {
        out[key] = json!(value[key] == true);
    }
    let people = value["replyRecipients"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if people.len() > 1024 {
        return Err("recovery_too_large");
    }
    out["replyRecipients"] = json!(
        people
            .iter()
            .map(|v| json!({"email":text(&v["email"]),"display":text(&v["display"])}))
            .collect::<Vec<_>>()
    );
    for key in [
        "originalAttachments",
        "forwardedAttachments",
        "draftAttachments",
    ] {
        let rows = value[key].as_array().cloned().unwrap_or_default();
        if rows.len() > 1000 {
            return Err("recovery_too_large");
        }
        let mut attachments = Vec::new();
        for row in rows {
            let path = text(&row["path"]);
            // Recovery stores descriptions only. Relative/control-bearing paths
            // cannot be handed to a later attachment reader or cleanup action.
            if !path.is_empty()
                && (!Path::new(&path).is_absolute()
                    || path.chars().any(char::is_control)
                    || path.split('/').any(|part| part == "." || part == ".."))
            {
                return Err("recovery_attachment_path_invalid");
            }
            let size = row["size"]
                .as_f64()
                .or_else(|| row["size"].as_str().and_then(|s| s.parse().ok()))
                .unwrap_or(0.0)
                .floor()
                .max(0.0);
            let size = if size <= u64::MAX as f64 {
                json!(size as u64)
            } else {
                json!(size)
            };
            attachments.push(json!({"filename":text(&row["filename"]),"mimeType":text(&row["mimeType"]),"size":size,"data":if path.is_empty(){text(&row["data"])}else{String::new()},"path":path,"owned":row["owned"]==true,"attachmentId":text(&row["attachmentId"]),"partId":text(&row["partId"])}));
        }
        out[key] = json!(attachments);
    }
    Ok(out)
}
fn meaningful(d: &Value) -> bool {
    for key in ["to", "cc", "bcc", "subject"] {
        if !text(&d[key]).trim().is_empty() {
            return true;
        }
    }
    if (d["bodyWasEdited"] == true || d["body"] != d["placedBody"])
        && !text(&d["body"]).trim().is_empty()
    {
        return true;
    }
    ["forwardedAttachments", "draftAttachments"]
        .iter()
        .any(|k| d[k].as_array().is_some_and(|a| !a.is_empty()))
}
pub fn normalize(value: &Value) -> Result<Value> {
    if value["version"] != 1 || value["active"] != true {
        return Ok(empty());
    }
    let saved = draft(&value["draft"])?;
    if !meaningful(&saved) {
        return Ok(empty());
    }
    let parked = value["parked"].as_array().cloned().unwrap_or_default();
    if parked.len() > 64 {
        return Err("recovery_too_large");
    }
    let mut others = Vec::new();
    for row in parked {
        let row = draft(&row)?;
        if meaningful(&row) {
            others.push(row);
        }
    }
    let view = text(&value["returnView"]);
    Ok(
        json!({"active":true,"returnView":if ["reader","calendar"].contains(&view.as_str()){view}else{"list".into()},"draft":saved,"parked":others}),
    )
}
fn home() -> Result<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".config")))
        .filter(|p| p.is_absolute())
        .ok_or("config_home_invalid")
}
fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn record(bytes: &[u8]) -> Result<Value> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(v) => normalize(&v),
        Err(_) => Ok(empty()),
    }
}
pub fn call(method: &str, params: &Value) -> Result<Value> {
    call_at(&home()?, method, params)
}
fn call_at(root: &Path, method: &str, params: &Value) -> Result<Value> {
    if !matches!(method, "compose.recoveryRead" | "compose.recoverySave") {
        return Err("unknown_method");
    }
    let writing = method == "compose.recoverySave";
    let bytes = if writing {
        if !params["record"].is_object()
            || params["record"]["version"] != 1
            || !params["record"]["active"].is_boolean()
        {
            return Err("recovery_invalid");
        }
        let value = normalize(&params["record"])?;
        let mut stored = value.clone();
        stored["version"] = json!(1);
        let bytes = serde_json::to_vec(&stored).map_err(|_| "recovery_invalid")?;
        if bytes.len() > MAX_BYTES {
            return Err("recovery_too_large");
        }
        if params["expectedRevision"].as_str().is_none() {
            return Err("invalid_params");
        }
        bytes
    } else {
        Vec::new()
    };
    let Some(dir) = crate::cache::directories(root, &["omamail"], writing)? else {
        return Ok(json!({"record":empty(),"revision":revision(&[])}));
    };
    let _lock = if writing {
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                c".compose.lock".as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err("recovery_unsafe_path");
        }
        let file = unsafe { File::from_raw_fd(fd) };
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata().map_err(|_| "recovery_unavailable")?;
        if !meta.is_file() || meta.nlink() != 1 || meta.uid() != unsafe { libc::geteuid() } {
            return Err("recovery_unsafe_path");
        }
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("recovery_busy");
        }
        Some(RecoveryLock(file))
    } else {
        None
    };
    let mut old = Vec::new();
    if let Some(file) = crate::cache::regular(&dir, "compose.json", false)? {
        file.take(MAX_BYTES as u64 + 1)
            .read_to_end(&mut old)
            .map_err(|_| "recovery_unavailable")?;
    }
    if old.len() > MAX_BYTES {
        return Err("recovery_too_large");
    }
    if !writing {
        return Ok(json!({"record":record(&old)?,"revision":revision(&old)}));
    }
    if params["expectedRevision"] != revision(&old) {
        return Err("recovery_conflict");
    }
    let temporary = CString::new(format!(
        ".compose.{}.{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ))
    .unwrap();
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err("recovery_unavailable");
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "recovery_unavailable")?;
        if unsafe {
            libc::renameat(
                dir.as_raw_fd(),
                temporary.as_ptr(),
                dir.as_raw_fd(),
                c"compose.json".as_ptr(),
            )
        } != 0
        {
            return Err("recovery_unavailable");
        }
        dir.sync_all().map_err(|_| "recovery_unavailable")?;
        Ok(json!({"record":record(&bytes)?,"revision":revision(&bytes)}))
    })();
    if result.is_err() {
        unsafe { libc::unlinkat(dir.as_raw_fd(), temporary.as_ptr(), 0) };
    }
    result
}
#[cfg(test)]
mod tests;
