use std::{
    fs::File,
    os::fd::{AsRawFd, FromRawFd},
    path::Path,
};
use tokio::net::{UnixListener, UnixStream};
type Result<T> = std::result::Result<T, &'static str>;

/// The descriptor pins the endpoint directory even when an ancestor is renamed.
pub(crate) struct LocalEndpoint {
    dir: File,
}
impl LocalEndpoint {
    pub(crate) fn outbox(root: &Path) -> Result<Self> {
        let dir = crate::platform::private_fs::directories_readonly(root, &["omamail"])?
            .ok_or("outbox_owner_unavailable")?;
        crate::platform::private_fs::validate_owned_root(&dir)?;
        Ok(Self { dir })
    }
    fn check_socket(&self) -> Result<bool> {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe {
            libc::fstatat(
                self.dir.as_raw_fd(),
                c"outbox.sock".as_ptr(),
                stat.as_mut_ptr(),
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
                Ok(false)
            } else {
                Err("outbox_owner_unavailable")
            };
        }
        let stat = unsafe { stat.assume_init() };
        if stat.st_mode & libc::S_IFMT != libc::S_IFSOCK
            || stat.st_uid != unsafe { libc::geteuid() }
            || stat.st_nlink != 1
            || stat.st_mode & 0o077 != 0
        {
            return Err("outbox_storage_unsafe");
        }
        Ok(true)
    }
    /// Caller must hold the outbox lease before cleaning a stale endpoint.
    pub(crate) fn listen(&self) -> Result<UnixListener> {
        if self.check_socket()?
            && unsafe { libc::unlinkat(self.dir.as_raw_fd(), c"outbox.sock".as_ptr(), 0) } != 0
        {
            return Err("outbox_storage_unavailable");
        }
        let listener = self.with_path(|path| std::os::unix::net::UnixListener::bind(path))?;
        if unsafe { libc::fchmodat(self.dir.as_raw_fd(), c"outbox.sock".as_ptr(), 0o600, 0) } != 0 {
            return Err("outbox_storage_unavailable");
        }
        listener
            .set_nonblocking(true)
            .map_err(|_| "outbox_storage_unavailable")?;
        UnixListener::from_std(listener).map_err(|_| "outbox_storage_unavailable")
    }
    pub(crate) async fn connect(&self) -> Result<UnixStream> {
        if !self.check_socket()? {
            return Err("outbox_owner_unavailable");
        }
        // Socket creation and connect must finish synchronously while Darwin's
        // thread-local cwd is installed. The socket itself is nonblocking, so
        // backlog exhaustion cannot escape the caller's async deadline.
        let stream = self.with_path(connect_nonblocking)?;
        let stream = UnixStream::from_std(stream).map_err(|_| "outbox_owner_unavailable")?;
        stream
            .writable()
            .await
            .map_err(|_| "outbox_owner_unavailable")?;
        let mut error: libc::c_int = 0;
        let mut length = std::mem::size_of_val(&error) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&mut error as *mut libc::c_int).cast(),
                &mut length,
            )
        } != 0
            || error != 0
        {
            return Err("outbox_owner_unavailable");
        }
        check_peer(&stream)?;
        Ok(stream)
    }
    #[cfg(target_os = "linux")]
    fn with_path<T>(&self, operation: impl FnOnce(&str) -> std::io::Result<T>) -> Result<T> {
        operation(&format!(
            "/proc/self/fd/{}/outbox.sock",
            self.dir.as_raw_fd()
        ))
        .map_err(|_| "outbox_owner_unavailable")
    }
    #[cfg(target_os = "macos")]
    fn with_path<T>(&self, operation: impl FnOnce(&str) -> std::io::Result<T>) -> Result<T> {
        // Darwin provides per-thread cwd precisely for descriptor-anchored
        // operations without an *at syscall. Never suspend or change process cwd.
        unsafe extern "C" {
            fn pthread_fchdir_np(fd: libc::c_int) -> libc::c_int;
        }
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                // A failed reset would redirect later relative IO on this worker.
                // Stop the process rather than continuing in an unexpected root.
                if unsafe { pthread_fchdir_np(-1) } != 0 {
                    std::process::abort();
                }
            }
        }
        if unsafe { pthread_fchdir_np(self.dir.as_raw_fd()) } != 0 {
            return Err("outbox_storage_unavailable");
        }
        let _reset = Reset;
        operation("outbox.sock").map_err(|_| "outbox_owner_unavailable")
    }
}
fn connect_nonblocking(path: &str) -> std::io::Result<std::os::unix::net::UnixStream> {
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if path.len() >= address.sun_path.len() {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    address.sun_family = libc::AF_UNIX as _;
    for (out, byte) in address.sun_path.iter_mut().zip(path.bytes()) {
        *out = byte as _;
    }
    let length =
        (std::mem::offset_of!(libc::sockaddr_un, sun_path) + path.len() + 1) as libc::socklen_t;
    #[cfg(target_os = "macos")]
    {
        address.sun_len = length as u8;
    }
    #[cfg(target_os = "linux")]
    let flags = libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK;
    #[cfg(not(target_os = "linux"))]
    let flags = libc::SOCK_STREAM;
    let fd = unsafe { libc::socket(libc::AF_UNIX, flags, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(fd) };
    if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    stream.set_nonblocking(true)?;
    if unsafe { libc::connect(fd, (&address as *const libc::sockaddr_un).cast(), length) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINPROGRESS) {
            return Err(error);
        }
    }
    Ok(stream)
}
pub(crate) fn check_peer(stream: &UnixStream) -> Result<()> {
    if stream
        .peer_cred()
        .map_err(|_| "outbox_owner_unavailable")?
        .uid()
        != unsafe { libc::geteuid() }
    {
        return Err("outbox_storage_unsafe");
    }
    Ok(())
}

pub(crate) async fn authenticate(stream: &mut UnixStream) -> Result<()> {
    check_peer(stream)
}
