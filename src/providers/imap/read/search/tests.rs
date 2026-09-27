use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct Counts {
    searches: AtomicUsize,
    fetches: AtomicUsize,
    selects: AtomicUsize,
    active: AtomicUsize,
    peak: AtomicUsize,
}

async fn peer(socket: TcpStream, counts: Arc<Counts>) {
    let mut wire: Wire = BufReader::new(Box::new(socket));
    write(&mut wire, b"* OK synthetic server\r\n")
        .await
        .unwrap();
    let mut folder = String::new();
    while let Ok(bytes) = line(&mut wire).await {
        let cmd = String::from_utf8(bytes).unwrap();
        let mut data = String::new();
        let mut delay = false;
        if cmd.starts_with("O1 LOGIN ") {
        } else if cmd == "O1 CAPABILITY\r\n" {
            data.push_str("* CAPABILITY IMAP4rev1\r\n");
        } else if cmd == "O1 LIST \"\" \"*\"\r\n" {
            for index in 0..120 {
                data.push_str(&format!("* LIST () \"/\" f{index:03}\r\n"));
            }
            data.push_str("* LIST (\\Trash) \"/\" Bin\r\n* LIST (\\Junk) \"/\" Spam\r\n* LIST (\\Noselect) \"/\" Root\r\n");
        } else if let Some(name) = cmd.strip_prefix("O1 SELECT ") {
            folder = name.trim().trim_matches('"').to_owned();
            assert!(!["Bin", "Spam", "Root"].contains(&folder.as_str()));
            counts.selects.fetch_add(1, Ordering::SeqCst);
            data.push_str("* OK [UIDVALIDITY 1] stable\r\n");
            delay = true;
        } else if cmd == "O1 UID SEARCH UNDELETED ALL\r\n" {
            counts.searches.fetch_add(1, Ordering::SeqCst);
            data.push_str("* SEARCH");
            if folder == "f118" || folder == "f119" {
                for uid in 1..=5000 {
                    data.push_str(&format!(" {uid}"));
                }
            }
            data.push_str("\r\n");
            delay = true;
        } else if let Some(rest) = cmd.strip_prefix("O1 UID FETCH ") {
            counts.fetches.fetch_add(1, Ordering::SeqCst);
            assert!(rest.ends_with(" (UID INTERNALDATE)\r\n"));
            for uid in rest.split_once(' ').unwrap().0.split(',') {
                let day = if uid == "1" { 28 } else { 20 };
                data.push_str(&format!(
                    "* 1 FETCH (UID {uid} INTERNALDATE \"{day}-Sep-2026 12:00:00 +0000\")\r\n"
                ));
            }
            delay = true;
        } else {
            panic!("unexpected command: {cmd}");
        }
        if delay {
            let active = counts.active.fetch_add(1, Ordering::SeqCst) + 1;
            counts.peak.fetch_max(active, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(10)).await;
            counts.active.fetch_sub(1, Ordering::SeqCst);
        }
        data.push_str("O1 OK done\r\n");
        if write(&mut wire, data.as_bytes()).await.is_err() {
            break;
        }
    }
}

#[tokio::test]
async fn large_account_scan_is_parallel_bounded_and_pages_reuse_snapshot() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let counts = Arc::new(Counts::default());
    let counter = counts.clone();
    let server = tokio::spawn(async move {
        let mut peers = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                connection = listener.accept() => {
                    let (socket, _) = connection.unwrap();
                    peers.spawn(peer(socket, counter.clone()));
                }
                result = peers.join_next(), if !peers.is_empty() => { result.unwrap().unwrap(); }
            }
        }
    });
    let mut p = json!({"settings":{"imapHost":"127.0.0.1","imapPort":port,
        "username":"synthetic","insecure":true,"testPlaintext":true},
        "credential":"synthetic:secret","query":"search:ALL","limit":2,"requestToken":"large-account"});
    let mut rounds = 0;
    let first = loop {
        let before = counts.selects.load(Ordering::SeqCst);
        let result = super::super::super::call(
            if rounds == 0 {
                "imap.list"
            } else {
                "imap.listContinue"
            },
            &p,
        )
        .await
        .unwrap();
        assert!(counts.selects.load(Ordering::SeqCst) - before <= WORKERS);
        rounds += 1;
        assert!(rounds < 100);
        if result["continuation"].is_null() {
            break result;
        }
        assert_eq!(
            result["page"]["ids"],
            json!([]),
            "no incomplete newest prefix is exposed"
        );
        p["continuation"] = result["continuation"].clone();
    };
    assert!(rounds > 1);
    assert_eq!(first["page"]["estimate"], 10000);
    assert_eq!(first["page"]["ids"], json!(["1:f118", "1:f119"]));
    assert_eq!(counts.searches.load(Ordering::SeqCst), 120);
    assert_eq!(counts.fetches.load(Ordering::SeqCst), 4);
    assert!(counts.peak.load(Ordering::SeqCst) > 1);
    assert!(counts.peak.load(Ordering::SeqCst) <= WORKERS);
    p.as_object_mut().unwrap().remove("continuation");
    p["pageToken"] = first["page"]["nextPageToken"].clone();
    let before = counts.selects.load(Ordering::SeqCst);
    let second = call(&p).await.unwrap();
    assert_eq!(second["page"]["ids"], json!(["5000:f118", "4999:f118"]));
    assert_eq!(counts.selects.load(Ordering::SeqCst), before);
    p["query"] = json!("search:SUBJECT invoice");
    assert_eq!(call(&p).await, Err("imap_search_expired"));
    p["query"] = json!("search:ALL");
    p["credential"] = json!("synthetic:other-account-secret");
    assert_eq!(call(&p).await, Err("imap_search_expired"));
    assert_eq!(counts.selects.load(Ordering::SeqCst), before);
    server.abort();
}

fn metadata(uid: u32, day: u8, body: &str) -> Vec<u8> {
    format!("* 1 FETCH (UID {uid} INTERNALDATE \"{day:02}-Sep-2026 12:00:00 +0000\" BODY[] {{{}}}\r\n{body})\r\n", body.len()).into_bytes()
}

#[test]
fn aggregate_only_mail_survives_and_reused_message_ids_do_not_hide_distinct_mail() {
    let boxes = parse_folders(b"* LIST () \"/\" INBOX\r\n* LIST (\\Archive) \"/\" Archive\r\n* LIST (\\All) \"/\" Everything\r\n* LIST (\\Trash) \"/\" Bin\r\n* LIST (\\Junk) \"/\" Junkmail\r\n").unwrap();
    let mut scan = plan(&boxes, &json!({}), "ALL".into()).unwrap();
    let bodies = [
        (
            0,
            7,
            23,
            "Message-ID: <same@example.org>\r\n\r\nInbox content",
        ),
        (
            1,
            7,
            24,
            "Message-ID: <same@example.org>\r\n\r\nDifferent archive content",
        ),
        (
            2,
            1,
            25,
            "Subject: aggregate only\r\n\r\nArchived without a label",
        ),
        (
            2,
            2,
            23,
            "Message-ID: <same@example.org>\r\n\r\nInbox content",
        ),
        (2, 3, 26, "Subject: trash\r\n\r\nDeleted content"),
        (3, 7, 26, "Subject: trash\r\n\r\nDeleted content"),
        (2, 4, 27, "Subject: spam\r\n\r\nJunk content"),
        (4, 7, 27, "Subject: spam\r\n\r\nJunk content"),
    ];
    for (folder, uid, day, body) in bodies {
        scan.folders[folder]
            .messages
            .extend(fetched(&metadata(uid, day, body), &[uid], Identity::Content).unwrap());
    }
    scan.finish();
    let first = scan.page(0, 2).unwrap();
    assert_eq!(first["page"]["ids"], json!(["1:Everything", "7:Archive"]));
    assert_eq!(first["page"]["estimate"], 3);
    assert_eq!(scan.page(2, 2).unwrap()["page"]["ids"], json!(["7:INBOX"]));
}

#[test]
fn unsolicited_fetch_updates_cannot_replace_identity_or_insert_results() {
    let mut data = metadata(7, 23, "Message-ID: <x>\r\n\r\nreal body");
    data.extend(b"* 1 FETCH (UID 7 FLAGS (\\Seen))\r\n");
    data.extend(metadata(999, 30, "Message-ID: <x>\r\n\r\nforged body"));
    let found = fetched(&data, &[7], Identity::Content).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].uid, 7);
    assert_eq!(
        found[0].identity,
        Some(Sha256::digest(b"Message-ID: <x>\r\n\r\nreal body").into())
    );
    assert_eq!(
        validity(b"* OK [UIDVALIDITY 123] valid\r\nO1 OK selected\r\n"),
        Ok(123)
    );
}

#[test]
fn server_identity_uses_protocol_fields_not_sender_headers() {
    for (kind, field) in [
        (Identity::EmailId, "EMAILID (stable-object)"),
        (Identity::GmailId, "X-GM-MSGID 18446744073709551614"),
    ] {
        let data =
            format!("* 1 FETCH (UID 7 INTERNALDATE \"23-Sep-2026 12:00:00 +0000\" {field})\r\n");
        let found = fetched(data.as_bytes(), &[7], kind).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found[0].identity.is_some());
        assert!(
            fetched(
                &metadata(7, 23, "Message-ID: <stable-object>\r\n\r\nbody"),
                &[7],
                kind
            )
            .is_err()
        );
    }
    let found = fetched(
        &metadata(7, 23, "Message-ID: <same>\r\n\r\nbody"),
        &[7],
        Identity::FolderUid,
    )
    .unwrap();
    assert!(found[0].identity.is_none());
}

#[test]
fn matching_headers_only_nominate_candidates_and_different_bodies_survive() {
    let boxes = parse_folders(b"* LIST (\\All) \"/\" Everything\r\n* LIST (\\Trash) \"/\" Bin\r\n")
        .unwrap();
    let mut scan = plan(&boxes, &json!({}), "ALL".into()).unwrap();
    let header = "Message-ID: <reused>\r\n\r\n";
    for (folder, uid) in [(0, 1), (0, 2), (1, 7)] {
        let data = format!(
            "* 1 FETCH (UID {uid} INTERNALDATE \"23-Sep-2026 12:00:00 +0000\" RFC822.SIZE 99 BODY[HEADER] {{{}}}\r\n{header})\r\n",
            header.len()
        );
        scan.folders[folder]
            .messages
            .extend(fetched(data.as_bytes(), &[uid], Identity::Candidate).unwrap());
    }
    // An aggregate-only message with no matching Trash header needs no body read.
    let data = b"* 1 FETCH (UID 3 INTERNALDATE \"24-Sep-2026 12:00:00 +0000\" RFC822.SIZE 100 BODY[HEADER] {3}\r\nnew)\r\n";
    scan.folders[0]
        .messages
        .extend(fetched(data, &[3], Identity::Candidate).unwrap());
    scan.refine();
    assert_eq!(scan.folders[0].pending, [1, 2]);
    assert_eq!(scan.folders[1].pending, [7]);
    assert!(
        scan.folders
            .iter()
            .all(|f| f.messages.iter().all(|m| m.identity.is_none()))
    );
    // Same Message-ID, same full headers and same size, but unrelated content.
    for (folder, uid, body) in [
        (0, 1, "legitimate"),
        (0, 2, "junk mail!"),
        (1, 7, "junk mail!"),
    ] {
        let full = format!("{header}{body}");
        let found = fetched(&metadata(uid, 23, &full), &[uid], Identity::Content).unwrap();
        scan.folders[folder]
            .messages
            .iter_mut()
            .find(|m| m.uid == uid)
            .unwrap()
            .identity = found[0].identity;
    }
    scan.finish();
    assert_eq!(
        scan.page(0, 10).unwrap()["page"]["ids"],
        json!(["3:Everything", "1:Everything"])
    );
}

#[tokio::test]
async fn cancelled_parallel_scan_closes_every_busy_socket() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (ready, mut reached) = tokio::sync::mpsc::channel(4);
    let server = tokio::spawn(async move {
        let mut peers = tokio::task::JoinSet::new();
        for _ in 0..WORKERS {
            let (socket, _) = listener.accept().await.unwrap();
            let ready = ready.clone();
            peers.spawn(async move {
                let mut wire: Wire = BufReader::new(Box::new(socket));
                write(&mut wire, b"* OK synthetic\r\n").await.unwrap();
                assert!(line(&mut wire).await.unwrap().starts_with(b"O1 LOGIN "));
                write(&mut wire, b"O1 OK login\r\n").await.unwrap();
                assert_eq!(line(&mut wire).await.unwrap(), b"O1 CAPABILITY\r\n");
                write(&mut wire, b"* CAPABILITY IMAP4rev1\r\nO1 OK caps\r\n")
                    .await
                    .unwrap();
                assert!(line(&mut wire).await.unwrap().starts_with(b"O1 SELECT "));
                ready.send(()).await.unwrap();
                let mut byte = [0];
                assert_eq!(wire.read(&mut byte).await.unwrap(), 0);
            });
        }
        while let Some(result) = peers.join_next().await {
            result.unwrap();
        }
    });
    let mut p = json!({"settings":{"imapHost":"127.0.0.1","imapPort":port,
        "username":"synthetic","insecure":true,"testPlaintext":true},
        "credential":"synthetic:secret","query":"search:ALL","requestToken":"cancel-parallel"});
    let boxes = parse_folders(
        b"* LIST () \"/\" A\r\n* LIST () \"/\" B\r\n* LIST () \"/\" C\r\n* LIST () \"/\" D\r\n",
    )
    .unwrap();
    let scan = plan(&boxes, &p, "ALL".into()).unwrap();
    p["continuation"] = json!(scan.token);
    SNAPSHOTS
        .get_or_init(Default::default)
        .lock()
        .await
        .push(scan);
    let q = p.clone();
    let request =
        tokio::spawn(async move { super::super::super::call("imap.listContinue", &q).await });
    for _ in 0..WORKERS {
        reached.recv().await.unwrap();
    }
    super::super::super::call("imap.cancel", &p).await.unwrap();
    assert_eq!(request.await.unwrap(), Err("request_cancelled"));
    tokio::time::timeout(Duration::from_secs(1), server)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(call(&p).await, Err("imap_search_expired"));
}
