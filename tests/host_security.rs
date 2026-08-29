use std::{
    collections::HashMap,
    fs,
    net::IpAddr,
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

static PROCESS_TEST_LOCK: Mutex<()> = Mutex::new(());

fn serial_process_test() -> MutexGuard<'static, ()> {
    PROCESS_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

use base64::{Engine as _, engine::general_purpose::STANDARD};

use omamail::platform::{
    commands::{
        CommandError, CommandPolicy, HeyOperation, ProcessRunner, Resolver, SystemProcessRunner,
        TransportOperation,
    },
    secrets::{
        MemorySecretStore, Secret, SecretKey, SecretStore, SecretStoreError, SystemSecretStore,
        keyring_error_class,
    },
};

fn refresh_token_key(client_id: &str, grant: &str) -> SecretKey {
    SecretKey::new(
        "omamail",
        "refresh-token",
        client_id,
        "me@example.com",
        Some(grant),
    )
    .expect("a complete secret key")
}

fn policy(image_fetch: PathBuf, unsubscribe: PathBuf) -> CommandPolicy {
    CommandPolicy::with_resolver(
        PathBuf::from("/usr/bin/hey"),
        PathBuf::from("/opt/omamail/scripts/mail-transport.sh"),
        image_fetch,
        unsubscribe,
        Arc::new(PublicResolver),
    )
}

struct PublicResolver;

impl Resolver for PublicResolver {
    fn resolve(&self, _host: &str, _port: u16) -> std::io::Result<Vec<IpAddr>> {
        Ok(vec!["93.184.216.34".parse().expect("fixture IP address")])
    }
}

struct FakeResolver {
    answers: HashMap<(String, u16), Vec<IpAddr>>,
}

impl FakeResolver {
    fn returning(host: &str, port: u16, addresses: &[&str]) -> Arc<Self> {
        Arc::new(Self {
            answers: HashMap::from([(
                (host.to_owned(), port),
                addresses
                    .iter()
                    .map(|address| address.parse().expect("fixture IP address"))
                    .collect(),
            )]),
        })
    }
}

impl Resolver for FakeResolver {
    fn resolve(&self, host: &str, port: u16) -> std::io::Result<Vec<IpAddr>> {
        self.answers
            .get(&(host.to_owned(), port))
            .cloned()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no fake answer"))
    }
}

fn policy_with_resolver(
    image_fetch: PathBuf,
    unsubscribe: PathBuf,
    resolver: Arc<dyn Resolver>,
) -> CommandPolicy {
    CommandPolicy::with_resolver(
        PathBuf::from("/usr/bin/hey"),
        PathBuf::from("/opt/omamail/scripts/mail-transport.sh"),
        image_fetch,
        unsubscribe,
        resolver,
    )
}

#[test]
fn memory_secret_store_round_trips_and_deletes_a_secret() {
    let store = MemorySecretStore::default();
    let key = refresh_token_key("desktop-client", "calendar-events-v1");
    let secret = Secret::new("refresh-token-value");

    assert_eq!(store.get(&key).unwrap(), None);
    store.set(&key, secret.clone()).unwrap();
    assert_eq!(store.get(&key).unwrap(), Some(secret));
    store.delete(&key).unwrap();
    assert_eq!(store.get(&key).unwrap(), None);
}

#[test]
fn secret_key_preserves_existing_linux_attributes_and_avoids_binary_key_collisions() {
    let first = refresh_token_key("desktop-client", "calendar-events-v1");
    let second = refresh_token_key("desktop-client", "mail-readonly-v1");

    assert_ne!(first, second);
    assert_eq!(
        first.secret_service_attributes(),
        [
            ("service", "omamail"),
            ("kind", "refresh-token"),
            ("client-id", "desktop-client"),
            ("account", "me@example.com"),
            ("grant", "calendar-events-v1"),
        ]
    );
    assert_eq!(first.keyring_service(), "com.omarchy.omamail.secrets.v1");
    assert_ne!(first.keyring_account(), second.keyring_account());
}

#[test]
fn gmail_secret_key_has_ordered_exact_legacy_identities_without_placeholder_attributes() {
    let key = SecretKey::gmail(
        "omamail",
        "omarchy-gmail",
        "desktop-client",
        "me@example.com",
        "calendar-events-v1",
    )
    .unwrap();

    assert_eq!(
        key.secret_service_lookup_attributes(),
        vec![
            vec![
                ("service", "omamail"),
                ("kind", "refresh-token"),
                ("client-id", "desktop-client"),
                ("account", "me@example.com"),
                ("grant", "calendar-events-v1"),
            ],
            vec![
                ("service", "omamail"),
                ("kind", "refresh-token"),
                ("client-id", "desktop-client"),
                ("account", "me@example.com"),
            ],
            vec![
                ("service", "omamail"),
                ("kind", "refresh-token"),
                ("client-id", "desktop-client"),
            ],
            vec![
                ("service", "omarchy-gmail"),
                ("kind", "refresh-token"),
                ("client-id", "desktop-client"),
                ("account", "me@example.com"),
            ],
            vec![
                ("service", "omarchy-gmail"),
                ("kind", "refresh-token"),
                ("client-id", "desktop-client"),
            ],
        ]
    );
}

#[test]
fn imap_and_caldav_secret_keys_use_only_their_protocol_identity() {
    let imap = SecretKey::imap("omamail", "imap:me@example.com").unwrap();
    let caldav = SecretKey::caldav("omamail", "calendar-source-id").unwrap();

    assert_eq!(
        imap.secret_service_attributes(),
        vec![
            ("service", "omamail"),
            ("kind", "imap-password"),
            ("account", "imap:me@example.com"),
        ]
    );
    assert_eq!(
        caldav.secret_service_attributes(),
        vec![
            ("service", "omamail"),
            ("kind", "calendar-password"),
            ("source", "calendar-source-id"),
        ]
    );
}

#[test]
fn imap_endpoint_key_migrates_only_from_account_identity_and_changes_with_endpoint() {
    let first = SecretKey::imap_endpoint(
        "omamail",
        "imap:a@example.test",
        "mail.one.test",
        993,
        "alice",
    )
    .unwrap();
    let changed = SecretKey::imap_endpoint(
        "omamail",
        "imap:a@example.test",
        "mail.two.test",
        993,
        "alice",
    )
    .unwrap();
    assert_ne!(first.keyring_account(), changed.keyring_account());
    let lookups = first.secret_service_lookup_attributes();
    assert_eq!(lookups.len(), 1);
    assert!(lookups[0].contains(&("host", "mail.one.test")));
}

#[test]
fn binary_keyring_identity_is_unambiguous_across_field_boundaries() {
    let left = SecretKey::new("a", "b", "c", "d.e", Some("f")).unwrap();
    let right = SecretKey::new("a", "b", "c", "d", Some("e.f")).unwrap();

    assert_eq!(left.keyring_service(), right.keyring_service());
    assert_ne!(left.keyring_account(), right.keyring_account());
}

#[cfg(target_os = "linux")]
fn executable_fixture(contents: &str) -> (tempfile::TempDir, PathBuf) {
    use std::os::unix::fs::PermissionsExt as _;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("secret-tool");
    fs::write(
        &path,
        contents.replace("@DIR@", &directory.path().to_string_lossy()),
    )
    .unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    (directory, path)
}

#[cfg(target_os = "linux")]
#[test]
fn linux_store_migrates_first_legacy_match_to_canonical_and_clears_it() {
    let _process_guard = serial_process_test();
    let (_directory, tool) = executable_fixture(
        r##"#!/bin/sh
command="$1"
shift
case "$command:$*" in
  "lookup:service omamail kind refresh-token client-id desktop-client account me@example.com grant calendar-events-v1") exit 1 ;;
  search:*)
    printf '[legacy]\n'
    printf 'attribute.service = omamail\nattribute.kind = refresh-token\nattribute.client-id = desktop-client\nattribute.account = me@example.com\n' >&2
    printf search >> "@DIR@/log" ;;
  "lookup:service omamail kind refresh-token client-id desktop-client account me@example.com") printf legacy-secret; printf lookup >> "@DIR@/log" ;;
  store:*) IFS= read -r secret; [ "$secret" = legacy-secret ] || exit 9; printf store >> "@DIR@/log" ;;
  clear:*) printf clear >> "@DIR@/log" ;;
  *) exit 8 ;;
esac
"##,
    );
    let log = _directory.path().join("log");
    let store = SystemSecretStore::with_secret_tool(&tool, Duration::from_secs(1), true);
    let key = SecretKey::gmail(
        "omamail",
        "omarchy-gmail",
        "desktop-client",
        "me@example.com",
        "calendar-events-v1",
    )
    .unwrap();

    assert_eq!(store.get(&key).unwrap().unwrap().expose(), "legacy-secret");
    assert_eq!(fs::read_to_string(log).unwrap(), "searchlookupstoreclear");
}

#[cfg(target_os = "linux")]
#[test]
fn linux_store_never_reads_an_account_fallback_when_search_finds_named_siblings() {
    let _process_guard = serial_process_test();
    let (_directory, tool) = executable_fixture(
        r##"#!/bin/sh
command="$1"
shift
case "$command:$*" in
  "lookup:service omamail kind refresh-token client-id desktop-client account me@example.com grant calendar-events-v1") exit 1 ;;
  search:*)
    printf '[one]\n[other]\n[legacy]\n'
    printf 'attribute.service = omamail\nattribute.kind = refresh-token\nattribute.client-id = desktop-client\nattribute.account = me@example.com\nattribute.service = omamail\nattribute.kind = refresh-token\nattribute.client-id = desktop-client\nattribute.account = other@example.com\nattribute.service = omamail\nattribute.kind = refresh-token\nattribute.client-id = desktop-client\n' >&2
    printf search >> "@DIR@/log" ;;
  lookup:*) printf wrong-account-secret; printf lookup >> "@DIR@/log" ;;
  *) exit 8 ;;
esac
"##,
    );
    let log = _directory.path().join("log");
    let store = SystemSecretStore::with_secret_tool(&tool, Duration::from_secs(1), true);
    let key = SecretKey::gmail(
        "omamail",
        "omarchy-gmail",
        "desktop-client",
        "me@example.com",
        "calendar-events-v1",
    )
    .unwrap();

    assert_eq!(store.get(&key).unwrap(), None);
    assert_eq!(fs::read_to_string(log).unwrap(), "searchsearchsearchsearch");
}

#[cfg(target_os = "linux")]
#[test]
fn linux_store_refuses_multiple_accountless_legacy_entries() {
    let _process_guard = serial_process_test();
    let (_directory, tool) = executable_fixture(
        r##"#!/bin/sh
command="$1"
shift
case "$command:$*" in
  "lookup:service omamail kind refresh-token client-id desktop-client account me@example.com grant calendar-events-v1") exit 1 ;;
  search:*)
    printf '[old-one]\n[old-two]\n'
    printf 'attribute.service = omamail\nattribute.kind = refresh-token\nattribute.client-id = desktop-client\nattribute.account = me@example.com\nattribute.service = omamail\nattribute.kind = refresh-token\nattribute.client-id = desktop-client\nattribute.account = me@example.com\n' >&2
    printf search >> "@DIR@/log" ;;
  lookup:*) printf ambiguous-secret; printf lookup >> "@DIR@/log" ;;
  *) exit 8 ;;
esac
"##,
    );
    let log = _directory.path().join("log");
    let store = SystemSecretStore::with_secret_tool(&tool, Duration::from_secs(1), true);
    let key = SecretKey::gmail(
        "omamail",
        "omarchy-gmail",
        "desktop-client",
        "me@example.com",
        "calendar-events-v1",
    )
    .unwrap();

    assert_eq!(store.get(&key).unwrap(), None);
    assert_eq!(fs::read_to_string(log).unwrap(), "searchsearchsearchsearch");
}

#[cfg(target_os = "linux")]
#[test]
fn linux_store_times_out_and_delete_missing_is_success() {
    let _process_guard = serial_process_test();
    let (_directory, slow_tool) = executable_fixture("#!/bin/sh\nsleep 5\n");
    let store = SystemSecretStore::with_secret_tool(&slow_tool, Duration::from_millis(30), false);
    let key = refresh_token_key("client", "grant");
    let started = Instant::now();
    assert_eq!(
        store.get(&key),
        Err(omamail::platform::secrets::SecretStoreError::TimedOut)
    );
    assert!(started.elapsed() < Duration::from_secs(1));

    let (_directory, missing_tool) = executable_fixture("#!/bin/sh\nexit 1\n");
    let store = SystemSecretStore::with_secret_tool(&missing_tool, Duration::from_secs(1), false);
    assert_eq!(store.delete(&key), Ok(()));
}

#[test]
fn keyring_v4_errors_keep_not_found_invalid_and_unavailable_distinct() {
    assert_eq!(
        keyring_error_class(&keyring::Error::NoEntry),
        SecretStoreError::NotFound
    );
    assert_eq!(
        keyring_error_class(&keyring::Error::Invalid("service".into(), "empty".into())),
        SecretStoreError::InvalidKey
    );
    assert_eq!(
        keyring_error_class(&keyring::Error::NoDefaultStore),
        SecretStoreError::Unavailable
    );
    assert_eq!(
        keyring_error_class(&keyring::Error::NotSupportedByStore("disabled".into())),
        SecretStoreError::Unavailable
    );
}

#[test]
fn secret_debug_and_errors_do_not_disclose_the_secret_value() {
    let secret = Secret::new("do-not-log-this");
    let error = SecretKey::new("", "refresh-token", "client", "me@example.com", None)
        .expect_err("an empty service is rejected");

    assert!(!format!("{secret:?}").contains("do-not-log-this"));
    assert!(!error.to_string().contains("do-not-log-this"));
}

#[test]
fn policy_maps_only_described_hey_operations_to_direct_argument_vectors() {
    let policy = policy(
        PathBuf::from("/opt/omamail/scripts/image-fetch.sh"),
        PathBuf::from("/opt/omamail/scripts/unsubscribe.sh"),
    );

    let command = policy
        .prepare_hey(HeyOperation::AuthStatus, Duration::from_secs(10))
        .expect("known HEY operation");

    assert_eq!(command.program(), PathBuf::from("/usr/bin/hey").as_path());
    assert_eq!(command.arguments(), ["auth", "status", "--json"]);
    assert!(!command.has_stdin());
    assert_eq!(command.deadline(), Duration::from_secs(10));
}

#[test]
fn policy_keeps_image_url_out_of_arguments_and_debug_output() {
    let url = "https://images.example.test/banner.png?subscriber=private-token";
    let command = policy(
        PathBuf::from("/opt/omamail/scripts/image-fetch.sh"),
        PathBuf::from("/opt/omamail/scripts/unsubscribe.sh"),
    )
    .prepare_transport(TransportOperation::image_fetch(url), Duration::from_secs(5))
    .expect("public image URL is allowed");

    assert!(command.arguments().is_empty());
    assert!(command.has_stdin());
    assert!(!format!("{command:?}").contains("private-token"));
}

#[test]
fn policy_encodes_the_complete_unsubscribe_request_on_stdin() {
    let url = "https://lists.example.test/unsubscribe?token=private";
    let command = policy(
        PathBuf::from("/opt/omamail/scripts/image-fetch.sh"),
        PathBuf::from("/opt/omamail/scripts/unsubscribe.sh"),
    )
    .prepare_transport(
        TransportOperation::unsubscribe(
            url,
            "application/x-www-form-urlencoded",
            "List-Unsubscribe=One-Click",
        ),
        Duration::from_secs(5),
    )
    .expect("one-click request is allowed");

    assert!(command.arguments().is_empty());
    assert!(command.has_stdin());
    assert!(!format!("{command:?}").contains("token=private"));
}

#[test]
fn policy_refuses_private_and_local_transport_urls_before_spawning() {
    let policy = policy(
        PathBuf::from("/opt/omamail/scripts/image-fetch.sh"),
        PathBuf::from("/opt/omamail/scripts/unsubscribe.sh"),
    );
    for url in [
        "http://127.0.0.1/a",
        "http://[::1]/a",
        "http://169.254.1.1/a",
        "http://192.168.1.1/a",
        "http://100.64.0.1/a",
        "http://198.18.0.1/a",
        "http://192.0.2.1/a",
        "http://[2001:db8::1]/a",
        "https://intranet/a",
        "https://printer.local/a",
    ] {
        assert_eq!(
            policy
                .prepare_transport(TransportOperation::image_fetch(url), Duration::from_secs(5))
                .expect_err("non-public URL is refused"),
            CommandError::DisallowedUrl
        );
    }
}

#[test]
fn policy_refuses_ipv4_mapped_private_addresses_and_trailing_dot_local_names() {
    let policy = policy_with_resolver(
        PathBuf::from("/opt/omamail/scripts/image-fetch.sh"),
        PathBuf::from("/opt/omamail/scripts/unsubscribe.sh"),
        FakeResolver::returning("unused.example", 443, &["93.184.216.34"]),
    );

    for url in [
        "http://[::ffff:127.0.0.1]/a",
        "http://[::ffff:192.168.1.1]/a",
        "https://localhost./a",
        "https://printer.local./a",
    ] {
        assert_eq!(
            policy
                .prepare_transport(TransportOperation::image_fetch(url), Duration::from_secs(5))
                .expect_err("normalized local URL is refused"),
            CommandError::DisallowedUrl
        );
    }
}

#[test]
fn policy_refuses_a_domain_if_any_resolved_address_is_not_public() {
    let policy = policy_with_resolver(
        PathBuf::from("/opt/omamail/scripts/image-fetch.sh"),
        PathBuf::from("/opt/omamail/scripts/unsubscribe.sh"),
        FakeResolver::returning("mixed.example.test", 443, &["93.184.216.34", "10.0.0.7"]),
    );

    assert_eq!(
        policy
            .prepare_transport(
                TransportOperation::image_fetch("https://mixed.example.test/a"),
                Duration::from_secs(5),
            )
            .expect_err("one private DNS answer refuses the whole destination"),
        CommandError::DisallowedUrl
    );
}

#[cfg(unix)]
#[test]
fn policy_normalizes_a_trailing_dot_and_pins_every_resolved_address_on_stdin() {
    let _process_guard = serial_process_test();
    let (_root, capture) = executable_script("IFS= read -r line\nprintf '%s\\n' \"$line\"");
    let policy = policy_with_resolver(
        capture.clone(),
        capture,
        FakeResolver::returning(
            "images.example.test",
            443,
            &["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"],
        ),
    );
    let command = policy
        .prepare_transport(
            TransportOperation::image_fetch(
                "https://images.example.test./banner.png?subscriber=private-token",
            ),
            Duration::from_secs(5),
        )
        .expect("public DNS answers are allowed");

    assert!(command.arguments().is_empty());
    assert!(!format!("{command:?}").contains("private-token"));
    let output = SystemProcessRunner
        .run(command)
        .expect("capture protected stdin");
    let fields: Vec<_> = std::str::from_utf8(output.stdout())
        .expect("text fixture output")
        .split_whitespace()
        .map(|field| {
            String::from_utf8(STANDARD.decode(field).expect("base64 fixture field"))
                .expect("UTF-8 fixture field")
        })
        .collect();

    assert_eq!(
        fields,
        [
            "https://images.example.test/banner.png?subscriber=private-token",
            "images.example.test:443:93.184.216.34",
            "images.example.test:443:[2606:2800:220:1:248:1893:25c8:1946]",
        ]
    );
}

#[cfg(unix)]
fn executable_script(body: &str) -> (tempfile::TempDir, PathBuf) {
    use std::os::unix::fs::PermissionsExt as _;

    let root = tempfile::tempdir().expect("process fixture directory");
    let script = root.path().join("fixture.sh");
    fs::write(&script, format!("#!/bin/sh\nset -eu\n{body}\n")).expect("process fixture");
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).expect("fixture executable");
    (root, script)
}

#[cfg(unix)]
fn run_helper_with_fake_curl(
    helper: &str,
    request: &str,
    answer: &str,
) -> (tempfile::TempDir, std::process::Output, String) {
    use std::{io::Write as _, os::unix::fs::PermissionsExt as _};

    let root = tempfile::tempdir().expect("fake curl directory");
    let curl = root.path().join("curl");
    fs::write(
        &curl,
        r#"#!/bin/sh
set -eu
config=$OMAMAIL_TEST_CURL_CONFIG
: > "$config"
while IFS= read -r line; do printf '%s\n' "$line" >> "$config"; done
output=$(sed -n 's/^output = "\(.*\)"$/\1/p' "$config")
if [ -n "$output" ] && [ "$output" != /dev/null ]; then printf x > "$output"; fi
printf '%s' "$OMAMAIL_TEST_CURL_ANSWER"
"#,
    )
    .expect("write fake curl");
    fs::set_permissions(&curl, fs::Permissions::from_mode(0o700)).expect("fake curl executable");
    let config = root.path().join("curl.conf");
    let path = format!(
        "{}:{}",
        root.path().display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut child = Command::new(helper)
        .env("PATH", path)
        .env("OMAMAIL_TEST_CURL_CONFIG", &config)
        .env("OMAMAIL_TEST_CURL_ANSWER", answer)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("start helper");
    child
        .stdin
        .take()
        .expect("helper stdin")
        .write_all(request.as_bytes())
        .expect("write helper request");
    let output = child.wait_with_output().expect("wait for helper");
    let config = fs::read_to_string(config).unwrap_or_default();
    (root, output, config)
}

#[cfg(unix)]
#[test]
fn image_helper_pins_curl_to_every_validated_address_without_redirects() {
    let _process_guard = serial_process_test();
    let fields = [
        "https://images.example.test/pixel.png?token=private",
        "images.example.test:443:93.184.216.34",
        "images.example.test:443:[2606:2800:220:1:248:1893:25c8:1946]",
    ];
    let request = fields
        .iter()
        .map(|field| STANDARD.encode(field))
        .collect::<Vec<_>>()
        .join(" ")
        + "\n";
    let (_root, output, config) =
        run_helper_with_fake_curl("scripts/image-fetch.sh", &request, "200 image/png");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(config.contains("resolve = \"images.example.test:443:93.184.216.34\""));
    assert!(
        config
            .contains("resolve = \"images.example.test:443:[2606:2800:220:1:248:1893:25c8:1946]\"")
    );
    assert!(config.contains("max-redirs = 0"));
    assert!(config.contains("noproxy = \"*\""));
    assert!(!config.contains("location"));
}

#[cfg(unix)]
#[test]
fn unsubscribe_helper_pins_curl_without_following_redirects() {
    let _process_guard = serial_process_test();
    let fields = [
        "https://lists.example.test/unsubscribe?token=private",
        "application/x-www-form-urlencoded",
        "List-Unsubscribe=One-Click",
        "lists.example.test:443:93.184.216.34",
    ];
    let request = fields
        .iter()
        .map(|field| STANDARD.encode(field))
        .collect::<Vec<_>>()
        .join(" ")
        + "\n";
    let (_root, output, config) =
        run_helper_with_fake_curl("scripts/unsubscribe.sh", &request, "204");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(config.contains("resolve = \"lists.example.test:443:93.184.216.34\""));
    assert!(config.contains("max-redirs = 0"));
    assert!(config.contains("noproxy = \"*\""));
    assert!(!config.contains("location"));
}

#[cfg(unix)]
#[test]
fn runner_drains_large_stdout_and_stderr_while_the_process_is_running() {
    let _process_guard = serial_process_test();
    let (_root, script) = executable_script(
        "head -c 262144 /dev/zero | tr '\\0' o\nhead -c 262144 /dev/zero | tr '\\0' e >&2",
    );
    let command = policy(script.clone(), script)
        .prepare_transport(
            TransportOperation::image_fetch("https://images.example.test/a"),
            Duration::from_secs(3),
        )
        .expect("fixture command");

    let output = SystemProcessRunner
        .run(command)
        .expect("large output must not deadlock");
    assert_eq!(output.stdout().len(), 262_144);
    assert_eq!(output.stderr().len(), 262_144);
}

#[cfg(unix)]
#[test]
fn runner_times_out_and_reaps_the_child_process_group() {
    let _process_guard = serial_process_test();
    let state = tempfile::tempdir().expect("process state directory");
    let pid_file = state.path().join("grandchild.pid");
    let (_root, script) = executable_script(&format!(
        "sleep 60 &\necho $! > {}\nwait",
        pid_file.display()
    ));
    let command = policy(script.clone(), script)
        .prepare_transport(
            TransportOperation::image_fetch("https://images.example.test/a"),
            Duration::from_millis(100),
        )
        .expect("fixture command");

    let started = Instant::now();
    let error = SystemProcessRunner
        .run(command)
        .expect_err("fixture must time out");
    assert_eq!(error, CommandError::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(2));

    let grandchild: i32 = fs::read_to_string(&pid_file)
        .expect("fixture records its child pid")
        .trim()
        .parse()
        .expect("numeric grandchild pid");
    std::thread::sleep(Duration::from_millis(25));
    assert_eq!(unsafe { libc::kill(grandchild, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

#[cfg(unix)]
#[test]
fn runner_deadline_covers_pipe_eof_after_the_parent_exits() {
    let _process_guard = serial_process_test();
    let (_root, script) = executable_script("sleep 60 &\nexit 0");
    let command = policy(script.clone(), script)
        .prepare_transport(
            TransportOperation::image_fetch("https://images.example.test/a"),
            Duration::from_millis(100),
        )
        .expect("fixture command");
    let started = Instant::now();

    let error = SystemProcessRunner
        .run(command)
        .expect_err("open descendant pipe must exhaust the deadline");

    assert_eq!(error, CommandError::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn process_runner_is_a_separate_boundary_from_the_policy() {
    fn accept_runner(_: &dyn ProcessRunner) {}

    let runner = SystemProcessRunner;
    accept_runner(&runner);
}

#[cfg(windows)]
#[test]
fn windows_runner_exposes_a_job_object_child_containment_boundary() {
    fn accepts(_: Option<omamail::platform::commands::WindowsChildContainment>) {}
    accepts(None);
}
