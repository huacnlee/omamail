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
/// Twenty files at four kilobytes of path each, and room for the JSON around
/// them. The chooser answers with metadata only, so a large answer is a
/// malformed one rather than a big attachment.
const MAX_CHOICE_BYTES: usize = 128 * 1024;
/// The same ceilings the send path holds — `MAX_ATTACHMENTS` and
/// `MAX_ATTACHMENT_TOTAL_BYTES` in `imap_host` and in `main.js`.
const MAX_CHOICES: usize = 20;
const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;

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

/// How the user names the files a draft carries.
///
/// GPUI has no file dialog of its own and this window must not grow one: a
/// chooser drawn here would be a second file browser on a desktop that already
/// ships one, and it would be drawing it from the process that is holding the
/// draft. The QML plugin answered the same question with
/// `scripts/attachment.sh pick`, which asks the desktop's FileChooser portal
/// through `omarchy-file-select` and falls back to `zenity` — a chooser in its
/// own process, so one that dies leaves the draft standing. That script is
/// already in this checkout and already tested, and the standalone client reads
/// its other helpers (`mail-transport.sh`, `image-fetch.sh`) from the same
/// place, so it is what this asks too.
///
/// It asks for `choose` rather than `pick`: this client sends an attachment by
/// path and its host opens the file at send time, so what it needs back is what
/// each file *is* — name, media type, size — and never the bytes.
pub trait FileChooser: Send + Sync {
    fn choose(&self) -> Result<String, AttachmentError>;
}

/// The shipped helper, run as a child process. No deadline, deliberately: the
/// user is looking at a file browser, and a picker killed out from under
/// somebody choosing a file is worse than one that stays open.
pub struct ScriptChooser {
    script: PathBuf,
}
impl ScriptChooser {
    pub fn new(script: PathBuf) -> Self {
        Self { script }
    }
}
impl FileChooser for ScriptChooser {
    fn choose(&self) -> Result<String, AttachmentError> {
        let output = Command::new(&self.script)
            .arg("choose")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|_| AttachmentError)?;
        if !output.status.success() || output.stdout.len() > MAX_CHOICE_BYTES {
            return Err(AttachmentError);
        }
        String::from_utf8(output.stdout).map_err(|_| AttachmentError)
    }
}

/// What the chooser said, checked before the window is allowed to believe it.
///
/// The names come off a stranger's disk and go into a `Content-Type` and a
/// `Content-Disposition` parameter, so they are held to what `main.js` and
/// `imap_host::validate_attachments` hold them to — and held here as well as
/// there, because a file the send would refuse should be refused while the user
/// is still looking at the picker rather than after they press Send.
pub fn choose_files(chooser: &dyn FileChooser) -> String {
    let answer = match chooser.choose() {
        Ok(text) => text,
        Err(_) => return refused("The file picker could not be run"),
    };
    let value: serde_json::Value = match serde_json::from_str(&answer) {
        Ok(value) => value,
        Err(_) => return refused("The file picker could not be read"),
    };
    if value.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        let error = value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .filter(|text| text.len() <= 256)
            .unwrap_or("No file was attached");
        return refused(error);
    }
    let Some(listed) = value.get("files").and_then(serde_json::Value::as_array) else {
        return refused("The file picker could not be read");
    };
    if listed.is_empty() || listed.len() > MAX_CHOICES {
        return refused("That is more files than one message can carry");
    }
    let mut files = Vec::with_capacity(listed.len());
    let mut total: u64 = 0;
    for entry in listed {
        let path = entry.get("path").and_then(serde_json::Value::as_str);
        let filename = entry.get("filename").and_then(serde_json::Value::as_str);
        let media = entry.get("mimeType").and_then(serde_json::Value::as_str);
        let size = entry.get("size").and_then(serde_json::Value::as_u64);
        let (Some(path), Some(filename), Some(media), Some(size)) = (path, filename, media, size)
        else {
            return refused("The file picker could not be read");
        };
        // Absolute and unwalked: the host opens this path, and one that still
        // has a "." or ".." in it is a traversal assembled out of a name.
        if !path.starts_with('/')
            || path.len() > 4096
            || path.chars().any(char::is_control)
            || path.split('/').any(|part| part == "." || part == "..")
        {
            return refused("That file cannot be attached from where it is");
        }
        if checked_filename(filename).is_err() || filename.contains(['"', '\\', ';']) {
            return refused("That file cannot be attached under its own name");
        }
        if !valid_media_type(media) {
            return refused("That file cannot be attached under its own type");
        }
        total = total.saturating_add(size);
        if size > MAX_ATTACHMENT_BYTES || total > MAX_ATTACHMENT_BYTES {
            return refused("That is more than the 20 MB a message can carry");
        }
        files.push(serde_json::json!({
            "path": path,
            "filename": filename,
            "mimeType": media,
            "size": size,
        }));
    }
    serde_json::to_string(&serde_json::json!({"ok": true, "files": files}))
        .unwrap_or_else(|_| refused("The file picker could not be read"))
}

fn refused(error: &str) -> String {
    serde_json::to_string(&serde_json::json!({"ok": false, "error": error}))
        .unwrap_or_else(|_| r#"{"ok":false,"error":"No file was attached"}"#.to_owned())
}

/// Two RFC 2045 tokens and nothing else, the way `imap_host` writes one into a
/// header. A copy rather than a shared helper: this is the boundary check, and
/// the send-side one has to stay standing whatever happens here.
fn valid_media_type(value: &str) -> bool {
    fn token(part: &str) -> bool {
        !part.is_empty()
            && part.len() <= 64
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&byte))
    }
    value
        .split_once('/')
        .is_some_and(|(kind, subtype)| token(kind) && token(subtype))
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
