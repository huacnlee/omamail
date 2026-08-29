use std::{fmt, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use url::Url;

use crate::platform::{
    commands::{CommandError, PreparedCommand, SystemProcessRunner},
    secrets::Secret,
};

const MAX_FOLDER_BYTES: usize = 4096;
const MAX_RECIPIENT_BYTES: usize = 320;
const MAX_RECIPIENTS: usize = 100;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_PROCESS_OUTPUT_BYTES: usize = 2_000_000;
const MAX_DECODED_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub struct ImapAccount {
    account_id: String,
    email: String,
    imap_url: Url,
    smtp_url: Url,
    username: String,
    password: Secret,
}

impl ImapAccount {
    pub fn new(
        account_id: &str,
        email: &str,
        imap_url: &str,
        smtp_url: &str,
        username: &str,
        password: Secret,
    ) -> Result<Self, PlanError> {
        if account_id != format!("imap:{email}")
            || !valid_address(email)
            || username.is_empty()
            || username.contains(['\r', '\n', '\0'])
            || password.expose().is_empty()
        {
            return Err(PlanError::InvalidAccount);
        }
        let imap_url = transport_url(imap_url, &["imap", "imaps"])?;
        let smtp_url = transport_url(smtp_url, &["smtp", "smtps"])?;
        Ok(Self {
            account_id: account_id.to_owned(),
            email: email.to_owned(),
            imap_url,
            smtp_url,
            username: username.to_owned(),
            password,
        })
    }
}

impl fmt::Debug for ImapAccount {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ImapAccount")
            .field("account_id", &self.account_id)
            .field("email", &self.email)
            .field("imap_url", &self.imap_url)
            .field("smtp_url", &self.smtp_url)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action<'a> {
    MarkSeen,
    MarkUnseen,
    AddFlag(&'a str),
    RemoveFlag(&'a str),
    Move { destination: &'a str },
    CopyStoreUidExpunge { destination: &'a str },
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MailOperation<'a> {
    Discover,
    List {
        folder: &'a str,
    },
    Detail {
        message_id: &'a str,
    },
    Action {
        message_id: &'a str,
        action: Action<'a>,
    },
    BatchAction {
        message_ids: Vec<&'a str>,
        action: Action<'a>,
    },
    Send {
        from: &'a str,
        recipients: Vec<&'a str>,
        subject: &'a str,
        body: &'a str,
    },
    SendThreaded {
        from: &'a str,
        to: Vec<&'a str>,
        cc: Vec<&'a str>,
        bcc: Vec<&'a str>,
        subject: &'a str,
        body: &'a str,
        in_reply_to: Option<&'a str>,
        references: Option<&'a str>,
    },
}

pub struct PlannedTransport {
    mode: &'static str,
    stdin: Secret,
}

impl PlannedTransport {
    pub fn mode(&self) -> &'static str {
        self.mode
    }

    pub fn argv(&self) -> &[String] {
        &[]
    }

    pub fn stdin(&self) -> &Secret {
        &self.stdin
    }
}

impl fmt::Debug for PlannedTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PlannedTransport")
            .field("mode", &self.mode)
            .field("argv", &self.argv())
            .field("stdin", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanError {
    InvalidAccount,
    InvalidUrl,
    InvalidFolder,
    InvalidMessageId,
    InvalidFlag,
    InvalidHeader,
    NoRecipients,
    PayloadTooLarge,
}

impl fmt::Display for PlanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidAccount => "invalid IMAP account",
            Self::InvalidUrl => "invalid mail transport URL",
            Self::InvalidFolder => "invalid IMAP folder",
            Self::InvalidMessageId => "message id must be <uid>:<folder>",
            Self::InvalidFlag => "invalid IMAP flag",
            Self::InvalidHeader => "invalid message header",
            Self::NoRecipients => "message has no recipients",
            Self::PayloadTooLarge => "mail payload is too large",
        })
    }
}

impl std::error::Error for PlanError {}

pub struct MailProcessOutput {
    status: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl MailProcessOutput {
    pub fn new(status: Option<i32>, stdout: Vec<u8>, stderr: Vec<u8>) -> Self {
        Self {
            status,
            stdout,
            stderr,
        }
    }
}

impl fmt::Debug for MailProcessOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MailProcessOutput")
            .field("status", &self.status)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr.len())
            .finish()
    }
}

pub trait MailProcessRunner: Send + Sync {
    fn run_bounded(
        &self,
        command: PreparedCommand,
        max_stdout: usize,
        max_stderr: usize,
    ) -> Result<MailProcessOutput, CommandError>;
}

impl MailProcessRunner for SystemProcessRunner {
    fn run_bounded(
        &self,
        command: PreparedCommand,
        max_stdout: usize,
        max_stderr: usize,
    ) -> Result<MailProcessOutput, CommandError> {
        let output = crate::platform::commands::ProcessRunner::run_bounded(
            self, command, max_stdout, max_stderr,
        )?;
        Ok(MailProcessOutput::new(
            output.status(),
            output.stdout().to_vec(),
            output.stderr().to_vec(),
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerError {
    PlatformUnavailable,
    InvalidDeadline,
    TimedOut,
    OutputTooLarge,
    InvalidResponse,
    TransportFailed,
    ProcessFailed,
}

impl fmt::Display for RunnerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::PlatformUnavailable => "mail transport is unavailable on this platform",
            Self::InvalidDeadline => "mail transport deadline is invalid",
            Self::TimedOut => "mail transport timed out",
            Self::OutputTooLarge => "mail transport output is too large",
            Self::InvalidResponse => "mail transport returned an invalid response",
            Self::TransportFailed => "mail server transport failed",
            Self::ProcessFailed => "mail transport process failed",
        })
    }
}

impl std::error::Error for RunnerError {}

pub struct MailTransportReply {
    stdout: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailTransportExecutor {
    script: std::path::PathBuf,
}

impl MailTransportExecutor {
    pub fn new(app_root: std::path::PathBuf) -> Self {
        Self {
            script: app_root.join("scripts/mail-transport.sh"),
        }
    }
}

impl MailTransportReply {
    pub fn stdout(&self) -> &[u8] {
        &self.stdout
    }
}

impl fmt::Debug for MailTransportReply {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MailTransportReply")
            .field("stdout_bytes", &self.stdout.len())
            .finish()
    }
}

pub fn execute(
    planned: PlannedTransport,
    executor: &MailTransportExecutor,
    deadline: Duration,
) -> Result<MailTransportReply, RunnerError> {
    execute_with_runner(planned, executor, deadline, &SystemProcessRunner)
}

pub fn execute_with_runner(
    planned: PlannedTransport,
    executor: &MailTransportExecutor,
    deadline: Duration,
    runner: &dyn MailProcessRunner,
) -> Result<MailTransportReply, RunnerError> {
    let command = PreparedCommand::new(
        executor.script.clone(),
        Vec::new(),
        Some(planned.stdin),
        deadline,
    )
    .map_err(map_command_error)?;
    let output = runner
        .run_bounded(command, MAX_PROCESS_OUTPUT_BYTES, MAX_PROCESS_OUTPUT_BYTES)
        .map_err(map_command_error)?;
    parse_transport_output(output)
}

fn map_command_error(error: CommandError) -> RunnerError {
    match error {
        CommandError::PlatformUnavailable => RunnerError::PlatformUnavailable,
        CommandError::InvalidDeadline => RunnerError::InvalidDeadline,
        CommandError::TimedOut => RunnerError::TimedOut,
        CommandError::OutputTooLarge => RunnerError::OutputTooLarge,
        _ => RunnerError::ProcessFailed,
    }
}

fn parse_transport_output(output: MailProcessOutput) -> Result<MailTransportReply, RunnerError> {
    if output.stdout.len() > MAX_PROCESS_OUTPUT_BYTES
        || output.stderr.len() > MAX_PROCESS_OUTPUT_BYTES
    {
        return Err(RunnerError::OutputTooLarge);
    }
    if output.status != Some(0) {
        return Err(RunnerError::ProcessFailed);
    }
    let text = std::str::from_utf8(&output.stdout).map_err(|_| RunnerError::InvalidResponse)?;
    if text.contains('\r') || !text.ends_with('\n') {
        return Err(RunnerError::InvalidResponse);
    }
    let mut lines: Vec<&str> = text.split('\n').collect();
    lines.pop();
    if lines.len() != 3 {
        return Err(RunnerError::InvalidResponse);
    }
    let transport_status = lines[0]
        .parse::<u8>()
        .map_err(|_| RunnerError::InvalidResponse)?;
    let stdout = decode_capped(lines[1])?;
    let _stderr = decode_capped(lines[2])?;
    if transport_status != 0 {
        return Err(RunnerError::TransportFailed);
    }
    Ok(MailTransportReply { stdout })
}

fn decode_capped(value: &str) -> Result<Vec<u8>, RunnerError> {
    if value.len() > MAX_PROCESS_OUTPUT_BYTES {
        return Err(RunnerError::OutputTooLarge);
    }
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| RunnerError::InvalidResponse)?;
    if decoded.len() > MAX_DECODED_OUTPUT_BYTES {
        Err(RunnerError::OutputTooLarge)
    } else {
        Ok(decoded)
    }
}

pub fn plan(
    account: &ImapAccount,
    operation: MailOperation<'_>,
) -> Result<PlannedTransport, PlanError> {
    match operation {
        MailOperation::Discover => imap_plan(
            account,
            "INBOX",
            vec!["CAPABILITY".to_owned(), "LIST \"\" \"*\" RETURN (SPECIAL-USE)".to_owned()],
        ),
        MailOperation::List { folder } => imap_plan(
            account,
            folder,
            vec!["UID FETCH 1:* (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (DATE FROM SUBJECT MESSAGE-ID REFERENCES IN-REPLY-TO)])".to_owned()],
        ),
        MailOperation::Detail { message_id } => {
            let (uid, folder) = message_parts(message_id)?;
            imap_plan(
                account,
                folder,
                vec![format!(
                    "UID FETCH {uid} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])"
                )],
            )
        }
        MailOperation::Action { message_id, action } => {
            let (uid, folder) = message_parts(message_id)?;
            let commands = action_commands(uid, action)?;
            imap_plan(account, folder, commands)
        }
        MailOperation::BatchAction { message_ids, action } => {
            if message_ids.is_empty() || message_ids.len() > 100 {
                return Err(PlanError::PayloadTooLarge);
            }
            let mut folder = None;
            let mut uids = Vec::with_capacity(message_ids.len());
            for message_id in message_ids {
                let (uid, current_folder) = message_parts(message_id)?;
                if folder.is_some_and(|value| value != current_folder) {
                    return Err(PlanError::InvalidMessageId);
                }
                folder = Some(current_folder);
                uids.push(uid.to_string());
            }
            let uid_set = uids.join(",");
            let commands = action_commands_set(&uid_set, action)?;
            imap_plan(account, folder.ok_or(PlanError::InvalidMessageId)?, commands)
        }
        MailOperation::Send {
            from,
            recipients,
            subject,
            body,
        } => smtp_plan(account, from, recipients, subject, body),
        MailOperation::SendThreaded { from, to, cc, bcc, subject, body, in_reply_to, references } =>
            smtp_threaded_plan(account, from, to, cc, bcc, subject, body, in_reply_to, references),
    }
}

#[allow(clippy::too_many_arguments)]
fn smtp_threaded_plan(
    account: &ImapAccount,
    from: &str,
    to: Vec<&str>,
    cc: Vec<&str>,
    bcc: Vec<&str>,
    subject: &str,
    body: &str,
    in_reply_to: Option<&str>,
    references: Option<&str>,
) -> Result<PlannedTransport, PlanError> {
    let recipients: Vec<_> = to.iter().chain(&cc).chain(&bcc).copied().collect();
    if recipients.is_empty() || recipients.len() > MAX_RECIPIENTS || body.len() > MAX_BODY_BYTES {
        return Err(if recipients.is_empty() {
            PlanError::NoRecipients
        } else {
            PlanError::PayloadTooLarge
        });
    }
    for value in std::iter::once(from)
        .chain(recipients.iter().copied())
        .chain(std::iter::once(subject))
        .chain(in_reply_to)
        .chain(references)
    {
        validate_header(value)?;
    }
    if !valid_from(from, &account.email) || recipients.iter().any(|value| !valid_address(value)) {
        return Err(PlanError::InvalidHeader);
    }
    let mut message = format!("From: {from}\r\nTo: {}\r\n", to.join(", "));
    if !cc.is_empty() {
        message.push_str(&format!("Cc: {}\r\n", cc.join(", ")));
    }
    if let Some(value) = in_reply_to {
        message.push_str(&format!("In-Reply-To: {value}\r\n"));
    }
    if let Some(value) = references {
        message.push_str(&format!("References: {value}\r\n"));
    }
    message.push_str(&format!("Subject: {subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{}\r\n", normalize_crlf(body)));
    let credentials = format!("{}:{}", account.username, account.password.expose());
    let fields = [
        "smtp".to_owned(),
        encode(account.smtp_url.as_str()),
        encode(&credentials),
        encode(&account.email),
        encode(&message),
    ]
    .into_iter()
    .chain(recipients.into_iter().map(encode))
    .collect::<Vec<_>>();
    Ok(PlannedTransport {
        mode: "smtp",
        stdin: Secret::new(format!("{}\n", fields.join(" "))),
    })
}

fn imap_plan(
    account: &ImapAccount,
    folder: &str,
    commands: Vec<String>,
) -> Result<PlannedTransport, PlanError> {
    validate_folder(folder)?;
    let mut url = account.imap_url.clone();
    url.set_path("");
    url.set_query(None);
    url.path_segments_mut()
        .map_err(|_| PlanError::InvalidUrl)?
        .push(folder);
    let credentials = format!("{}:{}", account.username, account.password.expose());
    let mut fields = vec![
        "imap".to_owned(),
        encode(url.as_str()),
        encode(&credentials),
    ];
    fields.extend(commands.iter().map(|command| encode(command)));
    Ok(PlannedTransport {
        mode: "imap",
        stdin: Secret::new(format!("{}\n", fields.join(" "))),
    })
}

fn smtp_plan(
    account: &ImapAccount,
    from: &str,
    recipients: Vec<&str>,
    subject: &str,
    body: &str,
) -> Result<PlannedTransport, PlanError> {
    if recipients.is_empty() {
        return Err(PlanError::NoRecipients);
    }
    if recipients.len() > MAX_RECIPIENTS || body.len() > MAX_BODY_BYTES {
        return Err(PlanError::PayloadTooLarge);
    }
    validate_header(from)?;
    validate_header(subject)?;
    if !valid_from(from, &account.email) || recipients.iter().any(|value| !valid_address(value)) {
        return Err(PlanError::InvalidHeader);
    }
    let normalized_body = normalize_crlf(body);
    let message = format!(
        "From: {from}\r\nTo: {}\r\nSubject: {subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{normalized_body}\r\n",
        recipients.join(", ")
    );
    let credentials = format!("{}:{}", account.username, account.password.expose());
    let mut fields = vec![
        "smtp".to_owned(),
        encode(account.smtp_url.as_str()),
        encode(&credentials),
        encode(&account.email),
        encode(&message),
    ];
    fields.extend(recipients.into_iter().map(encode));
    Ok(PlannedTransport {
        mode: "smtp",
        stdin: Secret::new(format!("{}\n", fields.join(" "))),
    })
}

fn action_commands(uid: u64, action: Action<'_>) -> Result<Vec<String>, PlanError> {
    action_commands_set(&uid.to_string(), action)
}

fn action_commands_set(uid: &str, action: Action<'_>) -> Result<Vec<String>, PlanError> {
    let commands = match action {
        Action::MarkSeen => vec![format!("UID STORE {uid} +FLAGS.SILENT (\\Seen)")],
        Action::MarkUnseen => vec![format!("UID STORE {uid} -FLAGS.SILENT (\\Seen)")],
        Action::AddFlag(flag) => vec![format!(
            "UID STORE {uid} +FLAGS.SILENT ({})",
            checked_flag(flag)?
        )],
        Action::RemoveFlag(flag) => vec![format!(
            "UID STORE {uid} -FLAGS.SILENT ({})",
            checked_flag(flag)?
        )],
        Action::Move { destination } => {
            validate_folder(destination)?;
            vec![format!("UID MOVE {uid} {}", quote(destination))]
        }
        Action::CopyStoreUidExpunge { destination } => {
            validate_folder(destination)?;
            vec![
                format!("UID COPY {uid} {}", quote(destination)),
                format!("UID STORE {uid} +FLAGS.SILENT (\\Deleted)"),
                format!("UID EXPUNGE {uid}"),
            ]
        }
        Action::Delete => vec![
            format!("UID STORE {uid} +FLAGS.SILENT (\\Deleted)"),
            format!("UID EXPUNGE {uid}"),
        ],
    };
    Ok(commands)
}

fn message_parts(message_id: &str) -> Result<(u64, &str), PlanError> {
    let (uid, folder) = message_id
        .split_once(':')
        .ok_or(PlanError::InvalidMessageId)?;
    let uid = uid
        .parse::<u64>()
        .ok()
        .filter(|uid| *uid > 0)
        .ok_or(PlanError::InvalidMessageId)?;
    validate_folder(folder).map_err(|_| PlanError::InvalidMessageId)?;
    Ok((uid, folder))
}

fn validate_folder(folder: &str) -> Result<(), PlanError> {
    if folder.trim() != folder
        || folder.is_empty()
        || folder.len() > MAX_FOLDER_BYTES
        || folder.contains(['\r', '\n', '\0'])
    {
        Err(PlanError::InvalidFolder)
    } else {
        Ok(())
    }
}

fn checked_flag(flag: &str) -> Result<&str, PlanError> {
    if flag.is_empty()
        || !flag
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "\\$".contains(character))
    {
        Err(PlanError::InvalidFlag)
    } else {
        Ok(flag)
    }
}

fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn transport_url(value: &str, schemes: &[&str]) -> Result<Url, PlanError> {
    let url = Url::parse(value).map_err(|_| PlanError::InvalidUrl)?;
    if !schemes.contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        Err(PlanError::InvalidUrl)
    } else {
        Ok(url)
    }
}

fn validate_header(value: &str) -> Result<(), PlanError> {
    if value.is_empty() || value.len() > MAX_HEADER_BYTES || value.contains(['\r', '\n', '\0']) {
        Err(PlanError::InvalidHeader)
    } else {
        Ok(())
    }
}

fn valid_address(value: &str) -> bool {
    validate_header(value).is_ok()
        && value.len() <= MAX_RECIPIENT_BYTES
        && !value.contains(char::is_whitespace)
        && value.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
        })
}

fn valid_from(value: &str, account_email: &str) -> bool {
    if value == account_email {
        return true;
    }
    if value.trim() != value || !value.ends_with('>') {
        return false;
    }
    let without_close = &value[..value.len() - 1];
    let Some((display, address)) = without_close.rsplit_once('<') else {
        return false;
    };
    let display = display.trim_end();
    !display.is_empty()
        && !display.contains(['<', '>'])
        && address == account_email
        && valid_address(address)
}

fn normalize_crlf(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\r\n")
}

fn encode(value: &str) -> String {
    STANDARD.encode(value.as_bytes())
}
