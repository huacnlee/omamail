use super::*;
const MAX_STORE: usize = 4 * 1024 * 1024;

pub(super) fn empty() -> Value {
    json!({"version":2,"account":"","profile":null,"labels":[],"queries":{},"session":null})
}

pub(super) fn normalize_store(value: &Value) -> Value {
    if !value.is_object() || value["version"].as_u64() != Some(2) {
        return empty();
    }
    let mut out = empty();
    out["account"] = json!(js_string(&value["account"]));
    for key in ["profile", "session"] {
        if value[key].is_object() {
            out[key] = value[key].clone();
        }
    }
    if value["labels"].is_array() {
        out["labels"] = value["labels"].clone();
    }
    if let Some(queries) = value["queries"].as_object() {
        let mut entries: Vec<_> = queries.iter().collect();
        entries.sort_by(|a, b| {
            b.1["at"]
                .as_f64()
                .unwrap_or(0.0)
                .total_cmp(&a.1["at"].as_f64().unwrap_or(0.0))
        });
        for (key, entry) in entries.into_iter().take(12) {
            let summaries = entry["summaries"].as_array().cloned().unwrap_or_default();
            let token = if summaries.len() > 100 {
                String::new()
            } else {
                js_string(&entry["nextPageToken"])
            };
            out["queries"][key] = json!({"summaries":summaries.into_iter().take(100).map(|mut row| { if row.is_object() { row["subjectDirection"] = json!(crate::message::direction::resolve_subject(row["subject"].as_str().unwrap_or(""), crate::message::direction::AUTO)); } row }).collect::<Vec<_>>(),"nextPageToken":token,"estimate":entry["estimate"].as_f64().unwrap_or(0.0).floor().max(0.0),"at":entry["at"].as_f64().unwrap_or(0.0)});
        }
    }
    out
}

pub(super) fn call_at(root: &Path, method: &str, params: &Value) -> Result<Value> {
    let calendar = method.starts_with("cache.calendar");
    let normalize: fn(&Value) -> Value = if calendar {
        normalize_calendar
    } else {
        normalize_store
    };
    let empty = || normalize(&Value::Null);
    let name = if calendar {
        let name = field(params, "name")?;
        if !matches!(name, "calendar" | "calendar-bar") {
            return Err("cache_invalid_input");
        }
        format!("{name}.json")
    } else {
        validate_params(params, false)?;
        format!("{}.json", account_name(field(params, "accountId")?)?)
    };
    let _lock = OPERATIONS.lock().map_err(|_| "cache_unavailable")?;
    let writing = matches!(method, "cache.storePut" | "cache.calendarPut");
    let value = normalize(&params["store"]);
    let bytes = if writing {
        let bytes = serde_json::to_vec(&value).map_err(|_| "cache_store_invalid")?;
        if bytes.len() > MAX_STORE {
            return Err("cache_store_too_large");
        }
        bytes
    } else {
        Vec::new()
    };
    let Some(dir) = directories(root, &["omamail"], writing)? else {
        return Ok(empty());
    };
    let existing = regular(&dir, &name, false)?;
    if !writing {
        let Some(mut file) = existing else {
            return Ok(empty());
        };
        if file.metadata().map_err(|_| "cache_unavailable")?.len() > MAX_STORE as u64 {
            return Ok(empty());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(MAX_STORE as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "cache_unavailable")?;
        if bytes.len() > MAX_STORE {
            return Ok(empty());
        }
        return Ok(serde_json::from_slice(&bytes)
            .map(|v| normalize(&v))
            .unwrap_or_else(|_| empty()));
    }
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
        let target = CString::new(name).unwrap();
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
        dir.sync_all().map_err(|_| "cache_unavailable")?;
        Ok(json!({"stored":true}))
    })();
    if result.is_err() {
        let _ = unlink(&dir, &temporary);
    }
    result
}

fn normalize_calendar(value: &Value) -> Value {
    let mut out = json!({"version":3,"ranges":{}});
    if value["version"].as_u64() != Some(3) {
        return out;
    }
    if let Some(ranges) = value["ranges"].as_object() {
        let mut entries: Vec<_> = ranges.iter().collect();
        entries.sort_by(|a, b| {
            b.1["at"]
                .as_f64()
                .unwrap_or(0.0)
                .total_cmp(&a.1["at"].as_f64().unwrap_or(0.0))
        });
        for (key, entry) in entries.into_iter().take(8) {
            let mut entry = entry.clone();
            if !entry.is_object() {
                continue;
            }
            entry["events"] = json!(
                entry["events"]
                    .as_array()
                    .map(|v| v.iter().take(2500).cloned().collect::<Vec<_>>())
                    .unwrap_or_default()
            );
            out["ranges"][key] = entry;
        }
    }
    out
}
