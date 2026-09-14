//! Private, bounded body files compatible with the desktop's legacy cache.
//! Directory descriptors pin every path component; sender values never form paths.
use serde_json::{Value, json};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::SystemTime,
};

mod disk;
pub mod query;
pub mod render;
pub mod resource;
mod store;
#[cfg(all(test, unix))]
mod tests;

const MAX_BODY: usize = 16 * 1024 * 1024;
const MAX_BODIES: usize = 1000;
#[cfg(test)]
static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static OPERATIONS: Mutex<()> = Mutex::new(());
type Result<T> = std::result::Result<T, &'static str>;

pub fn validate_params(params: &Value, needs_id: bool) -> Result<()> {
    account_name(field(params, "accountId")?)?;
    if needs_id {
        body_name(field(params, "id")?)?;
    }
    Ok(())
}

pub fn call(method: &str, params: &Value) -> Result<Value> {
    let root = cache_home()?;
    call_at(&root, method, params)
}

pub fn put_upload(params: &Value, bytes: &[u8]) -> Result<Value> {
    validate_params(params, true)?;
    if bytes.len() > MAX_BODY {
        return Err("cache_body_too_large");
    }
    let body: Value = serde_json::from_slice(bytes).map_err(|_| "cache_body_invalid")?;
    let root = cache_home()?;
    let _lock = OPERATIONS.lock().map_err(|_| "cache_unavailable")?;
    put_at(&root, params, &body)
}

fn cache_home() -> Result<PathBuf> {
    Ok(crate::platform::dirs::AppDirs::discover()?.cache)
}

fn field<'a>(params: &'a Value, key: &str) -> Result<&'a str> {
    let text = params
        .get(key)
        .and_then(Value::as_str)
        .ok_or("cache_invalid_input")?;
    if text.is_empty() || text.len() > 4096 || text.bytes().any(|byte| byte < 32 || byte == 127) {
        return Err("cache_invalid_input");
    }
    Ok(text)
}

fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-".contains(&byte) {
            out.push(byte as char);
        } else {
            use std::fmt::Write;
            write!(&mut out, "_{byte:02x}").unwrap();
        }
    }
    out
}

fn account_name(account: &str) -> Result<String> {
    if account.trim().is_empty() {
        return Err("cache_invalid_input");
    }
    let mut encoded = encode(&account.to_lowercase());
    if encoded.len() > 120 {
        let hash = encoded.bytes().fold(0x811c9dc5_u32, |hash, byte| {
            (hash ^ byte as u32).wrapping_mul(0x01000193)
        });
        encoded = format!("{}-{hash:x}", &encoded[..120]);
    }
    Ok(format!("account-{encoded}"))
}

fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn body_name(id: &str) -> Result<String> {
    let key = id.trim_matches(js_whitespace);
    if key.is_empty() {
        return Err("cache_invalid_input");
    }
    let name = format!("{}.json", encode(key));
    if name.len() > 255 {
        return Err("cache_invalid_input");
    }
    Ok(name)
}

use crate::platform::private_fs::{
    atomic_replace, names, open_dir, remove_owned as unlink, sync_dir,
};
pub(crate) use crate::platform::private_fs::{
    directories, directories_readonly, regular, regular_readonly,
};

fn directory(root: &Path, account: &str, create: bool) -> Result<Option<File>> {
    directories(root, &["omamail", "bodies", account], create)
}

fn js_string(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(false) => String::new(),
        Value::Bool(true) => "true".into(),
        Value::Number(number) if number.as_f64() == Some(0.0) => String::new(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(values) => values
            .iter()
            .map(|value| match value {
                Value::Null => String::new(),
                Value::Bool(false) => "false".into(),
                Value::Number(number) => number.to_string(),
                _ => js_string(value),
            })
            .collect::<Vec<_>>()
            .join(","),
    }
}

fn normalize(body: &Value) -> Result<Value> {
    if !body.is_object() {
        return Err("cache_body_invalid");
    }
    let array = |key| {
        body.get(key)
            .filter(|value| value.is_array())
            .cloned()
            .unwrap_or(json!([]))
    };
    let object = |key| {
        body.get(key)
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or(Value::Null)
    };
    Ok(
        json!({"text":js_string(&body["text"]), "bodyDirection":crate::message::direction::resolve_body(&js_string(&body["text"]), crate::message::direction::AUTO), "source":js_string(&body["source"]), "html":js_string(&body["html"]), "attachments":array("attachments"), "images":array("images"), "invite":object("invite"), "unsubscribe":object("unsubscribe")}),
    )
}

fn call_at(root: &Path, method: &str, params: &Value) -> Result<Value> {
    if method.starts_with("cache.resource") {
        return resource::call_at(root, method, params);
    }
    if matches!(
        method,
        "cache.storeRead" | "cache.storePut" | "cache.calendarRead" | "cache.calendarPut"
    ) {
        return store::call_at(root, method, params);
    }
    if !matches!(
        method,
        "cache.bodyRead" | "cache.bodyPut" | "cache.bodyTouch" | "cache.bodyClear"
    ) {
        return Err("method_not_found");
    }
    validate_params(params, method != "cache.bodyClear")?;
    let _lock = OPERATIONS.lock().map_err(|_| "cache_unavailable")?;
    if method == "cache.bodyPut" {
        return put_at(root, params, &params["body"]);
    }
    let account = account_name(field(params, "accountId")?)?;
    if method == "cache.bodyClear" {
        // Validate both disposable stores before deleting any account data.
        let mut stores = Vec::new();
        for kind in ["bodies", "resources"] {
            if let Some(dir) = directories(root, &["omamail", kind, &account], false)? {
                let files = entries(&dir)?;
                stores.push((dir, files));
            }
        }
        for (dir, files) in stores {
            for (_, name) in files {
                unlink(&dir, &name)?;
            }
            sync_dir(&dir)?;
        }
        return Ok(json!({"cleared":true}));
    }
    let Some(dir) = directory(root, &account, false)? else {
        return Ok(match method {
            "cache.bodyClear" => json!({"cleared":true}),
            "cache.bodyTouch" => json!({"touched":false}),
            _ => Value::Null,
        });
    };
    let name = body_name(field(params, "id")?)?;
    let Some(mut file) = regular(&dir, &name, false)? else {
        return Ok(if method == "cache.bodyTouch" {
            json!({"touched":false})
        } else {
            Value::Null
        });
    };
    if method == "cache.bodyTouch" {
        file.set_modified(SystemTime::now())
            .map_err(|_| "cache_unavailable")?;
        return Ok(json!({"touched":true}));
    }
    if file.metadata().map_err(|_| "cache_unavailable")?.len() > MAX_BODY as u64 {
        return Ok(Value::Null);
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_BODY as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cache_unavailable")?;
    if bytes.len() > MAX_BODY {
        return Ok(Value::Null);
    }
    let body = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|text| serde_json::from_str(text.trim_matches(js_whitespace)).ok())
        .and_then(|body| normalize(&body).ok())
        .unwrap_or(Value::Null);
    if !body.is_null() {
        file.set_modified(SystemTime::now())
            .map_err(|_| "cache_unavailable")?;
    }
    Ok(body)
}

fn put_at(root: &Path, params: &Value, body: &Value) -> Result<Value> {
    validate_params(params, true)?;
    let body = normalize(body)?;
    let bytes = serde_json::to_vec(&body).map_err(|_| "cache_body_invalid")?;
    if bytes.len() > MAX_BODY {
        return Err("cache_body_too_large");
    }
    let account = account_name(field(params, "accountId")?)?;
    let name = body_name(field(params, "id")?)?;
    let dir = directory(root, &account, true)?.ok_or("cache_unavailable")?;
    // Refuse preexisting links and nonregular entries before writing anything.
    regular(&dir, &name, false)?;
    let mut files = entries(&dir)?;
    disk::reserve(root, bytes.len() as u64, Some(("bodies", &account, &name)))?;
    atomic_replace(&dir, &name, &bytes)?;
    files.retain(|(_, existing)| existing != &name);
    files.sort_by(|a, b| b.cmp(a));
    for (_, old) in files.into_iter().skip(MAX_BODIES - 1) {
        unlink(&dir, &old)?;
    }
    sync_dir(&dir)?;
    Ok(json!({"stored":true}))
}

fn entries(dir: &File) -> Result<Vec<(SystemTime, String)>> {
    let mut found = Vec::new();
    for name in names(dir)?
        .into_iter()
        .filter(|name| name.ends_with(".json"))
    {
        let Some(file) = regular(dir, &name, false)? else {
            continue;
        };
        found.push((
            file.metadata()
                .and_then(|meta| meta.modified())
                .map_err(|_| "cache_unavailable")?,
            name,
        ));
    }
    Ok(found)
}

#[cfg(all(test, windows))]
mod windows_tests;
