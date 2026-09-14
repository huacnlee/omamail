//! Descriptor-relative Unix storage. No path is re-resolved after it is checked.
use std::{
    ffi::{CStr, CString},
    fs::File,
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, PermissionsExt},
    },
    path::{Component, Path},
    sync::atomic::{AtomicU64, Ordering},
};
type Result<T> = std::result::Result<T, &'static str>;
#[cfg(target_os = "linux")]
const NO_ATIME: i32 = libc::O_NOATIME;
// Darwin has no per-open NOATIME flag. Read-only access never chmods or writes,
// but filesystem access-time policy remains the OS's responsibility.
#[cfg(not(target_os = "linux"))]
const NO_ATIME: i32 = 0;
static SERIAL: AtomicU64 = AtomicU64::new(0);
fn cstr(name: &std::ffi::OsStr) -> Result<CString> {
    use std::os::unix::ffi::OsStrExt;
    if name.as_bytes().is_empty() || name.as_bytes().contains(&b'/') || name == "." || name == ".."
    {
        return Err("cache_invalid_input");
    }
    CString::new(name.as_bytes()).map_err(|_| "cache_invalid_input")
}

pub(crate) fn open_dir(
    parent: &File,
    name: &std::ffi::OsStr,
    create: bool,
    private: bool,
) -> Result<Option<File>> {
    validate_acl(parent, false)?;
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
    validate_acl(&file, private)?;
    if private {
        if file.metadata().map_err(|_| "cache_unavailable")?.uid() != unsafe { libc::geteuid() } {
            return Err("cache_unsafe_path");
        }
        file.set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "cache_unavailable")?;
    }
    Ok(Some(file))
}

fn open_dir_readonly(parent: &File, name: &std::ffi::OsStr, private: bool) -> Result<Option<File>> {
    let name = cstr(name)?;
    let access = libc::O_RDONLY
        | libc::O_DIRECTORY
        | libc::O_NOFOLLOW
        | libc::O_CLOEXEC
        | if private { NO_ATIME } else { 0 };
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), access) };
    if fd < 0 {
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err("cache_unsafe_path");
    }
    let file = unsafe { File::from_raw_fd(fd) };
    validate_acl(&file, private)?;
    if private {
        let metadata = file.metadata().map_err(|_| "cache_unavailable")?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err("cache_unsafe_path");
        }
    }
    Ok(Some(file))
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
                let metadata = next.metadata().map_err(|_| "cache_unavailable")?;
                let uid = unsafe { libc::geteuid() };
                if (metadata.uid() != uid && metadata.uid() != 0)
                    || (metadata.mode() & 0o022 != 0
                        && !(metadata.uid() == 0 && metadata.mode() & 0o1000 != 0))
                {
                    return Err("cache_unsafe_path");
                }
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

pub(crate) fn directories_readonly(root: &Path, suffix: &[&str]) -> Result<Option<File>> {
    if !root.is_absolute() {
        return Err("cache_home_invalid");
    }
    let mut dir = File::open("/").map_err(|_| "cache_unavailable")?;
    for component in root.components() {
        match component {
            Component::RootDir => (),
            Component::Normal(name) => {
                let Some(next) = open_dir_readonly(&dir, name, false)? else {
                    return Ok(None);
                };
                let metadata = next.metadata().map_err(|_| "cache_unavailable")?;
                let uid = unsafe { libc::geteuid() };
                if (metadata.uid() != uid && metadata.uid() != 0)
                    || (metadata.mode() & 0o022 != 0
                        && !(metadata.uid() == 0 && metadata.mode() & 0o1000 != 0))
                {
                    return Err("cache_unsafe_path");
                }
                dir = next;
            }
            _ => return Err("cache_home_invalid"),
        }
    }
    for name in suffix {
        let Some(next) = open_dir_readonly(&dir, name.as_ref(), true)? else {
            return Ok(None);
        };
        dir = next;
    }
    Ok(Some(dir))
}

fn regular_impl(dir: &File, name: &str, writable: bool) -> Result<Option<File>> {
    let name = cstr(name.as_ref())?;
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
    if metadata.nlink() == 0 {
        return Ok(None);
    }
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.uid() != unsafe { libc::geteuid() }
    {
        return Err("cache_unsafe_path");
    }
    validate_acl(&file, true)?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|_| "cache_unavailable")?;
    Ok(Some(file))
}

pub(crate) fn regular_readonly(dir: &File, name: &str) -> Result<Option<File>> {
    let name = cstr(name.as_ref())?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC | NO_ATIME,
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
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err("cache_unsafe_path");
    }
    validate_acl(&file, true)?;
    Ok(Some(file))
}

pub(crate) fn names(dir: &File) -> Result<Vec<String>> {
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
    let result = (|| {
        let mut out = Vec::new();
        loop {
            unsafe {
                *errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                if unsafe { *errno_location() } != 0 {
                    return Err("cache_unavailable");
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
                .to_str()
                .map_err(|_| "cache_unsafe_path")?;
            if name == "." || name == ".." {
                continue;
            }
            out.push(name.to_owned());
            if out.len() > 10_000 {
                return Err("cache_too_many_files");
            }
        }
        Ok(out)
    })();
    unsafe {
        libc::closedir(stream);
    }
    result
}

#[cfg(target_os = "linux")]
fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__errno_location() }
}
#[cfg(target_os = "macos")]
fn errno_location() -> *mut libc::c_int {
    unsafe { libc::__error() }
}

pub(crate) fn validate_owned_root(dir: &File) -> Result<()> {
    validate_acl(dir, true)?;
    let metadata = dir.metadata().map_err(|_| "cache_unavailable")?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err("cache_unsafe_path");
    }
    Ok(())
}

pub(crate) fn open_private(dir: &File, name: &str, writable: bool) -> Result<Option<File>> {
    validate_owned_root(dir)?;
    regular_impl(dir, name, writable)
}

pub(crate) fn remove_owned(dir: &File, name: &str) -> Result<()> {
    validate_owned_root(dir)?;
    if regular_readonly(dir, name)?.is_none() {
        return Ok(());
    }
    let name = cstr(name.as_ref())?;
    if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err("cache_unavailable");
    }
    Ok(())
}

/// Temp creation and replacement are relative to one pinned directory. Neither
/// an existing hard link nor a symlink is ever opened for writing or deleted.
pub(crate) fn atomic_replace(dir: &File, name: &str, bytes: &[u8]) -> Result<()> {
    validate_owned_root(dir)?;
    regular(dir, name, false)?;
    let target = cstr(name.as_ref())?;
    let temporary = cstr(
        format!(
            ".tmp.{}.{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        )
        .as_ref(),
    )?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err("cache_unavailable");
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "cache_unavailable")?;
        regular(dir, name, false)?;
        if unsafe {
            libc::renameat(
                dir.as_raw_fd(),
                temporary.as_ptr(),
                dir.as_raw_fd(),
                target.as_ptr(),
            )
        } != 0
        {
            return Err("cache_unavailable");
        }
        dir.sync_all().map_err(|_| "cache_unavailable")
    })();
    if result.is_err() {
        unsafe {
            libc::unlinkat(dir.as_raw_fd(), temporary.as_ptr(), 0);
        }
    }
    result
}

pub(crate) fn sync_dir(dir: &File) -> Result<()> {
    dir.sync_all().map_err(|_| "cache_unavailable")
}

pub(crate) struct ExclusiveLock {
    file: File,
    owner: u32,
}
impl ExclusiveLock {
    #[cfg(test)]
    pub(crate) fn from_locked(file: File) -> Self {
        Self {
            file,
            owner: std::process::id(),
        }
    }
}
impl AsRawFd for ExclusiveLock {
    fn as_raw_fd(&self) -> std::os::fd::RawFd {
        self.file.as_raw_fd()
    }
}
impl Drop for ExclusiveLock {
    fn drop(&mut self) {
        // Forked pre-exec children must neither retain nor unlock the owner's lease.
        if std::process::id() == self.owner {
            unsafe {
                libc::flock(self.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}
pub(crate) fn lock_exclusive(dir: &File, name: &str) -> Result<ExclusiveLock> {
    validate_owned_root(dir)?;
    let name = cstr(name.as_ref())?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDWR | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err("cache_unsafe_path");
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let m = file.metadata().map_err(|_| "cache_unavailable")?;
    if !m.is_file()
        || m.nlink() != 1
        || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o077 != 0
    {
        return Err("cache_unsafe_path");
    }
    validate_acl(&file, true)?;
    if unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("private_fs_busy");
    }
    Ok(ExclusiveLock {
        file,
        owner: std::process::id(),
    })
}

pub(crate) use open_private as regular;

pub(crate) fn open_external(path: &Path) -> Result<File> {
    let raw = path.to_str().ok_or("mail_send_attachment_path")?;
    if !path.is_absolute()
        || raw.len() > 8192
        || raw.chars().any(char::is_control)
        || raw.split('/').any(|part| matches!(part, "." | ".."))
    {
        return Err("mail_send_attachment_path");
    }
    let mut parent = File::open("/").map_err(|_| "mail_send_attachment_unreadable")?;
    let parts: Vec<_> = raw.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return Err("mail_send_attachment_path");
    }
    for (index, part) in parts.iter().enumerate() {
        let name = std::ffi::CString::new(*part).map_err(|_| "mail_send_attachment_path")?;
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if index + 1 < parts.len() {
                libc::O_DIRECTORY
            } else {
                0
            };
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err("mail_send_attachment_unreadable");
        }
        parent = unsafe { File::from_raw_fd(fd) };
    }
    Ok(parent)
}

pub(crate) fn same_file_version(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    (
        before.mtime(),
        before.mtime_nsec(),
        before.ctime(),
        before.ctime_nsec(),
    ) == (
        after.mtime(),
        after.mtime_nsec(),
        after.ctime(),
        after.ctime_nsec(),
    )
}

#[cfg(not(target_os = "macos"))]
fn validate_acl(_: &File, _: bool) -> Result<()> {
    Ok(())
}

/// Darwin's mode bits do not constrain extended allow ACEs. Deny-only ACLs
/// (including the standard home-directory delete denial) are safe. Private
/// objects refuse all allow ACEs; ancestors refuse any ACL mutation grant.
#[cfg(target_os = "macos")]
fn validate_acl(file: &File, private: bool) -> Result<()> {
    use std::ffi::c_void;
    unsafe extern "C" {
        fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_int) -> *mut c_void;
        fn acl_get_entry(
            acl: *mut c_void,
            entry_id: libc::c_int,
            entry: *mut *mut c_void,
        ) -> libc::c_int;
        fn acl_get_tag_type(entry: *mut c_void, tag: *mut libc::c_int) -> libc::c_int;
        fn acl_get_permset(entry: *mut c_void, permissions: *mut *mut c_void) -> libc::c_int;
        fn acl_get_perm_np(permissions: *mut c_void, permission: libc::c_uint) -> libc::c_int;
        fn acl_free(value: *mut c_void) -> libc::c_int;
    }
    struct Acl(*mut c_void);
    impl Drop for Acl {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    acl_free(self.0);
                }
            }
        }
    }
    let acl = Acl(unsafe {
        acl_get_fd_np(file.as_raw_fd(), 0x100 /* ACL_TYPE_EXTENDED */)
    });
    if acl.0.is_null() {
        // Darwin reports ENOENT for a file that has no extended ACL at all.
        return if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
            Ok(())
        } else {
            Err("cache_unsafe_path")
        };
    }
    let mut index = 0; // ACL_FIRST_ENTRY; subsequent reads use ACL_NEXT_ENTRY=-1.
    loop {
        let mut entry = std::ptr::null_mut();
        let result = unsafe { acl_get_entry(acl.0, index, &mut entry) };
        if result != 0 {
            // Darwin returns -1/EINVAL when the ACL has no further entries.
            return if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
                Ok(())
            } else {
                Err("cache_unsafe_path")
            };
        }
        index = -1;
        let mut tag = 0;
        if unsafe { acl_get_tag_type(entry, &mut tag) } != 0 {
            return Err("cache_unsafe_path");
        }
        if tag == 2
        /* ACL_EXTENDED_DENY */
        {
            continue;
        }
        if tag != 1 /* ACL_EXTENDED_ALLOW */ || private {
            return Err("cache_unsafe_path");
        }
        let mut permissions = std::ptr::null_mut();
        if unsafe { acl_get_permset(entry, &mut permissions) } != 0 {
            return Err("cache_unsafe_path");
        }
        for bit in [2, 4, 5, 6, 8, 10, 12, 13] {
            if unsafe { acl_get_perm_np(permissions, 1 << bit) } != 0 {
                return Err("cache_unsafe_path");
            }
        }
    }
}
