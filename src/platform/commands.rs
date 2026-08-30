use std::{
    fmt,
    io::{Read as _, Write as _},
    net::{IpAddr, ToSocketAddrs as _},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use url::{Host, Url};

use super::secrets::Secret;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeyOperation {
    AuthStatus,
    AuthLogin,
    AuthLogout,
}

pub enum TransportOperation {
    Mail {
        request: Secret,
    },
    ImageFetch {
        url: String,
    },
    Unsubscribe {
        url: String,
        content_type: String,
        body: String,
    },
}

impl TransportOperation {
    pub fn image_fetch(url: impl Into<String>) -> Self {
        Self::ImageFetch { url: url.into() }
    }
    pub fn unsubscribe(
        url: impl Into<String>,
        content_type: impl Into<String>,
        body: impl Into<String>,
    ) -> Self {
        Self::Unsubscribe {
            url: url.into(),
            content_type: content_type.into(),
            body: body.into(),
        }
    }
}

impl fmt::Debug for TransportOperation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Mail { .. } => f.write_str("TransportOperation::Mail([REDACTED])"),
            Self::ImageFetch { .. } => f.write_str("TransportOperation::ImageFetch([REDACTED])"),
            Self::Unsubscribe { .. } => f.write_str("TransportOperation::Unsubscribe([REDACTED])"),
        }
    }
}

pub trait Resolver: Send + Sync {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>>;
}

pub struct SystemResolver;

impl Resolver for SystemResolver {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>> {
        (host, port)
            .to_socket_addrs()
            .map(|addresses| addresses.map(|address| address.ip()).collect())
    }
}

#[derive(Clone)]
pub struct CommandPolicy {
    hey: PathBuf,
    mail_transport: PathBuf,
    image_fetch: PathBuf,
    unsubscribe: PathBuf,
    resolver: Arc<dyn Resolver>,
}

impl fmt::Debug for CommandPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CommandPolicy")
            .field("hey", &self.hey)
            .field("mail_transport", &self.mail_transport)
            .field("image_fetch", &self.image_fetch)
            .field("unsubscribe", &self.unsubscribe)
            .finish_non_exhaustive()
    }
}

impl CommandPolicy {
    pub fn new(
        hey: PathBuf,
        mail_transport: PathBuf,
        image_fetch: PathBuf,
        unsubscribe: PathBuf,
    ) -> Self {
        Self::with_resolver(
            hey,
            mail_transport,
            image_fetch,
            unsubscribe,
            Arc::new(SystemResolver),
        )
    }

    pub fn with_resolver(
        hey: PathBuf,
        mail_transport: PathBuf,
        image_fetch: PathBuf,
        unsubscribe: PathBuf,
        resolver: Arc<dyn Resolver>,
    ) -> Self {
        Self {
            hey,
            mail_transport,
            image_fetch,
            unsubscribe,
            resolver,
        }
    }

    pub fn prepare_hey(
        &self,
        operation: HeyOperation,
        deadline: Duration,
    ) -> Result<PreparedCommand, CommandError> {
        let args = match operation {
            HeyOperation::AuthStatus => ["auth", "status", "--json"].as_slice(),
            HeyOperation::AuthLogin => ["auth", "login"].as_slice(),
            HeyOperation::AuthLogout => ["auth", "logout", "--json"].as_slice(),
        };
        PreparedCommand::new(
            self.hey.clone(),
            args.iter().map(|x| (*x).to_owned()).collect(),
            None,
            deadline,
        )
    }

    pub fn prepare_transport(
        &self,
        operation: TransportOperation,
        deadline: Duration,
    ) -> Result<PreparedCommand, CommandError> {
        match operation {
            TransportOperation::Mail { request } => PreparedCommand::new(
                self.mail_transport.clone(),
                Vec::new(),
                Some(request),
                deadline,
            ),
            TransportOperation::ImageFetch { url } => {
                let destination = validate_url(&url, false, self.resolver.as_ref())?;
                let request = protected_request(&destination.url, &destination.pins);
                PreparedCommand::new(
                    self.image_fetch.clone(),
                    Vec::new(),
                    Some(Secret::new(request)),
                    deadline,
                )
            }
            TransportOperation::Unsubscribe {
                url,
                content_type,
                body,
            } => {
                let destination = validate_url(&url, true, self.resolver.as_ref())?;
                if content_type.is_empty()
                    || body.is_empty()
                    || content_type.contains(['\r', '\n'])
                    || body.contains(['\r', '\n'])
                {
                    return Err(CommandError::InvalidRequest);
                }
                let request = [destination.url, content_type, body]
                    .into_iter()
                    .chain(destination.pins)
                    .map(|part| STANDARD.encode(part))
                    .collect::<Vec<_>>()
                    .join(" ")
                    + "\n";
                PreparedCommand::new(
                    self.unsubscribe.clone(),
                    Vec::new(),
                    Some(Secret::new(request)),
                    deadline,
                )
            }
        }
    }
}

struct ValidatedDestination {
    url: String,
    pins: Vec<String>,
}

fn protected_request(url: &str, pins: &[String]) -> String {
    std::iter::once(url)
        .chain(pins.iter().map(String::as_str))
        .map(|part| STANDARD.encode(part))
        .collect::<Vec<_>>()
        .join(" ")
        + "\n"
}

fn validate_url(
    value: &str,
    https_only: bool,
    resolver: &dyn Resolver,
) -> Result<ValidatedDestination, CommandError> {
    let mut url = Url::parse(value).map_err(|_| CommandError::InvalidUrl)?;
    if (https_only && url.scheme() != "https")
        || (!https_only && !matches!(url.scheme(), "http" | "https"))
        || url.username() != ""
        || url.password().is_some()
    {
        return Err(CommandError::DisallowedUrl);
    }
    let port = url
        .port_or_known_default()
        .ok_or(CommandError::InvalidUrl)?;
    let pins = match url.host() {
        Some(Host::Domain(host)) => {
            let host = host.trim_end_matches('.').to_owned();
            if host.is_empty() || host.ends_with(".local") || !host.contains('.') {
                return Err(CommandError::DisallowedUrl);
            }
            let addresses = resolver
                .resolve(&host, port)
                .map_err(|_| CommandError::ResolutionFailed)?;
            if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(*address)) {
                return Err(CommandError::DisallowedUrl);
            }
            url.set_host(Some(&host))
                .map_err(|_| CommandError::InvalidUrl)?;
            let mut pins = Vec::new();
            for address in addresses {
                let address = match address {
                    IpAddr::V4(address) => address.to_string(),
                    IpAddr::V6(address) => format!("[{address}]"),
                };
                let pin = format!("{host}:{port}:{address}");
                if !pins.contains(&pin) {
                    pins.push(pin);
                }
            }
            pins
        }
        Some(Host::Ipv4(ip)) if is_public_ip(IpAddr::V4(ip)) => Vec::new(),
        Some(Host::Ipv6(ip)) if is_public_ip(IpAddr::V6(ip)) => Vec::new(),
        _ => return Err(CommandError::DisallowedUrl),
    };
    Ok(ValidatedDestination {
        url: url.into(),
        pins,
    })
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [first, second, third, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_multicast()
                || first == 0
                || (first == 100 && (64..=127).contains(&second))
                || (first == 192 && second == 0 && third == 0)
                || (first == 192 && second == 0 && third == 2)
                || (first == 192 && second == 88 && third == 99)
                || (first == 198 && (18..=19).contains(&second))
                || (first == 198 && second == 51 && third == 100)
                || (first == 203 && second == 0 && third == 113)
                || first >= 224)
        }
        IpAddr::V6(ip) => {
            if let Some(ipv4) = ip.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(ipv4));
            }
            let segments = ip.segments();
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || (segments[0] & 0xffc0) == 0xfec0
                || (segments[0] == 0x0100 && segments[1..].iter().all(|part| *part == 0))
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] & 0xfff0) == 0x3ff0)
        }
    }
}

pub struct PreparedCommand {
    program: PathBuf,
    arguments: Vec<String>,
    stdin: Option<Secret>,
    deadline: Duration,
}
impl PreparedCommand {
    pub(crate) fn new(
        program: PathBuf,
        arguments: Vec<String>,
        stdin: Option<Secret>,
        deadline: Duration,
    ) -> Result<Self, CommandError> {
        if deadline.is_zero() {
            return Err(CommandError::InvalidDeadline);
        }
        Ok(Self {
            program,
            arguments,
            stdin,
            deadline,
        })
    }
    pub fn program(&self) -> &Path {
        &self.program
    }
    pub fn arguments(&self) -> &[String] {
        &self.arguments
    }
    pub fn has_stdin(&self) -> bool {
        self.stdin.is_some()
    }
    pub fn deadline(&self) -> Duration {
        self.deadline
    }
}
impl fmt::Debug for PreparedCommand {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreparedCommand")
            .field("program", &self.program)
            .field("arguments", &self.arguments)
            .field("has_stdin", &self.has_stdin())
            .field("deadline", &self.deadline)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandError {
    PlatformUnavailable,
    InvalidDeadline,
    InvalidUrl,
    ResolutionFailed,
    DisallowedUrl,
    InvalidRequest,
    SpawnFailed,
    WriteStdinFailed,
    ReadOutputFailed,
    WaitFailed,
    TimedOut,
    ReapFailed,
    ContainmentFailed,
    OutputTooLarge,
}
impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::PlatformUnavailable => {
                "permitted command execution is unavailable on this platform"
            }
            Self::InvalidDeadline => "command deadline must be greater than zero",
            Self::InvalidUrl => "transport URL is invalid",
            Self::ResolutionFailed => "transport host could not be resolved",
            Self::DisallowedUrl => "transport URL is not a public permitted address",
            Self::InvalidRequest => "transport request is invalid",
            Self::SpawnFailed => "could not start permitted command",
            Self::WriteStdinFailed => "could not write permitted command stdin",
            Self::ReadOutputFailed => "could not read permitted command output",
            Self::WaitFailed => "could not wait for permitted command",
            Self::TimedOut => "permitted command exceeded its deadline",
            Self::ReapFailed => "could not terminate and reap permitted command",
            Self::ContainmentFailed => "could not contain permitted command descendants",
            Self::OutputTooLarge => "permitted command output exceeded its limit",
        })
    }
}
impl std::error::Error for CommandError {}

pub struct ProcessOutput {
    status: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}
impl ProcessOutput {
    pub fn new(status: Option<i32>, stdout: Vec<u8>, stderr: Vec<u8>) -> Self {
        Self {
            status,
            stdout,
            stderr,
        }
    }
    pub fn status(&self) -> Option<i32> {
        self.status
    }
    pub fn stdout(&self) -> &[u8] {
        &self.stdout
    }
    pub fn stderr(&self) -> &[u8] {
        &self.stderr
    }
}
impl fmt::Debug for ProcessOutput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProcessOutput")
            .field("status", &self.status)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr.len())
            .finish()
    }
}

pub trait ProcessRunner: Send + Sync {
    fn run(&self, command: PreparedCommand) -> Result<ProcessOutput, CommandError>;

    fn run_bounded(
        &self,
        command: PreparedCommand,
        max_stdout: usize,
        max_stderr: usize,
    ) -> Result<ProcessOutput, CommandError>;
}
pub struct SystemProcessRunner;
impl ProcessRunner for SystemProcessRunner {
    fn run(&self, command: PreparedCommand) -> Result<ProcessOutput, CommandError> {
        self.run_bounded(command, usize::MAX, usize::MAX)
    }

    fn run_bounded(
        &self,
        command: PreparedCommand,
        max_stdout: usize,
        max_stderr: usize,
    ) -> Result<ProcessOutput, CommandError> {
        #[cfg(windows)]
        {
            let _ = (command, max_stdout, max_stderr);
            return Err(CommandError::PlatformUnavailable);
        }
        let mut process = Command::new(&command.program);
        process
            .args(&command.arguments)
            .stdin(if command.stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt as _;
            process.process_group(0);
        }
        let mut child = process.spawn().map_err(|_| CommandError::SpawnFailed)?;
        let stdout = child.stdout.take().ok_or(CommandError::ReadOutputFailed)?;
        let stderr = child.stderr.take().ok_or(CommandError::ReadOutputFailed)?;
        let overflow = Arc::new(AtomicBool::new(false));
        let out_overflow = Arc::clone(&overflow);
        let out_reader = thread::spawn(move || {
            let mut data = Vec::new();
            stdout
                .take(max_stdout.saturating_add(1) as u64)
                .read_to_end(&mut data)
                .map(|_| {
                    if data.len() > max_stdout {
                        out_overflow.store(true, Ordering::Release);
                    }
                    data
                })
        });
        let err_overflow = Arc::clone(&overflow);
        let err_reader = thread::spawn(move || {
            let mut data = Vec::new();
            stderr
                .take(max_stderr.saturating_add(1) as u64)
                .read_to_end(&mut data)
                .map(|_| {
                    if data.len() > max_stderr {
                        err_overflow.store(true, Ordering::Release);
                    }
                    data
                })
        });
        let writer = command.stdin.map(|secret| {
            let mut stdin = child.stdin.take().expect("piped stdin exists");
            thread::spawn(move || stdin.write_all(secret.expose().as_bytes()))
        });
        let deadline = Instant::now() + command.deadline;
        let status = match wait_until(&mut child, command.deadline, &overflow) {
            Ok(WaitOutcome::Exited(status)) => status,
            Ok(WaitOutcome::TimedOut) => {
                let termination = terminate_and_reap(&mut child);
                let joins = join_threads(out_reader, err_reader, writer);
                termination?;
                joins?;
                return Err(CommandError::TimedOut);
            }
            Ok(WaitOutcome::OutputTooLarge) => {
                let termination = terminate_and_reap(&mut child);
                let joins = join_threads(out_reader, err_reader, writer);
                termination?;
                joins?;
                return Err(CommandError::OutputTooLarge);
            }
            Err(_) => {
                let termination = terminate_and_reap(&mut child);
                let joins = join_threads(out_reader, err_reader, writer);
                termination?;
                joins?;
                return Err(CommandError::WaitFailed);
            }
        };
        while (!out_reader.is_finished() || !err_reader.is_finished()) && Instant::now() < deadline
        {
            thread::sleep(Duration::from_millis(5));
        }
        if !out_reader.is_finished() || !err_reader.is_finished() {
            let termination = terminate_and_reap(&mut child);
            let joins = join_threads(out_reader, err_reader, writer);
            termination?;
            joins?;
            return Err(CommandError::TimedOut);
        }
        let (stdout, stderr) = join_threads(out_reader, err_reader, writer)?;
        if stdout.len() > max_stdout || stderr.len() > max_stderr {
            return Err(CommandError::OutputTooLarge);
        }
        Ok(ProcessOutput {
            status: status.code(),
            stdout,
            stderr,
        })
    }
}

enum WaitOutcome {
    Exited(std::process::ExitStatus),
    TimedOut,
    OutputTooLarge,
}

fn wait_until(
    child: &mut std::process::Child,
    deadline: Duration,
    overflow: &AtomicBool,
) -> std::io::Result<WaitOutcome> {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(WaitOutcome::Exited(status));
        }
        if overflow.load(Ordering::Acquire) {
            return Ok(WaitOutcome::OutputTooLarge);
        }
        if started.elapsed() >= deadline {
            return Ok(WaitOutcome::TimedOut);
        }
        thread::sleep(Duration::from_millis(5));
    }
}

fn join_reader(
    reader: thread::JoinHandle<std::io::Result<Vec<u8>>>,
) -> Result<Vec<u8>, CommandError> {
    reader
        .join()
        .map_err(|_| CommandError::ReadOutputFailed)?
        .map_err(|_| CommandError::ReadOutputFailed)
}
fn join_threads(
    a: thread::JoinHandle<std::io::Result<Vec<u8>>>,
    b: thread::JoinHandle<std::io::Result<Vec<u8>>>,
    writer: Option<thread::JoinHandle<std::io::Result<()>>>,
) -> Result<(Vec<u8>, Vec<u8>), CommandError> {
    let stdout = join_reader(a);
    let stderr = join_reader(b);
    let written = writer.map(|handle| {
        handle
            .join()
            .map_err(|_| CommandError::WriteStdinFailed)?
            .map_err(|_| CommandError::WriteStdinFailed)
    });
    // All handles have been joined before any individual error is returned.
    let stdout = stdout?;
    let stderr = stderr?;
    if let Some(written) = written {
        written?;
    }
    Ok((stdout, stderr))
}
fn terminate_and_reap(child: &mut std::process::Child) -> Result<(), CommandError> {
    #[cfg(unix)]
    let kill_error = unsafe {
        if libc::kill(-(child.id() as i32), libc::SIGKILL) == 0 {
            None
        } else {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                None
            } else {
                // Still kill the direct child so even a group-signal failure
                // cannot leave the owned process running or zombied.
                let _ = child.kill();
                Some(error)
            }
        }
    };
    #[cfg(not(unix))]
    let kill_error = child.kill().err();
    // Waiting on this exact Child is the operation that reaps it. Always do it
    // after group-kill success, ESRCH, or a failed kill attempt.
    child.wait().map_err(|_| CommandError::ReapFailed)?;
    if kill_error.is_some() {
        Err(CommandError::ReapFailed)
    } else {
        Ok(())
    }
}

#[cfg(windows)]
pub struct WindowsChildContainment {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl WindowsChildContainment {
    pub fn create_and_assign(child: &std::process::Child) -> Result<Self, std::io::Error> {
        use std::os::windows::io::AsRawHandle as _;
        use windows_sys::Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
        };

        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut limits = JOB_OBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            )
        };
        let process: HANDLE = child.as_raw_handle() as HANDLE;
        let assigned = configured != 0 && unsafe { AssignProcessToJobObject(job, process) } != 0;
        if !assigned {
            unsafe { CloseHandle(job) };
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { job })
    }
}

#[cfg(windows)]
impl Drop for WindowsChildContainment {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.job) };
    }
}
