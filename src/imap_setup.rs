//! Privileged, setup-only IMAP credential verification and commit boundary.

use std::{
    net::IpAddr,
    path::PathBuf,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::json;
use url::{Host, Url};

use crate::platform::{
    commands::{CommandError, PreparedCommand, ProcessRunner, SystemProcessRunner},
    secrets::{Secret, SecretKey, SecretStore, SystemSecretStore},
};

const MAX_REQUEST_BYTES: usize = 16 * 1024;
const MAX_DEADLINE: Duration = Duration::from_secs(120);
const MAX_EMAIL_BYTES: usize = 320;
const MAX_USERNAME_BYTES: usize = 1024;
const MAX_PASSWORD_BYTES: usize = 4096;
const MAX_HOST_BYTES: usize = 253;
const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupProtocol {
    Imap,
    Smtp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupTarget {
    protocol: SetupProtocol,
    url: String,
}
impl SetupTarget {
    pub fn protocol(&self) -> SetupProtocol {
        self.protocol
    }
    pub fn url(&self) -> &str {
        &self.url
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupError {
    Invalid,
    InsecureRemote,
    Rejected,
    TimedOut,
    Unavailable,
    Storage,
}
impl SetupError {
    pub fn message(self) -> &'static str {
        match self {
            Self::Invalid => "Invalid IMAP setup request",
            Self::InsecureRemote => "Insecure mail servers must use loopback addresses",
            Self::Rejected => "Mail server sign-in was rejected",
            Self::TimedOut => "Mail server verification timed out",
            Self::Unavailable => "Mail server verification is unavailable",
            Self::Storage => "Couldn’t store the mail password",
        }
    }
}

pub trait SetupVerifier: Send + Sync {
    fn verify(
        &self,
        target: &SetupTarget,
        credentials: &Secret,
        deadline: Duration,
    ) -> Result<(), SetupError>;
}

pub struct ImapSetupAuthority<V, S> {
    verifier: V,
    store: S,
}
impl<V, S> ImapSetupAuthority<V, S> {
    pub fn new(verifier: V, store: S) -> Self {
        Self { verifier, store }
    }
    pub fn verifier(&self) -> &V {
        &self.verifier
    }
    pub fn store(&self) -> &S {
        &self.store
    }
}

impl<V: SetupVerifier, S: SecretStore> ImapSetupAuthority<V, S> {
    pub fn dispatch(&self, request: &str) -> String {
        let result = self.parse_and_execute(request);
        match result {
            Ok(data) => serde_json::to_string(&json!({"ok":true,"data":data})),
            Err(error) => {
                let forget = serde_json::from_str::<serde_json::Value>(request)
                    .ok()
                    .and_then(|value| value.get("operation").and_then(|op| op.as_str()).map(str::to_owned))
                    .as_deref()
                    == Some("imap.setup.forgetCredential");
                if forget {
                    serde_json::to_string(&json!({
                        "ok":false,
                        "credentialOutcome": if error == SetupError::Storage { "uncertain" } else { "beforeEffect" },
                        "error":error.message()
                    }))
                } else {
                    serde_json::to_string(&json!({"ok":false,"error":error.message()}))
                }
            }
        }
        .unwrap_or_else(|_| {
            r#"{"ok":false,"error":"Mail server verification is unavailable"}"#.to_owned()
        })
    }

    fn parse_and_execute(&self, json: &str) -> Result<SetupReply, SetupError> {
        if json.len() > MAX_REQUEST_BYTES {
            return Err(SetupError::Invalid);
        }
        let value: serde_json::Value =
            serde_json::from_str(json).map_err(|_| SetupError::Invalid)?;
        let operation = value
            .get("operation")
            .and_then(serde_json::Value::as_str)
            .ok_or(SetupError::Invalid)?;
        if operation == "imap.setup.forgetCredential" {
            let request: ForgetRequest =
                serde_json::from_value(value).map_err(|_| SetupError::Invalid)?;
            return self.forget(request).map(|_| SetupReply::forgotten());
        }
        let request: VerifyRequest =
            serde_json::from_value(value).map_err(|_| SetupError::Invalid)?;
        if request.operation != "imap.setup.verifyAndStore"
            || request.deadline_ms == 0
            || request.deadline_ms > MAX_DEADLINE.as_millis() as u64
        {
            return Err(SetupError::Invalid);
        }
        let setup = ValidatedSetup::new(request)?;
        let deadline = Duration::from_millis(setup.deadline_ms);
        let started = Instant::now();
        let credentials = Secret::new(format!("{}:{}", setup.username, setup.password.expose()));
        self.verifier.verify(&setup.imap, &credentials, deadline)?;
        let remaining = deadline
            .checked_sub(started.elapsed())
            .filter(|value| !value.is_zero())
            .ok_or(SetupError::TimedOut)?;
        self.verifier.verify(&setup.smtp, &credentials, remaining)?;
        if started.elapsed() >= deadline {
            return Err(SetupError::TimedOut);
        }
        let key = SecretKey::imap_endpoint(
            "omamail",
            &setup.account_id,
            &setup.imap_host,
            setup.imap_port,
            &setup.username,
        )
        .map_err(|_| SetupError::Invalid)?;
        let reply = setup.reply();
        if self.store.set(&key, setup.password).is_err() {
            let _ = self.store.delete(&key);
            return Err(SetupError::Storage);
        }
        Ok(reply)
    }

    fn forget(&self, request: ForgetRequest) -> Result<(), SetupError> {
        if request.operation != "imap.setup.forgetCredential" {
            return Err(SetupError::Invalid);
        }
        let email = canonical_email(
            request
                .account_id
                .strip_prefix("imap:")
                .ok_or(SetupError::Invalid)?,
        )?;
        if request.account_id != format!("imap:{email}") {
            return Err(SetupError::Invalid);
        }
        let host = canonical_host(&request.imap_host)?;
        let username = bounded_text(&request.username, MAX_USERNAME_BYTES)?;
        let key = SecretKey::imap_endpoint(
            "omamail",
            &request.account_id,
            &host,
            request.imap_port,
            &username,
        )
        .map_err(|_| SetupError::Invalid)?;
        self.store.delete(&key).map_err(|_| SetupError::Storage)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct VerifyRequest {
    operation: String,
    deadline_ms: u64,
    email: String,
    username: String,
    password: String,
    imap_host: String,
    #[serde(default)]
    imap_port: Option<u16>,
    smtp_host: String,
    #[serde(default)]
    smtp_port: Option<u16>,
    #[serde(default)]
    insecure: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ForgetRequest {
    operation: String,
    account_id: String,
    imap_host: String,
    imap_port: u16,
    username: String,
}

struct ValidatedSetup {
    deadline_ms: u64,
    account_id: String,
    email: String,
    username: String,
    password: Secret,
    imap_host: String,
    imap_port: u16,
    smtp_host: String,
    smtp_port: u16,
    insecure: bool,
    imap: SetupTarget,
    smtp: SetupTarget,
}
impl ValidatedSetup {
    fn new(request: VerifyRequest) -> Result<Self, SetupError> {
        let email = canonical_email(&request.email)?;
        let username = bounded_text(&request.username, MAX_USERNAME_BYTES)?;
        if request.password.is_empty()
            || request.password.len() > MAX_PASSWORD_BYTES
            || request.password.contains('\0')
        {
            return Err(SetupError::Invalid);
        }
        let imap_host = canonical_host(&request.imap_host)?;
        let smtp_host = canonical_host(&request.smtp_host)?;
        if request.insecure && (!literal_loopback(&imap_host) || !literal_loopback(&smtp_host)) {
            return Err(SetupError::InsecureRemote);
        }
        let imap_port = request
            .imap_port
            .unwrap_or(if request.insecure { 143 } else { 993 });
        let smtp_port = request
            .smtp_port
            .unwrap_or(if request.insecure { 587 } else { 465 });
        if imap_port == 0 || smtp_port == 0 {
            return Err(SetupError::Invalid);
        }
        let imap = SetupTarget {
            protocol: SetupProtocol::Imap,
            url: transport_url(
                if request.insecure { "imap" } else { "imaps" },
                &imap_host,
                imap_port,
            )?,
        };
        let smtp = SetupTarget {
            protocol: SetupProtocol::Smtp,
            url: transport_url(
                if request.insecure { "smtp" } else { "smtps" },
                &smtp_host,
                smtp_port,
            )?,
        };
        Ok(Self {
            deadline_ms: request.deadline_ms,
            account_id: format!("imap:{email}"),
            email,
            username,
            password: Secret::new(request.password),
            imap_host,
            imap_port,
            smtp_host,
            smtp_port,
            insecure: request.insecure,
            imap,
            smtp,
        })
    }

    fn reply(&self) -> SetupReply {
        let context = SetupContext {
            kind: "imap",
            account_id: self.account_id.clone(),
            email: self.email.clone(),
            username: self.username.clone(),
            imap_host: self.imap_host.clone(),
            imap_port: self.imap_port,
            smtp_host: self.smtp_host.clone(),
            smtp_port: self.smtp_port,
            insecure: self.insecure,
        };
        SetupReply {
            account: Some(SetupAccount {
                id: self.account_id.clone(),
                email: self.email.clone(),
                provider: "imap",
                label: self.email.clone(),
                imap: SetupImap {
                    username: self.username.clone(),
                    imap_host: self.imap_host.clone(),
                    imap_port: self.imap_port,
                    smtp_host: self.smtp_host.clone(),
                    smtp_port: self.smtp_port,
                    insecure: self.insecure,
                },
            }),
            context: Some(context),
            forgotten: None,
            outcome: None,
        }
    }
}

#[derive(Serialize)]
struct SetupReply {
    #[serde(skip_serializing_if = "Option::is_none")]
    account: Option<SetupAccount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<SetupContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    forgotten: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<&'static str>,
}
impl SetupReply {
    fn forgotten() -> Self {
        Self {
            account: None,
            context: None,
            forgotten: Some(true),
            outcome: Some("deleted"),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupAccount {
    id: String,
    email: String,
    provider: &'static str,
    label: String,
    imap: SetupImap,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupImap {
    username: String,
    imap_host: String,
    imap_port: u16,
    smtp_host: String,
    smtp_port: u16,
    insecure: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupContext {
    kind: &'static str,
    account_id: String,
    email: String,
    username: String,
    imap_host: String,
    imap_port: u16,
    smtp_host: String,
    smtp_port: u16,
    insecure: bool,
}

fn bounded_text(value: &str, max: usize) -> Result<String, SetupError> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.len() > max
        || trimmed.chars().any(|character| character.is_control())
    {
        Err(SetupError::Invalid)
    } else {
        Ok(trimmed.to_owned())
    }
}

fn canonical_email(value: &str) -> Result<String, SetupError> {
    let email = bounded_text(value, MAX_EMAIL_BYTES)?;
    let mut parts = email.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    if local.is_empty()
        || domain.is_empty()
        || parts.next().is_some()
        || local.starts_with('.')
        || local.ends_with('.')
        || local.contains("..")
        || domain.starts_with('.')
        || domain.ends_with('.')
    {
        return Err(SetupError::Invalid);
    }
    let host = canonical_host(domain)?;
    if host.parse::<IpAddr>().is_ok() || !host.contains('.') {
        return Err(SetupError::Invalid);
    }
    Ok(format!("{local}@{host}"))
}

fn canonical_host(value: &str) -> Result<String, SetupError> {
    let host = bounded_text(value, MAX_HOST_BYTES)?;
    if let Ok(address) = host.parse::<IpAddr>() {
        return Ok(address.to_string());
    }
    if host.contains(['/', ':', '[', ']', '@', '?', '#']) {
        return Err(SetupError::Invalid);
    }
    let parsed = Host::parse(&host).map_err(|_| SetupError::Invalid)?;
    let canonical = parsed.to_string().to_ascii_lowercase();
    if canonical.len() > MAX_HOST_BYTES {
        Err(SetupError::Invalid)
    } else {
        Ok(canonical)
    }
}

fn literal_loopback(host: &str) -> bool {
    host.parse::<IpAddr>()
        .is_ok_and(|address| address.is_loopback())
}

fn transport_url(scheme: &str, host: &str, port: u16) -> Result<String, SetupError> {
    let authority = if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    let url =
        Url::parse(&format!("{scheme}://{authority}:{port}")).map_err(|_| SetupError::Invalid)?;
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

pub struct SystemSetupVerifier {
    script: PathBuf,
    runner: SystemProcessRunner,
}
impl SystemSetupVerifier {
    pub fn new(app_root: PathBuf) -> Self {
        Self {
            script: app_root.join("scripts/mail-transport.sh"),
            runner: SystemProcessRunner,
        }
    }
}
impl SetupVerifier for SystemSetupVerifier {
    fn verify(
        &self,
        target: &SetupTarget,
        credentials: &Secret,
        deadline: Duration,
    ) -> Result<(), SetupError> {
        let mode = match target.protocol {
            SetupProtocol::Imap => "imap",
            SetupProtocol::Smtp => "smtp-verify",
        };
        let argument = match target.protocol {
            SetupProtocol::Imap => "CAPABILITY",
            SetupProtocol::Smtp => "verify",
        };
        let input = [
            mode.to_owned(),
            STANDARD.encode(target.url.as_bytes()),
            STANDARD.encode(credentials.expose().as_bytes()),
            STANDARD.encode(argument.as_bytes()),
        ]
        .join(" ")
            + "\n";
        let command = PreparedCommand::new(
            self.script.clone(),
            Vec::new(),
            Some(Secret::new(input)),
            deadline,
        )
        .map_err(map_command_error)?;
        let output = self
            .runner
            .run_bounded(command, MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES)
            .map_err(map_command_error)?;
        if output.status() != Some(0) {
            return Err(SetupError::Unavailable);
        }
        let stdout = std::str::from_utf8(output.stdout()).map_err(|_| SetupError::Unavailable)?;
        if stdout.contains('\r') || !stdout.ends_with('\n') {
            return Err(SetupError::Unavailable);
        }
        let lines = stdout
            .trim_end_matches('\n')
            .split('\n')
            .collect::<Vec<_>>();
        if lines.len() != 3
            || STANDARD.decode(lines[1]).is_err()
            || STANDARD.decode(lines[2]).is_err()
        {
            return Err(SetupError::Unavailable);
        }
        if lines[0] == "0" {
            Ok(())
        } else {
            Err(SetupError::Rejected)
        }
    }
}

fn map_command_error(error: CommandError) -> SetupError {
    match error {
        CommandError::TimedOut => SetupError::TimedOut,
        _ => SetupError::Unavailable,
    }
}

pub type ProductionImapSetup = ImapSetupAuthority<SystemSetupVerifier, SystemSecretStore>;
pub fn production(app_root: PathBuf) -> ProductionImapSetup {
    ImapSetupAuthority::new(
        SystemSetupVerifier::new(app_root),
        SystemSecretStore::default(),
    )
}
