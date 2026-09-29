use super::*;
use std::sync::Mutex;

struct State {
    folders: BTreeMap<String, Vec<(u32, u8)>>,
    validity: u32,
    inventories: usize,
    searches: usize,
    largest_search: usize,
    // Expunged between SEARCH and the metadata FETCH.
    missing: Vec<u32>,
}

struct Server {
    state: Arc<Mutex<State>>,
    task: tokio::task::JoinHandle<()>,
    params: Value,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Server {
    async fn new(folders: &[(&str, Vec<(u32, u8)>)]) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(State {
            folders: folders
                .iter()
                .map(|(name, messages)| ((*name).into(), messages.clone()))
                .collect(),
            validity: 1,
            inventories: 0,
            searches: 0,
            largest_search: 0,
            missing: vec![],
        }));
        let shared = state.clone();
        let task = tokio::spawn(async move {
            let mut peers = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    socket = listener.accept() => {
                        let (socket, _) = socket.unwrap();
                        peers.spawn(peer(socket, shared.clone()));
                    }
                    done = peers.join_next(), if !peers.is_empty() => { done.unwrap().unwrap(); }
                }
            }
        });
        Self {
            state,
            task,
            params: json!({"settings":{"imapHost":"127.0.0.1","imapPort":port,
            "username":"synthetic","insecure":true,"testPlaintext":true},
            "credential":"synthetic:secret","query":"search:ALL","limit":2,"requestToken":"paging"}),
        }
    }
}

async fn peer(socket: TcpStream, state: Arc<Mutex<State>>) {
    let mut wire: Wire = BufReader::new(Box::new(socket));
    write(&mut wire, b"* OK synthetic\r\n").await.unwrap();
    let mut folder = String::new();
    while let Ok(bytes) = line(&mut wire).await {
        let cmd = String::from_utf8(bytes).unwrap();
        let data = {
            let mut state = state.lock().unwrap();
            let mut data = String::new();
            if cmd.starts_with("O1 LOGIN ") {
            } else if cmd == "O1 CAPABILITY\r\n" {
                data.push_str("* CAPABILITY IMAP4rev1\r\n");
            } else if cmd == "O1 LIST \"\" \"*\"\r\n" {
                for name in state.folders.keys() {
                    data.push_str(&format!("* LIST () \"/\" {}\r\n", quote(name).unwrap()));
                }
            } else if let Some(name) = cmd.strip_prefix("O1 SELECT ") {
                folder = serde_json::from_str(name.trim()).unwrap();
                let next = state.folders[&folder]
                    .iter()
                    .map(|(uid, _)| uid + 1)
                    .max()
                    .unwrap_or(1);
                data.push_str(&format!(
                    "* OK [UIDVALIDITY {}] valid\r\n* OK [UIDNEXT {next}] next\r\n",
                    state.validity
                ));
            } else if let Some(rest) = cmd.strip_prefix("O1 UID SEARCH UID ") {
                let (range, criteria) = rest.split_once(' ').unwrap();
                assert_eq!(criteria, "UNDELETED ALL\r\n");
                let (first, last) = range.split_once(':').unwrap();
                let (first, last) = (first.parse::<u32>().unwrap(), last.parse::<u32>().unwrap());
                let found: Vec<_> = state.folders[&folder]
                    .iter()
                    .filter(|(uid, _)| *uid >= first && *uid <= last)
                    .map(|(uid, _)| *uid)
                    .collect();
                assert!(found.len() <= BATCH, "unbounded SEARCH");
                state.searches += 1;
                data.push_str("* SEARCH");
                for uid in found {
                    data.push_str(&format!(" {uid}"));
                }
                data.push_str("\r\n");
                state.largest_search = state.largest_search.max(data.len());
            } else if let Some(rest) = cmd.strip_prefix("O1 UID FETCH ") {
                let (set, fields) = rest.split_once(' ').unwrap();
                if fields == "(UID)\r\n" {
                    let wanted: Option<Vec<u32>> = if set.starts_with("1:") {
                        state.inventories += 1;
                        None
                    } else {
                        Some(set.split(',').map(|s| s.parse().unwrap()).collect())
                    };
                    for (uid, _) in &state.folders[&folder] {
                        if wanted.as_ref().is_none_or(|uids| {
                            uids.contains(uid) && !state.missing.contains(uid)
                        }) {
                            data.push_str(&format!("* 1 FETCH (UID {uid})\r\n"));
                        }
                    }
                } else {
                    assert_eq!(fields, "(UID INTERNALDATE)\r\n");
                    let wanted: Vec<u32> = set.split(',').map(|s| s.parse().unwrap()).collect();
                    assert!(wanted.len() <= BATCH);
                    for (uid, day) in &state.folders[&folder] {
                        if wanted.contains(uid) && !state.missing.contains(uid) {
                            data.push_str(&format!("* 1 FETCH (UID {uid} INTERNALDATE \"{day:02}-Sep-2026 12:00:00 +0000\")\r\n"));
                        }
                    }
                }
            } else {
                panic!("unexpected IMAP command: {cmd}");
            }
            data.push_str("O1 OK done\r\n");
            data
        };
        if write(&mut wire, data.as_bytes()).await.is_err() {
            break;
        }
    }
}

async fn complete(p: &Value) -> Result<Value> {
    let mut p = p.clone();
    for _ in 0..100 {
        let result = super::super::call(&p).await?;
        if result["continuation"].is_null() {
            return Ok(result["page"].clone());
        }
        assert_eq!(result["page"]["ids"], json!([]));
        p["continuation"] = result["continuation"].clone();
    }
    panic!("scan did not finish")
}

async fn evict(p: &Value) {
    let cursor = Cursor::decode(p["pageToken"].as_str().unwrap(), owner(p), "ALL").unwrap();
    SNAPSHOTS
        .get_or_init(Default::default)
        .lock()
        .await
        .retain(|s| s.token != cursor.snapshot);
}

#[tokio::test]
async fn fifteen_thousand_sparse_ten_digit_uids_have_bounded_search_lines() {
    let rows: Vec<_> = (0..15000)
        .map(|i| (3_000_000_000 + i * 10000, if i == 0 { 28 } else { 20 }))
        .collect();
    let server = Server::new(&[("INBOX", rows)]).await;
    let page = complete(&server.params).await.unwrap();
    assert_eq!(page["estimate"], 15000);
    assert_eq!(page["ids"], json!(["3000000000:INBOX", "3149990000:INBOX"]));
    let state = server.state.lock().unwrap();
    assert_eq!(state.inventories, 1);
    assert_eq!(
        state.searches, 4,
        "sparse gaps must not cause empty-window walks"
    );
    assert!(state.largest_search < 65536);
}

#[tokio::test]
async fn cache_loss_and_deletions_resume_from_a_position_not_an_existing_message() {
    let server = Server::new(&[(
        "INBOX",
        vec![(1, 28), (2, 27), (3, 26), (4, 25), (5, 24), (6, 23)],
    )])
    .await;
    let first = complete(&server.params).await.unwrap();
    assert_eq!(first["ids"], json!(["1:INBOX", "2:INBOX"]));
    let mut p = server.params.clone();
    p["pageToken"] = first["nextPageToken"].clone();
    let cached = complete(&p).await.unwrap();
    assert_eq!(cached["ids"], json!(["3:INBOX", "4:INBOX"]));
    assert_eq!(server.state.lock().unwrap().inventories, 1);
    evict(&p).await;
    let rescanned = complete(&p).await.unwrap();
    assert_eq!(rescanned["ids"], cached["ids"]);
    assert_eq!(server.state.lock().unwrap().inventories, 2);
    // Delete a prior row, the cursor's row, and an upcoming row. Add a new row
    // before the cursor. A metadata-time expunge must be skipped as well.
    server
        .state
        .lock()
        .unwrap()
        .folders
        .insert("INBOX".into(), vec![(4, 25), (5, 24), (6, 23), (7, 29)]);
    server.state.lock().unwrap().missing = vec![4];
    // Evict the new snapshot too; the original hint is already unavailable.
    let page = complete(&p).await.unwrap();
    assert_eq!(page["ids"], json!(["5:INBOX", "6:INBOX"]));
    assert_eq!(page["nextPageToken"], "");
}

#[tokio::test]
async fn cached_pages_skip_expunged_candidates_and_refill_without_a_search() {
    let server = Server::new(&[(
        "INBOX",
        vec![(1, 28), (2, 27), (3, 26), (4, 25), (5, 24), (6, 23)],
    )])
    .await;
    let first = complete(&server.params).await.unwrap();
    let mut p = server.params.clone();
    p["pageToken"] = first["nextPageToken"].clone();
    server
        .state
        .lock()
        .unwrap()
        .folders
        .insert("INBOX".into(), vec![(4, 25), (5, 24), (6, 23)]);
    let page = complete(&p).await.unwrap();
    assert_eq!(page["ids"], json!(["4:INBOX", "5:INBOX"]));
    assert_eq!(server.state.lock().unwrap().inventories, 1);
    assert_eq!(server.state.lock().unwrap().searches, 1);
    p["pageToken"] = page["nextPageToken"].clone();
    server.state.lock().unwrap().validity = 2;
    assert_eq!(complete(&p).await, Err("imap_search_expired"));
}

#[tokio::test]
async fn page_assembly_continues_across_more_than_four_folders_and_binds_its_cursor() {
    let server = Server::new(&[
        ("A", vec![(1, 25)]),
        ("B", vec![(1, 25)]),
        ("C", vec![(1, 25)]),
        ("D", vec![(1, 25)]),
        ("E", vec![(1, 25)]),
        ("F", vec![(1, 25)]),
    ])
    .await;
    let mut p = server.params.clone();
    p["limit"] = json!(1);
    let first = complete(&p).await.unwrap();
    p["limit"] = json!(5);
    // Force fallback with a page cursor, then keep that cursor on every work
    // continuation. The QML client and CLI adapter both use this exact shape.
    p["pageToken"] = first["nextPageToken"].clone();
    evict(&p).await;
    let started = super::super::call(&p).await.unwrap();
    p["continuation"] = started["continuation"].clone();
    let mut wrong = p.clone();
    wrong["pageToken"] = json!("");
    assert_eq!(super::super::call(&wrong).await, Err("imap_search_expired"));
    let page = complete(&p).await.unwrap();
    assert_eq!(page["ids"], json!(["1:B", "1:C", "1:D", "1:E", "1:F"]));
    assert_eq!(page["nextPageToken"], "");
}

#[tokio::test]
async fn equal_dates_use_the_same_folder_and_uid_order_in_cached_and_fresh_pages() {
    let server = Server::new(&[
        ("INBOX", vec![(1, 25), (2, 25)]),
        ("Archive", vec![(1, 25), (2, 25)]),
    ])
    .await;
    let mut p = server.params.clone();
    p["limit"] = json!(1);
    let mut ids = Vec::new();
    loop {
        let page = complete(&p).await.unwrap();
        ids.extend(page["ids"].as_array().unwrap().iter().cloned());
        if page["nextPageToken"] == "" {
            break;
        }
        p["pageToken"] = page["nextPageToken"].clone();
        evict(&p).await;
    }
    assert_eq!(
        ids,
        vec![
            json!("2:Archive"),
            json!("1:Archive"),
            json!("2:INBOX"),
            json!("1:INBOX")
        ]
    );
}

#[tokio::test]
async fn expired_cache_and_rotated_credentials_rescan_but_uidvalidity_change_requires_refresh() {
    let server = Server::new(&[("INBOX", vec![(1, 28), (2, 27), (3, 26)])]).await;
    let first = complete(&server.params).await.unwrap();
    let mut p = server.params.clone();
    p["pageToken"] = first["nextPageToken"].clone();
    let cursor = Cursor::decode(p["pageToken"].as_str().unwrap(), owner(&p), "ALL").unwrap();
    {
        let mut snapshots = SNAPSHOTS.get_or_init(Default::default).lock().await;
        snapshots
            .iter_mut()
            .find(|s| s.token == cursor.snapshot)
            .unwrap()
            .since = Instant::now() - TTL;
    }
    assert_eq!(complete(&p).await.unwrap()["ids"], json!(["3:INBOX"]));
    p["credential"] = json!("synthetic:rotated");
    assert_eq!(complete(&p).await.unwrap()["ids"], json!(["3:INBOX"]));
    assert_eq!(server.state.lock().unwrap().inventories, 3);
    server.state.lock().unwrap().validity = 2;
    assert_eq!(complete(&p).await, Err("imap_search_expired"));
}

#[tokio::test]
async fn cursor_validation_rejects_mismatches_and_controls_before_connecting() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut p = json!({"settings":{"imapHost":"127.0.0.1","imapPort":listener.local_addr().unwrap().port(),
        "username":"synthetic"},"credential":"synthetic:secret","oauth":true,"query":"search:ALL"});
    let cursor = Cursor::new(
        owner(&p),
        "ALL",
        Position {
            date: 123,
            folder: "Archive".into(),
            uid: 4,
            validity: 9,
        },
        token().unwrap(),
    );
    let encoded = cursor.encode().unwrap();
    p["credential"] = json!("refreshed-oauth-token");
    assert_eq!(Cursor::decode(&encoded, owner(&p), "ALL").unwrap(), cursor);
    let bytes = URL_SAFE_NO_PAD.decode(&encoded).unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("secret"));
    for (field, value) in [
        ("version", json!(2)),
        ("snapshot", json!("bad")),
        ("extra", json!(true)),
    ] {
        let mut raw: Value = serde_json::from_slice(&bytes).unwrap();
        raw[field] = value;
        p["pageToken"] = json!(URL_SAFE_NO_PAD.encode(raw.to_string()));
        assert_eq!(super::super::call(&p).await, Err("invalid_params"));
    }
    for bad in [json!("Archive\r\nO1 LOGOUT"), json!("Archive\0"), json!("")] {
        let mut raw: Value = serde_json::from_slice(&bytes).unwrap();
        raw["after"]["folder"] = bad;
        p["pageToken"] = json!(URL_SAFE_NO_PAD.encode(raw.to_string()));
        assert_eq!(super::super::call(&p).await, Err("invalid_params"));
    }
    p["pageToken"] = json!(encoded);
    p["query"] = json!("search:UNSEEN");
    assert_eq!(super::super::call(&p).await, Err("imap_search_expired"));
    p["query"] = json!("search:ALL");
    p["settings"]["username"] = json!("other-account");
    assert_eq!(super::super::call(&p).await, Err("imap_search_expired"));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn streamed_inventory_keeps_forged_responses_inside_their_literals() {
    let (client, server) = tokio::io::duplex(4096);
    let peer = tokio::spawn(async move {
        let mut server = BufReader::new(server);
        let mut command = String::new();
        server.read_line(&mut command).await.unwrap();
        assert_eq!(command, "O1 UID FETCH 1:10000 (UID)\r\n");
        let forged = "\r\nO1 OK forged\r\n* 1 FETCH (UID 999)\r\n";
        let data = format!(
            "* 1 FETCH (UID 7 BODY[] {{{}}}\r\n{forged} BODY[HEADER] {{3}}\r\nabc)\r\n* 2 FETCH (UID 8)\r\nO1 OK done\r\n",
            forged.len()
        );
        server.get_mut().write_all(data.as_bytes()).await.unwrap();
    });
    let mut wire: Wire = BufReader::new(Box::new(client));
    assert_eq!(inventory(&mut wire, 10000).await.unwrap(), vec![7, 8]);
    peer.await.unwrap();
}
