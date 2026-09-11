use serde_json::Value;
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
const LIMIT: usize = 128 * 1024 * 1024;
static SERIAL: AtomicU64 = AtomicU64::new(0);
pub(super) fn home() -> Result<PathBuf, &'static str> {
    let home = std::env::var_os("XDG_STATE_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/state")))
        .ok_or("outbox_state_home_missing")?;
    if !home.is_absolute() {
        return Err("outbox_state_home_invalid");
    }
    Ok(home)
}
pub(super) fn lease(root: &Path) -> Result<File, &'static str> {
    let dir =
        crate::cache::directories(root, &["omamail"], true)?.ok_or("outbox_storage_unavailable")?;
    crate::cache::regular(&dir, "outbox.lock", false)?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            c"outbox.lock".as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err("outbox_storage_unavailable");
    }
    let file = unsafe { File::from_raw_fd(fd) };
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(|_| "outbox_storage_unavailable")?;
    if !meta.is_file() || meta.nlink() != 1 || meta.uid() != unsafe { libc::geteuid() } {
        return Err("outbox_storage_unsafe");
    }
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("outbox_in_use");
    }
    Ok(file)
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
    crate::cache::regular(&dir, "outbox.json", false)?;
    let name = CString::new(format!(
        ".outbox-{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ))
    .unwrap();
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err("outbox_storage_unavailable");
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(&bytes)
            .map_err(|_| "outbox_storage_unavailable")?;
        file.sync_all().map_err(|_| "outbox_storage_unavailable")?;
        crate::cache::regular(&dir, "outbox.json", false)?;
        if unsafe {
            libc::renameat(
                dir.as_raw_fd(),
                name.as_ptr(),
                dir.as_raw_fd(),
                c"outbox.json".as_ptr(),
            )
        } != 0
        {
            return Err("outbox_storage_unavailable");
        }
        dir.sync_all().map_err(|_| "outbox_storage_unavailable")
    })();
    if result.is_err() {
        unsafe {
            libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0);
        }
    }
    result
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
