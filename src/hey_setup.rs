//! Setup-only HEY authentication boundary. This module is intentionally not
//! reachable from the generic effect dispatcher.

use std::{
    collections::BTreeSet,
    fmt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::platform::commands::{CommandError, PreparedCommand, SystemProcessRunner};

const MAX_INPUT_BYTES: usize = 16 * 1024;
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_DEADLINE_MS: u64 = 120_000;
const MAX_ACCOUNTS: usize = 32;
const MAX_ADDRESS_BYTES: usize = 320;

pub struct HeySetupOutput {
    status: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}
impl HeySetupOutput {
    pub fn success(stdout: Vec<u8>) -> Self {
        Self {
            status: Some(0),
            stdout,
            stderr: vec![],
        }
    }
}
impl fmt::Debug for HeySetupOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HeySetupOutput")
            .field("status", &self.status)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr.len())
            .finish()
    }
}

pub trait HeySetupRunner: Send + Sync {
    fn run_bounded(
        &self,
        command: PreparedCommand,
        max_stdout: usize,
        max_stderr: usize,
    ) -> Result<HeySetupOutput, CommandError>;
}
impl HeySetupRunner for SystemProcessRunner {
    fn run_bounded(
        &self,
        command: PreparedCommand,
        max_stdout: usize,
        max_stderr: usize,
    ) -> Result<HeySetupOutput, CommandError> {
        let output = crate::platform::commands::ProcessRunner::run_bounded(
            self, command, max_stdout, max_stderr,
        )?;
        Ok(HeySetupOutput {
            status: output.status(),
            stdout: output.stdout().to_vec(),
            stderr: output.stderr().to_vec(),
        })
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct TerminalLaunchPlan {
    program: PathBuf,
    arguments: Vec<String>,
}
impl TerminalLaunchPlan {
    fn login(hey: &Path) -> Self {
        Self {
            program: hey.to_owned(),
            arguments: vec!["auth".into(), "login".into()],
        }
    }
    pub fn program(&self) -> &Path {
        &self.program
    }
    pub fn arguments(&self) -> &[String] {
        &self.arguments
    }
}
impl fmt::Debug for TerminalLaunchPlan {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TerminalLaunchPlan")
            .field("program", &self.program)
            .field("arguments", &self.arguments)
            .finish()
    }
}

pub trait TerminalLauncher: Send + Sync {
    /// Launches the interactive OAuth flow. Completion is observed separately
    /// by polling status; this call does not claim to supervise that terminal.
    fn launch(&self, plan: TerminalLaunchPlan) -> Result<(), TerminalLaunchError>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalLaunchError {
    PlatformUnavailable,
    Failed,
}

pub struct SystemTerminalLauncher {
    terminal: PathBuf,
}
impl SystemTerminalLauncher {
    fn new(terminal: PathBuf) -> Self {
        Self { terminal }
    }
}
impl TerminalLauncher for SystemTerminalLauncher {
    fn launch(&self, plan: TerminalLaunchPlan) -> Result<(), TerminalLaunchError> {
        #[cfg(not(unix))]
        {
            let _ = plan;
            return Err(TerminalLaunchError::PlatformUnavailable);
        }
        #[cfg(unix)]
        let child = Command::new(&self.terminal)
            .arg("--")
            .arg(plan.program())
            .args(plan.arguments())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    TerminalLaunchError::PlatformUnavailable
                } else {
                    TerminalLaunchError::Failed
                }
            })?;
        std::thread::spawn(move || {
            let mut child = child;
            let _ = child.wait();
        });
        Ok(())
    }
}

pub struct ProductionHeySetup {
    candidates: Vec<PathBuf>,
    pinned: std::sync::Mutex<Option<PathBuf>>,
    runner: SystemProcessRunner,
    launcher: SystemTerminalLauncher,
}
impl ProductionHeySetup {
    pub fn new(candidates: Vec<PathBuf>, terminal: PathBuf) -> Result<Self, &'static str> {
        if candidates.is_empty()
            || candidates
                .iter()
                .any(|candidate| !valid_candidate(candidate, "hey"))
            || !valid_program(&terminal)
        {
            return Err("invalid HEY setup program");
        }
        Ok(Self {
            candidates,
            pinned: std::sync::Mutex::new(None),
            runner: SystemProcessRunner,
            launcher: SystemTerminalLauncher::new(terminal),
        })
    }
    pub fn dispatch(&self, input: &str) -> String {
        let hey = {
            let mut pinned = match self.pinned.lock() {
                Ok(value) => value,
                Err(_) => return failure(),
            };
            if let Some(path) = pinned.as_ref() {
                resolve_hey_executable(std::slice::from_ref(path))
            } else {
                let resolved = resolve_hey_executable(&self.candidates);
                if let Some(path) = &resolved {
                    *pinned = Some(path.clone());
                }
                resolved
            }
        };
        let Some(hey) = hey else {
            return unavailable();
        };
        HeySetupDispatcher::new(hey, &self.runner, &self.launcher).dispatch(input)
    }
}

pub struct HeySetupDispatcher<'a> {
    hey: PathBuf,
    runner: &'a dyn HeySetupRunner,
    launcher: &'a dyn TerminalLauncher,
}
impl<'a> HeySetupDispatcher<'a> {
    pub fn new(
        hey: PathBuf,
        runner: &'a dyn HeySetupRunner,
        launcher: &'a dyn TerminalLauncher,
    ) -> Self {
        Self {
            hey,
            runner,
            launcher,
        }
    }

    pub fn dispatch(&self, input: &str) -> String {
        match self.try_dispatch(input) {
            Ok(reply) => reply,
            Err(SetupFailure::Unavailable) => unavailable(),
            Err(SetupFailure::Failed) => failure(),
        }
    }

    fn try_dispatch(&self, input: &str) -> Result<String, SetupFailure> {
        if input.len() > MAX_INPUT_BYTES {
            return Err(SetupFailure::Failed);
        }
        let request: Request = serde_json::from_str(input).map_err(|_| ())?;
        let data = match request {
            Request::Status(request) => self.status(request.deadline()?)?,
            Request::Accounts(request) => self.accounts(request.deadline()?)?,
            Request::Login(_) => {
                self.launcher
                    .launch(TerminalLaunchPlan::login(&self.hey))
                    .map_err(|error| match error {
                        TerminalLaunchError::PlatformUnavailable => SetupFailure::Unavailable,
                        TerminalLaunchError::Failed => SetupFailure::Failed,
                    })?;
                json!({"launched":true})
            }
            Request::Logout(request) => {
                self.envelope(self.run(&["auth", "logout", "--json"], request.deadline()?)?)?;
                json!({"machineGlobal":true})
            }
        };
        serde_json::to_string(&json!({"ok":true,"data":data})).map_err(|_| SetupFailure::Failed)
    }

    fn status(&self, deadline: Duration) -> Result<Value, SetupFailure> {
        let data = self.envelope(self.run(&["auth", "status", "--json"], deadline)?)?;
        let authenticated = data
            .get("authenticated")
            .and_then(Value::as_bool)
            .ok_or(())?;
        let expired = data.get("expired").and_then(Value::as_bool).ok_or(())?;
        Ok(json!({"authenticated":authenticated,"expired":expired}))
    }

    fn accounts(&self, deadline: Duration) -> Result<Value, SetupFailure> {
        let data = self.envelope(self.run(&["accounts", "list", "--json"], deadline)?)?;
        let rows = data
            .as_array()
            .filter(|rows| rows.len() <= MAX_ACCOUNTS)
            .ok_or(())?;
        let mut accounts = Vec::new();
        let mut addresses = BTreeSet::new();
        for row in rows {
            if row.get("id").and_then(Value::as_str) == Some("all") {
                continue;
            }
            let address = canonical_address(row.get("email").and_then(Value::as_str).ok_or(())?)?;
            if !addresses.insert(address.clone()) {
                return Err(SetupFailure::Failed);
            }
            accounts.push(json!({"id":format!("hey:{address}"),"address":address}));
        }
        Ok(json!({"accounts":accounts}))
    }

    fn run(&self, arguments: &[&str], deadline: Duration) -> Result<HeySetupOutput, SetupFailure> {
        let command = PreparedCommand::new(
            self.hey.clone(),
            arguments.iter().map(|value| (*value).to_owned()).collect(),
            None,
            deadline,
        )
        .map_err(|_| SetupFailure::Failed)?;
        self.runner
            .run_bounded(command, MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES)
            .map_err(|error| match error {
                CommandError::PlatformUnavailable => SetupFailure::Unavailable,
                _ => SetupFailure::Failed,
            })
    }

    fn envelope(&self, output: HeySetupOutput) -> Result<Value, SetupFailure> {
        if output.status != Some(0)
            || output.stdout.len() > MAX_OUTPUT_BYTES
            || output.stderr.len() > MAX_OUTPUT_BYTES
        {
            return Err(SetupFailure::Failed);
        }
        let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| ())?;
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(SetupFailure::Failed);
        }
        Ok(value.get("data").cloned().unwrap_or(Value::Null))
    }
}

#[derive(Deserialize)]
#[serde(tag = "operation")]
enum Request {
    #[serde(rename = "hey.auth.status")]
    Status(DeadlineRequest),
    #[serde(rename = "hey.auth.accounts")]
    Accounts(DeadlineRequest),
    #[serde(rename = "hey.auth.login")]
    Login(EmptyRequest),
    #[serde(rename = "hey.auth.logout")]
    Logout(DeadlineRequest),
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeadlineRequest {
    deadline_ms: u64,
}
impl DeadlineRequest {
    fn deadline(&self) -> Result<Duration, SetupFailure> {
        if self.deadline_ms == 0 || self.deadline_ms > MAX_DEADLINE_MS {
            return Err(SetupFailure::Failed);
        }
        Ok(Duration::from_millis(self.deadline_ms))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyRequest {}

fn canonical_address(value: &str) -> Result<String, ()> {
    let address = value.to_ascii_lowercase();
    if address.is_empty()
        || address.len() > MAX_ADDRESS_BYTES
        || address.trim() != address
        || address.chars().any(char::is_whitespace)
        || address.chars().any(char::is_control)
    {
        return Err(());
    }
    let (local, domain) = address.split_once('@').ok_or(())?;
    if local.is_empty() || domain.is_empty() || domain.contains('@') || !domain.contains('.') {
        return Err(());
    }
    Ok(address)
}

fn failure() -> String {
    r#"{"ok":false,"error":"HEY setup failed"}"#.to_owned()
}

fn unavailable() -> String {
    r#"{"ok":false,"error":"HEY setup is unavailable"}"#.to_owned()
}

#[derive(Debug, Clone, Copy)]
enum SetupFailure {
    Unavailable,
    Failed,
}
impl From<()> for SetupFailure {
    fn from(_: ()) -> Self {
        Self::Failed
    }
}

fn valid_program(path: &Path) -> bool {
    path.is_absolute()
        && path.file_name().is_some()
        && path
            .components()
            .all(|part| !matches!(part, std::path::Component::ParentDir))
}

fn valid_candidate(path: &Path, basename: &str) -> bool {
    valid_program(path) && path.file_name().and_then(|name| name.to_str()) == Some(basename)
}

/// Resolves HEY only from explicit absolute candidates. It never searches
/// `PATH`, and rejects symlinks, non-regular files, and non-executable files.
pub fn resolve_hey_executable(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find_map(|candidate| {
        if !valid_candidate(candidate, "hey") {
            return None;
        }
        let metadata = std::fs::symlink_metadata(candidate).ok()?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return None;
        }
        let resolved = std::fs::canonicalize(candidate).ok()?;
        if resolved.file_name().and_then(|name| name.to_str()) != Some("hey") {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return None;
            }
        }
        #[cfg(not(unix))]
        {
            return None;
        }
        Some(resolved)
    })
}

pub fn standard_hey_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from)
        && home.is_absolute()
    {
        candidates.push(home.join(".local/bin/hey"));
    }
    if let Some(bin_home) = std::env::var_os("XDG_BIN_HOME").map(PathBuf::from)
        && bin_home.is_absolute()
    {
        candidates.push(bin_home.join("hey"));
    }
    candidates.extend([
        PathBuf::from("/usr/local/bin/hey"),
        PathBuf::from("/usr/bin/hey"),
    ]);
    candidates
}
