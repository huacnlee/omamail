use std::{
    fmt,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
};

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde::Deserialize;

const MAX_ENCODED: usize = 1_398_104;
const MAX_DECODED: usize = 1_048_576;

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct AttachmentError;
impl fmt::Debug for AttachmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AttachmentError")
    }
}
impl fmt::Display for AttachmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("attachment request failed")
    }
}
impl std::error::Error for AttachmentError {}

pub trait AttachmentLauncher: Send + Sync {
    fn launch(&self, path: &Path) -> Result<(), AttachmentError>;
}
impl<T: AttachmentLauncher + ?Sized> AttachmentLauncher for Arc<T> {
    fn launch(&self, path: &Path) -> Result<(), AttachmentError> {
        (**self).launch(path)
    }
}

pub struct XdgOpenLauncher;
impl AttachmentLauncher for XdgOpenLauncher {
    fn launch(&self, path: &Path) -> Result<(), AttachmentError> {
        launch_and_wait(Path::new("/usr/bin/xdg-open"), path)
    }
}

fn launch_and_wait(program: &Path, path: &Path) -> Result<(), AttachmentError> {
    Command::new(program)
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .and_then(|mut child| child.wait())
        .and_then(|status| {
            status
                .success()
                .then_some(())
                .ok_or(std::io::ErrorKind::Other.into())
        })
        .map_err(|_| AttachmentError)
}

pub struct AttachmentHost<L> {
    #[cfg(unix)]
    root: File,
    launcher: L,
    directories: Mutex<Vec<(String, String)>>,
}
impl<L: AttachmentLauncher> AttachmentHost<L> {
    pub fn new(root: PathBuf, launcher: L) -> Result<Self, AttachmentError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let root = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(root)
                .map_err(|_| AttachmentError)?;
            if !root.metadata().map_err(|_| AttachmentError)?.is_dir() {
                return Err(AttachmentError);
            }
            Ok(Self {
                root,
                launcher,
                directories: Mutex::new(Vec::new()),
            })
        }
        #[cfg(not(unix))]
        {
            let _ = (root, launcher);
            Err(AttachmentError)
        }
    }
    pub fn open_json(&self, input: &str) -> Result<(), AttachmentError> {
        if input.len() > MAX_ENCODED + 1024 {
            return Err(AttachmentError);
        }
        let request: Request = serde_json::from_str(input).map_err(|_| AttachmentError)?;
        let filename = checked_filename(&request.filename)?;
        if request.data.len() > MAX_ENCODED {
            return Err(AttachmentError);
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(&request.data)
            .or_else(|_| STANDARD.decode(&request.data))
            .map_err(|_| AttachmentError)?;
        if bytes.len() > MAX_DECODED {
            return Err(AttachmentError);
        }
        #[cfg(not(unix))]
        return Err(AttachmentError);
        #[cfg(unix)]
        let directory = create_private_directory(&self.root)?;
        #[cfg(unix)]
        let result = (|| {
            use std::os::fd::{AsRawFd, FromRawFd};
            let relative = std::ffi::CString::new(format!("{directory}/{filename}"))
                .map_err(|_| AttachmentError)?;
            let fd = unsafe {
                libc::openat(
                    self.root.as_raw_fd(),
                    relative.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if fd < 0 {
                return Err(AttachmentError);
            }
            let mut file = unsafe { File::from_raw_fd(fd) };
            file.write_all(&bytes).map_err(|_| AttachmentError)?;
            file.sync_all().map_err(|_| AttachmentError)?;
            let target = PathBuf::from(format!(
                "/proc/{}/fd/{}/{directory}/{filename}",
                std::process::id(),
                self.root.as_raw_fd()
            ));
            self.launcher.launch(&target).map_err(|_| AttachmentError)
        })();
        #[cfg(unix)]
        if result.is_err() {
            cleanup(&self.root, &directory, filename);
            return result;
        }
        #[cfg(unix)]
        self.directories
            .lock()
            .map_err(|_| AttachmentError)?
            .push((directory, filename.to_owned()));
        Ok(())
    }
}

#[cfg(unix)]
fn create_private_directory(root: &File) -> Result<String, AttachmentError> {
    use std::os::fd::AsRawFd;
    for _ in 0..16 {
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| AttachmentError)?;
        let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let directory = format!("omamail-attachment-{suffix}");
        let name = std::ffi::CString::new(directory.as_str()).map_err(|_| AttachmentError)?;
        if unsafe { libc::mkdirat(root.as_raw_fd(), name.as_ptr(), 0o700) } == 0 {
            return Ok(directory);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::AlreadyExists {
            return Err(AttachmentError);
        }
    }
    Err(AttachmentError)
}

#[cfg(unix)]
fn cleanup(root: &File, directory: &str, filename: &str) {
    use std::os::fd::AsRawFd;
    if let Ok(file) = std::ffi::CString::new(format!("{directory}/{filename}")) {
        unsafe {
            libc::unlinkat(root.as_raw_fd(), file.as_ptr(), 0);
        }
    }
    if let Ok(directory) = std::ffi::CString::new(directory) {
        unsafe {
            libc::unlinkat(root.as_raw_fd(), directory.as_ptr(), libc::AT_REMOVEDIR);
        }
    }
}
impl<L> Drop for AttachmentHost<L> {
    fn drop(&mut self) {
        if let Ok(directories) = self.directories.get_mut() {
            for (directory, filename) in directories.drain(..) {
                #[cfg(unix)]
                cleanup(&self.root, &directory, &filename);
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    filename: String,
    data: String,
}

fn checked_filename(value: &str) -> Result<&str, AttachmentError> {
    if value.is_empty()
        || value.len() > 240
        || value == "."
        || value == ".."
        || value.contains(['/', '\\'])
        || value.chars().any(char::is_control)
    {
        Err(AttachmentError)
    } else {
        Ok(value)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::PermissionsExt,
        time::{Duration, Instant},
    };

    #[test]
    fn launcher_waits_and_requires_a_successful_exit() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("launcher");
        fs::write(&script, "#!/bin/sh\nsleep 0.1\nexit 0\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let start = Instant::now();
        launch_and_wait(&script, Path::new("ignored")).unwrap();
        assert!(start.elapsed() >= Duration::from_millis(80));
        fs::write(&script, "#!/bin/sh\nexit 7\n").unwrap();
        assert_eq!(
            launch_and_wait(&script, Path::new("ignored")),
            Err(AttachmentError)
        );
    }
}
