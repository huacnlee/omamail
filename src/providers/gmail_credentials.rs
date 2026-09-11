//! Existing desktop OAuth client and current-grant keyring compatibility.
use serde_json::Value;
use std::{
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::Duration,
};

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
fn read_path(path: &Path, account: &str) -> Result<Client, &'static str> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "gmail_client_unreadable")?;
    let metadata = file.metadata().map_err(|_| "gmail_client_unreadable")?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err("gmail_client_permissions");
    }
    let mut bytes = vec![];
    file.take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "gmail_client_unreadable")?;
    if bytes.len() > 1024 * 1024 {
        return Err("gmail_client_too_large");
    }
    parse_client(&bytes, account)
}
pub fn read_for_account(account: &str) -> Result<Client, &'static str> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or("config_home_invalid")?;
    read_path(&home.join(".config/omamail/credentials.json"), account)
}
fn lookup_with(
    client: &Client,
    account: &str,
    run: impl FnOnce(&[String]) -> Result<Vec<u8>, &'static str>,
) -> Result<String, &'static str> {
    if account.chars().any(char::is_control)
        || account.len() > 1024
        || client.client_id.is_empty()
        || client.client_id.chars().any(char::is_control)
    {
        return Err("gmail_token_account_invalid");
    }
    let account = account.trim().to_lowercase();
    let args: Vec<String> = [
        "lookup",
        "service",
        "omamail",
        "kind",
        "refresh-token",
        "client-id",
        &client.client_id,
        "account",
        if account.is_empty() {
            "default"
        } else {
            &account
        },
        "grant",
        "calendar-events-v1",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    let bytes = run(&args)?;
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
    let token = std::str::from_utf8(bytes).map_err(|_| "gmail_token_invalid")?;
    if token.is_empty()
        || token.len() > 16384
        || token.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("gmail_token_invalid");
    }
    Ok(token.into())
}
pub fn lookup_refresh_token(client: &Client, account: &str) -> Result<String, &'static str> {
    lookup_with(client, account, |args| {
        crate::process::run("secret-tool", args, b"", Duration::from_secs(15), 16385).map_err(
            |error| {
                if error == "process_failed" {
                    "gmail_token_missing"
                } else {
                    error
                }
            },
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink};

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
    #[test]
    fn private_regular_file_only() {
        let dir = std::env::temp_dir().join(format!(
            "omamail-client-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("client");
        let mut out = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&file)
            .unwrap();
        out.write_all(SINGLE).unwrap();
        assert!(read_path(&file, "one@example.org").is_ok());
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_path(&file, "one@example.org").is_err());
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.join("link");
        symlink(&file, &link).unwrap();
        assert!(read_path(&link, "one@example.org").is_err());
        assert!(read_path(&dir, "one@example.org").is_err());
        out.set_len(1024 * 1024 + 1).unwrap();
        assert!(read_path(&file, "one@example.org").is_err());
        std::fs::remove_file(link).unwrap();
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn lookup_is_account_and_current_grant_bound() {
        let c = parse_client(SINGLE, "one@example.org").ok().unwrap();
        let token = lookup_with(&c, "ONE@example.org", |args| {
            assert_eq!(
                args,
                [
                    "lookup",
                    "service",
                    "omamail",
                    "kind",
                    "refresh-token",
                    "client-id",
                    "123-abc.apps.googleusercontent.com",
                    "account",
                    "one@example.org",
                    "grant",
                    "calendar-events-v1"
                ]
            );
            Ok(b"synthetic-token\n".to_vec())
        })
        .unwrap();
        assert_eq!(token, "synthetic-token");
    }
    #[test]
    fn refuses_controls_without_keyring_and_noncanonical_token_output() {
        let c = parse_client(SINGLE, "one@example.org").ok().unwrap();
        assert!(lookup_with(&c, "one@example.org\n", |_| panic!("must not execute")).is_err());
        for bytes in [
            b"token\n\n".as_slice(),
            b"token\0",
            b"token\r\n",
            b" token\n",
            b"\xff",
        ] {
            assert!(lookup_with(&c, "one@example.org", |_| Ok(bytes.to_vec())).is_err());
        }
    }
}
