use serde_json::Value;
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
const LIMIT: usize = 128 * 1024 * 1024;
pub(super) fn home() -> Result<PathBuf, &'static str> {
    Ok(crate::platform::dirs::AppDirs::discover()?.state)
}
pub(super) type Lease = crate::platform::private_fs::ExclusiveLock;
pub(super) fn lease(root: &Path) -> Result<Lease, &'static str> {
    let dir =
        crate::cache::directories(root, &["omamail"], true)?.ok_or("outbox_storage_unavailable")?;
    crate::platform::private_fs::lock_exclusive(&dir, "outbox.lock").map_err(|error| match error {
        "private_fs_busy" => "outbox_in_use",
        "cache_unsafe_path" => "outbox_storage_unsafe",
        _ => "outbox_storage_unavailable",
    })
}
pub(super) fn read(root: &Path) -> Result<Value, &'static str> {
    let Some(dir) = crate::cache::directories(root, &["omamail"], false)? else {
        return Ok(serde_json::json!([]));
    };
    let Some(mut file) = crate::cache::regular(&dir, "outbox.json", false)? else {
        return Ok(serde_json::json!([]));
    };
    if file
        .metadata()
        .map_err(|_| "outbox_storage_unavailable")?
        .len()
        > LIMIT as u64
    {
        return Err("outbox_storage_too_large");
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "outbox_storage_unavailable")?;
    if bytes.len() > LIMIT {
        return Err("outbox_storage_too_large");
    }
    serde_json::from_slice(&bytes).map_err(|_| "outbox_storage_invalid")
}
pub(super) fn write(root: &Path, value: &Value) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(value).map_err(|_| "outbox_storage_invalid")?;
    if bytes.len() > LIMIT {
        return Err("outbox_storage_too_large");
    }
    let dir =
        crate::cache::directories(root, &["omamail"], true)?.ok_or("outbox_storage_unavailable")?;
    crate::platform::private_fs::atomic_replace(&dir, "outbox.json", &bytes).map_err(|error| {
        if error == "cache_unavailable" {
            "outbox_storage_unavailable"
        } else {
            error
        }
    })
}

#[derive(Default)]
pub(super) struct Writer {
    issued: AtomicU64,
    committed: std::sync::Mutex<u64>,
}
impl Writer {
    pub(super) fn reserve(&self) -> u64 {
        self.issued.fetch_add(1, Ordering::SeqCst) + 1
    }
    pub(super) fn write(
        &self,
        sequence: u64,
        root: &Path,
        value: &Value,
    ) -> Result<(), &'static str> {
        let mut committed = self
            .committed
            .lock()
            .map_err(|_| "outbox_storage_unavailable")?;
        if sequence <= *committed {
            return Ok(());
        }
        write(root, value)?;
        *committed = sequence;
        Ok(())
    }
}
