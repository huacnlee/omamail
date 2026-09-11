//! Descriptor-pinned private durable storage for local assistant jobs.
use serde_json::Value;
use std::{
    ffi::{CStr, CString},
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
type Result<T> = std::result::Result<T, &'static str>;
const MAX_BYTES: usize = 1024 * 1024;
static SERIAL: AtomicU64 = AtomicU64::new(1);
pub struct Store {
    root: File,
    lock: File,
    path: PathBuf,
}
pub fn check_id(id: &str) -> Result<()> {
    if id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err("agent_invalid_id")
    }
}
fn filename(name: &str) -> Result<CString> {
    if !matches!(name, "job.json" | "context.json" | "display.json") {
        return Err("agent_invalid_filename");
    }
    Ok(CString::new(name).unwrap())
}
fn ioerror() -> &'static str {
    "agent_storage_unavailable"
}
fn lock_with_timeout(file: &File, timeout: std::time::Duration) -> Result<()> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if !matches!(error.raw_os_error(), Some(libc::EWOULDBLOCK | libc::EINTR)) {
            return Err(ioerror());
        }
        let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
            return Err("agent_storage_busy");
        };
        std::thread::sleep(remaining.min(std::time::Duration::from_millis(5)));
    }
}
fn private(file: &File, directory: bool) -> Result<()> {
    let m = file.metadata().map_err(|_| ioerror())?;
    if m.uid() != unsafe { libc::geteuid() }
        || (if directory {
            !m.is_dir() || m.mode() & 0o7777 != 0o700
        } else {
            !m.is_file() || m.nlink() != 1 || m.mode() & 0o7777 != 0o600
        })
    {
        return Err("agent_unsafe_storage");
    }
    Ok(())
}
fn regular(dir: &File, name: &str) -> Result<Option<File>> {
    let name = CString::new(name).map_err(|_| "agent_invalid_filename")?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err("agent_unsafe_storage");
    }
    let file = unsafe { File::from_raw_fd(fd) };
    private(&file, false)?;
    Ok(Some(file))
}
fn names(dir: &File) -> Result<Vec<String>> {
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(ioerror());
    }
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        unsafe { libc::close(fd) };
        return Err(ioerror());
    }
    let result = (|| {
        let mut result = Vec::new();
        loop {
            unsafe {
                *libc::__errno_location() = 0;
            }
            let e = unsafe { libc::readdir(stream) };
            if e.is_null() {
                if unsafe { *libc::__errno_location() } != 0 {
                    return Err(ioerror());
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*e).d_name.as_ptr()) }
                .to_str()
                .map_err(|_| "agent_unsafe_storage")?;
            if name == "." || name == ".." {
                continue;
            }
            result.push(name.to_owned());
            if result.len() > 256 {
                return Err("agent_storage_limit");
            }
        }
        Ok(result)
    })();
    unsafe { libc::closedir(stream) };
    result
}
impl Store {
    pub fn open() -> Result<Self> {
        let base = if let Some(p) = std::env::var_os("XDG_STATE_HOME").filter(|p| !p.is_empty()) {
            PathBuf::from(p)
        } else {
            PathBuf::from(std::env::var_os("HOME").ok_or("agent_state_home_invalid")?)
                .join(".local/state")
        };
        Self::open_at(&base)
    }
    pub fn open_at(base: &Path) -> Result<Self> {
        if !base.is_absolute()
            || base.components().any(|part| {
                !matches!(
                    part,
                    std::path::Component::RootDir | std::path::Component::Normal(_)
                )
            })
            || base
                .as_os_str()
                .as_encoded_bytes()
                .iter()
                .any(|b| *b < 32 || *b == 127)
        {
            return Err("agent_state_home_invalid");
        }
        let root = crate::cache::directories(base, &["omamail", "assistant"], true)?
            .ok_or("agent_storage_unavailable")?;
        let fd = unsafe {
            libc::openat(
                root.as_raw_fd(),
                c".lock".as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err("agent_unsafe_storage");
        }
        let lock = unsafe { File::from_raw_fd(fd) };
        private(&lock, false)?;
        lock_with_timeout(&lock, std::time::Duration::from_secs(5))?;
        Ok(Self {
            root,
            lock,
            path: base.join("omamail/assistant"),
        })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    fn directory(&self, id: &str) -> Result<File> {
        check_id(id)?;
        let id = CString::new(id).unwrap();
        let fd = unsafe {
            libc::openat(
                self.root.as_raw_fd(),
                id.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err("agent_unsafe_storage");
        }
        let file = unsafe { File::from_raw_fd(fd) };
        private(&file, true)?;
        Ok(file)
    }
    pub fn create(&self, id: &str) -> Result<()> {
        check_id(id)?;
        let id = CString::new(id).unwrap();
        if unsafe { libc::mkdirat(self.root.as_raw_fd(), id.as_ptr(), 0o700) } != 0 {
            return Err(ioerror());
        }
        self.root.sync_all().map_err(|_| ioerror())
    }
    pub fn ids(&self) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        for id in names(&self.root)? {
            if id == ".lock" {
                continue;
            }
            check_id(&id)?;
            self.directory(&id)?;
            ids.push(id);
        }
        ids.sort();
        Ok(ids)
    }
    pub fn read_json(&self, id: &str, name: &str, limit: usize) -> Result<Option<Value>> {
        filename(name)?;
        if limit > MAX_BYTES {
            return Err("agent_storage_limit");
        }
        let dir = self.directory(id)?;
        let Some(mut file) = regular(&dir, name)? else {
            return Ok(None);
        };
        if file.metadata().map_err(|_| ioerror())?.len() > limit as u64 {
            return Err("agent_storage_limit");
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| ioerror())?;
        if bytes.len() > limit {
            return Err("agent_storage_limit");
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| "agent_invalid_record")
    }
    pub fn write_json(&self, id: &str, name: &str, value: &Value) -> Result<()> {
        let target = filename(name)?;
        check_id(id)?;
        let bytes = serde_json::to_vec(value).map_err(|_| "agent_invalid_record")?;
        if bytes.len() > MAX_BYTES {
            return Err("agent_storage_limit");
        }
        let dir = self.directory(id)?;
        regular(&dir, name)?;
        let temporary = format!(
            ".write-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        );
        let temp = CString::new(temporary).unwrap();
        let fd = unsafe {
            libc::openat(
                dir.as_raw_fd(),
                temp.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(ioerror());
        }
        let mut file = unsafe { File::from_raw_fd(fd) };
        let result = (|| {
            file.write_all(&bytes).map_err(|_| ioerror())?;
            file.sync_all().map_err(|_| ioerror())?;
            if unsafe {
                libc::renameat(
                    dir.as_raw_fd(),
                    temp.as_ptr(),
                    dir.as_raw_fd(),
                    target.as_ptr(),
                )
            } != 0
            {
                return Err(ioerror());
            }
            dir.sync_all().map_err(|_| ioerror())
        })();
        if result.is_err() {
            unsafe { libc::unlinkat(dir.as_raw_fd(), temp.as_ptr(), 0) };
        }
        result
    }
    pub fn remove(&self, id: &str) -> Result<()> {
        let dir = self.directory(id)?;
        let entries = names(&dir)?;
        // Validate the complete set before deleting anything.
        for name in &entries {
            // Pre-streaming jobs kept this legacy output file. Permit its
            // removal only after the same regular/private/no-link validation.
            if !name.starts_with(".write-") && name != "response.txt" {
                filename(name)?;
            }
            regular(&dir, name)?.ok_or("agent_unsafe_storage")?;
        }
        for name in entries {
            let name = CString::new(name).map_err(|_| "agent_unsafe_storage")?;
            if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(ioerror());
            }
        }
        let id = CString::new(id).unwrap();
        if unsafe { libc::unlinkat(self.root.as_raw_fd(), id.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
            return Err(ioerror());
        }
        self.root.sync_all().map_err(|_| ioerror())
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        unsafe { libc::flock(self.lock.as_raw_fd(), libc::LOCK_UN) };
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "omamail-agent-store-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    const ID: &str = "0123456789abcdef0123456789abcdef";
    #[test]
    fn private_roundtrip_atomic_bounds_and_remove() {
        let temp = Temp::new();
        let store = Store::open_at(&temp.0).unwrap();
        store.create(ID).unwrap();
        store.write_json(ID, "job.json", &json!({"id":ID})).unwrap();
        assert_eq!(
            store.read_json(ID, "job.json", 1024).unwrap(),
            Some(json!({"id":ID}))
        );
        assert!(store.read_json(ID, "job.json", 1).is_err());
        assert_eq!(store.ids().unwrap(), vec![ID]);
        let path = store.path().join(ID).join("job.json");
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert!(
            store
                .write_json(ID, "job.json", &json!("x".repeat(MAX_BYTES)))
                .is_err()
        );
        assert_eq!(
            store.read_json(ID, "job.json", 1024).unwrap(),
            Some(json!({"id":ID}))
        );
        store.remove(ID).unwrap();
        assert!(!path.exists());
    }
    #[test]
    fn legacy_response_links_are_refused_before_any_removal() {
        let temp = Temp::new();
        let store = Store::open_at(&temp.0).unwrap();
        store.create(ID).unwrap();
        store.write_json(ID, "job.json", &json!({"id":ID})).unwrap();
        let external = temp.0.join("unrelated");
        std::fs::write(&external, "keep").unwrap();
        let response = store.path().join(ID).join("response.txt");
        std::os::unix::fs::symlink(&external, &response).unwrap();
        assert!(store.remove(ID).is_err());
        assert!(store.path().join(ID).join("job.json").exists());
        assert_eq!(std::fs::read_to_string(&external).unwrap(), "keep");
        assert!(std::fs::symlink_metadata(response).unwrap().is_symlink());
    }
    #[test]
    fn hostile_components_and_links_have_no_external_effect() {
        let temp = Temp::new();
        let store = Store::open_at(&temp.0).unwrap();
        store.create(ID).unwrap();
        let victim = temp.0.join("victim");
        std::fs::write(&victim, b"untouched").unwrap();
        for id in [
            "../victim",
            "",
            "A123456789abcdef0123456789abcdef",
            "0123456789abcdef0123456789abcdef\n",
        ] {
            assert!(store.create(id).is_err());
            assert!(store.remove(id).is_err());
        }
        for name in ["../victim", "/tmp/victim", "job.json\0", "job.json\n"] {
            assert!(store.write_json(ID, name, &json!(1)).is_err());
        }
        let target = store.path().join(ID).join("job.json");
        std::os::unix::fs::symlink(&victim, &target).unwrap();
        assert!(store.read_json(ID, "job.json", 1024).is_err());
        assert!(store.write_json(ID, "job.json", &json!(1)).is_err());
        assert!(store.remove(ID).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"untouched");
        std::fs::remove_file(&target).unwrap();
        std::fs::hard_link(&victim, &target).unwrap();
        assert!(store.read_json(ID, "job.json", 1024).is_err());
        assert!(store.write_json(ID, "job.json", &json!(1)).is_err());
        assert!(store.remove(ID).is_err());
        assert_eq!(std::fs::read(&victim).unwrap(), b"untouched");
    }
    #[test]
    fn insecure_job_and_file_permissions_are_refused_without_chmod() {
        let temp = Temp::new();
        let store = Store::open_at(&temp.0).unwrap();
        store.create(ID).unwrap();
        let dir = store.path().join(ID);
        let path = dir.join("job.json");
        std::fs::write(&path, b"{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(store.read_json(ID, "job.json", 1024).is_err());
        assert!(store.remove(ID).is_err());
        assert_eq!(std::fs::metadata(&path).unwrap().mode() & 0o777, 0o644);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(store.ids().is_err());
    }

    #[test]
    fn parent_and_job_symlinks_never_open_or_delete_their_target() {
        let temp = Temp::new();
        let outside = Temp::new();
        std::os::unix::fs::symlink(&outside.0, temp.0.join("omamail")).unwrap();
        assert!(Store::open_at(&temp.0).is_err());
        assert!(!outside.0.join("assistant").exists());
        std::fs::remove_file(temp.0.join("omamail")).unwrap();
        let store = Store::open_at(&temp.0).unwrap();
        std::os::unix::fs::symlink(&outside.0, store.path().join(ID)).unwrap();
        assert!(store.ids().is_err());
        assert!(store.remove(ID).is_err());
        assert!(outside.0.is_dir());
        let invalid = temp.0.join("not-created/../escape");
        assert!(Store::open_at(&invalid).is_err());
        assert!(!temp.0.join("not-created").exists());
    }

    #[test]
    fn lock_is_exclusive_and_drop_explicitly_unlocks_even_with_duplicate_fd() {
        let temp = Temp::new();
        let store = Store::open_at(&temp.0).unwrap();
        let duplicate = store.lock.try_clone().unwrap();
        let other = File::open(store.path().join(".lock")).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            lock_with_timeout(&other, std::time::Duration::from_millis(20)),
            Err("agent_storage_busy")
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_ne!(
            unsafe { libc::flock(other.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        drop(store);
        assert_eq!(
            unsafe { libc::flock(other.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        drop(duplicate);
    }
}
