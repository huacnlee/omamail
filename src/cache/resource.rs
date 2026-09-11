//! Full provider message resources retained for background preload and reader reuse.
//! Parsed presentation bodies remain in the separate legacy-compatible body cache.
use super::*;
use std::sync::Arc;

pub async fn read(account: &str, id: &str) -> Result<Option<Value>> {
    let params = json!({"accountId":account,"id":id});
    let value = tokio::task::spawn_blocking(move || call("cache.resourceRead", &params))
        .await
        .map_err(|_| "cache_unavailable")??;
    Ok((!value.is_null()).then_some(value))
}
pub async fn put(account: &str, id: &str, resource: &Value) -> Result<()> {
    put_guarded(account, id, resource, Arc::new(Mutex::new(true))).await
}
pub async fn put_guarded(
    account: &str,
    id: &str,
    resource: &Value,
    live: Arc<Mutex<bool>>,
) -> Result<()> {
    let params = json!({"accountId":account,"id":id,"resource":resource});
    tokio::task::spawn_blocking(move || {
        let root = cache_home()?;
        let _lock = OPERATIONS.lock().map_err(|_| "cache_unavailable")?;
        put_at(&root, &params, &live).map(|_| ())
    })
    .await
    .map_err(|_| "cache_unavailable")?
}
pub fn call(method: &str, params: &Value) -> Result<Value> {
    call_at(&cache_home()?, method, params)
}
fn valid(resource: &Value, id: &str) -> bool {
    resource.is_object()
        && resource["id"].as_str() == Some(id)
        && resource["payload"].is_object()
        && resource["payload"]["headers"].is_array()
}
pub(super) fn call_at(root: &Path, method: &str, params: &Value) -> Result<Value> {
    validate_params(params, method != "cache.resourceClear")?;
    let _lock = OPERATIONS.lock().map_err(|_| "cache_unavailable")?;
    if method == "cache.resourcePut" {
        return put_at(root, params, &Mutex::new(true));
    }
    if !matches!(method, "cache.resourceRead" | "cache.resourceClear") {
        return Err("method_not_found");
    }
    let account = account_name(field(params, "accountId")?)?;
    let Some(dir) = directories(root, &["omamail", "resources", &account], false)? else {
        return Ok(if method == "cache.resourceClear" {
            json!({"cleared":true})
        } else {
            Value::Null
        });
    };
    if method == "cache.resourceClear" {
        for (_, name) in entries(&dir)? {
            unlink(&dir, &name)?;
        }
        return Ok(json!({"cleared":true}));
    }
    let id = field(params, "id")?;
    let name = body_name(id)?;
    let Some(mut file) = regular(&dir, &name, false)? else {
        return Ok(Value::Null);
    };
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
    let Ok(record) = serde_json::from_slice::<Value>(&bytes) else {
        return Ok(Value::Null);
    };
    if record["version"] != 1
        || record["accountId"].as_str() != Some(&field(params, "accountId")?.to_lowercase())
        || !valid(&record["resource"], id)
    {
        return Ok(Value::Null);
    }
    file.set_modified(SystemTime::now())
        .map_err(|_| "cache_unavailable")?;
    Ok(record["resource"].clone())
}
fn put_at(root: &Path, params: &Value, live: &Mutex<bool>) -> Result<Value> {
    validate_params(params, true)?;
    if !*live.lock().map_err(|_| "cache_unavailable")? {
        return Err("cache_cancelled");
    }
    let id = field(params, "id")?;
    if !valid(&params["resource"], id) {
        return Err("cache_resource_invalid");
    }
    let bytes = serde_json::to_vec(&json!({"version":1,"accountId":field(params,"accountId")?.to_lowercase(),"resource":params["resource"]})).map_err(|_| "cache_resource_invalid")?;
    if bytes.len() > MAX_BODY {
        return Err("cache_body_too_large");
    }
    let account = account_name(field(params, "accountId")?)?;
    let name = body_name(id)?;
    let dir =
        directories(root, &["omamail", "resources", &account], true)?.ok_or("cache_unavailable")?;
    regular(&dir, &name, false)?;
    let mut files = entries(&dir)?;
    if !*live.lock().map_err(|_| "cache_unavailable")? {
        return Err("cache_cancelled");
    }
    disk::reserve(
        root,
        bytes.len() as u64,
        Some(("resources", &account, &name)),
    )?;
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
        let commit_guard = live.lock().map_err(|_| "cache_unavailable")?;
        if !*commit_guard {
            return Err("cache_cancelled");
        }
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
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_resource_roundtrip_scoped_identity_corrupt_and_cancelled() {
        let temp = super::super::tests::Temp::new();
        let params = json!({"accountId":"imap:one@example.org","id":"12:INBOX","resource":{"id":"12:INBOX","payload":{"headers":[],"body":{"data":"SGVsbG8"}}}});
        call_at(&temp.0, "cache.resourcePut", &params).unwrap();
        assert_eq!(
            call_at(&temp.0, "cache.resourceRead", &params).unwrap(),
            params["resource"]
        );
        let mut other = params.clone();
        other["accountId"] = json!("imap:two@example.org");
        assert!(
            call_at(&temp.0, "cache.resourceRead", &other)
                .unwrap()
                .is_null()
        );
        assert_eq!(
            put_at(&temp.0, &other, &Mutex::new(false)),
            Err("cache_cancelled")
        );
        assert!(
            !temp
                .0
                .join("omamail/resources/account-imap_3atwo_40example.org")
                .exists()
        );
        other["resource"]["id"] = json!("different");
        assert_eq!(
            call_at(&temp.0, "cache.resourcePut", &other),
            Err("cache_resource_invalid")
        );
        let path = temp
            .0
            .join("omamail/resources")
            .join(account_name(params["accountId"].as_str().unwrap()).unwrap())
            .join(body_name("12:INBOX").unwrap());
        std::fs::write(&path, b"{invalid").unwrap();
        assert!(
            call_at(&temp.0, "cache.resourceRead", &params)
                .unwrap()
                .is_null()
        );
    }
}
