//! Private, bounded body files compatible with the desktop's legacy cache.
//! Directory descriptors pin every path component; sender values never form paths.
use serde_json::{Value, json};
use std::{
    ffi::{CStr, CString, OsString},
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStringExt,
            fs::{MetadataExt, PermissionsExt},
        },
    },
    path::{Component, Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::SystemTime,
};

mod disk;
pub mod query;
pub mod render;
pub mod resource;
mod store;
#[cfg(test)]
mod tests;

const MAX_BODY: usize = 16 * 1024 * 1024;
const MAX_BODIES: usize = 1000;
static OPERATIONS: Mutex<()> = Mutex::new(());
static SERIAL: AtomicU64 = AtomicU64::new(0);
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
    let base = std::env::var_os("XDG_CACHE_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|home| PathBuf::from(home).join(".cache"))
        })
        .ok_or("cache_home_missing")?;
    if !base.is_absolute() {
        return Err("cache_home_invalid");
    }
    Ok(base)
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

fn cstr(name: &std::ffi::OsStr) -> Result<CString> {
    use std::os::unix::ffi::OsStrExt;
    CString::new(name.as_bytes()).map_err(|_| "cache_invalid_input")
}

fn open_dir(
    parent: &File,
    name: &std::ffi::OsStr,
    create: bool,
    private: bool,
) -> Result<Option<File>> {
    let name = cstr(name)?;
    if create {
        // SAFETY: valid directory fd and NUL-terminated single component.
        let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
        if result != 0
            && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err("cache_unavailable");
        }
    }
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err("cache_unsafe_path");
    }
    let file = unsafe { File::from_raw_fd(fd) };
    if private {
        if file.metadata().map_err(|_| "cache_unavailable")?.uid() != unsafe { libc::geteuid() } {
            return Err("cache_unsafe_path");
        }
        file.set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "cache_unavailable")?;
    }
    Ok(Some(file))
}

fn directory(root: &Path, account: &str, create: bool) -> Result<Option<File>> {
    directories(root, &["omamail", "bodies", account], create)
}

pub(crate) fn directories(root: &Path, suffix: &[&str], create: bool) -> Result<Option<File>> {
    if !root.is_absolute() {
        return Err("cache_home_invalid");
    }
    let mut dir = File::open("/").map_err(|_| "cache_unavailable")?;
    for component in root.components() {
        match component {
            Component::RootDir => (),
            Component::Normal(name) => {
                let Some(next) = open_dir(&dir, name, create, false)? else {
                    return Ok(None);
                };
                dir = next;
            }
            _ => return Err("cache_home_invalid"),
        }
    }
    for name in suffix {
        let Some(next) = open_dir(&dir, name.as_ref(), create, true)? else {
            return Ok(None);
        };
        dir = next;
    }
    Ok(Some(dir))
}

pub(crate) fn regular(dir: &File, name: &str, writable: bool) -> Result<Option<File>> {
    let name = CString::new(name).map_err(|_| "cache_invalid_input")?;
    let access = if writable {
        libc::O_RDWR
    } else {
        libc::O_RDONLY
    };
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            access | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err("cache_unsafe_path");
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata().map_err(|_| "cache_unavailable")?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err("cache_unsafe_path");
    }
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|_| "cache_unavailable")?;
    Ok(Some(file))
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
            dir.sync_all().map_err(|_| "cache_unavailable")?;
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
    let temporary = format!(
        ".tmp.{}.{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    );
    let temporary_c = CString::new(temporary.clone()).unwrap();
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            temporary_c.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err("cache_unavailable");
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(&bytes).map_err(|_| "cache_unavailable")?;
        file.sync_all().map_err(|_| "cache_unavailable")?;
        let target = CString::new(name.clone()).unwrap();
        if unsafe {
            libc::renameat(
                dir.as_raw_fd(),
                temporary_c.as_ptr(),
                dir.as_raw_fd(),
                target.as_ptr(),
            )
        } != 0
        {
            return Err("cache_unavailable");
        }
        files.retain(|(_, existing)| existing != &name);
        files.sort_by(|a, b| b.cmp(a));
        for (_, old) in files.into_iter().skip(MAX_BODIES - 1) {
            unlink(&dir, &old)?;
        }
        dir.sync_all().map_err(|_| "cache_unavailable")?;
        Ok(json!({"stored":true}))
    })();
    if result.is_err() {
        let _ = unlink(&dir, &temporary);
    }
    result
}

fn unlink(dir: &File, name: &str) -> Result<()> {
    // Recheck the final component and unlink relative to the pinned directory.
    if regular(dir, name, false)?.is_none() {
        return Ok(());
    }
    let name = CString::new(name).map_err(|_| "cache_invalid_input")?;
    if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err("cache_unavailable");
    }
    Ok(())
}

fn entries(dir: &File) -> Result<Vec<(SystemTime, String)>> {
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("cache_unavailable");
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err("cache_unavailable");
    }
    struct Stream(*mut libc::DIR);
    impl Drop for Stream {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let stream = Stream(stream);
    let mut found = Vec::new();
    let mut inspected = 0;
    loop {
        // readdir uses a null result for both EOF and failure.
        unsafe {
            *libc::__errno_location() = 0;
        }
        let entry = unsafe { libc::readdir(stream.0) };
        if entry.is_null() {
            if unsafe { *libc::__errno_location() } != 0 {
                return Err("cache_unavailable");
            }
            break;
        }
        inspected += 1;
        if inspected > 10_002 {
            return Err("cache_too_many_files");
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        let name = OsString::from_vec(name.to_vec());
        let Some(name) = name.to_str().filter(|name| name.ends_with(".json")) else {
            continue;
        };
        let Some(file) = regular(dir, name, false)? else {
            continue;
        };
        found.push((
            file.metadata()
                .and_then(|meta| meta.modified())
                .map_err(|_| "cache_unavailable")?,
            name.to_owned(),
        ));
    }
    Ok(found)
}
