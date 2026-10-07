//! Save one message's original bytes as `.eml` in the user's Downloads folder,
//! or in a folder the user picked.
//!
//! The bytes come from the provider's raw-message operation (`imap.rawMessage`)
//! and are written unchanged. The `mail.exportEml` RPC contract is fixed; this
//! module owns strict account resolution's consumer side, the filename
//! policy, the bounded write, and the result shape.
use super::{Account, ExportRequest, Provider};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};

/// The product size limit: below the transport's 32 MiB response bound and
/// above the 20 MiB attachment limit. Checked before any unbounded allocation.
pub(crate) const MAX_BYTES: usize = 25 * 1024 * 1024;

/// The fixed admission and retrieval deadline, checked again before file
/// creation. After exclusive creation the synchronous write completes; a
/// storage error removes the file, but process termination can interrupt it.
pub(crate) const EXPORT_DEADLINE: Duration = Duration::from_secs(25);

/// The fixed concurrency ceiling: one export per account, at most two overall.
const GLOBAL_INFLIGHT: usize = 2;
const ACCOUNT_INFLIGHT: usize = 1;

/// The process-wide concurrency ceiling. Every RPC dispatch shares one of
/// these, so different accounts share the same process limit. Tests build
/// their own, so they neither
/// contend with each other nor leave permits held for an unrelated case.
pub(crate) struct ExportLimits {
    global: Arc<Semaphore>,
    accounts: std::sync::Mutex<HashMap<String, Arc<Semaphore>>>,
    in_flight: Arc<std::sync::Mutex<HashSet<(String, String)>>>,
}

/// Owns one duplicate-admission slot until the export ends. Dropping it on any
/// exit path frees the (account, message) pair for a later request.
struct InFlight {
    key: (String, String),
    set: Arc<std::sync::Mutex<HashSet<(String, String)>>>,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.set
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.key);
    }
}

impl ExportLimits {
    pub(crate) fn new() -> Self {
        Self {
            global: Arc::new(Semaphore::new(GLOBAL_INFLIGHT)),
            accounts: std::sync::Mutex::new(HashMap::new()),
            in_flight: Arc::new(std::sync::Mutex::new(HashSet::new())),
        }
    }

    fn account(&self, account: &str) -> Arc<Semaphore> {
        let mut accounts = self
            .accounts
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        accounts
            .entry(account.to_owned())
            .or_insert_with(|| Arc::new(Semaphore::new(ACCOUNT_INFLIGHT)))
            .clone()
    }

    /// Refuse a request whose (account, message) pair is already exporting,
    /// before any scarce capacity is taken. The returned guard releases the
    /// slot when dropped, so a later identical request is admitted again.
    fn admit(&self, account: &str, id: &str) -> Result<InFlight, &'static str> {
        let key = (account.to_owned(), id.to_owned());
        let mut in_flight = self
            .in_flight
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !in_flight.insert(key.clone()) {
            return Err("mail_export_in_flight");
        }
        Ok(InFlight {
            key,
            set: self.in_flight.clone(),
        })
    }

    /// Take the account permit first, then the global one. A queued second
    /// request for the same account therefore holds no global permit, so it can
    /// never starve a different account. Both waits share the operation
    /// deadline.
    async fn acquire(
        &self,
        account: &str,
        deadline: tokio::time::Instant,
    ) -> Result<(OwnedSemaphorePermit, OwnedSemaphorePermit), &'static str> {
        let global = self.global.clone();
        let account = self.account(account);
        let account = tokio::time::timeout_at(deadline, account.acquire_owned())
            .await
            .map_err(|_| "request_timed_out")?
            .map_err(|_| "request_cancelled")?;
        let global = tokio::time::timeout_at(deadline, global.acquire_owned())
            .await
            .map_err(|_| "request_timed_out")?
            .map_err(|_| "request_cancelled")?;
        Ok((account, global))
    }
}

static PROCESS_LIMITS: OnceLock<ExportLimits> = OnceLock::new();

/// The concurrency ceiling every dispatch in this backend process shares.
pub(crate) fn process_limits() -> &'static ExportLimits {
    PROCESS_LIMITS.get_or_init(ExportLimits::new)
}

/// An in-process cancellation signal. The select observes it before the commit
/// point; the drop guard raises it when the future is dropped (a disconnected
/// client or an expired RPC) so the provider fetch is stopped as well.
#[derive(Clone, Default)]
struct Cancellation {
    inner: Arc<CancelInner>,
}

#[derive(Default)]
struct CancelInner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl Cancellation {
    fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    async fn cancelled(&self) {
        loop {
            let notified = self.inner.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// The fixed per-request controls. The token names the provider fetch in
/// the IMAP cancel registry; the signal lets the export stop it before commit.
/// Cloning shares both, so the drop guard can cancel a request it did not make.
#[derive(Clone)]
pub(crate) struct ExportControl {
    pub(crate) token: String,
    cancel: Cancellation,
}

impl ExportControl {
    pub(crate) fn new() -> Self {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        Self {
            token: format!("export-{}-{sequence}", std::process::id()),
            cancel: Cancellation::default(),
        }
    }
}

/// Stop the provider fetch when the export is dropped before it commits. The
/// synchronous write cannot be interrupted: once it starts, the operation
/// returns success, so the guard is disarmed at that point rather than
/// cancelling a file that is already on disk.
struct ControlGuard {
    account: String,
    token: String,
    cancel: Cancellation,
    armed: bool,
}

impl ControlGuard {
    fn new(account: &str, control: &ExportControl) -> Self {
        Self {
            account: account.to_owned(),
            token: control.token.clone(),
            cancel: control.cancel.clone(),
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ControlGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.armed = false;
        self.cancel.cancel();
        let account = std::mem::take(&mut self.account);
        let token = std::mem::take(&mut self.token);
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = crate::providers::imap::call(
                    "imap.cancel",
                    &json!({"accountId": account, "requestToken": token}),
                )
                .await;
            });
        }
    }
}

/// Fetches the raw provider result (`{"bytes": n, "data": <base64>}`) for one
/// account-qualified message. The backend supplies the IMAP-backed one; the
/// request token is what the IMAP cancel registry can name.
pub(crate) trait ExportAdapter: Send + Sync {
    fn raw<'a>(
        &'a self,
        account: &'a Account,
        id: &'a str,
        request_token: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>>;
}

pub(crate) async fn export_with(
    request: ExportRequest,
    adapter: &impl ExportAdapter,
    downloads: &Path,
    refusals: &Value,
    limits: &ExportLimits,
    control: &ExportControl,
) -> Result<Value, &'static str> {
    // Provider ceiling: only Outlook and generic IMAP share the native path.
    if !matches!(request.account.provider, Provider::Outlook | Provider::Imap) {
        return Err("mail_export_unsupported");
    }
    if !crate::providers::can(request.account.provider.id(), "emlExport", refusals) {
        return Err("mail_export_unsupported");
    }
    // Reject a malformed `<uid>:<folder>` before any credential or network
    // work, and derive the canonical identity for admission. Leading zeros on
    // the UID (e.g. "01:INBOX") must not make the same message look distinct.
    let (uid, folder) = crate::providers::imap::message_id(&request.id)
        .map_err(|_| "mail_export_message_invalid")?;
    let canonical_id = format!("{uid}:{folder}");

    // A repeated (account, message) request is refused, not queued behind the
    // one already saving it. This happens before the cancellation guard exists,
    // so a refusal never cancels an in-flight export that shares a control.
    let _admission = limits.admit(&request.account.id, &canonical_id)?;

    let mut guard = ControlGuard::new(&request.account.id, control);
    let result = run_export(&request, adapter, downloads, limits, control).await;
    // `Ok` means the complete file is committed. A cancellation that lost the
    // race must not also be reported as a failure, and the guard must not
    // cancel the provider fetch that produced the file.
    if result.is_ok() {
        guard.disarm();
    }
    result
}

async fn run_export(
    request: &ExportRequest,
    adapter: &impl ExportAdapter,
    downloads: &Path,
    limits: &ExportLimits,
    control: &ExportControl,
) -> Result<Value, &'static str> {
    let deadline = tokio::time::Instant::now() + EXPORT_DEADLINE;
    if control.cancel.is_cancelled() {
        return Err("request_cancelled");
    }
    // The ceiling and the fetch both sit under the operation deadline, and both
    // stop as soon as a cancellation is observed.
    let _permits = tokio::select! {
        biased;
        _ = control.cancel.cancelled() => return Err("request_cancelled"),
        result = limits.acquire(&request.account.id, deadline) => result?,
    };
    let fetched = tokio::select! {
        biased;
        _ = control.cancel.cancelled() => return Err("request_cancelled"),
        result = tokio::time::timeout_at(
            deadline,
            adapter.raw(&request.account, &request.id, &control.token),
        ) => result.map_err(|_| "request_timed_out")??,
    };
    let data = fetched["data"].as_str().ok_or("mail_export_incomplete")?;
    // Refuse an over-limit payload before decoding it.
    if data.len() > MAX_BYTES.div_ceil(3) * 4 + 1024 {
        return Err("mail_export_too_large");
    }
    let bytes = decode(data)?;
    if bytes.len() > MAX_BYTES {
        return Err("mail_export_too_large");
    }

    let filename = export_filename(&request.suggested_name);
    let fallback = filename.clone();
    let byte_count = bytes.len();
    let downloads = downloads.to_path_buf();
    let deadline_std = deadline.into_std();
    let cancel = control.cancel.clone();
    // Downloads is created on first use. A folder the user picked must already
    // exist and pass the same ownership checks: a picker answer is never a
    // reason to create directories.
    let create = request.directory.is_none();
    // Storage is synchronous create/write/fsync, so it runs on a blocking
    // worker rather than a Tokio worker. The destination directory is anchored
    // to a descriptor before the deadline is observed, so a path swap after the
    // check cannot redirect the write. The exclusive create is the commit
    // point: a cancellation or an expired deadline observed before it leaves no
    // file; after it the write completes and success is returned.
    let path = tokio::task::spawn_blocking(move || {
        let dir = crate::platform::private_fs::directories(&downloads, &[], create)
            .map_err(|_| "mail_export_write_failed")?
            .ok_or("mail_export_write_failed")?;
        write_unique_in(&downloads, &dir, &filename, &bytes, deadline_std, &cancel)
    })
    .await
    .map_err(|_| "request_cancelled")??;
    let saved = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or(fallback);
    Ok(json!({
        "accountId": request.account.id,
        "messageId": request.id,
        "path": path,
        "filename": saved,
        "bytes": byte_count,
    }))
}

fn decode(data: &str) -> Result<Vec<u8>, &'static str> {
    let compact: String = data.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    STANDARD
        .decode(&compact)
        .map_err(|_| "mail_export_incomplete")
}

/// A safe `.eml` basename built from the untrusted subject hint. The hint is
/// reduced to a basename, control characters and separators are dropped, the
/// name is capped, and `.eml` is appended exactly once.
pub(crate) fn export_filename(suggested: &str) -> String {
    let base: String = crate::attachment::safe_filename(suggested)
        .chars()
        .map(|c| {
            if matches!(c, ':' | '"' | '<' | '>' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Downloads is also used by the Windows host. A subject must never become
    // a device name or an invalid native filename there.
    let device = base.split('.').next().unwrap_or("").to_ascii_uppercase();
    let base = if matches!(
        device.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || (device.starts_with("COM") || device.starts_with("LPT"))
        && device.len() == 4
        && matches!(device.as_bytes()[3], b'1'..=b'9')
    {
        format!("message-{base}")
    } else {
        base
    };
    let base = if base == "attachment" {
        "message".to_owned()
    } else {
        base
    };
    let stem = if base.to_lowercase().ends_with(".eml") {
        &base[..base.len() - 4]
    } else {
        base.as_str()
    };
    let stem = stem.trim_end_matches([' ', '.']);
    let stem = if stem.is_empty() { "message" } else { stem };
    let mut end = stem.len().min(240 - 4);
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}.eml", &stem[..end])
}

// Anchored, handle-relative exclusive create. The destination directory is
// pinned by a descriptor so a rename/symlink swap of the path cannot redirect
// the file; the final component is opened with O_NOFOLLOW/O_EXCL so a symlink
// or an existing name is never followed or overwritten.
#[cfg(unix)]
fn write_unique_in(
    directory: &Path,
    dir: &std::fs::File,
    filename: &str,
    bytes: &[u8],
    deadline: std::time::Instant,
    cancel: &Cancellation,
) -> Result<PathBuf, &'static str> {
    use std::{
        ffi::CString,
        fs::File,
        io::Write,
        os::fd::{AsRawFd, FromRawFd},
    };
    let path = Path::new(filename);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let suffix = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    let dir_fd = dir.as_raw_fd();
    for n in 1..1000 {
        // Recheck the deadline and cancellation before each create attempt: a
        // collision retry must not outlive the operation deadline or commit
        // after a disconnect.
        if cancel.is_cancelled() {
            return Err("request_cancelled");
        }
        if std::time::Instant::now() >= deadline {
            return Err("request_timed_out");
        }
        let candidate = if n == 1 {
            filename.to_owned()
        } else {
            format!("{stem} ({n}){suffix}")
        };
        let Ok(cname) = CString::new(candidate.as_bytes().to_vec()) else {
            continue;
        };
        let fd = unsafe {
            libc::openat(
                dir_fd,
                cname.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd >= 0 {
            let mut file = unsafe { File::from_raw_fd(fd) };
            if crate::platform::private_fs::validate_private_file(&file).is_err()
                || file.write_all(bytes).and_then(|_| file.sync_all()).is_err()
            {
                unsafe { libc::unlinkat(dir_fd, cname.as_ptr(), 0) };
                return Err("mail_export_write_failed");
            }
            return Ok(directory.join(&candidate));
        }
        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::AlreadyExists {
            continue;
        }
        return Err("mail_export_write_failed");
    }
    Err("mail_export_write_failed")
}

#[cfg(windows)]
fn write_unique_in(
    _directory: &Path,
    dir: &std::fs::File,
    filename: &str,
    bytes: &[u8],
    deadline: std::time::Instant,
    cancel: &Cancellation,
) -> Result<PathBuf, &'static str> {
    if cancel.is_cancelled() {
        return Err("request_cancelled");
    }
    if std::time::Instant::now() >= deadline {
        return Err("request_timed_out");
    }
    crate::platform::private_fs::write_unique(dir, filename, bytes)
        .map_err(|_| "mail_export_write_failed")
}

// Anchor the directory then create the file relative to that handle. The
// export path calls `write_unique_in` directly so it can observe the deadline
// between the anchor and the exclusive create; tests use this wrapper with a
// far-future deadline and no cancellation.
#[cfg(test)]
fn write_unique(directory: &Path, filename: &str, bytes: &[u8]) -> Result<PathBuf, &'static str> {
    let dir = crate::platform::private_fs::directories(directory, &[], true)
        .map_err(|_| "mail_export_write_failed")?
        .ok_or("mail_export_write_failed")?;
    write_unique_in(
        directory,
        &dir,
        filename,
        bytes,
        std::time::Instant::now() + Duration::from_secs(3600),
        &Cancellation::default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    fn scratch(name: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "omamail-export-{}-{}-{}",
            std::process::id(),
            name,
            N.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn a_chosen_folder_must_be_an_absolute_plain_path() {
        if crate::mail::tests::isolated() {
            return;
        }
        let fixture = crate::mail::tests::account_fixture(json!({
            "version": 1,
            "activeId": "imap:owner@example.org",
            "accounts": [{"provider": "imap", "email": "owner@example.org",
                "imap": {"username": "owner@example.org"}}]
        }));
        let before = crate::mail::tests::fixture_tree(&fixture.root);
        let parse = |directory: Value| {
            ExportRequest::try_from(&json!({
                "account": "imap:owner@example.org", "id": "1:INBOX", "directory": directory
            }))
            .map(|request| request.directory)
        };
        assert_eq!(
            parse(json!("/home/owner/Mail")),
            Ok(Some(PathBuf::from("/home/owner/Mail")))
        );
        for refused in [
            json!(""),
            json!("Mail"),
            json!("./Mail"),
            json!("/home/owner/../other"),
            json!("/home/owner/./Mail"),
            json!("/home/owner//Mail"),
            json!("/home/owner/Mail/"),
            json!("/home/owner/Mail\n"),
            json!("/home/owner/\u{0}Mail"),
            json!(null),
            json!(7),
        ] {
            assert_eq!(parse(refused.clone()), Err("invalid_params"), "{refused}");
        }
        let request = ExportRequest::try_from(&json!({
            "account": "imap:owner@example.org", "id": "1:INBOX"
        }))
        .unwrap();
        assert_eq!(request.directory, None, "no folder means Downloads");
        assert_eq!(crate::mail::tests::fixture_tree(&fixture.root), before);
    }

    #[test]
    fn export_requires_an_explicit_account_without_creating_state() {
        if crate::mail::tests::isolated() {
            return;
        }
        let fixture = crate::mail::tests::account_fixture(json!({
            "version": 1,
            "activeId": "imap:owner@example.org",
            "accounts": [{"provider": "imap", "email": "owner@example.org",
                "imap": {"username": "owner@example.org"}}]
        }));
        let before = crate::mail::tests::fixture_tree(&fixture.root);
        assert_eq!(
            ExportRequest::try_from(&json!({"id": "1:INBOX"})).map(|_| ()),
            Err("invalid_params")
        );
        for account in [
            "",
            "imap:missing@example.org",
            "imap:owner@example.org\n",
            "imap:owner@example.org\r",
            "imap:owner@example.org\r\n",
            "imap:owner@example.org\0",
        ] {
            assert_eq!(
                ExportRequest::try_from(&json!({"account": account, "id": "1:INBOX"})).map(|_| ()),
                Err("mail_account_unknown")
            );
            assert_eq!(crate::mail::tests::fixture_tree(&fixture.root), before);
        }
        for params in [
            json!({"account": "imap:owner@example.org", "id": "1:INBOX", "path": "/tmp/other.eml"}),
            json!({"account": "imap:owner@example.org", "id": "1:INBOX", "suggestedName": "subject\n"}),
            json!({"account": "imap:owner@example.org", "id": "1:INBOX\0"}),
        ] {
            assert_eq!(
                ExportRequest::try_from(&params).map(|_| ()),
                Err("invalid_params")
            );
            assert_eq!(crate::mail::tests::fixture_tree(&fixture.root), before);
        }
        let request =
            ExportRequest::try_from(&json!({"account": "imap:owner@example.org", "id": "1:INBOX"}))
                .unwrap();
        assert_eq!(request.account.id, "imap:owner@example.org");
        assert_eq!(crate::mail::tests::fixture_tree(&fixture.root), before);
    }

    #[test]
    fn names_are_safe_and_get_one_eml_suffix() {
        assert_eq!(export_filename("Project update"), "Project update.eml");
        assert_eq!(export_filename("report.eml"), "report.eml");
        assert_eq!(export_filename("report.EML"), "report.eml");
        assert_eq!(export_filename("../../x\\invoice"), "invoice.eml");
        assert_eq!(export_filename(""), "message.eml");
        assert_eq!(export_filename(".."), "message.eml");
        assert_eq!(export_filename("a\nb"), "a_b.eml");
        assert_eq!(
            export_filename("Re: Project update?"),
            "Re_ Project update_.eml"
        );
        assert_eq!(export_filename("NUL.eml"), "message-NUL.eml");
        assert_eq!(export_filename("com1"), "message-com1.eml");
        assert_eq!(export_filename("AUX.notes.eml"), "message-AUX.notes.eml");
        let long = export_filename(&format!("{}.eml", "x".repeat(400)));
        assert!(long.len() <= 240);
        assert!(long.ends_with(".eml"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_inherited_read_acl_never_exposes_exported_bytes() {
        let dir = scratch("inherited-acl");
        assert!(
            std::process::Command::new("/bin/chmod")
                .args(["+a", "everyone allow read,file_inherit"])
                .arg(&dir)
                .status()
                .unwrap()
                .success()
        );
        let result = write_unique(&dir, "private.eml", b"private message bytes");
        assert_eq!(result, Err("mail_export_write_failed"));
        assert!(
            !dir.join("private.eml").exists(),
            "a refused file must be removed"
        );
        assert!(
            std::process::Command::new("/bin/chmod")
                .arg("-N")
                .arg(&dir)
                .status()
                .unwrap()
                .success()
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn duplicate_names_never_overwrite() {
        let dir = scratch("dup");
        let first = write_unique(&dir, "note.eml", b"one").unwrap();
        let second = write_unique(&dir, "note.eml", b"two").unwrap();
        assert_eq!(first.file_name().unwrap(), "note.eml");
        assert_eq!(second.file_name().unwrap(), "note (2).eml");
        assert_eq!(fs::read(&first).unwrap(), b"one");
        assert_eq!(fs::read(&second).unwrap(), b"two");
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_target_is_never_followed_and_permits_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("link");
        let victim = dir.join("victim");
        fs::write(&victim, b"keep").unwrap();
        std::os::unix::fs::symlink(&victim, dir.join("note.eml")).unwrap();
        let saved = write_unique(&dir, "note.eml", b"payload").unwrap();
        assert_eq!(saved.file_name().unwrap(), "note (2).eml");
        assert_eq!(fs::read(&victim).unwrap(), b"keep");
        assert_eq!(
            fs::metadata(&saved).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(dir).unwrap();
    }

    struct Fake {
        payload: Value,
    }
    impl ExportAdapter for Fake {
        fn raw<'a>(
            &'a self,
            _account: &'a Account,
            _id: &'a str,
            _request_token: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
            let payload = self.payload.clone();
            Box::pin(async move { Ok(payload) })
        }
    }

    /// A fetch that stays in flight long enough for another export to be
    /// attempted, and records how many ran at once.
    struct Counting {
        current: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
    }
    impl Counting {
        fn new() -> Self {
            Self {
                current: Arc::new(AtomicUsize::new(0)),
                peak: Arc::new(AtomicUsize::new(0)),
            }
        }
    }
    impl ExportAdapter for Counting {
        fn raw<'a>(
            &'a self,
            _account: &'a Account,
            _id: &'a str,
            _request_token: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
            let current = self.current.clone();
            let peak = self.peak.clone();
            Box::pin(async move {
                let now = current.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
                current.fetch_sub(1, Ordering::SeqCst);
                let bytes = b"Subject: hi\r\n\r\nbody";
                Ok(json!({"bytes": bytes.len(), "data": STANDARD.encode(bytes)}))
            })
        }
    }

    /// A fetch that never answers, so the operation deadline is what ends it.
    struct Hanging {
        started: Arc<Notify>,
    }
    impl ExportAdapter for Hanging {
        fn raw<'a>(
            &'a self,
            _account: &'a Account,
            _id: &'a str,
            _request_token: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
            let started = self.started.clone();
            Box::pin(async move {
                started.notify_one();
                std::future::pending::<Result<Value, &'static str>>().await
            })
        }
    }

    /// Account "a" blocks on a gate; any other account returns immediately.
    /// Proves a queued second request for "a" does not hold a global permit.
    struct Gated {
        a_started: Arc<Notify>,
        b_started: Arc<Notify>,
        gate: Arc<Semaphore>,
    }
    impl ExportAdapter for Gated {
        fn raw<'a>(
            &'a self,
            account: &'a Account,
            _id: &'a str,
            _request_token: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
            let account = account.id.clone();
            let a_started = self.a_started.clone();
            let b_started = self.b_started.clone();
            let gate = self.gate.clone();
            Box::pin(async move {
                if account.starts_with("imap:a") {
                    a_started.notify_one();
                    let _ = gate.acquire().await;
                } else {
                    b_started.notify_one();
                }
                let bytes = b"Subject: hi\r\n\r\nbody";
                Ok(json!({"bytes": bytes.len(), "data": STANDARD.encode(bytes)}))
            })
        }
    }

    fn request() -> ExportRequest {
        request_for("imap:person@example.test")
    }

    fn request_for(account: &str) -> ExportRequest {
        ExportRequest {
            account: Account {
                id: account.into(),
                provider: Provider::Imap,
            },
            id: "42:INBOX".into(),
            suggested_name: "Project update".into(),
            directory: None,
        }
    }

    async fn run(payload: Value) -> Result<Value, &'static str> {
        let dir = scratch("run");
        let limits = ExportLimits::new();
        let control = ExportControl::new();
        let result = export_with(
            request(),
            &Fake { payload },
            &dir,
            &Value::Null,
            &limits,
            &control,
        )
        .await;
        fs::remove_dir_all(dir).ok();
        result
    }

    #[tokio::test]
    async fn a_missing_payload_column_is_incomplete() {
        assert_eq!(
            run(json!({"bytes": 1})).await,
            Err("mail_export_incomplete")
        );
        assert_eq!(
            run(json!({"data": "not base64!"})).await,
            Err("mail_export_incomplete")
        );
    }

    #[tokio::test]
    async fn an_over_limit_payload_is_refused_before_decoding() {
        let huge = "A".repeat(MAX_BYTES.div_ceil(3) * 4 + 2048);
        assert_eq!(
            run(json!({"data": huge})).await,
            Err("mail_export_too_large")
        );
    }

    #[tokio::test]
    async fn a_committed_export_reports_the_exact_file_and_bytes() {
        let dir = scratch("commit");
        let bytes = b"Subject: hi\r\n\r\nbody \xc3\xa9";
        let payload = json!({"bytes": bytes.len(), "data": STANDARD.encode(bytes)});
        let limits = ExportLimits::new();
        let control = ExportControl::new();
        let result = export_with(
            request(),
            &Fake { payload },
            &dir,
            &Value::Null,
            &limits,
            &control,
        )
        .await
        .unwrap();
        assert_eq!(result["accountId"], "imap:person@example.test");
        assert_eq!(result["messageId"], "42:INBOX");
        assert_eq!(result["filename"], "Project update.eml");
        assert_eq!(result["bytes"], bytes.len());
        let saved = PathBuf::from(result["path"].as_str().unwrap());
        assert_eq!(saved.parent().unwrap(), dir);
        assert_eq!(fs::read(&saved).unwrap(), bytes);
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn malformed_message_ids_use_the_export_refusal() {
        let dir = scratch("invalid-id");
        for id in [
            "",
            "INBOX",
            "0:INBOX",
            "4294967296:INBOX",
            "1:",
            "1:IN\nBOX",
        ] {
            let mut request = request();
            request.id = id.into();
            assert_eq!(
                export_with(
                    request,
                    &Fake { payload: json!({}) },
                    &dir,
                    &Value::Null,
                    &ExportLimits::new(),
                    &ExportControl::new()
                )
                .await,
                Err("mail_export_message_invalid")
            );
        }
        assert!(fs::read_dir(&dir).unwrap().next().is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn an_unsupported_provider_is_refused_before_any_fetch() {
        let dir = scratch("provider");
        let mut request = request();
        request.account.provider = Provider::Gmail;
        assert_eq!(
            export_with(
                request,
                &Fake { payload: json!({}) },
                &dir,
                &Value::Null,
                &ExportLimits::new(),
                &ExportControl::new(),
            )
            .await,
            Err("mail_export_unsupported")
        );
        assert!(fs::read_dir(&dir).unwrap().next().is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    // A repeated request for the same message is refused, not queued: only one
    // (account, message) pair is ever in flight, and the others get a refusal
    // rather than waiting their turn to write a second copy.
    #[tokio::test]
    async fn a_duplicate_request_is_refused_not_queued() {
        let dir = scratch("duplicate");
        let limits = ExportLimits::new();
        let control = ExportControl::new();
        let adapter = Counting::new();
        let results = futures_util::future::join_all(
            (0..3).map(|_| export_with(request(), &adapter, &dir, &Value::Null, &limits, &control)),
        )
        .await;
        let ok = results.iter().filter(|r| r.is_ok()).count();
        let refused = results
            .iter()
            .filter(|r| r.as_ref().err() == Some(&"mail_export_in_flight"))
            .count();
        assert_eq!(ok, 1, "exactly one identical export commits");
        assert_eq!(refused, 2, "the other two are refused as in flight");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "one output file");
        fs::remove_dir_all(dir).unwrap();
    }

    // Equivalent ids name the same message, so a second request with a leading
    // zero on the UID is still refused as an in-flight duplicate.
    #[tokio::test]
    async fn equivalent_ids_share_one_admission_slot() {
        let dir = scratch("equivalent");
        let limits = ExportLimits::new();
        let control = ExportControl::new();
        let adapter = Counting::new();
        let mut first = request();
        first.id = "01:INBOX".into();
        let mut second = request();
        second.id = "1:INBOX".into();
        let results = futures_util::future::join_all([
            export_with(first, &adapter, &dir, &Value::Null, &limits, &control),
            export_with(second, &adapter, &dir, &Value::Null, &limits, &control),
        ])
        .await;
        let ok = results.iter().filter(|r| r.is_ok()).count();
        let refused = results
            .iter()
            .filter(|r| r.as_ref().err() == Some(&"mail_export_in_flight"))
            .count();
        assert_eq!(ok, 1, "exactly one of the equivalent ids commits");
        assert_eq!(refused, 1, "the other is refused as in flight");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "one output file");
        fs::remove_dir_all(dir).unwrap();
    }

    // Different messages on one account still run one at a time.
    #[tokio::test]
    async fn one_account_exports_one_message_at_a_time() {
        let dir = scratch("per-account");
        let limits = ExportLimits::new();
        let control = ExportControl::new();
        let adapter = Counting::new();
        let results = futures_util::future::join_all((0..3).map(|n| {
            let mut request = request();
            request.id = format!("{}:INBOX", n + 1);
            export_with(request, &adapter, &dir, &Value::Null, &limits, &control)
        }))
        .await;
        assert!(
            results.iter().all(Result::is_ok),
            "three different messages commit"
        );
        assert_eq!(adapter.peak.load(Ordering::SeqCst), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    // Two accounts may run together; a third waits for one of them.
    #[tokio::test]
    async fn at_most_two_exports_run_across_accounts() {
        let dir = scratch("global");
        let limits = ExportLimits::new();
        let control = ExportControl::new();
        let adapter = Counting::new();
        let results = futures_util::future::join_all(
            [
                "imap:a@example.test",
                "imap:b@example.test",
                "imap:c@example.test",
            ]
            .map(request_for)
            .map(|request| export_with(request, &adapter, &dir, &Value::Null, &limits, &control)),
        )
        .await;
        assert!(results.iter().all(Result::is_ok), "every export committed");
        assert_eq!(adapter.peak.load(Ordering::SeqCst), 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn an_export_that_reaches_the_deadline_writes_nothing() {
        let dir = scratch("deadline");
        let adapter = Hanging {
            started: Arc::new(Notify::new()),
        };
        assert_eq!(
            export_with(
                request(),
                &adapter,
                &dir,
                &Value::Null,
                &ExportLimits::new(),
                &ExportControl::new(),
            )
            .await,
            Err("request_timed_out")
        );
        assert!(fs::read_dir(&dir).unwrap().next().is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    // The public cancellation path is dropping the request: a client that
    // disconnects drops the export future, whose guard cancels the in-flight
    // fetch before the commit point. No file is written.
    #[tokio::test]
    async fn dropping_the_request_stops_the_fetch_before_commit() {
        let started = Arc::new(Notify::new());
        let dir = scratch("drop");
        let worker_dir = dir.clone();
        let worker_started = started.clone();
        let handle = tokio::spawn(async move {
            let adapter = Hanging {
                started: worker_started,
            };
            export_with(
                request(),
                &adapter,
                &worker_dir,
                &Value::Null,
                &ExportLimits::new(),
                &ExportControl::new(),
            )
            .await
        });
        started.notified().await;
        handle.abort();
        assert!(handle.await.is_err(), "the dropped request is cancelled");
        assert!(fs::read_dir(&dir).unwrap().next().is_none());
        fs::remove_dir_all(dir).unwrap();
    }

    // A queued second request for the same account must not hold a global
    // permit, or a different account is starved behind it. The account permit
    // is taken before the global one, so account b runs alongside account a.
    #[tokio::test]
    async fn a_queued_same_account_request_does_not_block_another_account() {
        fn spawn_one(
            dir: &Path,
            limits: &Arc<ExportLimits>,
            control: &ExportControl,
            adapter: &Arc<Gated>,
            request: ExportRequest,
        ) -> tokio::task::JoinHandle<Result<Value, &'static str>> {
            let dir = dir.to_path_buf();
            let limits = limits.clone();
            let control = control.clone();
            let adapter = adapter.clone();
            tokio::spawn(async move {
                export_with(
                    request,
                    adapter.as_ref(),
                    &dir,
                    &Value::Null,
                    limits.as_ref(),
                    &control,
                )
                .await
            })
        }

        let dir = scratch("fairness");
        let limits = Arc::new(ExportLimits::new());
        let control = ExportControl::new();
        let a_started = Arc::new(Notify::new());
        let b_started = Arc::new(Notify::new());
        let gate = Arc::new(Semaphore::new(0));
        let adapter = Arc::new(Gated {
            a_started: a_started.clone(),
            b_started: b_started.clone(),
            gate: gate.clone(),
        });

        let a1 = spawn_one(
            &dir,
            &limits,
            &control,
            &adapter,
            request_for("imap:a@example.test"),
        );
        a_started.notified().await;

        let mut a2_request = request_for("imap:a@example.test");
        a2_request.id = "2:INBOX".into();
        let a2 = spawn_one(&dir, &limits, &control, &adapter, a2_request);
        let b1 = spawn_one(
            &dir,
            &limits,
            &control,
            &adapter,
            request_for("imap:b@example.test"),
        );

        let b_ran = tokio::time::timeout(Duration::from_millis(500), b_started.notified())
            .await
            .is_ok();
        assert!(
            b_ran,
            "account b must run while account a is still exporting"
        );

        gate.add_permits(3);
        assert!(a1.await.unwrap().is_ok());
        assert!(a2.await.unwrap().is_ok());
        assert!(b1.await.unwrap().is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    // A picked folder receives the file, and one that is missing is refused
    // rather than created: only Downloads is made on first use.
    #[tokio::test]
    async fn a_chosen_folder_is_written_to_but_never_created() {
        let dir = scratch("chosen");
        let limits = ExportLimits::new();
        let adapter = Fake {
            payload: json!({"bytes": 4, "data": STANDARD.encode(b"body")}),
        };
        let mut chosen = request();
        chosen.directory = Some(dir.clone());
        let saved = export_with(
            chosen,
            &adapter,
            &dir,
            &Value::Null,
            &limits,
            &ExportControl::new(),
        )
        .await
        .unwrap();
        assert_eq!(
            Path::new(saved["path"].as_str().unwrap()),
            dir.join("Project update.eml")
        );
        assert_eq!(fs::read(dir.join("Project update.eml")).unwrap(), b"body");

        let missing = dir.join("not-there");
        let mut chosen = request();
        chosen.directory = Some(missing.clone());
        assert_eq!(
            export_with(
                chosen,
                &adapter,
                &missing,
                &Value::Null,
                &limits,
                &ExportControl::new()
            )
            .await,
            Err("mail_export_write_failed")
        );
        assert!(!missing.exists(), "a picked folder is never created");

        let downloads = dir.join("Downloads");
        let made = export_with(
            request(),
            &adapter,
            &downloads,
            &Value::Null,
            &limits,
            &ExportControl::new(),
        )
        .await;
        assert!(made.is_ok(), "{made:?}");
        assert!(downloads.join("Project update.eml").is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    // A swap of the destination directory after it is anchored must not
    // redirect the file: the handle still names the original directory.
    #[cfg(unix)]
    #[test]
    fn a_parent_directory_swap_does_not_redirect_the_write() {
        let dir = scratch("swap");
        let target = dir.join("Downloads");
        fs::create_dir_all(&target).unwrap();
        let anchored = crate::platform::private_fs::directories(&target, &[], true)
            .unwrap()
            .unwrap();
        let outside = dir.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let renamed = dir.join("Downloads-original");
        fs::rename(&target, &renamed).unwrap();
        std::os::unix::fs::symlink(&outside, &target).unwrap();
        let _ = write_unique_in(
            &target,
            &anchored,
            "note.eml",
            b"payload",
            std::time::Instant::now() + Duration::from_secs(3600),
            &Cancellation::default(),
        )
        .unwrap();
        assert!(
            renamed.join("note.eml").exists(),
            "written to the anchored directory"
        );
        assert!(
            !outside.join("note.eml").exists(),
            "not redirected through the symlink"
        );
        assert_eq!(fs::read(renamed.join("note.eml")).unwrap(), b"payload");
        fs::remove_dir_all(dir).unwrap();
    }

    // A collision retry must not outlive the deadline: it is rechecked before
    // each exclusive create, so an expired deadline refuses even when the first
    // candidate name already exists.
    #[test]
    fn a_collision_does_not_bypass_an_expired_deadline() {
        let dir = scratch("deadline-collision");
        fs::write(dir.join("note.eml"), b"existing").unwrap();
        let anchored = crate::platform::private_fs::directories(&dir, &[], true)
            .unwrap()
            .unwrap();
        let result = write_unique_in(
            &dir,
            &anchored,
            "note.eml",
            b"payload",
            std::time::Instant::now() - Duration::from_secs(1),
            &Cancellation::default(),
        );
        assert_eq!(result, Err("request_timed_out"));
        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            1,
            "no extra file is created"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
