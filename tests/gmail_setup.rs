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
        OAuthTokenExchanger, ProductionOAuthCommitter, RandomSource, SetupError, VerifiedGrant,
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
    let begin = flow
        .begin(
            "openid email gmail.modify gmail.send calendar.events",
            Duration::from_secs(2),
        )
        .unwrap();
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
    let begin = flow
        .begin(
            "openid email gmail.modify gmail.send calendar.events",
            Duration::from_secs(2),
        )
        .unwrap();
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
    let second = flow
        .begin(
            "openid email gmail.modify gmail.send calendar.events",
            Duration::from_secs(2),
        )
        .unwrap();
    flow.cancel(&second.flow_id);
    assert_eq!(flow.poll(&second.flow_id), Err(SetupError::Invalid));
}

#[test]
fn partial_callback_does_not_lock_other_flows() {
    let flow = Arc::new(LoopbackOAuthFlow::new(
        "123-client.apps.googleusercontent.com",
        SequencedRandom(AtomicU8::new(0)),
    ));
    let first = flow
        .begin(
            "openid email gmail.modify gmail.send calendar.events",
            Duration::from_secs(2),
        )
        .unwrap();
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
        let second = other
            .begin(
                "openid email gmail.modify gmail.send calendar.events",
                Duration::from_secs(2),
            )
            .unwrap();
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
    assert!(configs.contains("location = false"));
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
    let setup = omamail::gmail_setup::production(root.path());
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
    let setup = Arc::new(omamail::gmail_setup::production(root.path()));
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
        "omamail",
        "omarchy-mail",
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
        "omamail",
        "omarchy-mail",
        "123-client.apps.googleusercontent.com",
        "user@example.com",
        "gmail.modify gmail.send calendar.events",
    )
    .unwrap();
    let other = SecretKey::gmail(
        "omamail",
        "omarchy-mail",
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
