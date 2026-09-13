use super::*;
use serde_json::{Value, json};

fn request() -> SendRequest {
    SendRequest {
        account: Account {
            id: "a@example.org".into(),
            provider: Provider::Gmail,
        },
        from: String::new(),
        to: vec!["one@example.org".into()],
        cc: vec![],
        bcc: vec![],
        subject: "Plan".into(),
        body: "Line one\nLine two\n".into(),
        attachments: vec![],
        execute: false,
        send_id: None,
    }
}

fn identities() -> Value {
    json!([
        {"email":"a@example.org","displayName":"Primary","isPrimary":true},
        {"email":"alias@example.org","displayName":"Alias","isDefault":true}
    ])
}

#[test]
fn preview_normalizes_repeated_recipients_and_default_identity_without_files() {
    let mut request = request();
    request.to = vec![
        " one@example.org, two@example.org ".into(),
        "ONE@example.org".into(),
    ];
    request.cc = vec!["two@example.org".into(), "three@example.org".into()];
    let prepared = send::prepare(&request, &identities()).unwrap();
    assert_eq!(
        prepared.preview(),
        json!({
            "dryRun":true,"executed":false,"accountId":"a@example.org",
            "from":"Alias <alias@example.org>","to":["one@example.org","two@example.org"],
            "cc":["three@example.org"],"bcc":[],"subject":"Plan","body":"Line one\nLine two\n",
            "attachments":[]
        })
    );
}

#[test]
fn invalid_headers_recipients_and_unapproved_sender_are_rejected() {
    for invalid in [
        "bad",
        "a@@example.org",
        "x@example.org\rBcc: victim@example.org",
        "x@example.org\n",
        "x@example.org\0",
        "x@example.org\r\n",
        "group: x@example.org;",
    ] {
        let mut request = request();
        request.to = vec![invalid.into()];
        assert!(
            send::prepare(&request, &identities()).is_err(),
            "{invalid:?}"
        );
    }
    for invalid in ["\r", "\n", "\r\n", "\0"] {
        let mut request = request();
        request.subject.push_str(invalid);
        assert!(send::prepare(&request, &identities()).is_err());
        request.subject = "Plan".into();
        request.from = format!("alias@example.org{invalid}");
        assert!(send::prepare(&request, &identities()).is_err());
    }
    let mut request = request();
    request.to.clear();
    assert!(send::prepare(&request, &identities()).is_err());
    request.bcc = vec!["private@example.org".into()];
    assert!(send::prepare(&request, &identities()).is_ok());
    request.from = "unapproved@example.org".into();
    assert!(send::prepare(&request, &identities()).is_err());
}

#[test]
fn encoded_header_words_cannot_change_the_previewed_envelope() {
    let mut request = request();
    request.to = vec!["=?UTF-8?B?eCIgPHZpY3RpbUBleGFtcGxlLm9yZz4sICJ5?= <one@example.org>".into()];
    assert!(send::prepare(&request, &identities()).is_err());
    request.to = vec!["one@example.org".into()];
    request.subject = "=?UTF-8?B?DQpCY2M6IHZpY3RpbUBleGFtcGxlLm9yZw==?=".into();
    assert!(send::prepare(&request, &identities()).is_err());
}

#[test]
fn attachment_bytes_are_pinned_and_preview_never_changes_the_fixture() {
    if tests::isolated() {
        return;
    }
    let fixture = tests::account_fixture(
        json!({"version":1,"activeId":"a@example.org","accounts":[{"email":"a@example.org"}]}),
    );
    let path = fixture.root.join("brief.txt");
    std::fs::write(&path, "hello").unwrap();
    let mut request = request();
    request.attachments.push(AttachmentInput {
        path: path.clone(),
        name: "brief.txt".into(),
        size: 5,
    });
    let before = tests::fixture_tree(&fixture.root);
    let prepared = send::prepare(&request, &identities()).unwrap();
    assert_eq!(
        prepared.preview()["attachments"],
        json!([{"name":"brief.txt","size":5}])
    );
    let payload = prepared.payload(1_000, "test").unwrap();
    assert_eq!(tests::fixture_tree(&fixture.root), before);
    std::fs::rename(&path, fixture.root.join("original")).unwrap();
    std::fs::write(&path, "replacement secret").unwrap();
    assert_eq!(prepared.payload(1_000, "test").unwrap(), payload);
    use base64::Engine;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload["raw"].as_str().unwrap())
        .unwrap();
    let parsed = mailparse::parse_mail(&bytes).unwrap();
    assert_eq!(parsed.subparts[1].get_body_raw().unwrap(), b"hello");
    assert!(payload.get("attachments").is_none());
}

#[test]
fn attachment_paths_types_metadata_counts_and_sizes_are_validated_before_read() {
    if tests::isolated() {
        return;
    }
    let fixture = tests::account_fixture(
        json!({"version":1,"activeId":"a@example.org","accounts":[{"email":"a@example.org"}]}),
    );
    let path = fixture.root.join("file");
    std::fs::write(&path, "hello").unwrap();
    let link = fixture.root.join("link");
    std::os::unix::fs::symlink(&path, &link).unwrap();
    let ancestor = fixture.root.join("ancestor");
    std::os::unix::fs::symlink(&fixture.root, &ancestor).unwrap();
    let fifo = fixture.root.join("fifo");
    let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let mut request = request();
    for invalid in [
        std::path::PathBuf::from("relative"),
        link,
        ancestor.join("file"),
        fifo,
        fixture.root.clone(),
        fixture.root.join("../outside"),
        fixture.root.join("file\n"),
    ] {
        request.attachments = vec![AttachmentInput {
            path: invalid,
            name: "file".into(),
            size: 5,
        }];
        assert!(send::prepare(&request, &identities()).is_err());
    }
    for (name, size) in [("../file", 5), ("file\0", 5), ("file\n", 5), ("file", 6)] {
        request.attachments = vec![AttachmentInput {
            path: path.clone(),
            name: name.into(),
            size,
        }];
        assert!(send::prepare(&request, &identities()).is_err());
    }
    request.attachments = (0..33)
        .map(|_| AttachmentInput {
            path: path.clone(),
            name: "file".into(),
            size: 5,
        })
        .collect();
    assert!(send::prepare(&request, &identities()).is_err());
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(20 * 1024 * 1024 + 1)
        .unwrap();
    request.attachments = vec![AttachmentInput {
        path: path.clone(),
        name: "file".into(),
        size: 20 * 1024 * 1024 + 1,
    }];
    assert!(send::prepare(&request, &identities()).is_err());
    std::fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_len(11 * 1024 * 1024)
        .unwrap();
    request.attachments = (0..2)
        .map(|_| AttachmentInput {
            path: path.clone(),
            name: "file".into(),
            size: 11 * 1024 * 1024,
        })
        .collect();
    assert!(send::prepare(&request, &identities()).is_err());
}

#[test]
fn unicode_names_quotes_backslashes_and_rtl_body_survive_composition() {
    let mut request = request();
    request.from = "alias@example.org".into();
    request.to = vec!["\"Lee, \\\"J\\\" \\\\ 工\" <one@example.org>".into()];
    request.subject = "خطة \\\"".into();
    request.body = "مرحبا\nSecond line\n".into();
    let prepared = send::prepare(&request, &identities()).unwrap();
    use base64::Engine;
    let payload = prepared.payload(1_000, "test").unwrap();
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload["raw"].as_str().unwrap())
        .unwrap();
    let parsed = mailparse::parse_mail(&bytes).unwrap();
    assert_eq!(parsed.ctype.mimetype, "multipart/alternative");
    assert_eq!(parsed.subparts[0].get_body().unwrap(), request.body);
    assert!(
        parsed.subparts[1]
            .get_body()
            .unwrap()
            .contains("dir=\"rtl\"")
    );
}

#[test]
fn body_and_combined_wire_limits_are_enforced() {
    let mut request = request();
    request.body = "\0".into();
    assert!(send::prepare(&request, &identities()).is_err());
    request.body = "x".repeat(16 * 1024 * 1024 + 1);
    assert!(send::prepare(&request, &identities()).is_err());
}

#[test]
fn combined_mime_limit_is_checked_even_when_body_and_attachments_each_fit() {
    if tests::isolated() {
        return;
    }
    let fixture = tests::account_fixture(
        json!({"version":1,"activeId":"a@example.org","accounts":[{"email":"a@example.org"}]}),
    );
    let path = fixture.root.join("large.bin");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(10 * 1024 * 1024)
        .unwrap();
    let mut request = request();
    request.body = "x".repeat(16 * 1024 * 1024);
    request.attachments = vec![AttachmentInput {
        path,
        name: "large.bin".into(),
        size: 10 * 1024 * 1024,
    }];
    let prepared = send::prepare(&request, &identities()).unwrap();
    assert_eq!(prepared.payload(0, "preview"), Err("message_too_large"));
}

#[tokio::test]
async fn public_rpc_preview_uses_configured_imap_identity_without_writes() {
    if tests::isolated() {
        return;
    }
    let fixture = tests::account_fixture(
        json!({"version":1,"activeId":"imap:a@example.org","accounts":[{"provider":"imap","email":"a@example.org","imap":{"username":"a@example.org","aliases":[{"email":"alias@example.org","displayName":"Alias","isDefault":true}]}}]}),
    );
    let before = tests::fixture_tree(&fixture.root);
    let session = crate::backend::Session::default();
    let result = session.dispatch("mail.send", &json!({"to":["one@example.org"],"subject":"Plan","body":"Line one\nLine two\n","sendId":"explicit"})).await.unwrap();
    assert_eq!(result["from"], "Alias <alias@example.org>");
    assert_eq!(result["accountId"], "imap:a@example.org");
    assert_eq!(result["dryRun"], true);
    assert_eq!(tests::fixture_tree(&fixture.root), before);
    for id in [json!(""), json!("trailing\n"), json!(42)] {
        assert!(
            session
                .dispatch("mail.send", &json!({"to":["one@example.org"],"sendId":id}))
                .await
                .is_err()
        );
    }
    assert_eq!(tests::fixture_tree(&fixture.root), before);
}

#[tokio::test]
async fn hey_delivery_uses_the_validated_bytes_and_keeps_the_body_off_argv() {
    if tests::isolated() {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let fixture = tests::account_fixture(
        json!({"version":1,"activeId":"hey:a@example.org","accounts":[{"provider":"hey","email":"a@example.org"}]}),
    );
    let program = fixture.root.join("hey");
    std::fs::write(&program, r#"#!/usr/bin/python3
import json, os, sys
if sys.argv[1:] == ['accounts', 'list', '--json']:
    print(json.dumps({'ok': True, 'data': [{'id':'one','email':'a@example.org'}]}))
elif sys.argv[1] == 'compose':
    files = [sys.argv[i+1] for i, value in enumerate(sys.argv) if value == '--attach']
    report = {'argv':sys.argv[1:], 'body':sys.stdin.read(), 'files': [open(p).read() for p in files], 'paths':files}
    with open(os.environ['OMAMAIL_SEND_TEST_REPORT'], 'w') as f: json.dump(report,f)
    print(json.dumps({'ok':True}))
else:
    sys.exit(9)
"#).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let report = fixture.root.join("report.json");
    unsafe {
        std::env::set_var("PATH", &fixture.root);
        std::env::set_var("OMAMAIL_SEND_TEST_REPORT", &report);
    }
    let path = fixture.root.join("original.txt");
    std::fs::write(&path, "validated attachment").unwrap();
    let mut request = request();
    request.account = Account {
        id: "hey:a@example.org".into(),
        provider: Provider::Hey,
    };
    request.body = "private body\nمتن\n".into();
    request.attachments = vec![AttachmentInput {
        path: path.clone(),
        name: "original.txt".into(),
        size: 20,
    }];
    let prepared = send::prepare(&request, &json!([{"email":"a@example.org"}])).unwrap();
    let payload = prepared.payload(1_000, "delivery").unwrap();
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, "REPLACEMENT SECRET").unwrap();
    let result = crate::outbox::delivery::send(
        &json!({"accountId":"hey:a@example.org","provider":"hey","payload":payload}),
        &Default::default(),
        &Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(result, json!({"ok":true}));
    let recorded: Value = serde_json::from_slice(&std::fs::read(&report).unwrap()).unwrap();
    assert_eq!(recorded["body"], request.body);
    assert_eq!(recorded["files"], json!(["validated attachment"]));
    assert!(!recorded["argv"].to_string().contains("private body"));
    assert!(!recorded.to_string().contains("REPLACEMENT SECRET"));
    for path in recorded["paths"].as_array().unwrap() {
        assert!(!std::path::Path::new(path.as_str().unwrap()).exists());
    }
}
