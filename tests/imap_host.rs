use base64::{Engine as _, engine::general_purpose::STANDARD};
use omamail::{
    imap_host::{Action, ImapAccount, MailOperation, plan},
    platform::secrets::Secret,
};
use std::{
    fs,
    io::Write as _,
    process::{Command, Stdio},
};

fn account() -> ImapAccount {
    ImapAccount::new(
        "imap:me@example.com",
        "me@example.com",
        "imaps://mail.example.com/",
        "smtps://mail.example.com/",
        "me@example.com",
        Secret::new("top-secret"),
    )
    .unwrap()
}

fn fields(request: &Secret) -> Vec<Vec<u8>> {
    request
        .expose()
        .trim_end_matches('\n')
        .split(' ')
        .skip(1)
        .map(|field| STANDARD.decode(field).unwrap())
        .collect()
}

#[test]
fn list_uses_peek_and_keeps_credentials_only_in_protected_stdin() {
    let account = account();
    let planned = plan(&account, MailOperation::List { folder: "INBOX" }).unwrap();
    let decoded = fields(planned.stdin());

    assert_eq!(planned.argv(), &[] as &[String]);
    assert_eq!(decoded[0], b"imaps://mail.example.com/INBOX");
    assert_eq!(decoded[1], b"me@example.com:top-secret");
    assert!(String::from_utf8_lossy(&decoded[2]).contains("BODY.PEEK"));
    assert!(!format!("{account:?} {planned:?}").contains("top-secret"));
}

#[test]
fn detail_requires_uid_and_folder_and_never_uses_body_without_peek() {
    let planned = plan(
        &account(),
        MailOperation::Detail {
            message_id: "42:Archive/2026",
        },
    )
    .unwrap();
    let commands: Vec<String> = fields(planned.stdin())
        .into_iter()
        .skip(2)
        .map(|x| String::from_utf8(x).unwrap())
        .collect();
    assert!(
        commands
            .iter()
            .any(|x| x.contains("UID FETCH 42") && x.contains("BODY.PEEK[]"))
    );

    for invalid in ["42", "x:INBOX", "0:INBOX", "42:", "42:INBOX\r\nUID EXPUNGE"] {
        assert!(
            plan(
                &account(),
                MailOperation::Detail {
                    message_id: invalid
                }
            )
            .is_err(),
            "accepted {invalid:?}"
        );
    }
}

#[test]
fn delete_is_uid_scoped_and_folder_names_are_supplied_not_guessed() {
    let planned = plan(
        &account(),
        MailOperation::Action {
            message_id: "7:Receipts",
            action: Action::Delete,
        },
    )
    .unwrap();
    let commands: Vec<String> = fields(planned.stdin())
        .into_iter()
        .skip(2)
        .map(|x| String::from_utf8(x).unwrap())
        .collect();
    assert!(
        commands
            .iter()
            .any(|x| x == "UID STORE 7 +FLAGS.SILENT (\\Deleted)")
    );
    assert!(commands.iter().any(|x| x == "UID EXPUNGE 7"));
    assert!(!commands.iter().any(|x| x == "EXPUNGE"));

    let moved = plan(
        &account(),
        MailOperation::Action {
            message_id: "8:INBOX",
            action: Action::Move {
                destination: "Filed",
            },
        },
    )
    .unwrap();
    let text = String::from_utf8_lossy(moved.stdin().expose().as_bytes());
    assert!(!text.contains("Trash"));
}

#[test]
fn copy_store_fallback_is_uid_scoped_and_expunges_only_the_requested_uid() {
    let account = account();
    let planned = plan(
        &account,
        MailOperation::Action {
            message_id: "42:INBOX",
            action: Action::CopyStoreUidExpunge {
                destination: "Server Archive",
            },
        },
    )
    .unwrap();
    let commands: Vec<String> = fields(planned.stdin())
        .into_iter()
        .skip(2)
        .map(|value| String::from_utf8(value).unwrap())
        .collect();
    assert_eq!(
        commands,
        [
            "UID COPY 42 \"Server Archive\"",
            "UID STORE 42 +FLAGS.SILENT (\\Deleted)",
            "UID EXPUNGE 42",
        ]
    );
    assert!(!commands.iter().any(|command| command == "EXPUNGE"));
}

#[test]
fn batch_action_uses_one_uid_set_and_refuses_mixed_folders() {
    let account = account();
    let planned = plan(
        &account,
        MailOperation::BatchAction {
            message_ids: vec!["41:INBOX", "42:INBOX"],
            action: Action::MarkSeen,
        },
    )
    .unwrap();
    let commands: Vec<String> = fields(planned.stdin())
        .into_iter()
        .skip(2)
        .map(|value| String::from_utf8(value).unwrap())
        .collect();
    assert_eq!(commands, ["UID STORE 41,42 +FLAGS.SILENT (\\Seen)"]);
    assert!(
        plan(
            &account,
            MailOperation::BatchAction {
                message_ids: vec!["41:INBOX", "42:Archive"],
                action: Action::MarkSeen,
            },
        )
        .is_err()
    );
}

#[test]
fn smtp_builds_crlf_message_and_refuses_header_injection() {
    let planned = plan(
        &account(),
        MailOperation::Send {
            from: "Me <me@example.com>",
            recipients: vec!["you@example.net"],
            subject: "Hello",
            body: "First\nSecond",
        },
    )
    .unwrap();
    assert_eq!(planned.mode(), "smtp");
    let decoded = fields(planned.stdin());
    assert_eq!(decoded[2], b"me@example.com");
    let message = String::from_utf8(decoded[3].clone()).unwrap();
    assert!(message.contains("From: Me <me@example.com>\r\n"));
    assert!(message.contains("Subject: Hello\r\n"));
    assert!(message.ends_with("\r\n\r\nFirst\r\nSecond\r\n"));

    for subject in ["ok\r\nBcc: stolen@example.net", "bad\nCc: x@y.test"] {
        assert!(
            plan(
                &account(),
                MailOperation::Send {
                    from: "me@example.com",
                    recipients: vec!["you@example.net"],
                    subject,
                    body: "body",
                }
            )
            .is_err()
        );
    }
}

#[test]
fn smtp_threading_headers_are_explicit_and_forward_can_omit_them() {
    let planned = plan(
        &account(),
        MailOperation::SendThreaded {
            from: "me@example.com",
            to: vec!["you@example.net"],
            cc: vec!["copy@example.net"],
            bcc: vec![],
            subject: "Re: Hello",
            body: "reply",
            in_reply_to: Some("<message@example.net>"),
            references: Some("<root@example.net> <message@example.net>"),
        },
    )
    .unwrap();
    let message = String::from_utf8(fields(planned.stdin())[3].clone()).unwrap();
    assert!(message.contains("To: you@example.net\r\nCc: copy@example.net\r\n"));
    assert!(message.contains("In-Reply-To: <message@example.net>\r\nReferences: <root@example.net> <message@example.net>\r\n"));

    let forward = plan(
        &account(),
        MailOperation::SendThreaded {
            from: "me@example.com",
            to: vec!["next@example.net"],
            cc: vec![],
            bcc: vec![],
            subject: "Fwd: Hello",
            body: "forward",
            in_reply_to: None,
            references: None,
        },
    )
    .unwrap();
    let message = String::from_utf8(fields(forward.stdin())[3].clone()).unwrap();
    assert!(!message.contains("In-Reply-To:"));
    assert!(!message.contains("References:"));
}

#[test]
fn smtp_from_is_structurally_bound_to_the_account() {
    for from in [
        "attacker@example.net",
        "Me <attacker@example.net>",
        "me@example.com, attacker@example.net",
        "Me <me@example.com> trailing",
        "<me@example.com><attacker@example.net>",
    ] {
        assert!(
            plan(
                &account(),
                MailOperation::Send {
                    from,
                    recipients: vec!["you@example.net"],
                    subject: "Hello",
                    body: "body",
                }
            )
            .is_err(),
            "accepted spoofed From {from:?}"
        );
    }
}

#[test]
fn planner_caps_folders_recipients_headers_and_bodies() {
    let huge_folder = "x".repeat(4097);
    assert!(
        plan(
            &account(),
            MailOperation::List {
                folder: &huge_folder
            }
        )
        .is_err()
    );

    let recipients = vec!["you@example.net"; 101];
    assert!(
        plan(
            &account(),
            MailOperation::Send {
                from: "me@example.com",
                recipients,
                subject: "ok",
                body: "body"
            }
        )
        .is_err()
    );

    let huge_recipient = format!("{}@example.net", "x".repeat(321));
    let huge_subject = "x".repeat(16 * 1024 + 1);
    let huge_body = "x".repeat(1024 * 1024 + 1);
    for operation in [
        MailOperation::Send {
            from: "me@example.com",
            recipients: vec![&huge_recipient],
            subject: "ok",
            body: "body",
        },
        MailOperation::Send {
            from: "me@example.com",
            recipients: vec!["you@example.net"],
            subject: &huge_subject,
            body: "body",
        },
        MailOperation::Send {
            from: "me@example.com",
            recipients: vec!["you@example.net"],
            subject: "ok",
            body: &huge_body,
        },
    ] {
        assert!(plan(&account(), operation).is_err());
    }
}

#[cfg(unix)]
#[test]
fn planned_stdin_obeys_the_real_mail_transport_framing_contract() {
    use std::os::unix::fs::PermissionsExt as _;

    let temporary = tempfile::tempdir().unwrap();
    let fake_curl = temporary.path().join("curl");
    let capture = temporary.path().join("capture");
    fs::write(
        &fake_curl,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CAPTURE.args\"\ncat > \"$CAPTURE.config\"\nprintf accepted\n",
    )
    .unwrap();
    fs::set_permissions(&fake_curl, fs::Permissions::from_mode(0o700)).unwrap();

    let planned = plan(
        &account(),
        MailOperation::Send {
            from: "Me <me@example.com>",
            recipients: vec!["one@example.net", "two@example.net"],
            subject: "Contract",
            body: "payload",
        },
    )
    .unwrap();
    let original_path = std::env::var("PATH").unwrap_or_default();
    let mut child = Command::new("scripts/mail-transport.sh")
        .env(
            "PATH",
            format!("{}:{original_path}", temporary.path().display()),
        )
        .env("CAPTURE", &capture)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(planned.stdin().expose().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let args = fs::read_to_string(format!("{}.args", capture.display())).unwrap();
    let config = fs::read_to_string(format!("{}.config", capture.display())).unwrap();
    assert!(!args.contains("top-secret"));
    assert!(!format!("{planned:?}").contains("top-secret"));
    assert!(config.contains("user = \"me@example.com:top-secret\""));
    assert!(config.contains("mail-from = \"me@example.com\""));
    assert_eq!(config.matches("mail-rcpt =").count(), 2);
    assert!(config.find("mail-from =").unwrap() < config.find("mail-rcpt =").unwrap());
    assert!(config.contains("upload-file ="));
}

#[test]
fn account_identity_and_transport_urls_are_closed_and_validated() {
    assert!(
        ImapAccount::new(
            "me@example.com",
            "me@example.com",
            "imaps://mail.example.com/",
            "smtp://mail.example.com/",
            "me@example.com",
            Secret::new("x")
        )
        .is_err()
    );
    assert!(
        ImapAccount::new(
            "imap:me@example.com",
            "other@example.com",
            "https://mail.example.com/",
            "smtp://mail.example.com/",
            "me@example.com",
            Secret::new("x")
        )
        .is_err()
    );
}
