//! Synthetic regressions: no mailbox, credentials, or sender correspondence.
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use omamail::{backend, message};
use serde_json::{Value, json};

const GREETING: &str = "Добрый день!";
// Independently fixed bytes, not produced by the decoder being tested.
const CP1251: &[u8] = b"\xc4\xee\xe1\xf0\xfb\xe9 \xe4\xe5\xed\xfc!";
const GB2312: &[u8] =
    b"\xa7\xa5\xa7\xe0\xa7\xd2\xa7\xe2\xa7\xed\xa7\xdb \xa7\xd5\xa7\xd6\xa7\xdf\xa7\xee!";

fn qp(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("={byte:02X}")).collect()
}

fn call(method: &str, params: &Value) -> Value {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(backend::Session::default().dispatch(method, params))
        .unwrap()
}

fn prepare(raw: &[u8]) -> (Value, Value) {
    let payload = call(
        "message.parse",
        &json!({"raw": URL_SAFE_NO_PAD.encode(raw)}),
    );
    let prepared = call(
        "message.prepare",
        &json!({"message": {"id": "synthetic", "payload": payload}}),
    );
    (payload, prepared)
}

fn resource(charset: &str, bytes: &[u8]) -> Value {
    json!({"payload": {"mimeType": format!("text/plain; charset={charset}"), "body": {"data": URL_SAFE_NO_PAD.encode(bytes)}}})
}

#[test]
fn genuine_legacy_bodies_and_encoded_headers_decode_over_rpc() {
    for (charset, bytes) in [("windows-1251", CP1251), ("gb2312", GB2312)] {
        for cte in ["base64", "quoted-printable"] {
            for kind in ["plain", "html"] {
                for word_encoding in ["B", "Q"] {
                    let expected = if kind == "html" {
                        format!("<p>{GREETING}</p>")
                    } else {
                        GREETING.into()
                    };
                    let mut body = Vec::new();
                    if kind == "html" {
                        body.extend_from_slice(b"<p>");
                    }
                    body.extend_from_slice(bytes);
                    if kind == "html" {
                        body.extend_from_slice(b"</p>");
                    }
                    let encoded = if cte == "base64" {
                        STANDARD.encode(&body)
                    } else {
                        qp(&body)
                    };
                    let word = if word_encoding == "B" {
                        STANDARD.encode(bytes)
                    } else {
                        qp(bytes)
                    };
                    let word = format!("=?{charset}?{word_encoding}?{word}?=");
                    let raw = format!(
                        "From: {word} <sender@example.org>\r\nSubject: {word}\r\nMIME-Version: 1.0\r\nContent-Type: text/{kind}; charset=\"{charset}\"\r\nContent-Transfer-Encoding: {cte}\r\n\r\n{encoded}"
                    );
                    let (payload, prepared) = prepare(raw.as_bytes());
                    let actual = if kind == "html" {
                        &prepared["html"]
                    } else {
                        &prepared["body"]["text"]
                    };
                    assert_eq!(actual, &expected, "{charset} {cte} {kind} {word_encoding}");
                    assert_eq!(prepared["summary"]["subject"], GREETING);
                    assert_eq!(prepared["summary"]["from"]["name"], GREETING);
                    // MIME normalization must retain the original octets, not transcode attachments.
                    assert_eq!(
                        URL_SAFE_NO_PAD
                            .decode(payload["body"]["data"].as_str().unwrap())
                            .unwrap(),
                        body
                    );
                }
            }
        }
    }
}

#[test]
fn charset_aliases_case_and_quoted_parameters_are_respected() {
    for label in ["windows-1251", "WINDOWS-1251", "cp1251", "x-cp1251"] {
        assert_eq!(
            message::content::prepare(&resource(label, CP1251), 0).unwrap()["body"]["text"],
            GREETING,
            "{label}"
        );
    }
    for label in ["gb2312", "GB_2312-80", "chinese", "gbk"] {
        assert_eq!(
            message::content::prepare(&resource(label, GB2312), 0).unwrap()["body"]["text"],
            GREETING,
            "{label}"
        );
    }
    let body = STANDARD.encode(CP1251);
    let (_, prepared) = prepare(format!("Content-Type: text/plain; charset = \"WINDOWS-1251\"\r\nContent-Transfer-Encoding: base64\r\n\r\n{body}").as_bytes());
    assert_eq!(prepared["body"]["text"], GREETING);
}

#[test]
fn utf8_sniffing_and_other_real_charsets_do_not_regress() {
    for charset in [
        "utf-8",
        "us-ascii",
        "iso-8859-1",
        "iso-8859-2",
        "windows-1250",
        "windows-1251",
    ] {
        let text = "Dzień dobry 📨";
        assert_eq!(
            message::content::prepare(&resource(charset, text.as_bytes()), 0).unwrap()["body"]["text"],
            text,
            "{charset}"
        );
    }
    for (charset, bytes, expected) in [
        ("iso-8859-1", b"caf\xe9".as_slice(), "café"),
        ("iso-8859-2", b"\xa3\xf3d\xbc".as_slice(), "Łódź"),
        (
            "windows-1252",
            b"\x80 \x93quote\x94".as_slice(),
            "€ “quote”",
        ),
        ("koi8-r", b"\xf0\xd2\xc9\xd7\xc5\xd4".as_slice(), "Привет"),
        ("shift_jis", b"\x93\xfa\x96\x7b".as_slice(), "日本"),
    ] {
        assert_eq!(
            message::content::prepare(&resource(charset, bytes), 0).unwrap()["body"]["text"],
            expected,
            "{charset}"
        );
    }
}

#[test]
fn malformed_legacy_sequences_are_bounded_and_unknown_labels_keep_the_fallback() {
    assert_eq!(
        message::content::prepare(&resource("gb2312", b"\xa7"), 0).unwrap()["body"]["text"],
        "\u{fffd}"
    );
    assert_eq!(
        message::content::prepare(&resource("not-a-charset", b"ASCII\xff"), 0).unwrap()["body"]["text"],
        "ASCIIÿ"
    );
    // Not valid UTF-8: these must go through the declared legacy decoder.
    for bytes in [
        b"\xc0\xaf".as_slice(),
        b"\xed\xa0\x80".as_slice(),
        b"\xf4\x90\x80\x80".as_slice(),
    ] {
        let value = message::content::prepare(&resource("windows-1251", bytes), 0).unwrap();
        assert!(!value["body"]["text"].as_str().unwrap().contains('\u{fffd}'));
    }
}

#[test]
fn nested_mime_and_attachment_bytes_are_preserved() {
    let body = STANDARD.encode(CP1251);
    let filename = format!(
        "=?windows-1251?B?{}?=",
        STANDARD.encode(b"\xf1\xf7\xb8\xf2.pdf")
    );
    let raw = format!(
        "Content-Type: multipart/mixed; boundary=outer\r\n\r\n--outer\r\nContent-Type: multipart/alternative; boundary=inner\r\n\r\n--inner\r\nContent-Type: text/plain; charset=windows-1251\r\nContent-Transfer-Encoding: base64\r\n\r\n{body}\r\n--inner--\r\n--outer\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"{filename}\"\r\nContent-Transfer-Encoding: base64\r\n\r\nAP/+AQ==\r\n--outer--\r\n"
    );
    let (payload, prepared) = prepare(raw.as_bytes());
    assert_eq!(prepared["body"]["text"], GREETING);
    assert_eq!(prepared["attachments"][0]["filename"], "счёт.pdf");
    assert_eq!(
        URL_SAFE_NO_PAD
            .decode(payload["parts"][1]["body"]["data"].as_str().unwrap())
            .unwrap(),
        [0, 255, 254, 1]
    );
}

// The registry lives where the platform contract puts it: macOS reads
// ~/Library/Application Support and ignores XDG_CONFIG_HOME.
#[cfg(target_os = "macos")]
fn config_root(root: &std::path::Path) -> std::path::PathBuf {
    root.join("Library/Application Support")
}
#[cfg(all(unix, not(target_os = "macos")))]
fn config_root(root: &std::path::Path) -> std::path::PathBuf {
    root.join("config")
}

#[cfg(unix)]
#[test]
fn cached_reader_redecodes_original_octets_instead_of_reusing_mojibake() {
    use std::{
        fs,
        io::Write,
        os::unix::fs::PermissionsExt,
        process::{Command, Stdio},
    };
    // macOS puts TMPDIR under /var, a symlink the private_fs path walk
    // refuses (O_NOFOLLOW), so resolve it first like the other CLI tests.
    let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
        "omamail-charset-cache-{}-{}",
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
    fs::write(&registry, r#"{"version":1,"activeId":"synthetic@example.org","accounts":[{"email":"synthetic@example.org"}]}"#).unwrap();
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
    for (charset, bytes) in [("windows-1251", CP1251), ("gb2312", GB2312)] {
        let id = charset;
        call(
            "cache.bodyPut",
            json!({"accountId":"synthetic@example.org","id":id,"body":{"text":"stale mojibake","source":"plain"}}),
        );
        // Pre-0.9 body caches alone must not become a permanent native reader hit.
        let open = json!({"accountId":"synthetic@example.org","id":id,"requestId":"charset","now":0,"cacheOnly":true,"options":{"allowRemoteImages":false}});
        assert!(call("reader.open", open.clone()).is_null());
        let mut message = resource(charset, bytes);
        message["id"] = json!(id);
        message["payload"]["headers"] = json!([]);
        call(
            "cache.resourcePut",
            json!({"accountId":"synthetic@example.org","id":id,"resource":message}),
        );
        let result = call("reader.open", open);
        assert_eq!(result["nativeContent"]["body"]["text"], GREETING);
        let cached = call(
            "cache.resourceRead",
            json!({"accountId":"synthetic@example.org","id":id}),
        );
        assert_eq!(
            cached, message,
            "reading must not transcode persisted resource bytes"
        );
    }
    assert_eq!(
        fs::read_to_string(&registry).unwrap(),
        r#"{"version":1,"activeId":"synthetic@example.org","accounts":[{"email":"synthetic@example.org"}]}"#
    );
}

#[test]
fn decoded_legacy_html_still_passes_through_the_resource_gate() {
    for (charset, bytes) in [("windows-1251", CP1251), ("gb2312", GB2312)] {
        let mut html = b"<p>".to_vec();
        html.extend_from_slice(bytes);
        html.extend_from_slice(b"</p><script>alert(1)</script><img src=\"http://127.0.0.1/private\"><img src=\"https://example.org/pixel.png\"><table background=\"file:///etc/passwd\"><tr><td>safe</td></tr></table>");
        let (_, prepared) = prepare(format!("Content-Type: text/html; charset={charset}\r\nContent-Transfer-Encoding: base64\r\n\r\n{}", STANDARD.encode(&html)).as_bytes());
        assert!(prepared["html"].as_str().unwrap().contains(GREETING));
        let rendered = call(
            "message.render",
            &json!({"html": prepared["html"], "options": {"allowRemoteImages": false, "withReader": true}}),
        );
        for field in ["document", "reader"] {
            let result = rendered[field].to_string();
            for forbidden in ["127.0.0.1", "file:///", "pixel.png", "alert(1)", "<script"] {
                assert!(
                    !result.contains(forbidden),
                    "{charset}: {field}: {forbidden}"
                );
            }
        }
    }
}
