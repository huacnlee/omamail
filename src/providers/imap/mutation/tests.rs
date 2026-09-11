use super::*;
#[test]
fn native_envelope_preserves_groups_cc_and_bcc_recipients() {
    let (from,to)=envelope(b"From: Writer <from@example.org>\r\nTo: Group: a@example.org,b@example.org;\r\nCc: a@example.org\r\nBcc: secret@example.org\r\n\r\nHello","fallback@example.org").unwrap();
    assert_eq!(from, "from@example.org");
    assert_eq!(to, ["a@example.org", "b@example.org", "secret@example.org"]);
}
#[test]
fn folder_encoding_rejects_controls_and_uses_modified_utf7() {
    assert_eq!(encoded_mailbox("日本語").unwrap(), "&ZeVnLIqe-");
    assert_eq!(encoded_mailbox("R&D").unwrap(), "R&-D");
    for value in ["x\r", "x\n", "x\0", "x\t", ""] {
        assert!(encoded_mailbox(value).is_err());
    }
}
#[test]
fn bcc_is_in_envelope_but_absent_from_submitted_headers() {
    let raw=b"From: from@example.org\r\nTo: to@example.org\r\nbCc: secret@example.org,\r\n second@example.org\r\nSubject: visible\r\n\r\nBcc: body text stays\r\n";
    let (_, recipients) = envelope(raw, "fallback@example.org").unwrap();
    assert!(recipients.contains(&"secret@example.org".into()));
    assert!(recipients.contains(&"second@example.org".into()));
    let transmitted = String::from_utf8(without_bcc(raw)).unwrap();
    assert!(!transmitted.contains("secret@example.org"));
    assert!(!transmitted.contains("second@example.org"));
    assert!(transmitted.contains("Bcc: body text stays"));
}
async fn initialize(w: &mut Wire) {
    write(w, b"* OK ready\r\n").await.unwrap();
    assert!(line(w).await.unwrap().starts_with(b"O1 LOGIN"));
    write(w, b"O1 OK login\r\n").await.unwrap();
    for _ in 0..2 {
        assert_eq!(line(w).await.unwrap(), b"O1 CAPABILITY\r\n");
        write(w, b"* CAPABILITY IMAP4rev1\r\nO1 OK capabilities\r\n")
            .await
            .unwrap();
    }
    assert_eq!(line(w).await.unwrap(), b"O1 LIST \"\" \"*\"\r\n");
    write(w,b"* LIST () \"/\" INBOX\r\n* LIST (\\Archive) \"/\" Archive\r\n* LIST (\\Drafts) \"/\" Drafts\r\nO1 OK folders\r\n").await.unwrap();
}
fn params(port: u16) -> Value {
    json!({"settings":{"imapHost":"127.0.0.1","imapPort":port,"username":"synthetic","insecure":true},"credential":"synthetic:secret","oauth":false})
}
#[tokio::test]
async fn archive_without_move_sets_flags_then_copy_then_uid_expunge() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut w: Wire = BufReader::new(Box::new(socket));
        initialize(&mut w).await;
        for wanted in [
            "O1 SELECT \"INBOX\"\r\n",
            "O1 UID STORE 7 +FLAGS.SILENT (\\Seen)\r\n",
            "O1 UID COPY 7 \"Archive\"\r\n",
            "O1 UID STORE 7 +FLAGS.SILENT (\\Deleted)\r\n",
            "O1 UID EXPUNGE 7\r\n",
        ] {
            assert_eq!(line(&mut w).await.unwrap(), wanted.as_bytes());
            write(&mut w, b"O1 OK done\r\n").await.unwrap();
        }
    });
    let mut p = params(port);
    p["ids"] = json!(["7:INBOX"]);
    p["addLabelIds"] = json!([]);
    p["removeLabelIds"] = json!(["INBOX", "UNREAD"]);
    super::super::call("imap.modify", &p).await.unwrap();
    peer.await.unwrap();
}
#[tokio::test]
async fn malformed_later_mutation_id_opens_no_socket() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut p = params(port);
    p["ids"] = json!(["7:INBOX", "8:INBOX\r\nEXPUNGE"]);
    p["addLabelIds"] = json!([]);
    p["removeLabelIds"] = json!(["INBOX"]);
    assert_eq!(
        super::super::call("imap.modify", &p).await,
        Err("invalid_params")
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn saved_draft_cleanup_failure_still_returns_saved() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let raw = b"Subject: draft\r\n\r\nbody";
    let peer = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut w: Wire = BufReader::new(Box::new(socket));
        initialize(&mut w).await;
        assert_eq!(
            line(&mut w).await.unwrap(),
            format!("O1 APPEND \"Drafts\" (\\Draft) {{{}}}\r\n", raw.len()).as_bytes()
        );
        write(&mut w, b"+ send data\r\n").await.unwrap();
        let mut bytes = vec![0; raw.len() + 2];
        w.read_exact(&mut bytes).await.unwrap();
        assert_eq!(&bytes[..raw.len()], raw);
        write(&mut w, b"O1 OK appended\r\n").await.unwrap();
        assert_eq!(line(&mut w).await.unwrap(), b"O1 SELECT \"Drafts\"\r\n");
        write(&mut w, b"O1 NO cannot select\r\n").await.unwrap();
    });
    let mut p = params(port);
    p["raw"] = json!(URL_SAFE_NO_PAD.encode(raw));
    p["draftId"] = json!("7:Drafts");
    let result = super::super::call("imap.saveDraft", &p).await.unwrap();
    assert_eq!(result["saved"], true);
    assert!(result["warning"].as_str().unwrap().contains("old copy"));
    peer.await.unwrap();
}
#[tokio::test]
async fn invalid_draft_replacement_id_is_refused_before_append() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    for id in [
        "bad",
        "0:Drafts",
        "7:Drafts\r",
        "7:Drafts\n",
        "7:Drafts\r\n",
        "7:Drafts\0",
    ] {
        let mut p = params(port);
        p["raw"] = json!(URL_SAFE_NO_PAD.encode(b"Subject: draft\r\n\r\nbody"));
        p["draftId"] = json!(id);
        assert_eq!(
            super::super::call("imap.saveDraft", &p).await,
            Err("invalid_params")
        );
    }
    for wrong_type in [
        json!(123),
        json!({"id":"7:Drafts"}),
        json!(["7:Drafts"]),
        Value::Null,
        json!(false),
    ] {
        let mut p = params(port);
        p["raw"] = json!(URL_SAFE_NO_PAD.encode(b"Subject: draft\r\n\r\nbody"));
        p["draftId"] = wrong_type;
        assert_eq!(
            super::super::call("imap.saveDraft", &p).await,
            Err("invalid_params")
        );
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}
