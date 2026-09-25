use super::*;
#[test]
fn octet_literals_do_not_create_responses_or_fetch_fields() {
    let raw = b"Subject: test\r\n\r\n* 8 FETCH (UID 999)\r\n\xc3\xa9";
    let data=[format!("* 1 FETCH (UID 42 FLAGS (\\Seen) INTERNALDATE \"11-Sep-2026 12:00:00 +0000\" RFC822.SIZE 100 BODY[] {{{}}}\r\n",raw.len()).as_bytes(),raw,b")\r\nO1 OK done\r\n"].concat();
    let boxes = parse_folders(b"* LIST (\\Inbox) \"/\" INBOX\r\n").unwrap();
    let parsed = parse_messages(&data, "INBOX", true, &boxes).unwrap();
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0]["id"], "42:INBOX");
    assert_eq!(parsed[0]["labelIds"], json!(["INBOX"]));
    assert_eq!(parsed[0]["payload"]["headers"][0]["value"], "test");
    assert_eq!(
        fetched_dates(&data)
            .unwrap()
            .keys()
            .copied()
            .collect::<Vec<_>>(),
        [42]
    );
}
#[test]
fn list_handles_literals_noselect_special_use_and_modified_utf7() {
    let boxes=parse_folders(b"* CAPABILITY IMAP4rev1 ID MOVE\r\n* LIST (\\Noselect) \"/\" Root\r\n* LIST (\\Sent) \"/\" {10}\r\nSent Items\r\n* LIST () NIL &ZeVnLIqe-\r\n").unwrap();
    assert_eq!(resolve(&boxes, "\\Sent").unwrap(), "Sent Items");
    assert_eq!(resolve(&boxes, "\\Trash"), Err("imap_folder_unavailable"));
    let value = folders_value(&boxes);
    assert_eq!(value["labels"].as_array().unwrap().len(), 2);
    assert_eq!(value["labels"][1]["name"], "日本語");
}
#[test]
fn date_pages_are_descending_unique_with_uid_tiebreaker() {
    let dates = BTreeMap::from([(4, 100), (7, 200), (99, 300)]);
    let result = page(&[7, 4, 7, 99], &dates, "INBOX", 1, 2, true);
    assert_eq!(result["ids"], json!(["7:INBOX", "4:INBOX"]));
    assert_eq!(result["nextPageToken"], "3");
    assert_eq!(result["estimate"], 4);
    let dates = fetched_dates(b"* 1 FETCH (UID 1 INTERNALDATE \" 1-Sep-2026 12:00:00 +0200\")\r\n* 2 FETCH (INTERNALDATE \"01-Sep-2026 10:00:00 +0000\" UID 2)\r\n* 3 FETCH (UID 3 INTERNALDATE \"invalid\")\r\n").unwrap();
    assert_eq!(
        page(&[1, 2, 3, 4], &dates, "INBOX", 0, 10, false)["ids"],
        json!(["2:INBOX", "1:INBOX", "4:INBOX", "3:INBOX"])
    );
    assert_eq!(
        query("folder:\"Sent Items\" UNSEEN").unwrap(),
        ("Sent Items".into(), "UNSEEN".into())
    );
    assert!(query("folder:INBOX ALL\r\nEXPUNGE").is_err());
    assert_eq!(
        search_uids(b"* SEARCH 10 7 10\r\nO1 OK done\r\n").unwrap(),
        [7, 10]
    );
}
#[test]
fn parser_bounds_nesting_and_truncated_literals() {
    assert!(nodes(&[b'('; 100]).is_err());
    assert!(nodes(b"* LIST () NIL {20}\r\nshort").is_err());
}
async fn greeting(w: &mut Wire) {
    write(w, b"* OK ready\r\n").await.unwrap();
    assert!(line(w).await.unwrap().starts_with(b"O1 LOGIN"));
    write(w, b"O1 OK login\r\n").await.unwrap();
    for _ in 0..2 {
        assert_eq!(line(w).await.unwrap(), b"O1 CAPABILITY\r\n");
        write(w, b"* CAPABILITY IMAP4rev1\r\nO1 OK caps\r\n")
            .await
            .unwrap();
    }
    assert_eq!(line(w).await.unwrap(), b"O1 LIST \"\" \"*\"\r\n");
    write(w, b"* LIST () \"/\" INBOX\r\nO1 OK folders\r\n")
        .await
        .unwrap();
}
async fn select(w: &mut Wire) {
    assert_eq!(line(w).await.unwrap(), b"O1 SELECT \"INBOX\"\r\n");
    write(w, b"O1 OK selected\r\n").await.unwrap();
}
fn params(port: u16) -> Value {
    json!({"settings":{"imapHost":"127.0.0.1","imapPort":port,"username":"synthetic","insecure":true,"testPlaintext":true},"credential":"synthetic:secret","oauth":false,"query":"folder:INBOX UNSEEN","limit":3,"progressive":true,"requestToken":"request-1"})
}
#[tokio::test]
async fn sparse_search_orders_by_date_before_paging_even_when_progressive() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut w: Wire = BufReader::new(Box::new(stream));
        greeting(&mut w).await;
        select(&mut w).await;
        for page_index in 0..2 {
            assert_eq!(line(&mut w).await.unwrap(), b"O1 UID FETCH 1:* (UID)\r\n");
            write(&mut w, b"* 1 FETCH (UID 7)\r\n* 2 FETCH (UID 1000)\r\n* 3 FETCH (UID 50000)\r\nO1 OK snapshot\r\n").await.unwrap();
            assert_eq!(
                line(&mut w).await.unwrap(),
                b"O1 UID FETCH 7,1000,50000 (UID INTERNALDATE)\r\n"
            );
            write(&mut w,b"* 1 FETCH (UID 7 INTERNALDATE \"23-Sep-2026 12:00:00 +0000\")\r\n* 2 FETCH (UID 1000 INTERNALDATE \"22-Sep-2026 12:00:00 +0000\")\r\n* 3 FETCH (UID 50000 INTERNALDATE \"21-Sep-2026 12:00:00 +0000\")\r\nO1 OK snapshot\r\n").await.unwrap();
            assert_eq!(
                line(&mut w).await.unwrap(),
                b"O1 UID SEARCH UID 7:50000 UNSEEN\r\n"
            );
            write(&mut w, b"* SEARCH 7 1000 50000\r\nO1 OK found\r\n")
                .await
                .unwrap();
            if page_index == 0 {
                select(&mut w).await;
            }
        }
    });
    let mut p = params(port);
    p["limit"] = json!(2);
    let first = super::super::call("imap.list", &p).await.unwrap();
    assert_eq!(first["page"]["ids"], json!(["7:INBOX", "1000:INBOX"]));
    assert!(first["continuation"].is_null());
    p["pageToken"] = first["page"]["nextPageToken"].clone();
    let second = super::super::call("imap.list", &p).await.unwrap();
    assert_eq!(second["page"]["ids"], json!(["50000:INBOX"]));
    assert_eq!(second["page"]["nextPageToken"], "");
    peer.await.unwrap();
}
#[test]
fn unsolicited_flags_preserve_snapshot_dates() {
    let dates = fetched_dates(b"* 1 FETCH (UID 7 INTERNALDATE \"23-Sep-2026 12:00:00 +0000\")\r\n* 2 FETCH (UID 8 FLAGS ())\r\n* 2 FETCH (UID 8 INTERNALDATE \"22-Sep-2026 12:00:00 +0000\")\r\n* 1 FETCH (UID 7 FLAGS (\\Seen))\r\n").unwrap();
    assert_eq!(
        page(&[7, 8], &dates, "INBOX", 0, 1, false)["ids"],
        json!(["7:INBOX"])
    );
}

#[tokio::test]
async fn multi_window_dates_settle_before_paging_and_ignore_unsolicited_flags() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut w: Wire = BufReader::new(Box::new(stream));
        greeting(&mut w).await;
        let mut searches = 0;
        let mut batches = Vec::new();
        loop {
            let request = String::from_utf8(line(&mut w).await.unwrap()).unwrap();
            let mut response = String::new();
            if request == "O1 SELECT \"INBOX\"\r\n" {
                response.push_str("O1 OK selected\r\n");
            } else if let Some(fetch) = request.strip_prefix("O1 UID FETCH ") {
                let (set, fields) = fetch.split_once(' ').unwrap();
                let ids: Vec<u32> = if set == "1:*" {
                    (1..=4100).collect()
                } else {
                    set.split(',').map(|s| s.parse().unwrap()).collect()
                };
                let dated = fields.contains("INTERNALDATE");
                if dated {
                    assert!(ids.len() <= 4096, "date response must be bounded");
                    batches.push(ids.len());
                }
                for uid in ids {
                    // Date order deliberately crosses the 4096-message boundary.
                    let day = match uid {
                        1 => 24,
                        4097 => 23,
                        2 => 22,
                        _ => 21,
                    };
                    response.push_str(&if dated {
                        format!("* {uid} FETCH (UID {uid} INTERNALDATE \"{day}-Sep-2026 12:00:00 +0000\")\r\n")
                    } else {
                        format!("* {uid} FETCH (UID {uid})\r\n")
                    });
                }
                // Both within and outside the current batch: neither may erase
                // UID 1's date or add a post-snapshot arrival to the page.
                if dated {
                    response.push_str(
                        "* 1 FETCH (UID 1 FLAGS (\\Seen))\r\n* 4101 FETCH (UID 4101 FLAGS ())\r\n",
                    );
                }
                response.push_str("O1 OK fetched\r\n");
            } else if let Some(search) = request.strip_prefix("O1 UID SEARCH UID ") {
                let (range, _) = search.split_once(' ').unwrap();
                let (first, last) = range.split_once(':').unwrap();
                let first: u32 = first.parse().unwrap();
                let last: u32 = last.parse().unwrap();
                response.push_str("* SEARCH");
                for uid in first..=last.min(4100) {
                    response.push_str(&format!(" {uid}"));
                }
                response.push_str("\r\nO1 OK searched\r\n");
                searches += 1;
            } else {
                panic!("unexpected command: {request}");
            }
            write(&mut w, response.as_bytes()).await.unwrap();
            if searches == 4 {
                break;
            }
        }
        assert_eq!(batches, [4096, 4, 4096, 4]);
    });
    let mut p = params(port);
    p["limit"] = json!(2);
    // Also usable as a runtime regression on the old UID-only implementation:
    // it understands the same snapshot/search commands but chooses the wrong page.
    p["progressive"] = json!(false);
    let first = super::super::call("imap.list", &p).await.unwrap();
    assert_eq!(first["page"]["ids"], json!(["1:INBOX", "4097:INBOX"]));
    assert!(first["continuation"].is_null());
    p["pageToken"] = first["page"]["nextPageToken"].clone();
    let second = super::super::call("imap.list", &p).await.unwrap();
    assert_eq!(second["page"]["ids"], json!(["2:INBOX", "4100:INBOX"]));
    peer.await.unwrap();
}

#[tokio::test]
async fn native_metadata_fetch_and_mime_parse_stay_in_backend() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let peer = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut w: Wire = BufReader::new(Box::new(stream));
        greeting(&mut w).await;
        select(&mut w).await;
        assert_eq!(line(&mut w).await.unwrap(),b"O1 UID FETCH 7,8 (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REPLY-TO LIST-UNSUBSCRIBE)])\r\n");
        for uid in [8, 7] {
            let raw = format!("From: Test <test@example.org>\r\nSubject: Message {uid}\r\n\r\n");
            write(&mut w,format!("* {uid} FETCH (UID {uid} FLAGS (\\Flagged) RFC822.SIZE 88 BODY[HEADER.FIELDS (FROM SUBJECT)] {{{}}}\r\n{raw})\r\n",raw.len()).as_bytes()).await.unwrap();
        }
        write(&mut w, b"O1 OK fetched\r\n").await.unwrap();
    });
    let mut p = params(port);
    p["ids"] = json!(["7:INBOX", "8:INBOX"]);
    let result = super::super::call("imap.messages", &p).await.unwrap();
    assert_eq!(result["messages"][0]["id"], "7:INBOX");
    assert_eq!(result["messages"][1]["id"], "8:INBOX");
    assert_eq!(
        result["messages"][0]["labelIds"],
        json!(["UNREAD", "STARRED", "INBOX"])
    );
    assert_eq!(
        result["messages"][0]["payload"]["headers"][1]["value"],
        "Message 7"
    );
    peer.await.unwrap();
}
#[tokio::test]
async fn original_query_controls_are_rejected_before_connecting() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    for suffix in ["\r", "\n", "\r\n", "\0", "\t", "\x7f"] {
        let mut p = params(port);
        p["query"] = json!(format!("folder:INBOX UNSEEN{suffix}"));
        assert_eq!(
            super::super::call("imap.list", &p).await,
            Err("invalid_params")
        );
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}
