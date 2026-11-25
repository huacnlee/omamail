//! Synthetic regression: no mailbox, credentials, network or correspondence.
//!
//! A screenshot pasted into an Outlook or Thunderbird message travels as an
//! image part the HTML names with a `cid:` address. Qt has no `cid:` scheme,
//! so the reader must hand it the part itself as checked data, in Original
//! and in Reading, or the picture is simply missing.
#![cfg(unix)]

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    process::{Command, Stdio},
};

const ACCOUNT: &str = "synthetic@example.org";

#[cfg(target_os = "macos")]
fn config_root(root: &std::path::Path) -> std::path::PathBuf {
    root.join("Library/Application Support")
}
#[cfg(not(target_os = "macos"))]
fn config_root(root: &std::path::Path) -> std::path::PathBuf {
    root.join("config")
}

// A 1 x 1 PNG fixed here, not produced by the code under test.
const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLa0AAAAASUVORK5CYII=";

#[test]
fn a_cid_picture_is_drawn_from_the_message_and_never_handed_to_qt() {
    let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "omamail-cid-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(root.clone());
    let config = config_root(&root);
    let registry = config.join("omamail/accounts.json");
    fs::create_dir_all(registry.parent().unwrap()).unwrap();
    fs::set_permissions(&config, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(
        registry.parent().unwrap(),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    fs::write(
        &registry,
        format!(r#"{{"version":1,"activeId":"{ACCOUNT}","accounts":[{{"email":"{ACCOUNT}"}}]}}"#),
    )
    .unwrap();
    fs::set_permissions(&registry, fs::Permissions::from_mode(0o600)).unwrap();
    let call = |method: &str, params: Value| -> Value {
        let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
            .args(["call", method, "--json"])
            .env_clear()
            .env("HOME", &root)
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("XDG_CACHE_HOME", root.join("cache"))
            .env("XDG_DATA_HOME", root.join("data"))
            .env("XDG_STATE_HOME", root.join("state"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(params.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{method}: {} {}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(envelope["ok"], true, "{method}: {envelope}");
        envelope["result"].clone()
    };

    // The shape a pasted screenshot arrives in over IMAP: multipart/related,
    // the HTML naming the part by its Content-ID, the part kept inline.
    let raw = format!(
        "From: Sender <sender@example.org>\r\nSubject: Screenshot\r\nMIME-Version: 1.0\r\n\
         Content-Type: multipart/related; boundary=rel\r\n\r\n\
         --rel\r\nContent-Type: text/html; charset=utf-8\r\n\r\n\
         <p>Here it is:</p><p><img src=\"cid:image001.png@01DB0000.ABCDEF00\" alt=\"screenshot\"></p>\r\n\
         --rel\r\nContent-Type: image/png; name=\"image001.png\"\r\n\
         Content-ID: <image001.png@01DB0000.ABCDEF00>\r\n\
         Content-Disposition: inline; filename=\"image001.png\"\r\n\
         Content-Transfer-Encoding: base64\r\n\r\n{PNG}\r\n--rel--\r\n"
    );
    let payload = call(
        "message.parse",
        json!({"raw": URL_SAFE_NO_PAD.encode(raw.as_bytes())}),
    );
    call(
        "cache.resourcePut",
        json!({"accountId":ACCOUNT,"id":"1:INBOX","resource":{"id":"1:INBOX","payload":payload}}),
    );
    let opened = call(
        "reader.open",
        json!({"accountId":ACCOUNT,"id":"1:INBOX","requestId":"cid","now":0,"cacheOnly":true,
            "options":{"allowRemoteImages":false,"withReader":true,"withPlainText":true}}),
    );
    let rendered = &opened["nativeRender"];
    let picture = format!("data:image/png;base64,{PNG}");
    for (view, document) in [
        ("Original", &rendered["document"]),
        ("Reading", &rendered["reader"]["document"]),
    ] {
        let text = document.to_string();
        assert!(
            text.contains(&picture),
            "{view} does not draw the message's own picture: {text}"
        );
        assert!(
            !text.contains("cid:"),
            "{view} hands Qt a cid: source: {text}"
        );
    }
}
