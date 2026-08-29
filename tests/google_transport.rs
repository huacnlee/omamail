use omamail::providers::gmail::{AccessToken, AccessTokenProvider};
use omamail::{
    platform::{
        commands::{CommandError, PreparedCommand, SystemProcessRunner},
        secrets::{MemorySecretStore, Secret, SecretKey, SecretStore},
    },
    providers::{
        gmail::{GmailError, GmailExecutor, GmailExecutorConfig, GmailOperation, RequestIdentity},
        google_transport::{
            GoogleAccessTokenProvider, GoogleProcessOutput, GoogleProcessRunner, GoogleResolver,
            RestrictedGoogleTransport,
        },
    },
};
use std::{
    fs,
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    sync::Mutex,
    time::Duration,
};

struct Resolver(Vec<IpAddr>);
impl GoogleResolver for Resolver {
    fn resolve(&self, _: &str, _: u16) -> std::io::Result<Vec<IpAddr>> {
        Ok(self.0.clone())
    }
}
struct Runner {
    seen: Mutex<Vec<Seen>>,
    output: Mutex<Option<Result<GoogleProcessOutput, CommandError>>>,
}
struct Tokens;
impl AccessTokenProvider for Tokens {
    fn access_token(&self, refresh: Secret, _: Duration) -> Result<AccessToken, GmailError> {
        assert_eq!(refresh.expose(), "bearer-secret");
        Ok(AccessToken::new(Secret::new("access-secret")))
    }
}
static TOKENS: Tokens = Tokens;
#[derive(Debug, PartialEq, Eq)]
struct Seen {
    arguments: Vec<String>,
    has_stdin: bool,
    stdout_cap: usize,
    stderr_cap: usize,
}
impl GoogleProcessRunner for Runner {
    fn run_bounded(
        &self,
        command: PreparedCommand,
        out: usize,
        err: usize,
    ) -> Result<GoogleProcessOutput, CommandError> {
        self.seen.lock().unwrap().push(Seen {
            arguments: command.arguments().to_vec(),
            has_stdin: command.has_stdin(),
            stdout_cap: out,
            stderr_cap: err,
        });
        self.output.lock().unwrap().take().unwrap()
    }
}

fn run(transport: &RestrictedGoogleTransport<'_>) -> Result<(), GmailError> {
    let store = MemorySecretStore::default();
    let key = SecretKey::gmail(
        "omamail",
        "old",
        "client.apps.googleusercontent.com",
        "me@example.test",
        "gmail.modify",
    )
    .unwrap();
    store.set(&key, Secret::new("bearer-secret")).unwrap();
    GmailExecutor::new(
        &store,
        transport,
        &TOKENS,
        GmailExecutorConfig::new(
            "omamail",
            "old",
            "client.apps.googleusercontent.com",
            "me@example.test",
            "gmail.modify",
        ),
    )?
    .execute(
        RequestIdentity {
            account_id: "me@example.test".into(),
            object_id: "list".into(),
            revision: 1,
        },
        GmailOperation::List {
            query: "in:inbox".into(),
            max_results: 25,
            page_token: None,
        },
        Duration::from_secs(3),
    )?;
    Ok(())
}

fn run_with_tokens(
    transport: &RestrictedGoogleTransport<'_>,
    tokens: &dyn AccessTokenProvider,
) -> Result<(), GmailError> {
    let store = MemorySecretStore::default();
    let key = SecretKey::gmail(
        "omamail",
        "old",
        "client.apps.googleusercontent.com",
        "me@example.test",
        "gmail.modify",
    )
    .unwrap();
    store.set(&key, Secret::new("refresh-secret")).unwrap();
    GmailExecutor::new(
        &store,
        transport,
        tokens,
        GmailExecutorConfig::new(
            "omamail",
            "old",
            "client.apps.googleusercontent.com",
            "me@example.test",
            "gmail.modify",
        ),
    )?
    .execute(
        RequestIdentity {
            account_id: "me@example.test".into(),
            object_id: "list".into(),
            revision: 1,
        },
        GmailOperation::List {
            query: "in:inbox".into(),
            max_results: 25,
            page_token: None,
        },
        Duration::from_secs(3),
    )?;
    Ok(())
}

#[test]
fn fixed_request_is_bounded_and_mixed_private_dns_is_refused() {
    let runner = Runner {
        seen: Mutex::new(vec![]),
        output: Mutex::new(Some(Ok(GoogleProcessOutput::new(
            Some(0),
            b"{\"ok\":true}\nOMAMAIL-STATUS:200\n".to_vec(),
            vec![],
        )))),
    };
    let public = Resolver(vec![IpAddr::V4(Ipv4Addr::new(142, 250, 1, 1))]);
    let transport =
        RestrictedGoogleTransport::new(PathBuf::from("/usr/bin/curl"), &runner, &public);
    run(&transport).unwrap();
    assert_eq!(
        runner.seen.lock().unwrap().as_slice(),
        &[Seen {
            arguments: vec!["-q".into(), "--config".into(), "-".into()],
            has_stdin: true,
            stdout_cap: 1_048_608,
            stderr_cap: 65_536,
        }]
    );
    assert!(!format!("{transport:?}").contains("bearer-secret"));

    let blocked_runner = Runner {
        seen: Mutex::new(vec![]),
        output: Mutex::new(None),
    };
    let mixed = Resolver(vec![
        IpAddr::V4(Ipv4Addr::new(142, 250, 1, 1)),
        IpAddr::V4(Ipv4Addr::LOCALHOST),
    ]);
    let blocked = RestrictedGoogleTransport::new(PathBuf::from("curl"), &blocked_runner, &mixed);
    assert_eq!(run(&blocked).unwrap_err(), GmailError::InvalidRequest);
    assert!(blocked_runner.seen.lock().unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn oauth_exchange_reads_a_protected_client_file_and_never_uses_refresh_as_bearer() {
    use std::os::unix::fs::PermissionsExt as _;
    let temp = tempfile::tempdir().unwrap();
    let curl = temp.path().join("curl");
    let credentials = temp.path().join("oauth.json");
    let capture = temp.path().join("capture");
    let args = temp.path().join("args");
    fs::write(
        &credentials,
        r#"{"clientId":"client.apps.googleusercontent.com","clientSecret":"client-secret"}"#,
    )
    .unwrap();
    fs::set_permissions(&credentials, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&curl, format!(r#"#!/bin/sh
printf '%s\n' "$@" >> '{}'
config=$(cat)
printf '%s\n---\n' "$config" >> '{}'
case "$config" in
  *oauth2.googleapis.com/token*) printf '{{"access_token":"access-secret","token_type":"Bearer","expires_in":3600}}\nOMAMAIL-STATUS:200\n' ;;
  *) printf '{{"messages":[]}}\nOMAMAIL-STATUS:200\n' ;;
esac
"#, args.display(), capture.display())).unwrap();
    fs::set_permissions(&curl, fs::Permissions::from_mode(0o700)).unwrap();
    let resolver = Resolver(vec![IpAddr::V4(Ipv4Addr::new(142, 250, 1, 1))]);
    let system = SystemProcessRunner;
    let tokens = GoogleAccessTokenProvider::new(
        credentials,
        "client.apps.googleusercontent.com",
        curl.clone(),
        &system,
        &resolver,
    );
    let transport = RestrictedGoogleTransport::new(curl, &system, &resolver);
    run_with_tokens(&transport, &tokens).unwrap();
    run_with_tokens(&transport, &tokens).unwrap();
    let argv = fs::read_to_string(args).unwrap();
    let configs = fs::read_to_string(capture).unwrap();
    assert_eq!(argv.lines().filter(|line| *line == "-q").count(), 4);
    assert_eq!(argv.lines().filter(|line| *line == "--config").count(), 4);
    assert_eq!(
        configs
            .matches("https://oauth2.googleapis.com/token")
            .count(),
        2
    );
    assert!(configs.contains("https://oauth2.googleapis.com/token"));
    assert!(configs.contains("refresh-secret"));
    assert!(configs.contains("client-secret"));
    assert!(configs.contains("Authorization: Bearer access-secret"));
    assert!(!configs.contains("Authorization: Bearer refresh-secret"));
    assert!(!format!("{tokens:?} {transport:?}").contains("secret"));
}

#[cfg(unix)]
#[test]
fn fake_curl_receives_secret_url_and_pins_only_in_config_stdin() {
    use std::os::unix::fs::PermissionsExt as _;
    let temp = tempfile::tempdir().unwrap();
    let curl = temp.path().join("curl");
    let config = temp.path().join("config");
    let args = temp.path().join("args");
    fs::write(&curl, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\ncat > '{}'\nprintf '{{\"messages\":[]}}\\nOMAMAIL-STATUS:200\\n'\n", args.display(), config.display())).unwrap();
    fs::set_permissions(&curl, fs::Permissions::from_mode(0o700)).unwrap();
    let resolver = Resolver(vec![IpAddr::V4(Ipv4Addr::new(142, 250, 1, 1))]);
    let transport = RestrictedGoogleTransport::new(curl, &SystemProcessRunner, &resolver);
    run(&transport).unwrap();
    let argv = fs::read_to_string(args).unwrap();
    let config = fs::read_to_string(config).unwrap();
    assert!(!argv.contains("bearer-secret"));
    assert_eq!(argv.lines().collect::<Vec<_>>(), ["-q", "--config", "-"]);
    assert!(config.contains("Authorization: Bearer access-secret"));
    assert!(config.contains("noproxy = \"*\""));
    assert!(config.contains("max-redirs = 0"));
    assert!(config.contains("resolve = \"gmail.googleapis.com:443:142.250.1.1\""));
    assert!(config.contains("https://gmail.googleapis.com/gmail/v1/users/me/messages"));
}

#[test]
fn framing_status_and_process_errors_are_strict_and_redacted() {
    for result in [
        Ok(GoogleProcessOutput::new(
            Some(0),
            b"{}\nOMAMAIL-STATUS:20x\n".to_vec(),
            vec![],
        )),
        Ok(GoogleProcessOutput::new(
            Some(0),
            b"{}\nOMAMAIL-STATUS:500\nextra".to_vec(),
            b"bearer-secret".to_vec(),
        )),
        Err(CommandError::TimedOut),
        Err(CommandError::OutputTooLarge),
    ] {
        let runner = Runner {
            seen: Mutex::new(vec![]),
            output: Mutex::new(Some(result)),
        };
        let resolver = Resolver(vec![IpAddr::V4(Ipv4Addr::new(142, 250, 1, 1))]);
        let transport = RestrictedGoogleTransport::new(PathBuf::from("curl"), &runner, &resolver);
        let error = run(&transport).unwrap_err();
        assert!(!format!("{error:?}").contains("bearer-secret"));
    }
}

#[test]
fn platform_unavailable_is_not_collapsed_into_remote_failure() {
    let runner = Runner {
        seen: Mutex::new(vec![]),
        output: Mutex::new(Some(Err(CommandError::PlatformUnavailable))),
    };
    let resolver = Resolver(vec![IpAddr::V4(Ipv4Addr::new(142, 250, 1, 1))]);
    let transport = RestrictedGoogleTransport::new(PathBuf::from("curl"), &runner, &resolver);
    assert_eq!(
        run(&transport).unwrap_err(),
        GmailError::PlatformUnavailable
    );
}

#[cfg(windows)]
#[test]
fn system_google_transport_fails_closed_on_windows() {
    let resolver = Resolver(vec![IpAddr::V4(Ipv4Addr::new(142, 250, 1, 1))]);
    let transport =
        RestrictedGoogleTransport::new(PathBuf::from("curl.exe"), &SystemProcessRunner, &resolver);
    assert_eq!(
        run(&transport).unwrap_err(),
        GmailError::PlatformUnavailable
    );
}
