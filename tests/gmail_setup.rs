use std::{
    fs,
    io::Write as _,
    net::TcpStream,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};

use omamail::{
    gmail_setup::{
        FlowPoll, GoogleOAuthExchanger, LoopbackOAuthFlow, OAuthCommitter, OAuthFlow,
        OAuthTokenExchanger, ProductionOAuthCommitter, RandomSource, SCOPES, SetupError,
        VerifiedGrant,
    },
    platform::{
        commands::SystemProcessRunner,
        secrets::{Secret, SecretKey, SecretStore, SecretStoreError},
    },
    providers::google_transport::GoogleResolver,
};

struct PublicResolver;
impl GoogleResolver for PublicResolver {
    fn resolve(&self, _: &str, _: u16) -> std::io::Result<Vec<std::net::IpAddr>> {
        Ok(vec!["142.250.1.1".parse().unwrap()])
    }
}
struct MixedResolver;
impl GoogleResolver for MixedResolver {
    fn resolve(&self, _: &str, _: u16) -> std::io::Result<Vec<std::net::IpAddr>> {
        Ok(vec![
            "142.250.1.1".parse().unwrap(),
            "127.0.0.1".parse().unwrap(),
        ])
    }
}

struct FixedRandom;
impl RandomSource for FixedRandom {
    fn fill(&self, bytes: &mut [u8]) -> Result<(), SetupError> {
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = (index as u8).wrapping_add(1);
        }
        Ok(())
    }
}

struct SequencedRandom(AtomicU8);
impl RandomSource for SequencedRandom {
    fn fill(&self, bytes: &mut [u8]) -> Result<(), SetupError> {
        let seed = self.0.fetch_add(1, Ordering::SeqCst);
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = seed.wrapping_add(index as u8).wrapping_add(1);
        }
        Ok(())
    }
}

#[test]
fn loopback_flow_generates_pkce_state_and_accepts_one_strict_callback() {
    let flow = LoopbackOAuthFlow::new("123-client.apps.googleusercontent.com", FixedRandom);
    let begin = flow.begin(SCOPES, Duration::from_secs(2)).unwrap();
    let auth = url::Url::parse(&begin.url).unwrap();
    let query = auth
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        auth.origin().ascii_serialization(),
        "https://accounts.google.com"
    );
    assert_eq!(query.get("code_challenge_method").unwrap(), "S256");
    let redirect = url::Url::parse(query.get("redirect_uri").unwrap()).unwrap();
    assert_eq!(redirect.host_str(), Some("127.0.0.1"));
    let mut socket = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
    write!(
        socket,
        "GET /oauth2callback?code=verified-code&state={} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        query.get("state").unwrap()
    )
    .unwrap();
    assert!(
        matches!(flow.poll(&begin.flow_id), Ok(FlowPoll::Callback { code, .. }) if code == "verified-code")
    );
    assert_eq!(flow.poll(&begin.flow_id), Err(SetupError::Invalid));
}

#[test]
fn loopback_flow_rejects_wrong_method_and_cancel_drops_listener() {
    let flow = LoopbackOAuthFlow::new("123-client.apps.googleusercontent.com", FixedRandom);
    let begin = flow.begin(SCOPES, Duration::from_secs(2)).unwrap();
    let auth = url::Url::parse(&begin.url).unwrap();
    let redirect = url::Url::parse(
        &auth
            .query_pairs()
            .find(|(key, _)| key == "redirect_uri")
            .unwrap()
            .1,
    )
    .unwrap();
    let mut socket = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
    socket
        .write_all(b"POST /oauth2callback HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        .unwrap();
    assert_eq!(flow.poll(&begin.flow_id), Err(SetupError::Invalid));
    let second = flow.begin(SCOPES, Duration::from_secs(2)).unwrap();
    flow.cancel(&second.flow_id);
    assert_eq!(flow.poll(&second.flow_id), Err(SetupError::Invalid));
}

#[test]
fn partial_callback_does_not_lock_other_flows() {
    let flow = Arc::new(LoopbackOAuthFlow::new(
        "123-client.apps.googleusercontent.com",
        SequencedRandom(AtomicU8::new(0)),
    ));
    let first = flow.begin(SCOPES, Duration::from_secs(2)).unwrap();
    let auth = url::Url::parse(&first.url).unwrap();
    let redirect = url::Url::parse(
        &auth
            .query_pairs()
            .find(|(key, _)| key == "redirect_uri")
            .unwrap()
            .1,
    )
    .unwrap();
    let mut partial = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
    partial.write_all(b"GET /oauth2callback?").unwrap();

    let polling = Arc::clone(&flow);
    let flow_id = first.flow_id.clone();
    let reader = std::thread::spawn(move || polling.poll(&flow_id));
    std::thread::sleep(Duration::from_millis(25));

    let (sent, received) = std::sync::mpsc::channel();
    let other = Arc::clone(&flow);
    let worker = std::thread::spawn(move || {
        let second = other.begin(SCOPES, Duration::from_secs(2)).unwrap();
        assert_eq!(other.poll(&second.flow_id), Ok(FlowPoll::Pending));
        other.cancel(&second.flow_id);
        sent.send(()).unwrap();
    });
    let prompt = received.recv_timeout(Duration::from_millis(150));
    drop(partial);
    reader.join().unwrap().unwrap_err();
    worker.join().unwrap();
    assert!(
        prompt.is_ok(),
        "a partial callback held the flow registry lock"
    );
    assert_eq!(flow.poll(&first.flow_id), Err(SetupError::Invalid));
}

// A socket that connects and then says nothing must not cost the sign-in its
// remaining window.
//
// `accept` returns as soon as the TCP handshake finishes, which is not the same
// moment the request arrives — and on a loopback port a connection that never
// writes at all is ordinary: a browser's speculative preconnect, a second
// socket it opened and did not use. Reading one used to block for whatever was
// left of the person's four minutes, inside the host call the window is
// awaiting, so the page sat on "Waiting for sign-in" with nothing to say.
//
// Twenty seconds of window against a ten-second assertion: before the read was
// bounded this took the whole twenty.
#[test]
fn a_connection_that_says_nothing_does_not_swallow_the_sign_in_window() {
    let flow = LoopbackOAuthFlow::new("123-client.apps.googleusercontent.com", FixedRandom);
    let begin = flow.begin(SCOPES, Duration::from_secs(20)).unwrap();
    let auth = url::Url::parse(&begin.url).unwrap();
    let redirect = url::Url::parse(
        &auth
            .query_pairs()
            .find(|(key, _)| key == "redirect_uri")
            .unwrap()
            .1,
    )
    .unwrap();

    let silent = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
    let started = std::time::Instant::now();
    let outcome = flow.poll(&begin.flow_id);
    let waited = started.elapsed();
    drop(silent);

    assert!(
        waited < Duration::from_secs(10),
        "a silent connection held the poll for {waited:?}; the read is not bounded"
    );
    assert_eq!(outcome, Err(SetupError::Invalid));
}

#[test]
fn unavailable_production_boundary_is_closed_and_redacted() {
    assert_eq!(
        omamail::gmail_setup::dispatch_unavailable(
            r#"{"operation":"gmail.oauth.begin","deadlineMs":1000}"#
        ),
        r#"{"ok":false,"error":"Gmail sign-in is unavailable"}"#
    );
    let invalid = omamail::gmail_setup::dispatch_unavailable(
        r#"{"operation":"gmail.oauth.begin","deadlineMs":1000,"token":"secret-value"}"#,
    );
    assert_eq!(
        invalid,
        r#"{"ok":false,"error":"invalid Gmail sign-in request"}"#
    );
    assert!(!invalid.contains("secret-value"));
}

#[cfg(unix)]
#[test]
fn production_exchange_uses_fixed_pinned_endpoints_and_keeps_secrets_off_argv() {
    use std::os::unix::fs::PermissionsExt as _;

    let root = tempfile::tempdir().unwrap();
    let curl = root.path().join("curl");
    let argv = root.path().join("argv");
    let configs = root.path().join("configs");
    fs::write(
        &curl,
        format!(
            r#"#!/bin/sh
printf '%s\n' "$@" >> '{}'
config=$(cat)
printf '%s\n---\n' "$config" >> '{}'
case "$config" in
  *oauth2.googleapis.com/token*) printf '{{"access_token":"access-secret","refresh_token":"refresh-secret","expires_in":3600,"token_type":"Bearer","scope":"openid email"}}\nOMAMAIL-STATUS:200\n' ;;
  *openidconnect.googleapis.com/v1/userinfo*) printf '{{"sub":"subject","email":"User@Example.COM","email_verified":true}}\nOMAMAIL-STATUS:200\n' ;;
  *) exit 44 ;;
esac
"#,
            argv.display(),
            configs.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&curl, fs::Permissions::from_mode(0o700)).unwrap();
    let exchanger = GoogleOAuthExchanger::new(
        "123-client.apps.googleusercontent.com",
        Secret::new("client-secret-value"),
        curl,
        SystemProcessRunner,
        PublicResolver,
    );
    let grant = exchanger
        .exchange(
            "authorization-code",
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~",
            "http://127.0.0.1:4321/oauth2callback",
            Duration::from_secs(10),
        )
        .unwrap();
    assert!(!format!("{grant:?}").contains("refresh-secret"));
    let argv = fs::read_to_string(argv).unwrap();
    let configs = fs::read_to_string(configs).unwrap();
    assert_eq!(
        argv.lines().collect::<Vec<_>>(),
        ["-q", "--config", "-", "-q", "--config", "-"]
    );
    for secret in [
        "authorization-code",
        "client-secret-value",
        "access-secret",
        "refresh-secret",
    ] {
        assert!(!argv.contains(secret));
    }
    assert!(configs.contains("https://oauth2.googleapis.com/token"));
    assert!(configs.contains("https://openidconnect.googleapis.com/v1/userinfo"));
    assert!(configs.contains("code_verifier="));
    assert!(configs.contains("Authorization: Bearer access-secret"));
    assert!(configs.contains("noproxy = \"*\""));
    // Redirects are refused by `max-redirs = 0`, not by a boolean carrying a
    // value. curl 8 rejects `location = false` as trailing garbage and exits
    // before opening a socket, so the line that read like the safety measure
    // was the thing breaking every call.
    assert!(configs.contains("max-redirs = 0"));
    assert!(
        !configs
            .lines()
            .any(|line| line.ends_with(" = true") || line.ends_with(" = false")),
        "a curl boolean is written bare or not at all, never with a value"
    );
    assert!(configs.contains("resolve = \"oauth2.googleapis.com:443:142.250.1.1\""));
    assert!(configs.contains("resolve = \"openidconnect.googleapis.com:443:142.250.1.1\""));
    assert!(!format!("{exchanger:?}").contains("client-secret-value"));

    let deadlines = configs
        .lines()
        .filter_map(|line| line.strip_prefix("max-time = "))
        .map(|value| value.parse::<f64>().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(deadlines.len(), 2);
    assert!(
        deadlines[1] <= deadlines[0],
        "profile must receive only the remaining absolute deadline"
    );
}

// What Google actually sends back, rather than the smallest reply that would
// satisfy the parser.
//
// Both halves are real shapes. The token reply carries `id_token`, because the
// request asked for `openid`, and `refresh_token_expires_in`, because a project
// left in Testing is issued a seven-day refresh token — which is every project
// until somebody presses "Publish app", and the setup page says so in as many
// words. The userinfo reply carries the `profile` claims plus the ones Google
// has added since. Neither list is ours and neither is closed.
//
// The scope line is the granted set from a real consent screen: eight scopes,
// in Google's order, with `email` expanded to `userinfo.email` and `profile`
// added — none of which is the five this asked for, in the order it asked.
#[cfg(unix)]
#[test]
fn a_real_google_reply_is_read_for_what_it_needs_and_not_refused_for_the_rest() {
    use std::os::unix::fs::PermissionsExt as _;

    let root = tempfile::tempdir().unwrap();
    let curl = root.path().join("curl");
    fs::write(
        &curl,
        r#"#!/bin/sh
config=$(cat)
case "$config" in
  *oauth2.googleapis.com/token*) printf '{"access_token":"access-secret","expires_in":3599,"refresh_token":"refresh-secret","scope":"email profile https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email openid","token_type":"Bearer","id_token":"header.payload.signature","refresh_token_expires_in":604799}\nOMAMAIL-STATUS:200\n' ;;
  *openidconnect.googleapis.com/v1/userinfo*) printf '{"sub":"110000000000000000000","email":"User@Example.COM","email_verified":true,"name":"A Reader","given_name":"A","family_name":"Reader","picture":"https://lh3.example.test/a","locale":"en","hd":"example.com","profile":"https://example.test/a","nickname":"reader","updated_at":1750000000}\nOMAMAIL-STATUS:200\n' ;;
  *) exit 44 ;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(&curl, fs::Permissions::from_mode(0o700)).unwrap();

    let path = root.path().join("oauth-client.json");
    let store = omamail::platform::secrets::MemorySecretStore::default();
    let committer = ProductionOAuthCommitter::new(
        &path,
        "123-client.apps.googleusercontent.com",
        Secret::new("client-secret-value"),
        omamail::gmail_setup::GRANT,
        &store,
        GoogleOAuthExchanger::new(
            "123-client.apps.googleusercontent.com",
            Secret::new("client-secret-value"),
            curl,
            SystemProcessRunner,
            PublicResolver,
        ),
    );

    let account = committer
        .commit(
            "authorization-code",
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~",
            "http://127.0.0.1:4321/oauth2callback",
            Duration::from_secs(10),
        )
        .expect("a reply carrying fields this does not read is still a signed-in account");
    assert_eq!(account.email, "user@example.com");
    assert_eq!(account.id, "user@example.com");

    // Filed under the name the reading end uses, so the mailbox that was just
    // created can find its own credential.
    let key = SecretKey::gmail(
        "123-client.apps.googleusercontent.com",
        "user@example.com",
        "gmail.modify gmail.send calendar.events",
    )
    .unwrap();
    assert_eq!(
        store.get(&key).unwrap().unwrap().expose(),
        "refresh-secret",
        "the grant names the credential, so it must not follow the scope string"
    );
}

// The grant is the keyring's name for the credential and the scope list is a
// wire parameter. They were the same words once; a test rather than a comment
// is what stops the next person from re-merging them.
#[test]
fn the_grant_that_names_the_credential_is_not_the_scope_list() {
    assert_eq!(
        omamail::gmail_setup::GRANT,
        "gmail.modify gmail.send calendar.events"
    );
    assert_ne!(omamail::gmail_setup::GRANT, SCOPES);
}

#[test]
fn production_exchange_rejects_mixed_private_dns_before_spawning() {
    let exchanger = GoogleOAuthExchanger::new(
        "123-client.apps.googleusercontent.com",
        Secret::new("client-secret-value"),
        std::path::PathBuf::from("curl-must-not-run"),
        SystemProcessRunner,
        MixedResolver,
    );
    assert!(matches!(
        exchanger.exchange(
            "authorization-code",
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~",
            "http://127.0.0.1:4321/oauth2callback",
            Duration::from_secs(10),
        ),
        Err(SetupError::Failed)
    ));
}

#[cfg(unix)]
#[test]
fn production_dispatch_uses_the_configured_client_instead_of_unavailable_stub() {
    use std::os::unix::fs::PermissionsExt as _;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oauth-client.json");
    fs::write(
        &path,
        r#"{"clientId":"123-client.apps.googleusercontent.com","clientSecret":"client-secret-value"}"#,
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let setup = omamail::gmail_setup::production(root.path().join("oauth-client.json"));
    let reply: serde_json::Value = serde_json::from_str(
        &setup.dispatch(r#"{"operation":"gmail.oauth.begin","deadlineMs":1000}"#),
    )
    .unwrap();
    assert_eq!(reply["ok"], true);
    assert!(
        reply["url"]
            .as_str()
            .unwrap()
            .starts_with("https://accounts.google.com/")
    );
}

#[cfg(unix)]
#[test]
fn production_dispatch_does_not_hold_global_state_lock_during_partial_callback_io() {
    use std::os::unix::fs::PermissionsExt as _;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oauth-client.json");
    fs::write(
        &path,
        r#"{"clientId":"123-client.apps.googleusercontent.com","clientSecret":"client-secret-value"}"#,
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let setup = Arc::new(omamail::gmail_setup::production(
        root.path().join("oauth-client.json"),
    ));
    let first: serde_json::Value = serde_json::from_str(
        &setup.dispatch(r#"{"operation":"gmail.oauth.begin","deadlineMs":2000}"#),
    )
    .unwrap();
    let auth = url::Url::parse(first["url"].as_str().unwrap()).unwrap();
    let redirect = url::Url::parse(
        &auth
            .query_pairs()
            .find(|(key, _)| key == "redirect_uri")
            .unwrap()
            .1,
    )
    .unwrap();
    let mut partial = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
    partial.write_all(b"GET /oauth2callback?").unwrap();

    let polling = Arc::clone(&setup);
    let first_id = first["flowId"].as_str().unwrap().to_owned();
    let reader = std::thread::spawn(move || {
        polling.dispatch(
            &serde_json::json!({"operation":"gmail.oauth.status","flowId":first_id}).to_string(),
        )
    });
    std::thread::sleep(Duration::from_millis(25));

    let (sent, received) = std::sync::mpsc::channel();
    let other = Arc::clone(&setup);
    let worker = std::thread::spawn(move || {
        let second: serde_json::Value = serde_json::from_str(
            &other.dispatch(r#"{"operation":"gmail.oauth.begin","deadlineMs":1000}"#),
        )
        .unwrap();
        let second_id = second["flowId"].as_str().unwrap();
        let cancelled: serde_json::Value = serde_json::from_str(&other.dispatch(
            &serde_json::json!({"operation":"gmail.oauth.cancel","flowId":second_id}).to_string(),
        ))
        .unwrap();
        sent.send(cancelled["ok"] == true).unwrap();
    });
    let prompt = received.recv_timeout(Duration::from_millis(150));
    drop(partial);
    reader.join().unwrap();
    worker.join().unwrap();
    assert_eq!(prompt, Ok(true));
}

#[derive(Default)]
struct Store {
    value: Mutex<Option<Secret>>,
    fail_set_after_write: Mutex<bool>,
}
impl SecretStore for Store {
    fn get(&self, _: &SecretKey) -> Result<Option<Secret>, SecretStoreError> {
        Ok(self.value.lock().unwrap().clone())
    }
    fn set(&self, _: &SecretKey, secret: Secret) -> Result<(), SecretStoreError> {
        *self.value.lock().unwrap() = Some(secret);
        if *self.fail_set_after_write.lock().unwrap() {
            Err(SecretStoreError::Failed)
        } else {
            Ok(())
        }
    }
    fn delete(&self, _: &SecretKey) -> Result<(), SecretStoreError> {
        *self.value.lock().unwrap() = None;
        Ok(())
    }
}

struct Exchange;
impl OAuthTokenExchanger for Exchange {
    fn exchange(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
        _: Duration,
    ) -> Result<VerifiedGrant, SetupError> {
        assert_eq!(code, "authorization-code");
        assert_eq!(verifier, "pkce-verifier");
        assert_eq!(redirect_uri, "http://127.0.0.1:4321/oauth2callback");
        VerifiedGrant::new("user@example.com", Secret::new("new-refresh-secret"))
    }
}

fn committer<'a>(
    path: &std::path::Path,
    store: &'a Store,
) -> ProductionOAuthCommitter<Exchange, &'a Store> {
    ProductionOAuthCommitter::new(
        path,
        "123-client.apps.googleusercontent.com",
        Secret::new("client-secret-value"),
        "gmail.modify gmail.send calendar.events",
        store,
        Exchange,
    )
}

#[test]
fn commit_writes_a_protected_client_file_and_exact_refresh_token() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oauth-client.json");
    let store = Store::default();
    committer(&path, &store)
        .commit(
            "authorization-code",
            "pkce-verifier",
            "http://127.0.0.1:4321/oauth2callback",
            Duration::from_secs(10),
        )
        .unwrap();

    let body = fs::read_to_string(&path).unwrap();
    assert!(body.contains("123-client.apps.googleusercontent.com"));
    assert!(body.contains("client-secret-value"));
    assert_eq!(
        store.value.lock().unwrap().as_ref().unwrap().expose(),
        "new-refresh-secret"
    );
    assert!(!format!("{:?}", committer(&path, &store)).contains("client-secret-value"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn new_file_and_secret_are_removed_when_keyring_commit_fails() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oauth-client.json");
    let store = Store::default();
    *store.fail_set_after_write.lock().unwrap() = true;
    assert_eq!(
        committer(&path, &store).commit(
            "authorization-code",
            "pkce-verifier",
            "http://127.0.0.1:4321/oauth2callback",
            Duration::from_secs(10)
        ),
        Err(SetupError::Failed)
    );
    assert!(!path.exists());
    assert!(store.value.lock().unwrap().is_none());
}

#[test]
fn refresh_token_uses_the_full_canonical_gmail_identity() {
    use omamail::platform::secrets::MemorySecretStore;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oauth-client.json");
    let store = MemorySecretStore::default();
    let committer = ProductionOAuthCommitter::new(
        &path,
        "123-client.apps.googleusercontent.com",
        Secret::new("client-secret-value"),
        "gmail.modify gmail.send calendar.events",
        &store,
        Exchange,
    );
    committer
        .commit(
            "authorization-code",
            "pkce-verifier",
            "http://127.0.0.1:4321/oauth2callback",
            Duration::from_secs(10),
        )
        .unwrap();
    let exact = SecretKey::gmail(
        "123-client.apps.googleusercontent.com",
        "user@example.com",
        "gmail.modify gmail.send calendar.events",
    )
    .unwrap();
    assert_eq!(
        store.get(&exact).unwrap().unwrap().expose(),
        "new-refresh-secret"
    );
}

#[test]
fn local_revoke_removes_only_the_exact_gmail_refresh_token() {
    use omamail::platform::secrets::MemorySecretStore;
    let root = tempfile::tempdir().unwrap();
    let store = MemorySecretStore::default();
    let committer = ProductionOAuthCommitter::new(
        root.path().join("oauth-client.json"),
        "123-client.apps.googleusercontent.com",
        Secret::new("client-secret-value"),
        "gmail.modify gmail.send calendar.events",
        &store,
        Exchange,
    );
    let exact = SecretKey::gmail(
        "123-client.apps.googleusercontent.com",
        "user@example.com",
        "gmail.modify gmail.send calendar.events",
    )
    .unwrap();
    let other = SecretKey::gmail(
        "123-client.apps.googleusercontent.com",
        "other@example.com",
        "gmail.modify gmail.send calendar.events",
    )
    .unwrap();
    store.set(&exact, Secret::new("exact")).unwrap();
    store.set(&other, Secret::new("other")).unwrap();
    committer
        .revoke_local("user@example.com", "123-client.apps.googleusercontent.com")
        .unwrap();
    assert!(store.get(&exact).unwrap().is_none());
    assert_eq!(store.get(&other).unwrap().unwrap().expose(), "other");
}

#[test]
fn keyring_failure_restores_old_file_and_old_secret() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oauth-client.json");
    fs::write(&path, b"old-client-file").unwrap();
    let store = Store::default();
    *store.value.lock().unwrap() = Some(Secret::new("old-refresh-secret"));
    *store.fail_set_after_write.lock().unwrap() = true;

    let error = committer(&path, &store)
        .commit(
            "authorization-code",
            "pkce-verifier",
            "http://127.0.0.1:4321/oauth2callback",
            Duration::from_secs(10),
        )
        .unwrap_err();
    assert_eq!(error, SetupError::Failed);
    assert_eq!(fs::read(&path).unwrap(), b"old-client-file");
    assert_eq!(
        store.value.lock().unwrap().as_ref().unwrap().expose(),
        "old-refresh-secret"
    );
    assert!(!format!("{error:?}").contains("secret"));
}

#[cfg(unix)]
#[test]
fn symlink_client_path_is_refused_without_touching_target_or_keyring() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    let path = root.path().join("oauth-client.json");
    fs::write(&target, b"target-safe").unwrap();
    symlink(&target, &path).unwrap();
    let store = Store::default();
    assert_eq!(
        committer(&path, &store).commit(
            "authorization-code",
            "pkce-verifier",
            "http://127.0.0.1:4321/oauth2callback",
            Duration::from_secs(10)
        ),
        Err(SetupError::Failed)
    );
    assert_eq!(fs::read(target).unwrap(), b"target-safe");
    assert!(store.value.lock().unwrap().is_none());
}

// --------------------------------------------------------- the client file
//
// The client the whole of Gmail sign-in needs is written by the client itself:
// there is no other way to give a fresh checkout one, and no restart between
// saving it and using it.

#[cfg(unix)]
fn client_mode(path: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt as _;
    fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn save_request(client_id: &str, client_secret: &str) -> String {
    serde_json::json!({
        "operation": "gmail.oauth.saveClient",
        "clientId": client_id,
        "clientSecret": client_secret,
    })
    .to_string()
}

#[cfg(unix)]
#[test]
fn a_saved_client_is_protected_described_and_signed_in_without_a_restart() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oauth-client.json");
    let setup = omamail::gmail_setup::production(root.path().join("oauth-client.json"));

    // Absent: sign-in is closed and the settings page has nothing to name.
    assert_eq!(
        setup.dispatch(r#"{"operation":"gmail.oauth.begin","deadlineMs":1000}"#),
        r#"{"ok":false,"error":"Gmail sign-in is unavailable"}"#
    );
    assert_eq!(
        setup.dispatch(r#"{"operation":"gmail.oauth.client"}"#),
        r#"{"ok":true,"data":{"present":false,"clientId":"","description":""}}"#
    );

    assert_eq!(
        setup.dispatch(&save_request(
            "123456-abc.apps.googleusercontent.com",
            "client-secret-value"
        )),
        r#"{"ok":true}"#
    );
    assert_eq!(client_mode(&path), 0o600);
    assert!(fs::read_to_string(&path).unwrap().contains("clientSecret"));

    // The same process, no restart: the next begin is the saved client's.
    let begin: serde_json::Value = serde_json::from_str(
        &setup.dispatch(r#"{"operation":"gmail.oauth.begin","deadlineMs":1000}"#),
    )
    .unwrap();
    assert_eq!(begin["ok"], true);
    let url = url::Url::parse(begin["url"].as_str().unwrap()).unwrap();
    assert_eq!(
        url.query_pairs()
            .find(|(key, _)| key == "client_id")
            .unwrap()
            .1,
        "123456-abc.apps.googleusercontent.com"
    );

    // The description is the client id's own head, and the secret is never
    // handed back to anything that draws it.
    let described = setup.dispatch(r#"{"operation":"gmail.oauth.client"}"#);
    assert_eq!(
        described,
        r#"{"ok":true,"data":{"present":true,"clientId":"123456-abc.apps.googleusercontent.com","description":"123456"}}"#
    );
    assert!(!described.contains("client-secret-value"));

    // A second client replaces the first, still without a restart.
    assert_eq!(
        setup.dispatch(&save_request(
            "999999-xyz.apps.googleusercontent.com",
            "other-secret-value"
        )),
        r#"{"ok":true}"#
    );
    let begin: serde_json::Value = serde_json::from_str(
        &setup.dispatch(r#"{"operation":"gmail.oauth.begin","deadlineMs":1000}"#),
    )
    .unwrap();
    let url = url::Url::parse(begin["url"].as_str().unwrap()).unwrap();
    assert_eq!(
        url.query_pairs()
            .find(|(key, _)| key == "client_id")
            .unwrap()
            .1,
        "999999-xyz.apps.googleusercontent.com"
    );
    assert_eq!(client_mode(&path), 0o600);
}

#[cfg(unix)]
#[test]
fn a_client_saved_unchanged_keeps_a_flow_alive_and_a_changed_secret_ends_it() {
    let root = tempfile::tempdir().unwrap();
    let setup = omamail::gmail_setup::production(root.path().join("oauth-client.json"));
    assert_eq!(
        setup.dispatch(&save_request(
            "123456-abc.apps.googleusercontent.com",
            "client-secret-value"
        )),
        r#"{"ok":true}"#
    );
    let begin: serde_json::Value = serde_json::from_str(
        &setup.dispatch(r#"{"operation":"gmail.oauth.begin","deadlineMs":2000}"#),
    )
    .unwrap();
    let flow_id = begin["flowId"].as_str().unwrap().to_owned();

    // Saving the same client again resolves to the same setup, so a sign-in
    // already waiting on its loopback listener is untouched.
    assert_eq!(
        setup.dispatch(&save_request(
            "123456-abc.apps.googleusercontent.com",
            "client-secret-value"
        )),
        r#"{"ok":true}"#
    );
    assert_eq!(
        setup.dispatch(
            &serde_json::json!({"operation":"gmail.oauth.status","flowId":flow_id}).to_string()
        ),
        r#"{"ok":true,"status":"pending"}"#
    );

    // A different secret is a different client, so the flow it belonged to is
    // gone rather than committed against credentials nobody signed in with.
    assert_eq!(
        setup.dispatch(&save_request(
            "123456-abc.apps.googleusercontent.com",
            "rotated-secret-value"
        )),
        r#"{"ok":true}"#
    );
    assert_eq!(
        setup.dispatch(
            &serde_json::json!({"operation":"gmail.oauth.status","flowId":flow_id}).to_string()
        ),
        r#"{"ok":false,"status":"error","error":"invalid Gmail sign-in request"}"#
    );
}

#[cfg(unix)]
#[test]
fn an_empty_client_secret_is_stored_as_absent_rather_than_as_an_empty_secret() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oauth-client.json");
    let setup = omamail::gmail_setup::production(root.path().join("oauth-client.json"));
    assert_eq!(
        setup.dispatch(&save_request("123456-abc.apps.googleusercontent.com", "")),
        r#"{"ok":true}"#
    );
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        r#"{"clientId":"123456-abc.apps.googleusercontent.com"}"#
    );
    assert_eq!(client_mode(&path), 0o600);

    // A missing key means the same thing as an empty one, and the file it
    // writes is still one the reader accepts.
    assert_eq!(
        setup.dispatch(
            r#"{"operation":"gmail.oauth.saveClient","clientId":"123456-abc.apps.googleusercontent.com"}"#
        ),
        r#"{"ok":true}"#
    );
    assert_eq!(
        setup.dispatch(r#"{"operation":"gmail.oauth.client"}"#),
        r#"{"ok":true,"data":{"present":true,"clientId":"123456-abc.apps.googleusercontent.com","description":"123456"}}"#
    );
    let begin: serde_json::Value = serde_json::from_str(
        &setup.dispatch(r#"{"operation":"gmail.oauth.begin","deadlineMs":1000}"#),
    )
    .unwrap();
    assert_eq!(begin["ok"], true);
}

#[cfg(unix)]
#[test]
fn a_refused_client_leaves_no_file_and_says_what_to_fix() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oauth-client.json");
    let setup = omamail::gmail_setup::production(root.path().join("oauth-client.json"));

    for client_id in [
        "",
        "123456-abc",
        "123456-abc.apps.googleusercontent.com.evil.example",
        "123456-abc.apps.googleusercontent.com\n",
    ] {
        assert_eq!(
            setup.dispatch(&save_request(client_id, "client-secret-value")),
            r#"{"ok":false,"error":"That is not a Google client ID. It ends in .apps.googleusercontent.com"}"#
        );
    }
    for secret in ["line\nbreak", &"x".repeat(4097)] {
        assert_eq!(
            setup.dispatch(&save_request(
                "123456-abc.apps.googleusercontent.com",
                secret
            )),
            r#"{"ok":false,"error":"That client secret is too long, or has a line break in it"}"#
        );
    }
    assert!(!path.exists());

    // A malformed or oversized request is refused the way every other one is.
    for input in [
        r#"{"operation":"gmail.oauth.saveClient"}"#,
        r#"{"operation":"gmail.oauth.saveClient","clientId":"123456-abc.apps.googleusercontent.com","clientSecret":"nope","extra":true}"#,
        &save_request("123456-abc.apps.googleusercontent.com", &"n".repeat(20_000)),
    ] {
        let reply = setup.dispatch(input);
        assert_eq!(
            reply,
            r#"{"ok":false,"error":"invalid Gmail sign-in request"}"#
        );
        assert!(!reply.contains("nope"));
    }
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn a_symlink_at_the_client_path_is_refused_without_writing_through_it() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target");
    let path = root.path().join("oauth-client.json");
    fs::write(&target, b"target-safe").unwrap();
    symlink(&target, &path).unwrap();
    let setup = omamail::gmail_setup::production(root.path().join("oauth-client.json"));
    assert_eq!(
        setup.dispatch(&save_request(
            "123456-abc.apps.googleusercontent.com",
            "client-secret-value"
        )),
        r#"{"ok":false,"error":"oauth-client.json is not a plain file. Remove it and save the client again"}"#
    );
    assert_eq!(fs::read(&target).unwrap(), b"target-safe");
    assert!(
        fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[cfg(unix)]
#[test]
fn a_readable_or_unparsable_client_file_is_no_client_and_is_replaced_at_0600() {
    use std::os::unix::fs::PermissionsExt as _;
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("oauth-client.json");
    fs::write(&path, b"not json at all").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let setup = omamail::gmail_setup::production(root.path().join("oauth-client.json"));

    assert_eq!(
        setup.dispatch(r#"{"operation":"gmail.oauth.client"}"#),
        r#"{"ok":true,"data":{"present":false,"clientId":"","description":""}}"#
    );
    assert_eq!(
        setup.dispatch(r#"{"operation":"gmail.oauth.begin","deadlineMs":1000}"#),
        r#"{"ok":false,"error":"Gmail sign-in is unavailable"}"#
    );
    assert_eq!(
        setup.dispatch(&save_request(
            "123456-abc.apps.googleusercontent.com",
            "client-secret-value"
        )),
        r#"{"ok":true}"#
    );
    assert_eq!(client_mode(&path), 0o600);
    let begin: serde_json::Value = serde_json::from_str(
        &setup.dispatch(r#"{"operation":"gmail.oauth.begin","deadlineMs":1000}"#),
    )
    .unwrap();
    assert_eq!(begin["ok"], true);
}

// --------------------------------------------------------------------------
// The name a credential is written under and the name it is read under are one
// name, and this is the test that says so end to end.
//
// They were not, and nothing caught it: the committer filed the token, the
// window configured a context, the executor built a key of its own from that
// context, and the two keys were only ever compared by a person. A Gmail
// mailbox that had signed in successfully could not read one message, and the
// only thing said about it was "provider unavailable".

struct StubTransport;
impl omamail::providers::gmail::GmailTransport for StubTransport {
    fn max_response_bytes(&self) -> usize {
        omamail::providers::gmail::MAX_RESPONSE_BYTES
    }
    fn execute(
        &self,
        _: omamail::providers::gmail::GmailHttpRequest,
        _: omamail::providers::gmail::AccessToken,
    ) -> Result<omamail::providers::gmail::GmailHttpResponse, omamail::providers::gmail::GmailError>
    {
        Ok(omamail::providers::gmail::GmailHttpResponse::json(
            200,
            br#"{"messages":[]}"#.to_vec(),
        ))
    }
}

struct StubTokens;
impl omamail::providers::gmail::AccessTokenProvider for StubTokens {
    fn access_token(
        &self,
        refresh: Secret,
        _: Duration,
    ) -> Result<omamail::providers::gmail::AccessToken, omamail::providers::gmail::GmailError> {
        assert_eq!(
            refresh.expose(),
            "new-refresh-secret",
            "the reader found the credential the committer wrote, not another one"
        );
        Ok(omamail::providers::gmail::AccessToken::new(Secret::new(
            "access-token",
        )))
    }
}

#[test]
fn a_signed_in_account_reads_the_credential_its_own_sign_in_wrote() {
    use omamail::{
        host_context::{HostContext, HostContextRegistry},
        platform::secrets::MemorySecretStore,
        providers::gmail::{GmailExecutor, GmailExecutorConfig, GmailOperation, RequestIdentity},
    };
    let root = tempfile::tempdir().unwrap();
    let store = MemorySecretStore::default();
    let account = ProductionOAuthCommitter::new(
        root.path().join("oauth-client.json"),
        "123-client.apps.googleusercontent.com",
        Secret::new("client-secret-value"),
        omamail::gmail_setup::GRANT,
        &store,
        Exchange,
    )
    .commit(
        "authorization-code",
        "pkce-verifier",
        "http://127.0.0.1:4321/oauth2callback",
        Duration::from_secs(10),
    )
    .unwrap();

    // The read side, assembled the way the running host assembles it: the
    // window's own context JSON, `host_context`'s parse of it, and the
    // executor `native_provider_runtime` builds from the parsed context.
    let registry = HostContextRegistry::new();
    registry
        .replace_json(&format!(
            r#"[{{"kind":"gmail","accountId":"{}","clientId":"{}","grant":"{}"}}]"#,
            account.id,
            account.client_id,
            omamail::gmail_setup::GRANT
        ))
        .unwrap();
    let HostContext::Gmail(context) = registry.resolve_account(&account.id).unwrap() else {
        panic!("the window configured a Gmail account");
    };
    let transport = StubTransport;
    let tokens = StubTokens;
    GmailExecutor::new(
        &store,
        &transport,
        &tokens,
        GmailExecutorConfig::new(context.client_id(), context.account_id(), context.grant()),
    )
    .unwrap()
    .execute(
        RequestIdentity {
            account_id: account.id.clone(),
            object_id: String::new(),
            revision: 1,
        },
        GmailOperation::List {
            query: "in:inbox".into(),
            max_results: 25,
            page_token: None,
        },
        Duration::from_secs(5),
    )
    .expect("the mailbox that just signed in can read its own mail");
}

/// A mailbox signed in through the QML plugin has its refresh token filed
/// under that plugin's name for the same grant. Finding it is what spares a
/// working install a sign-in it does not need.
#[test]
fn the_plugins_own_name_for_this_credential_is_still_read() {
    use omamail::platform::secrets::{MemorySecretStore, SUPERSEDED_GMAIL_GRANTS};
    let store = MemorySecretStore::default();
    // The QML plugin's `Credentials.keyringAttributes`, which stores by the
    // canonical shape of its own key.
    let plugin = SecretKey::gmail(
        "123-client.apps.googleusercontent.com",
        "user@example.com",
        SUPERSEDED_GMAIL_GRANTS[0],
    )
    .unwrap();
    store.set(&plugin, Secret::new("plugin-secret")).unwrap();

    let current = SecretKey::gmail(
        "123-client.apps.googleusercontent.com",
        "user@example.com",
        omamail::gmail_setup::GRANT,
    )
    .unwrap();
    // `MemorySecretStore` keys on the whole `SecretKey`, so it cannot answer
    // this the way the keyring does; the identity list is what the system
    // store walks, and it must name the plugin's shape.
    assert!(
        current
            .secret_service_lookup_attributes()
            .contains(&plugin.secret_service_attributes()),
        "the reader looks under the name the plugin wrote"
    );
    assert!(store.get(&current).unwrap().is_none());
}
