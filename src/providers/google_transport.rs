use std::{
    fmt,
    io::Read as _,
    net::{IpAddr, ToSocketAddrs as _},
    path::PathBuf,
};

use serde::Deserialize;
use url::Url;

use crate::platform::{
    commands::{CommandError, PreparedCommand, SystemProcessRunner},
    secrets::Secret,
};

use super::gmail::{
    AccessToken, AccessTokenProvider, GmailError, GmailHttpRequest, GmailHttpResponse,
    GmailTransport, MAX_RESPONSE_BYTES,
};

const MAX_PROCESS_STDOUT: usize = MAX_RESPONSE_BYTES + 32;
const MAX_PROCESS_STDERR: usize = 65_536;

pub trait GoogleResolver: Send + Sync {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>>;
}

pub struct SystemGoogleResolver;
impl GoogleResolver for SystemGoogleResolver {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>> {
        (host, port)
            .to_socket_addrs()
            .map(|values| values.map(|value| value.ip()).collect())
    }
}

pub struct GoogleProcessOutput {
    status: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl GoogleProcessOutput {
    pub fn new(status: Option<i32>, stdout: Vec<u8>, stderr: Vec<u8>) -> Self {
        Self {
            status,
            stdout,
            stderr,
        }
    }
}

impl fmt::Debug for GoogleProcessOutput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GoogleProcessOutput")
            .field("status", &self.status)
            .field("stdout_bytes", &self.stdout.len())
            .field("stderr_bytes", &self.stderr.len())
            .finish()
    }
}

pub trait GoogleProcessRunner: Send + Sync {
    fn run_bounded(
        &self,
        command: PreparedCommand,
        max_stdout: usize,
        max_stderr: usize,
    ) -> Result<GoogleProcessOutput, CommandError>;
}

impl GoogleProcessRunner for SystemProcessRunner {
    fn run_bounded(
        &self,
        command: PreparedCommand,
        max_stdout: usize,
        max_stderr: usize,
    ) -> Result<GoogleProcessOutput, CommandError> {
        let output = crate::platform::commands::ProcessRunner::run_bounded(
            self, command, max_stdout, max_stderr,
        )?;
        Ok(GoogleProcessOutput::new(
            output.status(),
            output.stdout().to_vec(),
            output.stderr().to_vec(),
        ))
    }
}

pub struct RestrictedGoogleTransport<'a> {
    curl: PathBuf,
    runner: &'a dyn GoogleProcessRunner,
    resolver: &'a dyn GoogleResolver,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixedGoogleEndpoint {
    OAuthToken,
    OidcUserInfo,
}

pub struct FixedGoogleClient<'a> {
    curl: PathBuf,
    runner: &'a dyn GoogleProcessRunner,
    resolver: &'a dyn GoogleResolver,
}

impl<'a> FixedGoogleClient<'a> {
    pub fn new(
        curl: PathBuf,
        runner: &'a dyn GoogleProcessRunner,
        resolver: &'a dyn GoogleResolver,
    ) -> Self {
        Self {
            curl,
            runner,
            resolver,
        }
    }

    pub fn post_form(
        &self,
        endpoint: FixedGoogleEndpoint,
        form: Secret,
        deadline: std::time::Duration,
    ) -> Result<Vec<u8>, GmailError> {
        self.execute(
            endpoint,
            "POST",
            Some(("Content-Type: application/x-www-form-urlencoded", form)),
            None,
            deadline,
        )
    }

    pub fn get_bearer(
        &self,
        endpoint: FixedGoogleEndpoint,
        token: Secret,
        deadline: std::time::Duration,
    ) -> Result<Vec<u8>, GmailError> {
        self.execute(endpoint, "GET", None, Some(token), deadline)
    }

    fn execute(
        &self,
        endpoint: FixedGoogleEndpoint,
        method: &str,
        body: Option<(&str, Secret)>,
        bearer: Option<Secret>,
        deadline: std::time::Duration,
    ) -> Result<Vec<u8>, GmailError> {
        if deadline.is_zero() {
            return Err(GmailError::DeadlineExceeded);
        }
        let destination = fixed_destination(endpoint, self.resolver)?;
        let mut config = base_curl_config(&destination, method, deadline);
        if let Some(token) = bearer {
            if token.expose().is_empty() || token.expose().chars().any(char::is_control) {
                return Err(GmailError::InvalidRequest);
            }
            config.push_str(&format!(
                "header = \"Authorization: Bearer {}\"\n",
                escape(token.expose())
            ));
        }
        if let Some((content_type, body)) = body {
            config.push_str(&format!("header = \"{}\"\n", escape(content_type)));
            config.push_str(&format!("data = \"{}\"\n", escape(body.expose())));
        }
        let command = PreparedCommand::new(
            self.curl.clone(),
            vec!["-q".to_owned(), "--config".to_owned(), "-".to_owned()],
            Some(Secret::new(config)),
            deadline,
        )
        .map_err(map_command_error)?;
        let output = self
            .runner
            .run_bounded(command, 65_568, MAX_PROCESS_STDERR)
            .map_err(map_command_error)?;
        let (status, response) = parse_framed(output, 65_536)?;
        if !(200..300).contains(&status) {
            return Err(GmailError::AuthRequired);
        }
        Ok(response)
    }
}

impl fmt::Debug for FixedGoogleClient<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FixedGoogleClient")
            .field("curl", &self.curl)
            .finish_non_exhaustive()
    }
}

impl<'a> RestrictedGoogleTransport<'a> {
    pub fn new(
        curl: PathBuf,
        runner: &'a dyn GoogleProcessRunner,
        resolver: &'a dyn GoogleResolver,
    ) -> Self {
        Self {
            curl,
            runner,
            resolver,
        }
    }
}

impl fmt::Debug for RestrictedGoogleTransport<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RestrictedGoogleTransport")
            .field("curl", &self.curl)
            .finish_non_exhaustive()
    }
}

impl GmailTransport for RestrictedGoogleTransport<'_> {
    fn max_response_bytes(&self) -> usize {
        MAX_RESPONSE_BYTES
    }

    fn execute(
        &self,
        request: GmailHttpRequest,
        credential: AccessToken,
    ) -> Result<GmailHttpResponse, GmailError> {
        let destination = validate_destination(request.url(), self.resolver)?;
        let config = curl_config(&request, credential.expose(), &destination)?;
        let command = PreparedCommand::new(
            self.curl.clone(),
            vec!["-q".to_owned(), "--config".to_owned(), "-".to_owned()],
            Some(Secret::new(config)),
            request.deadline(),
        )
        .map_err(map_command_error)?;
        let output = self
            .runner
            .run_bounded(command, MAX_PROCESS_STDOUT, MAX_PROCESS_STDERR)
            .map_err(map_command_error)?;
        parse_response(output)
    }
}

pub struct GoogleAccessTokenProvider<'a> {
    credentials_file: PathBuf,
    client_id: String,
    curl: PathBuf,
    runner: &'a dyn GoogleProcessRunner,
    resolver: &'a dyn GoogleResolver,
}

impl<'a> GoogleAccessTokenProvider<'a> {
    pub fn new(
        credentials_file: PathBuf,
        client_id: impl Into<String>,
        curl: PathBuf,
        runner: &'a dyn GoogleProcessRunner,
        resolver: &'a dyn GoogleResolver,
    ) -> Self {
        Self {
            credentials_file,
            client_id: client_id.into(),
            curl,
            runner,
            resolver,
        }
    }
}

impl fmt::Debug for GoogleAccessTokenProvider<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GoogleAccessTokenProvider")
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OAuthClientFile {
    client_id: String,
    client_secret: String,
}

impl OAuthClientFile {
    pub fn client_id(&self) -> &str {
        &self.client_id
    }

    pub fn client_secret(&self) -> Secret {
        Secret::new(self.client_secret.clone())
    }
}

impl fmt::Debug for OAuthClientFile {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OAuthClientFile")
            .field("client_id", &self.client_id)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenReply {
    access_token: String,
    token_type: String,
    expires_in: u64,
    #[serde(default)]
    scope: String,
}

impl AccessTokenProvider for GoogleAccessTokenProvider<'_> {
    fn access_token(
        &self,
        refresh_token: Secret,
        deadline: std::time::Duration,
    ) -> Result<AccessToken, GmailError> {
        let client = read_client_file(&self.credentials_file)?;
        if client.client_id != self.client_id
            || client.client_secret.is_empty()
            || client.client_secret.chars().any(char::is_control)
        {
            return Err(GmailError::InvalidRequest);
        }
        let destination = oauth_destination(self.resolver)?;
        let form = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("client_id", &client.client_id)
            .append_pair("client_secret", &client.client_secret)
            .append_pair("refresh_token", refresh_token.expose())
            .append_pair("grant_type", "refresh_token")
            .finish();
        let mut config = base_curl_config(&destination, "POST", deadline);
        config.push_str("header = \"Content-Type: application/x-www-form-urlencoded\"\n");
        config.push_str(&format!("data = \"{}\"\n", escape(&form)));
        let command = PreparedCommand::new(
            self.curl.clone(),
            vec!["-q".to_owned(), "--config".to_owned(), "-".to_owned()],
            Some(Secret::new(config)),
            deadline,
        )
        .map_err(map_command_error)?;
        let output = self
            .runner
            .run_bounded(command, 65_568, MAX_PROCESS_STDERR)
            .map_err(map_command_error)?;
        let (status, body) = parse_framed(output, 65_536)?;
        if !(200..300).contains(&status) {
            return Err(GmailError::AuthRequired);
        }
        let reply: TokenReply =
            serde_json::from_slice(&body).map_err(|_| GmailError::InvalidResponse)?;
        if reply.token_type != "Bearer"
            || reply.access_token.is_empty()
            || reply.access_token.chars().any(char::is_control)
            || reply.expires_in == 0
            || reply.scope.len() > 4096
        {
            return Err(GmailError::InvalidResponse);
        }
        Ok(AccessToken::new(Secret::new(reply.access_token)))
    }
}

struct Destination {
    url: Url,
    host: String,
    pins: Vec<IpAddr>,
}

fn validate_destination(
    raw: &str,
    resolver: &dyn GoogleResolver,
) -> Result<Destination, GmailError> {
    let url = Url::parse(raw).map_err(|_| GmailError::InvalidRequest)?;
    let host = url.host_str().ok_or(GmailError::InvalidRequest)?.to_owned();
    let path_ok = match host.as_str() {
        "gmail.googleapis.com" => url.path().starts_with("/gmail/v1/"),
        "www.googleapis.com" => url.path().starts_with("/calendar/v3/"),
        _ => false,
    };
    if url.scheme() != "https"
        || !path_ok
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(GmailError::InvalidRequest);
    }
    let pins = resolver
        .resolve(&host, 443)
        .map_err(|_| GmailError::InvalidRequest)?;
    if pins.is_empty() || pins.iter().any(|address| !is_public(*address)) {
        return Err(GmailError::InvalidRequest);
    }
    Ok(Destination { url, host, pins })
}

fn oauth_destination(resolver: &dyn GoogleResolver) -> Result<Destination, GmailError> {
    let url = Url::parse("https://oauth2.googleapis.com/token")
        .map_err(|_| GmailError::InvalidRequest)?;
    let host = "oauth2.googleapis.com".to_owned();
    let pins = resolver
        .resolve(&host, 443)
        .map_err(|_| GmailError::InvalidRequest)?;
    if pins.is_empty() || pins.iter().any(|address| !is_public(*address)) {
        return Err(GmailError::InvalidRequest);
    }
    Ok(Destination { url, host, pins })
}

fn fixed_destination(
    endpoint: FixedGoogleEndpoint,
    resolver: &dyn GoogleResolver,
) -> Result<Destination, GmailError> {
    let (raw, host) = match endpoint {
        FixedGoogleEndpoint::OAuthToken => (
            "https://oauth2.googleapis.com/token",
            "oauth2.googleapis.com",
        ),
        FixedGoogleEndpoint::OidcUserInfo => (
            "https://openidconnect.googleapis.com/v1/userinfo",
            "openidconnect.googleapis.com",
        ),
    };
    let url = Url::parse(raw).map_err(|_| GmailError::InvalidRequest)?;
    let pins = resolver
        .resolve(host, 443)
        .map_err(|_| GmailError::InvalidRequest)?;
    if pins.is_empty() || pins.iter().any(|address| !is_public(*address)) {
        return Err(GmailError::InvalidRequest);
    }
    Ok(Destination {
        url,
        host: host.to_owned(),
        pins,
    })
}

pub fn read_client_file(path: &std::path::Path) -> Result<OAuthClientFile, GmailError> {
    #[cfg(not(unix))]
    {
        let _ = path;
        return Err(GmailError::PlatformUnavailable);
    }
    #[cfg(unix)]
    {
        use std::{
            fs::OpenOptions,
            os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _},
        };
        let mut file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| GmailError::SecretUnavailable)?;
        let metadata = file.metadata().map_err(|_| GmailError::SecretUnavailable)?;
        if !metadata.file_type().is_file()
            || metadata.len() > 65_536
            || metadata.permissions().mode() & 0o077 != 0
        {
            return Err(GmailError::SecretUnavailable);
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(65_537)
            .read_to_end(&mut bytes)
            .map_err(|_| GmailError::SecretUnavailable)?;
        if bytes.len() > 65_536 {
            return Err(GmailError::SecretUnavailable);
        }
        serde_json::from_slice(&bytes).map_err(|_| GmailError::InvalidRequest)
    }
}

fn base_curl_config(
    destination: &Destination,
    method: &str,
    deadline: std::time::Duration,
) -> String {
    let mut config = format!(
        "url = \"{}\"\nnoproxy = \"*\"\nproxy = \"\"\nproto = \"=https\"\nproto-redir = \"=https\"\nlocation = false\nmax-redirs = 0\nrequest = \"{}\"\nheader = \"Accept: application/json\"\nmax-time = {}\nconnect-timeout = 20\nwrite-out = \"\\nOMAMAIL-STATUS:%{{http_code}}\\n\"\n",
        escape(destination.url.as_str()),
        method,
        deadline.as_secs_f64()
    );
    append_pins(&mut config, destination);
    config
}

fn append_pins(config: &mut String, destination: &Destination) {
    for pin in &destination.pins {
        let pin = match pin {
            IpAddr::V4(value) => value.to_string(),
            IpAddr::V6(value) => format!("[{value}]"),
        };
        config.push_str(&format!("resolve = \"{}:443:{}\"\n", destination.host, pin));
    }
}

fn curl_config(
    request: &GmailHttpRequest,
    credential: &str,
    destination: &Destination,
) -> Result<String, GmailError> {
    if credential.is_empty() || credential.chars().any(char::is_control) {
        return Err(GmailError::InvalidRequest);
    }
    if !matches!(request.method(), "GET" | "POST") {
        return Err(GmailError::InvalidRequest);
    }
    let mut config = format!(
        "url = \"{}\"\nnoproxy = \"*\"\nproxy = \"\"\nproto = \"=https\"\nproto-redir = \"=https\"\nlocation = false\nmax-redirs = 0\nrequest = \"{}\"\nheader = \"Authorization: Bearer {}\"\nheader = \"Accept: application/json\"\nmax-time = {}\nconnect-timeout = 20\nwrite-out = \"\\nOMAMAIL-STATUS:%{{http_code}}\\n\"\n",
        escape(destination.url.as_str()),
        request.method(),
        escape(credential),
        request.deadline().as_secs_f64(),
    );
    for pin in &destination.pins {
        let pin = match pin {
            IpAddr::V4(value) => value.to_string(),
            IpAddr::V6(value) => format!("[{value}]"),
        };
        config.push_str(&format!("resolve = \"{}:443:{}\"\n", destination.host, pin));
    }
    if let Some(body) = request.body() {
        config.push_str("header = \"Content-Type: application/json\"\n");
        config.push_str(&format!("data = \"{}\"\n", escape(body)));
    }
    Ok(config)
}

fn parse_response(output: GoogleProcessOutput) -> Result<GmailHttpResponse, GmailError> {
    let (status, body) = parse_framed(output, MAX_RESPONSE_BYTES)?;
    Ok(GmailHttpResponse::json(status, body))
}

fn parse_framed(
    output: GoogleProcessOutput,
    max_body: usize,
) -> Result<(u16, Vec<u8>), GmailError> {
    if output.status != Some(0) {
        return Err(GmailError::RemoteFailure);
    }
    let text = std::str::from_utf8(&output.stdout).map_err(|_| GmailError::InvalidResponse)?;
    let (body, status) = text
        .rsplit_once("\nOMAMAIL-STATUS:")
        .ok_or(GmailError::InvalidResponse)?;
    let status = status
        .strip_suffix('\n')
        .filter(|value| value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or(GmailError::InvalidResponse)?
        .parse::<u16>()
        .map_err(|_| GmailError::InvalidResponse)?;
    if body.len() > max_body {
        return Err(GmailError::OutputTooLarge);
    }
    Ok((status, body.as_bytes().to_vec()))
}

fn map_command_error(error: CommandError) -> GmailError {
    match error {
        CommandError::TimedOut => GmailError::DeadlineExceeded,
        CommandError::OutputTooLarge => GmailError::OutputTooLarge,
        CommandError::PlatformUnavailable => GmailError::PlatformUnavailable,
        _ => GmailError::RemoteFailure,
    }
}

fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t")
}

fn is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(value) => {
            let [first, second, third, _] = value.octets();
            !(value.is_private()
                || value.is_loopback()
                || value.is_link_local()
                || value.is_broadcast()
                || value.is_unspecified()
                || value.is_multicast()
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
        IpAddr::V6(value) => match value.to_ipv4_mapped() {
            Some(mapped) => is_public(IpAddr::V4(mapped)),
            None => {
                let segments = value.segments();
                !(value.is_loopback()
                    || value.is_unspecified()
                    || value.is_unique_local()
                    || value.is_unicast_link_local()
                    || value.is_multicast()
                    || (segments[0] & 0xffc0) == 0xfec0
                    || (segments[0] == 0x0100 && segments[1..].iter().all(|part| *part == 0))
                    || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                    || (segments[0] & 0xfff0) == 0x3ff0)
            }
        },
    }
}
