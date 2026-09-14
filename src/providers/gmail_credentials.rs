//! Existing desktop OAuth client and current-grant keyring compatibility.
use crate::credentials::{
    CredentialKey, CredentialKind, CredentialStore, Error as StoreError, NativeStore, Secret,
};
use serde_json::Value;
use std::{fs::File, io::Read, path::Path};

const MAX_CLIENT_BYTES: u64 = 1024 * 1024;

pub struct Client {
    pub(crate) client_id: String,
    pub(crate) client_secret: String,
}

fn field<'a>(raw: &'a Value, snake: &str, camel: &str) -> &'a str {
    raw[snake]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| raw[camel].as_str())
        .unwrap_or("")
        .trim()
}
fn client(raw: &Value) -> Option<Client> {
    let raw = if raw["installed"].is_object() {
        &raw["installed"]
    } else if raw["web"].is_object() {
        return None;
    } else {
        raw
    };
    if ["client_id", "clientId", "client_secret", "clientSecret"]
        .iter()
        .any(|key| {
            raw[*key]
                .as_str()
                .is_some_and(|s| s.chars().any(char::is_control))
        })
    {
        return None;
    }
    let id = field(raw, "client_id", "clientId");
    let prefix = id.strip_suffix(".apps.googleusercontent.com")?;
    let (digits, suffix) = prefix.split_once('-')?;
    if digits.is_empty()
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || suffix.is_empty()
        || !suffix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return None;
    }
    let secret = field(raw, "client_secret", "clientSecret");
    if secret.chars().any(char::is_control) {
        return None;
    }
    Some(Client {
        client_id: id.into(),
        client_secret: secret.into(),
    })
}
fn parse_client(bytes: &[u8], account: &str) -> Result<Client, &'static str> {
    let raw: Value = serde_json::from_slice(bytes).map_err(|_| "gmail_client_invalid")?;
    if let Some(entries) = raw["accounts"].as_array() {
        let mut shared = None;
        for entry in entries {
            if let Some(value) = client(entry) {
                if entry["id"]
                    .as_str()
                    .unwrap_or("")
                    .trim()
                    .eq_ignore_ascii_case(account.trim())
                {
                    return Ok(value);
                }
                if shared.is_none() {
                    shared = Some(value);
                }
            }
        }
        shared.ok_or("gmail_client_missing")
    } else {
        client(&raw).ok_or("gmail_client_missing")
    }
}
fn storage_error(error: &'static str) -> &'static str {
    match error {
        "cache_unsafe_path" => "gmail_client_permissions",
        "cache_home_invalid" => "config_home_invalid",
        _ => "gmail_client_unreadable",
    }
}
fn read_file(file: File, account: &str) -> Result<Client, &'static str> {
    let metadata = file.metadata().map_err(|_| "gmail_client_unreadable")?;
    if metadata.len() > MAX_CLIENT_BYTES {
        return Err("gmail_client_too_large");
    }
    let mut bytes = vec![];
    file.take(MAX_CLIENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "gmail_client_unreadable")?;
    if bytes.len() as u64 > MAX_CLIENT_BYTES {
        return Err("gmail_client_too_large");
    }
    parse_client(&bytes, account)
}
fn read_at(config: &Path, account: &str) -> Result<Client, &'static str> {
    let dir = crate::platform::private_fs::directories_readonly(
        config,
        &[crate::platform::dirs::APP_DIRECTORY],
    )
    .map_err(storage_error)?
    .ok_or("gmail_client_unreadable")?;
    let file = crate::platform::private_fs::regular_readonly(&dir, "credentials.json")
        .map_err(storage_error)?
        .ok_or("gmail_client_unreadable")?;
    read_file(file, account)
}
pub fn read_for_account(account: &str) -> Result<Client, &'static str> {
    let config = crate::platform::dirs::AppDirs::discover()
        .map_err(|_| "config_home_invalid")?
        .config;
    read_at(&config, account)
}
pub(super) fn lookup_with(
    client: &Client,
    account: &str,
    run: impl FnOnce(&CredentialKey) -> Result<Secret, StoreError>,
) -> Result<zeroize::Zeroizing<String>, &'static str> {
    if account.chars().any(char::is_control)
        || account.len() > 1024
        || client.client_id.is_empty()
        || client.client_id.chars().any(char::is_control)
    {
        return Err("gmail_token_account_invalid");
    }
    let account = account.trim().to_lowercase();
    let key = CredentialKey {
        provider: "gmail".into(),
        account_id: if account.is_empty() {
            "default".into()
        } else {
            account
        },
        kind: CredentialKind::GoogleRefreshToken {
            client_id: client.client_id.clone(),
        },
    };
    let secret = run(&key).map_err(|error| match error {
        StoreError::Missing => "gmail_token_missing",
        StoreError::InvalidKey => "gmail_token_account_invalid",
        StoreError::InvalidSecret | StoreError::TooLarge => "gmail_token_invalid",
        StoreError::Unavailable | StoreError::Ambiguous => "gmail_keyring_failed",
    })?;
    let token = secret.text().map_err(|_| "gmail_token_invalid")?;
    if token.is_empty()
        || token.len() > 16384
        || token.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("gmail_token_invalid");
    }
    Ok(zeroize::Zeroizing::new(token.into()))
}
pub fn lookup_refresh_token(
    client: &Client,
    account: &str,
) -> Result<zeroize::Zeroizing<String>, &'static str> {
    lookup_with(client, account, |key| NativeStore.get(key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    static SERIAL: AtomicU64 = AtomicU64::new(0);

    const SINGLE: &[u8] = br#"{"installed":{"client_id":"123-abc.apps.googleusercontent.com","client_secret":"synthetic"}}"#;
    #[test]
    fn client_controls_are_not_normalized_away() {
        for key in ["client_id", "client_secret"] {
            for control in ["\n", "\r", "\r\n", "\0"] {
                let mut value: Value = serde_json::from_slice(SINGLE).unwrap();
                let before = value["installed"][key].as_str().unwrap().to_string();
                value["installed"][key] = Value::String(before + control);
                assert!(
                    parse_client(&serde_json::to_vec(&value).unwrap(), "one@example.org").is_err()
                );
            }
        }
    }
    #[test]
    fn console_client_and_account_specific_client_are_compatible() {
        let one = parse_client(SINGLE, "one@example.org").expect("console client");
        assert_eq!(one.client_secret, "synthetic");
        let bytes = br#"{"version":2,"accounts":[{"id":"other@example.org","installed":{"client_id":"123-shared.apps.googleusercontent.com"}},{"id":"ONE@example.org","clientId":"456-own.apps.googleusercontent.com","clientSecret":"own"}]}"#;
        assert_eq!(
            parse_client(bytes, "one@example.org")
                .expect("own")
                .client_secret,
            "own"
        );
        assert_eq!(
            parse_client(bytes, "third@example.org")
                .expect("shared")
                .client_id,
            "123-shared.apps.googleusercontent.com"
        );
        assert!(
            parse_client(
                br#"{"web":{"client_id":"123-abc.apps.googleusercontent.com"}}"#,
                "x"
            )
            .is_err()
        );
    }
    struct Fixture {
        root: PathBuf,
        config: PathBuf,
        directory: File,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "omamail-client-test-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            let config = root.join("config");
            let directory = crate::platform::private_fs::directories(
                &config,
                &[crate::platform::dirs::APP_DIRECTORY],
                true,
            )
            .unwrap()
            .unwrap();
            Self {
                root,
                config,
                directory,
            }
        }
        fn write(&self, bytes: &[u8]) {
            crate::platform::private_fs::atomic_replace(&self.directory, "credentials.json", bytes)
                .unwrap();
        }
        fn path(&self) -> PathBuf {
            self.config
                .join(crate::platform::dirs::APP_DIRECTORY)
                .join("credentials.json")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }
    #[test]
    fn reads_only_the_platform_config_root() {
        let name = std::thread::current().name().unwrap().to_owned();
        if std::env::var("OMAMAIL_GMAIL_DIR_TEST_CHILD").as_deref() != Ok(name.as_str()) {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &name, "--test-threads=1", "--nocapture"])
                .env("OMAMAIL_GMAIL_DIR_TEST_CHILD", &name)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let fixture = Fixture::new();
        fixture.write(SINGLE);
        let dirs = crate::platform::dirs::AppDirs::from_roots(
            fixture.config.clone(),
            fixture.root.join("cache"),
            fixture.root.join("state"),
            fixture.root.join("runtime"),
            fixture.root.join("downloads"),
        )
        .unwrap();
        assert_eq!(dirs.config_directory(), fixture.config.join("omamail"));
        let _override =
            crate::platform::dirs::install_test_override(dirs, fixture.root.join("different-home"))
                .unwrap();
        assert_eq!(
            read_for_account("one@example.org").unwrap().client_secret,
            "synthetic"
        );
    }
    #[test]
    fn hardlinks_and_oversized_files_are_rejected_before_parsing() {
        let fixture = Fixture::new();
        fixture.write(b"not json");
        let alias = fixture.root.join("second-name");
        std::fs::hard_link(fixture.path(), &alias).unwrap();
        assert!(matches!(
            read_at(&fixture.config, "one@example.org"),
            Err("gmail_client_permissions")
        ));
        std::fs::remove_file(alias).unwrap();
        fixture.write(&vec![b'x'; MAX_CLIENT_BYTES as usize + 1]);
        assert!(matches!(
            read_at(&fixture.config, "one@example.org"),
            Err("gmail_client_too_large")
        ));
    }
    #[cfg(unix)]
    #[test]
    fn unix_permissions_and_symlinks_are_rejected_before_parsing() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let fixture = Fixture::new();
        fixture.write(b"not json");
        std::fs::set_permissions(fixture.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(
            read_at(&fixture.config, "one@example.org"),
            Err("gmail_client_permissions")
        ));
        std::fs::remove_file(fixture.path()).unwrap();
        let target = fixture.root.join("outside");
        std::fs::write(&target, b"not json").unwrap();
        symlink(&target, fixture.path()).unwrap();
        assert!(matches!(
            read_at(&fixture.config, "one@example.org"),
            Err("gmail_client_permissions")
        ));
    }
    #[test]
    fn lookup_is_account_and_current_grant_bound() {
        let c = parse_client(SINGLE, "one@example.org").ok().unwrap();
        let token = lookup_with(&c, "ONE@example.org", |key| {
            assert_eq!(
                key,
                &CredentialKey {
                    provider: "gmail".into(),
                    account_id: "one@example.org".into(),
                    kind: CredentialKind::GoogleRefreshToken {
                        client_id: "123-abc.apps.googleusercontent.com".into()
                    },
                }
            );
            Secret::new(b"synthetic-token".to_vec())
        })
        .unwrap();
        assert_eq!(token.as_str(), "synthetic-token");
    }
    #[test]
    fn refuses_controls_without_keyring_and_noncanonical_token_output() {
        let c = parse_client(SINGLE, "one@example.org").ok().unwrap();
        assert!(lookup_with(&c, "one@example.org\n", |_| panic!("must not execute")).is_err());
        for bytes in [
            b"token\n".as_slice(),
            b"token\n\n",
            b"token\0",
            b"token\r\n",
            b" token\n",
            b"\xff",
        ] {
            assert!(lookup_with(&c, "one@example.org", |_| Secret::new(bytes.to_vec())).is_err());
        }
    }
}
