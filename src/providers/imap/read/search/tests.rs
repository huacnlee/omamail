use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
mod paging;

#[derive(Default)]
struct Counts {
    searches: AtomicUsize,
    fetches: AtomicUsize,
    inventories: AtomicUsize,
    verifications: AtomicUsize,
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
            let next = if folder == "f118" || folder == "f119" {
                5001
            } else {
                1
            };
            data.push_str(&format!(
                "* OK [UIDVALIDITY 1] stable\r\n* OK [UIDNEXT {next}] next\r\n"
            ));
            delay = true;
        } else if let Some(rest) = cmd.strip_prefix("O1 UID SEARCH UID ") {
            counts.searches.fetch_add(1, Ordering::SeqCst);
            assert!(rest.ends_with(" UNDELETED ALL\r\n"));
            let (first, last) = rest.split_once(' ').unwrap().0.split_once(':').unwrap();
            let (first, last) = (first.parse::<u32>().unwrap(), last.parse::<u32>().unwrap());
            assert!(last - first < BATCH as u32);
            data.push_str("* SEARCH");
            if folder == "f118" || folder == "f119" {
                for uid in first..=last {
                    data.push_str(&format!(" {uid}"));
                }
            }
            data.push_str("\r\n");
            delay = true;
        } else if cmd == "O1 UID FETCH 1:5000 (UID)\r\n" {
            counts.inventories.fetch_add(1, Ordering::SeqCst);
            for uid in 1..=5000 {
                data.push_str(&format!("* {uid} FETCH (UID {uid})\r\n"));
            }
        } else if let Some(rest) = cmd.strip_prefix("O1 UID FETCH ") {
            if rest.ends_with(" (UID)\r\n") {
                counts.verifications.fetch_add(1, Ordering::SeqCst);
                for uid in rest.split_once(' ').unwrap().0.split(',') {
                    data.push_str(&format!("* 1 FETCH (UID {uid})\r\n"));
                }
                data.push_str("O1 OK done\r\n");
                write(&mut wire, data.as_bytes()).await.unwrap();
                continue;
            }
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
    assert_eq!(counts.inventories.load(Ordering::SeqCst), 2);
    assert_eq!(counts.searches.load(Ordering::SeqCst), 4);
    assert_eq!(counts.fetches.load(Ordering::SeqCst), 4);
    assert!(counts.peak.load(Ordering::SeqCst) > 1);
    assert!(counts.peak.load(Ordering::SeqCst) <= WORKERS);
    p.as_object_mut().unwrap().remove("continuation");
    p["pageToken"] = first["page"]["nextPageToken"].clone();
    let before = counts.selects.load(Ordering::SeqCst);
    let second = call(&p).await.unwrap();
    assert_eq!(second["page"]["ids"], json!(["5000:f118", "4999:f118"]));
    assert_eq!(counts.selects.load(Ordering::SeqCst), before + 1);
    assert_eq!(counts.inventories.load(Ordering::SeqCst), 2);
    assert_eq!(counts.searches.load(Ordering::SeqCst), 4);
    assert_eq!(counts.fetches.load(Ordering::SeqCst), 4);
    assert_eq!(counts.verifications.load(Ordering::SeqCst), 3);
    p["query"] = json!("search:SUBJECT invoice");
    assert_eq!(call(&p).await, Err("imap_search_expired"));
    p["query"] = json!("search:ALL");
    p["settings"]["username"] = json!("other-account");
    assert_eq!(call(&p).await, Err("imap_search_expired"));
    assert_eq!(counts.selects.load(Ordering::SeqCst), before + 1);
    server.abort();
}

fn metadata(uid: u32, day: u8, body: &str) -> Vec<u8> {
    format!("* 1 FETCH (UID {uid} INTERNALDATE \"{day:02}-Sep-2026 12:00:00 +0000\" BODY[] {{{}}}\r\n{body})\r\n", body.len()).into_bytes()
}

// Generic \All server with no server-issued identity: (folder, uid, day, raw message).
const GENERIC: [(&str, u32, u8, &str); 10] = [
    (
        "INBOX",
        7,
        23,
        "Message-ID: <same@example.org>\r\n\r\nInbox content",
    ),
    (
        "Archive",
        7,
        24,
        "Message-ID: <same@example.org>\r\n\r\nDifferent archive content",
    ),
    (
        "Everything",
        1,
        25,
        "Subject: aggregate only\r\n\r\nArchived without a label",
    ),
    (
        "Everything",
        2,
        23,
        "Message-ID: <same@example.org>\r\n\r\nInbox content",
    ),
    (
        "Everything",
        5,
        24,
        "Message-ID: <same@example.org>\r\n\r\nDifferent archive content",
    ),
    (
        "Everything",
        3,
        26,
        "Message-ID: <t@example.org>\r\n\r\nDeleted content",
    ),
    (
        "Bin",
        7,
        26,
        "Message-ID: <t@example.org>\r\n\r\nDeleted content",
    ),
    (
        "Everything",
        6,
        22,
        "Message-ID: <t@example.org>\r\n\r\nKeepers content",
    ),
    ("Everything", 4, 27, "Subject: spam\r\n\r\nJunk content"),
    ("Junkmail", 7, 27, "Subject: spam\r\n\r\nJunk content"),
];

async fn generic_peer(socket: TcpStream, selected: Arc<std::sync::Mutex<Vec<String>>>) {
    let mut wire: Wire = BufReader::new(Box::new(socket));
    write(&mut wire, b"* OK synthetic server\r\n")
        .await
        .unwrap();
    let mut folder = String::new();
    while let Ok(bytes) = line(&mut wire).await {
        let cmd = String::from_utf8(bytes).unwrap();
        let mut data = String::new();
        if cmd.starts_with("O1 LOGIN ") {
        } else if cmd == "O1 CAPABILITY\r\n" {
            data.push_str("* CAPABILITY IMAP4rev1 SPECIAL-USE\r\n");
        } else if cmd == "O1 LIST \"\" \"*\"\r\n" {
            data.push_str("* LIST () \"/\" INBOX\r\n* LIST (\\Archive) \"/\" Archive\r\n* LIST (\\All) \"/\" Everything\r\n* LIST (\\Trash) \"/\" Bin\r\n* LIST (\\Junk) \"/\" Junkmail\r\n");
        } else if let Some(name) = cmd.strip_prefix("O1 SELECT ") {
            folder = name.trim().trim_matches('"').to_owned();
            selected.lock().unwrap().push(folder.clone());
            data.push_str("* OK [UIDVALIDITY 1] stable\r\n* OK [UIDNEXT 8] next\r\n");
        } else if cmd.starts_with("O1 UID SEARCH ") {
            data.push_str("* SEARCH");
            for (_, uid, _, _) in GENERIC.iter().filter(|m| m.0 == folder) {
                data.push_str(&format!(" {uid}"));
            }
            data.push_str("\r\n");
        } else if let Some(rest) = cmd.strip_prefix("O1 UID FETCH ") {
            let (set, fields) = rest.split_once(' ').unwrap();
            if fields == "(UID)\r\n" {
                let wanted: Vec<u32> = if set == "1:7" {
                    GENERIC
                        .iter()
                        .filter(|m| m.0 == folder)
                        .map(|m| m.1)
                        .collect()
                } else {
                    set.split(',').map(|uid| uid.parse().unwrap()).collect()
                };
                for (_, uid, _, _) in GENERIC
                    .iter()
                    .filter(|m| m.0 == folder && wanted.contains(&m.1))
                {
                    data.push_str(&format!("* 1 FETCH (UID {uid})\r\n"));
                }
                data.push_str("O1 OK done\r\n");
                write(&mut wire, data.as_bytes()).await.unwrap();
                continue;
            }
            for uid in set.split(',') {
                let uid = uid.parse::<u32>().unwrap();
                let (_, _, day, raw) = GENERIC
                    .iter()
                    .find(|m| m.0 == folder && m.1 == uid)
                    .unwrap();
                let mut item = format!(
                    "* 1 FETCH (UID {uid} INTERNALDATE \"{day:02}-Sep-2026 12:00:00 +0000\""
                );
                if fields.contains("HEADER.FIELDS (MESSAGE-ID)") {
                    let header = raw
                        .lines()
                        .find(|l| l.starts_with("Message-ID:"))
                        .map_or(String::from("\r\n"), |l| format!("{l}\r\n\r\n"));
                    item.push_str(&format!(
                        " RFC822.SIZE {} BODY[HEADER.FIELDS (MESSAGE-ID)] {{{}}}\r\n{header}",
                        raw.len(),
                        header.len()
                    ));
                } else {
                    assert!(fields.contains("BODY.PEEK[]"), "{fields}");
                    item.push_str(&format!(" BODY[] {{{}}}\r\n{raw}", raw.len()));
                }
                data.push_str(&item);
                data.push_str(")\r\n");
            }
        } else {
            panic!("unexpected command: {cmd}");
        }
        data.push_str("O1 OK done\r\n");
        if write(&mut wire, data.as_bytes()).await.is_err() {
            break;
        }
    }
}

#[tokio::test]
async fn generic_all_server_lists_each_message_once_and_verifies_exclusions() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let selected = Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = selected.clone();
    let server = tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            tokio::spawn(generic_peer(socket, seen.clone()));
        }
    });
    let mut p = json!({"settings":{"imapHost":"127.0.0.1","imapPort":port,
        "username":"synthetic","insecure":true,"testPlaintext":true},
        "credential":"synthetic:generic","query":"search:ALL","limit":10,"requestToken":"generic-all"});
    let mut method = "imap.list";
    let result = loop {
        let result = super::super::super::call(method, &p).await.unwrap();
        if result["continuation"].is_null() {
            break result;
        }
        p["continuation"] = result["continuation"].clone();
        method = "imap.listContinue";
    };
    // Inbox and Archive copies are not repeated from their folders; the
    // aggregate-only message survives; a verified Trash/Junk copy does not;
    // a message that only shares Message-ID and size with Trash survives.
    assert_eq!(
        result["page"]["ids"],
        json!([
            "1:Everything",
            "5:Everything",
            "2:Everything",
            "6:Everything"
        ])
    );
    let selected = selected.lock().unwrap();
    assert!(!selected.iter().any(|f| f == "INBOX" || f == "Archive"));
    server.abort();
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
fn server_identity_representative_is_stable_across_reordered_folder_discovery() {
    for list in [
        b"* LIST () \"/\" B\r\n* LIST () \"/\" A\r\n".as_slice(),
        b"* LIST () \"/\" A\r\n* LIST () \"/\" B\r\n".as_slice(),
    ] {
        let boxes = parse_folders(list).unwrap();
        let mut scan = plan(&boxes, &json!({}), "ALL".into()).unwrap();
        for folder in &mut scan.folders {
            folder.validity = Some(1);
            folder.messages.push(Message {
                size: 0,
                uid: 7,
                date: 123,
                identity: Some([1; 32]),
                candidate: None,
            });
        }
        scan.finish();
        assert_eq!(scan.page(None, 10).unwrap()["page"]["ids"], json!(["7:A"]));
    }
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
        scan.page(None, 10).unwrap()["page"]["ids"],
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

#[test]
fn oversized_candidates_stay_visible_instead_of_reading_their_bodies() {
    let boxes = parse_folders(b"* LIST (\\All) \"/\" Everything\r\n* LIST (\\Trash) \"/\" Bin\r\n")
        .unwrap();
    let mut scan = plan(&boxes, &json!({}), "ALL".into()).unwrap();
    let header = "Message-ID: <large>\r\n\r\n";
    for (folder, uid) in [(0, 1), (1, 7)] {
        let data = format!(
            "* 1 FETCH (UID {uid} INTERNALDATE \"23-Sep-2026 12:00:00 +0000\" RFC822.SIZE {} BODY[HEADER.FIELDS (MESSAGE-ID)] {{{}}}\r\n{header})\r\n",
            CONTENT_LIMIT + 1,
            header.len()
        );
        scan.folders[folder]
            .messages
            .extend(fetched(data.as_bytes(), &[uid], Identity::Candidate).unwrap());
    }
    scan.refine();
    assert!(scan.folders.iter().all(|f| f.pending.is_empty()));
    scan.finish();
    assert_eq!(
        scan.page(None, 10).unwrap()["page"]["ids"],
        json!(["1:Everything"])
    );
}
