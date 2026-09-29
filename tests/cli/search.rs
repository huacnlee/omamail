//! Each list invocation exits. Only the opaque cursor crosses the process
//! boundary: no backend, persisted snapshot, or credential cache is shared.
use super::*;
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn search_pages_survive_process_exit_and_deletion_of_the_cursor_message() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let fixture = mail_list_fixture(listener.local_addr().unwrap().port(), true);
    let peer = tokio::spawn(async move {
        // Three independent CLI processes, with deletions and a new arrival
        // between them. UID 2 (the first cursor) no longer exists on page two.
        for round in 0..3 {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = BufReader::new(reader);
            writer.write_all(b"* OK synthetic\r\n").await.unwrap();
            let rows: Vec<(u32, u8)> = match round {
                0 => vec![(1, 28), (2, 27), (3, 26), (4, 25), (5, 24), (6, 23)],
                1 => vec![(4, 25), (5, 24), (6, 23), (7, 29)],
                _ => vec![(6, 23), (7, 29)],
            };
            loop {
                let mut cmd = String::new();
                if reader.read_line(&mut cmd).await.unwrap() == 0 {
                    break;
                }
                let mut data = String::new();
                if cmd.starts_with("O1 LOGIN ") {
                } else if cmd == "O1 CAPABILITY\r\n" {
                    data.push_str("* CAPABILITY IMAP4rev1\r\n");
                } else if cmd == "O1 LIST \"\" \"*\"\r\n" {
                    data.push_str("* LIST () \"/\" INBOX\r\n");
                } else if cmd == "O1 SELECT \"INBOX\"\r\n" {
                    data.push_str("* OK [UIDVALIDITY 1] stable\r\n* OK [UIDNEXT 8] next\r\n");
                } else if cmd == "O1 UID FETCH 1:7 (UID)\r\n" {
                    for (uid, _) in &rows {
                        data.push_str(&format!("* 1 FETCH (UID {uid})\r\n"));
                    }
                } else if cmd.starts_with("O1 UID SEARCH UID ") {
                    assert!(cmd.ends_with(" UNDELETED TEXT \"invoice\"\r\n"));
                    data.push_str("* SEARCH");
                    for (uid, _) in &rows {
                        data.push_str(&format!(" {uid}"));
                    }
                    data.push_str("\r\n");
                } else if let Some(rest) = cmd.strip_prefix("O1 UID FETCH ") {
                    let (set, fields) = rest.split_once(' ').unwrap();
                    let wanted: Vec<u32> = set.split(',').map(|s| s.parse().unwrap()).collect();
                    if fields == "(UID)\r\n" {
                        for (uid, _) in &rows {
                            if wanted.contains(uid) {
                                data.push_str(&format!("* 1 FETCH (UID {uid})\r\n"));
                            }
                        }
                        data.push_str("O1 OK done\r\n");
                        writer.write_all(data.as_bytes()).await.unwrap();
                        continue;
                    }
                    let summary = fields.starts_with("(UID FLAGS ");
                    assert!(summary || fields == "(UID INTERNALDATE)\r\n");
                    for (uid, day) in &rows {
                        if !wanted.contains(uid) {
                            continue;
                        }
                        data.push_str(&format!(
                            "* 1 FETCH (UID {uid} INTERNALDATE \"{day:02}-Sep-2026 12:00:00 +0000\""
                        ));
                        if summary {
                            let headers = format!(
                                "From: Synthetic <test@example.org>\r\nSubject: invoice {uid}\r\n\r\n"
                            );
                            data.push_str(&format!(" FLAGS () RFC822.SIZE {} BODY[HEADER.FIELDS (FROM SUBJECT)] {{{}}}\r\n{headers}", headers.len(), headers.len()));
                        }
                        data.push_str(")\r\n");
                    }
                } else {
                    panic!("unexpected IMAP command: {cmd}");
                }
                data.push_str("O1 OK done\r\n");
                writer.write_all(data.as_bytes()).await.unwrap();
            }
        }
    });
    fs::write(fixture.0.join("credential-touched"), b"").unwrap();
    let before = fixture_snapshot(&fixture.0);
    let mut cursor = String::new();
    for expected in [
        json!(["1:INBOX", "2:INBOX"]),
        json!(["4:INBOX", "5:INBOX"]),
        json!(["6:INBOX"]),
    ] {
        let root = fixture.0.clone();
        let output = tokio::task::spawn_blocking(move || {
            root_mail(
                &root,
                &[
                    "list",
                    "--account",
                    "imap:imap@example.org",
                    "--query",
                    "invoice",
                    "--limit",
                    "2",
                    "--page-token",
                    &cursor,
                    "--json",
                ],
                b"",
            )
        })
        .await
        .unwrap();
        assert!(output.status.success(), "{output:?}");
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        let ids: Vec<_> = value["result"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["id"].clone())
            .collect();
        assert_eq!(json!(ids), expected);
        cursor = value["result"]["nextPageToken"]
            .as_str()
            .unwrap()
            .to_owned();
    }
    assert!(cursor.is_empty());
    peer.await.unwrap();
    assert_eq!(
        fixture_snapshot(&fixture.0),
        before,
        "pagination must not write a durable search cache"
    );
}
