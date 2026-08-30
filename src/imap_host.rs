use std::{
    fmt,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

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
// One file, and the whole set, at the size a file is refused at when it is
// picked. The compose host has already applied the same numbers; a plan is not
// allowed to depend on that, because this is what hands bytes to a transport.
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES: usize = 20 * 1024 * 1024;
const MAX_ATTACHMENTS: usize = 20;
const MAX_PROCESS_OUTPUT_BYTES: usize = 2_000_000;
const MAX_DECODED_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Clone)]
pub struct ImapAccount {
    account_id: String,
    email: String,
    imap_url: Url,
    // Absent for a mailbox with no SMTP server. The setup form offers that
    // state — "leave empty to read only" — so it has to survive as far as the
    // plan, where it becomes a refusal rather than a connection to nowhere.
    smtp_url: Option<Url>,
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
        let smtp_url = if smtp_url.is_empty() {
            None
        } else {
            Some(transport_url(smtp_url, &["smtp", "smtps"])?)
        };
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
        attachments: Vec<OutgoingFile<'a>>,
    },
}

/// One file to put in a message, already read by whoever opened it. The bytes
/// are borrowed: a plan holds them only for as long as it takes to encode one.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct OutgoingFile<'a> {
    pub filename: &'a str,
    pub mime_type: &'a str,
    pub data: &'a [u8],
}

// A filename is whatever a stranger, or the user, named a file; the bytes are
// the message itself. Neither belongs in a log line.
impl fmt::Debug for OutgoingFile<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OutgoingFile")
            .field("bytes", &self.data.len())
            .finish_non_exhaustive()
    }
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
    NoSmtpServer,
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
            Self::NoSmtpServer => "this mailbox has no SMTP server set, so it cannot send",
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
    /// The server answered, and its answer was a tagged `NO` or `BAD`.
    ///
    /// curl exits 0 for this: it delivered the command and read the reply, and
    /// whether the server agreed to it is not curl's question. So an exit code
    /// is not an answer about whether a `UID MOVE` happened, and reading only
    /// that reported every refusal — a folder that is gone, a mailbox over
    /// quota, a message another client expunged — as an action that was
    /// carried out, with the row already moved in the list.
    ServerRefused,
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
            // What the server said is not repeated: a refusal can quote the
            // command it refused, and a failed LOGIN is a command with a
            // password in it. `Imap.responseError` is where a sentence about
            // the reason belongs, and it has the response to read.
            Self::ServerRefused => "the mail server refused this request",
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
    let mode = planned.mode;
    let output = runner
        .run_bounded(command, MAX_PROCESS_OUTPUT_BYTES, MAX_PROCESS_OUTPUT_BYTES)
        .map_err(map_command_error)?;
    parse_transport_output(mode, output)
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

fn parse_transport_output(
    mode: &str,
    output: MailProcessOutput,
) -> Result<MailTransportReply, RunnerError> {
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
    // curl exited 0, which says the conversation happened and nothing about
    // what the server said in it. SMTP is left alone: its refusals are reply
    // codes curl already turns into a non-zero exit.
    if mode == "imap" && tagged_failure(&stdout) {
        return Err(RunnerError::ServerRefused);
    }
    Ok(MailTransportReply { stdout })
}

/// Whether a tagged completion in this response said `NO` or `BAD`.
///
/// A port of `Imap.failureCompletion`, and it has to walk the response the way
/// that one does rather than search the bytes: a FETCH carries the message
/// itself in a literal, and an ordinary header such as `X-Spam-Flag: NO` is
/// not the server refusing a command. Only the first protocol line of each
/// response can be a completion, so the literal's own octets are stepped over
/// by their declared count and never read as protocol.
///
/// curl removes the tagged completion around a custom IMAP request, so most
/// successful responses carry none of these at all and this answers false
/// without looking at anything but the untagged lines.
fn tagged_failure(bytes: &[u8]) -> bool {
    let mut index = 0;
    // Whether the next line begins a response rather than continuing one. A
    // literal folds the lines after it into the response that opened it.
    let mut at_start = true;
    while index < bytes.len() {
        let newline = find_crlf(&bytes[index..]).map(|at| index + at);
        let end = newline.unwrap_or(bytes.len());
        let line = &bytes[index..end];
        index = newline.map_or(bytes.len(), |at| at + 2);
        if at_start && refusal_line(line) {
            return true;
        }
        match literal_count(line) {
            Some(size) => {
                index = index.saturating_add(size).min(bytes.len());
                // curl can begin another untagged response at the exact byte
                // after a literal; the count is the boundary either way.
                at_start = bytes[index..].starts_with(b"* ");
            }
            None => at_start = true,
        }
    }
    false
}

fn find_crlf(bytes: &[u8]) -> Option<usize> {
    bytes.windows(2).position(|pair| pair == b"\r\n")
}

/// The octet count a line ending in `{123}` or `{123+}` continues into.
fn literal_count(line: &[u8]) -> Option<usize> {
    let inner = line.strip_suffix(b"}")?;
    let inner = inner.strip_suffix(b"+").unwrap_or(inner);
    let open = inner.iter().rposition(|byte| *byte == b'{')?;
    let digits = &inner[open + 1..];
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse::<usize>().ok()
}

/// `<tag> NO ...` or `<tag> BAD ...`, where the tag is neither the untagged
/// `*` nor the continuation `+`.
fn refusal_line(line: &[u8]) -> bool {
    let space = |byte: u8| byte == b' ' || byte == b'\t';
    // The tag starts the line: a response indented by anything is not one.
    if line
        .first()
        .is_none_or(|byte| space(*byte) || matches!(byte, b'*' | b'+'))
    {
        return false;
    }
    let mut words = line
        .split(|byte| space(*byte))
        .filter(|word| !word.is_empty())
        .skip(1);
    words
        .next()
        .is_some_and(|word| word.eq_ignore_ascii_case(b"NO") || word.eq_ignore_ascii_case(b"BAD"))
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
        // The same header set `ImapProtocol.LIST_HEADERS` asks for, plus the
        // two threading headers this side has always taken. A row is not only
        // a subject and a sender: To and Cc are what the reader shows a
        // message was addressed to, Reply-To is where answering it goes, and
        // List-Unsubscribe is the mailing list's own door out. Asking for
        // fewer left every one of those empty on an IMAP row, so the reader
        // drew a message with no recipients and no unsubscribe notice while
        // the same message on Gmail had both.
        MailOperation::List { folder } => imap_plan(
            account,
            folder,
            vec!["UID FETCH 1:* (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REPLY-TO LIST-UNSUBSCRIBE REFERENCES IN-REPLY-TO)])".to_owned()],
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
        MailOperation::SendThreaded { from, to, cc, bcc, subject, body, in_reply_to, references, attachments } =>
            smtp_threaded_plan(account, from, to, cc, bcc, subject, body, in_reply_to, references, &attachments),
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
    attachments: &[OutgoingFile<'_>],
) -> Result<PlannedTransport, PlanError> {
    // Asked first, because the answer is about the mailbox rather than about
    // the message: a read-only account refuses whatever was typed into it.
    let smtp_url = account.smtp_url.as_ref().ok_or(PlanError::NoSmtpServer)?;
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
    validate_attachments(attachments)?;
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
    message.push_str(&format!(
        "Subject: {}\r\nMIME-Version: 1.0\r\n",
        header_text(subject)
    ));
    if attachments.is_empty() {
        message.push_str(&format!(
            "Content-Type: text/plain; charset=UTF-8\r\n\r\n{}\r\n",
            normalize_crlf(body)
        ));
    } else {
        // With files the text becomes a part of its own, and every part is
        // base64 — including the one the user typed, so that nothing a message
        // contains can be read as the boundary that separates the parts.
        message.push_str(&multipart_body(body, attachments, &mime_boundary()));
    }
    let credentials = format!("{}:{}", account.username, account.password.expose());
    let fields = [
        "smtp".to_owned(),
        encode(smtp_url.as_str()),
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

/// Refuses a file that could write a header nobody agreed to, and a set that
/// is past what a message may carry. The filename is quoted into two header
/// parameters below, so a quote, a backslash or a semicolon in it would end
/// that parameter or start one of its own; the media type is written verbatim,
/// so it must be two RFC 2045 tokens and nothing else.
fn validate_attachments(files: &[OutgoingFile<'_>]) -> Result<(), PlanError> {
    if files.len() > MAX_ATTACHMENTS {
        return Err(PlanError::PayloadTooLarge);
    }
    let mut total = 0usize;
    for file in files {
        if file.filename.is_empty()
            || file.filename.len() > 255
            || file.filename.contains(['"', '\\', ';', '/'])
            || file.filename.chars().any(char::is_control)
        {
            return Err(PlanError::InvalidHeader);
        }
        if !valid_media_type(file.mime_type) {
            return Err(PlanError::InvalidHeader);
        }
        if file.data.len() > MAX_ATTACHMENT_BYTES {
            return Err(PlanError::PayloadTooLarge);
        }
        total = total
            .checked_add(file.data.len())
            .ok_or(PlanError::PayloadTooLarge)?;
        if total > MAX_ATTACHMENT_TOTAL_BYTES {
            return Err(PlanError::PayloadTooLarge);
        }
    }
    Ok(())
}

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

/// A separator no part can contain. Every part of a message built here is
/// base64, an alphabet with no `_` in it, so a boundary carrying one cannot
/// occur inside a body however long it is — the same argument `Message.js`
/// makes for the QML client. The counter keeps two messages built in the same
/// nanosecond apart.
pub fn mime_boundary() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |value| value.as_nanos() as u64);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("=_Omamail_{nanos:x}_{count:x}")
}

/// A filename as a header parameter, the way `Message.js` writes one: quoted
/// while it is printable ASCII, and an RFC 2047 encoded word when it is not,
/// because a raw 8-bit byte in a header is not a filename every server will
/// carry. The quote and the backslash that would need escaping inside the
/// quotes are already refused by [`validate_attachments`].
fn header_phrase(value: &str) -> String {
    if printable_ascii(value) {
        format!("\"{value}\"")
    } else {
        format!("=?UTF-8?B?{}?=", STANDARD.encode(value))
    }
}

/// A header *value* — a Subject — the way `Message.js`'s `foldHeader` writes
/// one: as it stands while it is printable ASCII, and as a single RFC 2047
/// base64 encoded word when it is not.
///
/// A header is US-ASCII by RFC 5322. A raw UTF-8 Subject is not something every
/// server on the way will carry unmodified and not something every reader will
/// decode; Gmail refuses a raw message that has one outright. The QML client
/// has put every Subject through this since it could send at all, and the port
/// wrote the value straight into the header — so "Café" went out as a Subject
/// nobody could rely on, on both the Gmail and the SMTP path.
///
/// One word rather than a folded run of them, which is what the QML does too.
/// It is the encoding that matters here; the length limit RFC 2047 sets on an
/// encoded word is a wrapping question, and no reader this has been put in
/// front of needs it to read the subject.
pub fn header_text(value: &str) -> String {
    if printable_ascii(value) {
        value.to_owned()
    } else {
        format!("=?UTF-8?B?{}?=", STANDARD.encode(value))
    }
}

fn printable_ascii(value: &str) -> bool {
    value
        .chars()
        .all(|character| ('\x20'..='\x7e').contains(&character))
}

/// The `multipart/mixed` body: the text the user wrote, then one part per
/// file, headers included. The caller has already checked every filename and
/// media type with [`validate_attachments`].
pub fn multipart_body(body: &str, files: &[OutgoingFile<'_>], boundary: &str) -> String {
    let mut raw = format!(
        "Content-Type: multipart/mixed; boundary=\"{boundary}\"\r\n\r\n--{boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{}\r\n",
        folded_base64(body.as_bytes())
    );
    for file in files {
        let name = header_phrase(file.filename);
        raw.push_str(&format!(
            "--{boundary}\r\nContent-Type: {}; name={name}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename={name}\r\n\r\n{}\r\n",
            file.mime_type,
            folded_base64(file.data)
        ));
    }
    raw.push_str(&format!("--{boundary}--\r\n"));
    raw
}

/// Base64 wrapped at 76 columns, which is the line length RFC 2045 sets for a
/// transfer encoding — and a limit SMTP servers do enforce.
fn folded_base64(value: &[u8]) -> String {
    STANDARD
        .encode(value)
        .as_bytes()
        .chunks(76)
        .map(|line| std::str::from_utf8(line).expect("base64 ASCII"))
        .collect::<Vec<_>>()
        .join("\r\n")
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
    let smtp_url = account.smtp_url.as_ref().ok_or(PlanError::NoSmtpServer)?;
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
        "From: {from}\r\nTo: {}\r\nSubject: {}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{normalized_body}\r\n",
        recipients.join(", "),
        header_text(subject)
    );
    let credentials = format!("{}:{}", account.username, account.password.expose());
    let mut fields = vec![
        "smtp".to_owned(),
        encode(smtp_url.as_str()),
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

// The message may only claim to come from this mailbox. Case is not part of
// the answer: the composer offers the account's own address back and a copy
// that differs only in case is the same mailbox, so comparing bytes would
// refuse the one address there is to pick.
fn valid_from(value: &str, account_email: &str) -> bool {
    if value.eq_ignore_ascii_case(account_email) {
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
        && address.eq_ignore_ascii_case(account_email)
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
