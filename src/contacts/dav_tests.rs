use super::*;
use crate::test_support::peers::ScriptedHttpsPeer;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

// No lookup can leave the test, even if a regression accepts a foreign host.
struct LoopbackDns(SocketAddr);
impl reqwest::dns::Resolve for LoopbackDns {
    fn resolve(&self, _: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let address = self.0;
        Box::pin(async move { Ok(Box::new(std::iter::once(address)) as reqwest::dns::Addrs) })
    }
}

async fn peer() -> (ScriptedHttpsPeer, reqwest::Client) {
    let server = ScriptedHttpsPeer::start().await;
    let address: SocketAddr = format!("127.0.0.1:{}", server.port).parse().unwrap();
    let certificate = reqwest::Certificate::from_pem(
        &std::fs::read(crate::test_support::tls::testdata("discovery.pem")).unwrap(),
    )
    .unwrap();
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .dns_resolver(Arc::new(LoopbackDns(address)))
        .add_root_certificate(certificate)
        .build()
        .unwrap();
    (server, client)
}

fn mailbox() -> Mailbox {
    Mailbox {
        origin: Url::parse("https://mail.example.test/").unwrap(),
        username: "person@example.test".into(),
    }
}

const MS: &str = r#"<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">"#;

fn multistatus(responses: &str) -> String {
    format!("{MS}{responses}</d:multistatus>")
}

fn principal() -> String {
    multistatus(
        "<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/dav/person%40example.test/</d:href></d:current-user-principal></d:prop></d:propstat></d:response>",
    )
}

fn home() -> String {
    multistatus(
        "<d:response><d:href>/dav/person%40example.test/</d:href><d:propstat><d:prop><card:addressbook-home-set><d:href>/dav/person%40example.test/</d:href></card:addressbook-home-set></d:prop></d:propstat></d:response>",
    )
}

fn collections() -> String {
    multistatus(concat!(
        "<d:response><d:href>/dav/person%40example.test/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>",
        "<d:response><d:href>/dav/person%40example.test/contacts/</d:href><d:propstat><d:prop><d:displayname>Personal</d:displayname><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype></d:prop></d:propstat></d:response>",
        "<d:response><d:href>/dav/person%40example.test/gal/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype></d:prop></d:propstat></d:response>",
        "<d:response><d:href>/dav/person%40example.test/calendar/</d:href><d:propstat><d:prop><d:displayname>Calendar</d:displayname><d:resourcetype><d:collection/><cal:calendar xmlns:cal=\"urn:ietf:params:xml:ns:caldav\"/></d:resourcetype></d:prop></d:propstat></d:response>",
    ))
}

fn card_answer(cards: &[&str]) -> String {
    let mut responses = String::new();
    for (index, card) in cards.iter().enumerate() {
        responses.push_str(&format!(
            "<d:response><d:href>/c/{index}.vcf</d:href><d:propstat><d:prop><card:address-data>{card}</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
        ));
    }
    multistatus(&responses)
}

#[test]
fn address_data_keeps_entities_and_cdata_and_skips_absent_cards() {
    let xml = multistatus(concat!(
        "<d:response><d:href>/a.vcf</d:href><d:propstat><d:prop><card:address-data>BEGIN:VCARD&#13;\nFN:Ada &amp; Co\nEMAIL:ada@example.org\nEND:VCARD</card:address-data></d:prop></d:propstat></d:response>",
        "<d:response><d:href>/b.vcf</d:href><d:propstat><d:prop><card:address-data><![CDATA[BEGIN:VCARD\nFN:Bob <B>\nEMAIL:bob@example.org\nEND:VCARD]]></card:address-data></d:prop></d:propstat></d:response>",
        "<d:response><d:href>/c.vcf</d:href><d:propstat><d:prop><card:address-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>",
    ));
    let found = cards(&xml).unwrap();
    assert_eq!(found.len(), 2);
    let mut book = Book::new();
    for card in &found {
        vcard(&mut book, card);
    }
    assert_eq!(book["ada@example.org"]["name"], "Ada & Co");
    assert_eq!(book["bob@example.org"]["name"], "Bob <B>");
    for broken in [
        "<d:multistatus><card:address-data>BEGIN:VCARD",
        "<d:multistatus><card:address-data>&unknown;</card:address-data></d:multistatus>",
    ] {
        assert!(cards(broken).is_err(), "{broken}");
    }
}

#[test]
fn only_address_books_on_the_mail_host_are_listed_and_named() {
    let base = Url::parse("https://mail.example.test/dav/person%40example.test/").unwrap();
    let listed = books(&collections(), &base, &mailbox()).unwrap();
    let names: Vec<_> = listed.iter().map(|(_, name)| name.as_str()).collect();
    assert_eq!(names, ["Personal", "gal"]);
    assert_eq!(
        listed[1].0.as_str(),
        "https://mail.example.test/dav/person%40example.test/gal/"
    );
    let foreign = multistatus(
        "<d:response><d:href>https://outside.example.test/book/</d:href><d:propstat><d:prop><d:resourcetype><card:addressbook/></d:resourcetype></d:prop></d:propstat></d:response>",
    );
    assert_eq!(
        books(&foreign, &base, &mailbox()).err(),
        Some("calendar_origin_refused")
    );
}

// The shape Radicale answers in behind a path prefix, end to end: two books
// are read with one addressbook-query each, everything stays on the mailbox's
// host and nothing but PROPFIND and REPORT is sent.
#[tokio::test]
async fn https_books_are_found_read_and_merged_without_leaving_the_mail_host() {
    let (server, client) = peer().await;
    let personal = card_answer(&[
        "BEGIN:VCARD\r\nFN:Ada Lovelace\r\nEMAIL:ada@example.org\r\nEND:VCARD\r\n",
        "BEGIN:VCARD\r\nFN:Bob\r\nEMAIL:bob@example.org\r\nEMAIL:BOB@example.org\r\nEND:VCARD\r\n",
    ]);
    let directory = card_answer(&[
        "BEGIN:VCARD\r\nFN:Robert\r\nEMAIL:bob@example.org\r\nEND:VCARD\r\n",
        "BEGIN:VCARD\r\nFN:Grace\r\nEMAIL:grace@example.org\r\nEND:VCARD\r\n",
        "BEGIN:VCARD\r\nFN:No address\r\nEND:VCARD\r\n",
    ]);
    server.responses(json!([
        {"status":301,"location":"/dav/"},
        {"status":207,"body":principal()},
        {"status":207,"body":home()},
        {"status":207,"body":collections()},
        {"status":207,"body":personal},
        {"status":207,"body":directory},
    ]));
    let found = fetch_with(
        &client,
        "imap:person@example.test",
        &mailbox(),
        "synthetic-password",
    )
    .await
    .unwrap();
    assert_eq!(
        found["books"],
        json!([{"name":"Personal","contacts":2},{"name":"gal","contacts":2}])
    );
    let contacts = found["contacts"].as_array().unwrap();
    assert_eq!(contacts.len(), 3, "{found}");
    assert_eq!(contacts[1]["email"], "bob@example.org");
    assert_eq!(contacts[1]["name"], "Bob", "the first book's name is kept");
    let requests = server.requests();
    let methods: Vec<_> = requests.iter().map(|r| r["method"].clone()).collect();
    assert_eq!(
        methods,
        [
            "PROPFIND", "PROPFIND", "PROPFIND", "PROPFIND", "REPORT", "REPORT"
        ]
    );
    assert_eq!(requests[0]["path"], "/.well-known/carddav");
    assert_eq!(requests[4]["path"], "/dav/person%40example.test/contacts/");
    assert_eq!(requests[4]["depth"], "1");
    assert!(
        requests[4]["body"]
            .as_str()
            .unwrap()
            .contains("<c:filter/>")
    );
    for request in &requests {
        assert!(
            request["host"]
                .as_str()
                .unwrap()
                .starts_with("mail.example.test")
        );
    }
}

#[tokio::test]
async fn https_a_book_redirected_off_the_mail_host_is_not_followed() {
    let (server, client) = peer().await;
    server.responses(json!([
        {"status":207,"body":principal()},
        {"status":207,"body":home()},
        {"status":207,"body":collections()},
        {"status":307,"location":"https://outside.example.test/stolen"},
        {"status":207,"body":"stolen"},
    ]));
    // The well-known address is skipped by a 207 at the root in this script:
    // the first answer is taken as the well-known one.
    let error = fetch_with(
        &client,
        "imap:person@example.test",
        &mailbox(),
        "synthetic-password",
    )
    .await
    .unwrap_err();
    assert_eq!(error, "calendar_origin_refused");
    assert_eq!(server.requests().len(), 4);
    assert_eq!(reason(error), "contacts_origin_refused");
}

static SERIAL: AtomicU64 = AtomicU64::new(0);
struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        let root = std::env::temp_dir().canonicalize().unwrap().join(format!(
            "omamail-address-books-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// Offline, a mailbox keeps suggesting what its server last said, and says why
// the answer is old; a mailbox never read has nothing to fall back on.
#[test]
fn a_failed_refresh_answers_the_saved_snapshot_and_forget_removes_it() {
    let temp = Temp::new();
    let account = "imap:person@example.test";
    assert_eq!(
        refreshed(&temp.0, account, Err("contacts_network_failed"), 1),
        Err("contacts_network_failed")
    );
    assert_eq!(read(&temp.0, account).unwrap(), None);
    let fresh = refreshed(
        &temp.0,
        account,
        Ok(json!({"accountId":account,
            "books":[{"name":"Personal","contacts":1}],
            "contacts":[{"name":"Ada","email":"ada@example.org"},
                        {"name":"Evil\nName","email":"evil@example.org\r\nBcc: x@y.z"}]})),
        42,
    )
    .unwrap();
    assert_eq!(fresh["cached"], false);
    assert_eq!(fresh["enabled"], true);
    let offline = refreshed(&temp.0, account, Err("contacts_network_failed"), 50).unwrap();
    assert_eq!(offline["cached"], true);
    assert_eq!(offline["error"], "contacts_network_failed");
    assert_eq!(offline["fetchedAt"], 42);
    assert_eq!(offline["books"], json!([{"name":"Personal","contacts":1}]));
    assert_eq!(
        offline["contacts"],
        json!([{"name":"Ada","email":"ada@example.org"}]),
        "a saved row is read back through the address checks"
    );
    assert_eq!(
        read(&temp.0, "imap:other@example.test").unwrap(),
        None,
        "each mailbox has its own snapshot"
    );
    let file = temp
        .0
        .join("omamail/address-books")
        .join(snapshot_name(account));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    forget(&temp.0, account).unwrap();
    assert!(!file.exists());
    assert_eq!(read(&temp.0, account).unwrap(), None);
    forget(&temp.0, account).unwrap();
}

// The consent named a server. A snapshot read from another one goes, a
// background refresh needs a snapshot read from the current server, and the
// Find button's request goes ahead only for the server it showed. Each
// refusal comes before any network or keyring access (no peer exists here).
#[test]
fn books_are_tied_to_the_server_the_person_agreed_to() {
    let temp = Temp::new();
    let account = "imap:person@example.test";
    let found = Ok(json!({"accountId":account,"books":[],
        "contacts":[{"name":"Ada","email":"ada@example.org"}]}));
    assert_eq!(
        may_refresh(&temp.0, account, None, Some("mail.example.test")),
        Err("contacts_server_changed"),
        "no snapshot: a background refresh has nothing it was allowed to read"
    );
    assert_eq!(
        may_refresh(
            &temp.0,
            account,
            Some("other.example.test"),
            Some("mail.example.test")
        ),
        Err("contacts_server_changed"),
        "Find for a server that is no longer the mailbox's"
    );
    assert_eq!(
        may_refresh(
            &temp.0,
            account,
            Some("Mail.Example.test"),
            Some("mail.example.test")
        ),
        Ok(())
    );
    refreshed_from(
        &temp.0,
        account,
        "mail.example.test",
        true,
        found.clone(),
        1,
    )
    .unwrap();
    assert_eq!(
        read_bound(&temp.0, account, Some("mail.example.test")).unwrap()["enabled"],
        true
    );
    assert_eq!(
        may_refresh(&temp.0, account, None, Some("mail.example.test")),
        Ok(())
    );
    // The IMAP host was edited: the next background refresh would sign in to
    // a host no row named, so it is refused and the books go.
    assert_eq!(
        may_refresh(&temp.0, account, None, Some("new.example.test")),
        Err("contacts_server_changed")
    );
    assert_eq!(read(&temp.0, account).unwrap(), None);
    // Refresh pressed on a row still showing the old server's books sends
    // the current host as its server, which no row named: refused, and the
    // old books go, so the row asks again naming the new server.
    refreshed_from(
        &temp.0,
        account,
        "mail.example.test",
        true,
        found.clone(),
        2,
    )
    .unwrap();
    assert_eq!(
        may_refresh(
            &temp.0,
            account,
            Some("new.example.test"),
            Some("new.example.test")
        ),
        Err("contacts_server_changed")
    );
    assert_eq!(read(&temp.0, account).unwrap(), None);
    assert_eq!(
        may_refresh(
            &temp.0,
            account,
            Some("new.example.test"),
            Some("new.example.test")
        ),
        Ok(()),
        "once asked again, Find for the new server goes ahead"
    );
    refreshed_from(
        &temp.0,
        account,
        "mail.example.test",
        true,
        found.clone(),
        2,
    )
    .unwrap();
    assert_eq!(
        read_bound(&temp.0, account, Some("new.example.test")).unwrap(),
        json!({"enabled":false,"error":"contacts_server_changed"})
    );
    assert_eq!(
        read(&temp.0, account).unwrap(),
        None,
        "reading it under another server deletes it"
    );
    // "Stop using" while a background refresh was out: its answer is dropped.
    refreshed_from(
        &temp.0,
        account,
        "mail.example.test",
        true,
        found.clone(),
        3,
    )
    .unwrap();
    forget(&temp.0, account).unwrap();
    assert_eq!(
        refreshed_from(&temp.0, account, "mail.example.test", false, found, 4).unwrap(),
        json!({"enabled":false})
    );
    assert_eq!(
        read(&temp.0, account).unwrap(),
        None,
        "the forgotten snapshot stays forgotten"
    );
}

#[test]
fn only_an_imap_account_and_a_known_operation_are_accepted() {
    assert!(account(&json!({"accountId":"imap:me@example.org","operation":"read"})).is_ok());
    assert!(account(&json!({"accountId":"imap:me@example.org","operation":"refresh","server":"mail.example.org"})).is_ok());
    for params in [
        json!({"accountId":"imap:me@example.org"}),
        json!({"accountId":"me@example.org","operation":"read"}),
        json!({"accountId":"jmap:me@example.org","operation":"read"}),
        json!({"accountId":"imap:me@example.org","operation":"write"}),
        json!({"accountId":"imap:me@example.org\n","operation":"read"}),
        json!({"accountId":"imap:me@example.org","operation":"read","url":"https://x/"}),
        json!({"accountId":"imap:me@example.org","operation":"read","server":"mail.example.org"}),
        json!({"accountId":"imap:me@example.org","operation":"refresh","server":""}),
        json!({"accountId":"imap:me@example.org","operation":"refresh","server":7}),
    ] {
        assert_eq!(account(&params).err(), Some("invalid_params"), "{params}");
    }
}

// The regression through the backend method itself: a snapshot read from the
// old server, then the mailbox's IMAP host edited. Neither Refresh naming the
// new host nor the background refresh may read the keyring or reach the new
// host: the person was never shown it. The new host is a local TLS peer, so a
// regression would show up as a keyring read and requests there.
#[tokio::test]
async fn a_changed_imap_host_gets_no_password_and_no_request() {
    if crate::mail::tests::isolated() {
        return;
    }
    use crate::credentials::{CredentialKey, CredentialStore, Error as StoreError, Secret};
    struct CountingStore(Arc<std::sync::atomic::AtomicUsize>);
    impl CredentialStore for CountingStore {
        fn get(&self, _: &CredentialKey) -> Result<Secret, StoreError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Secret::new(b"synthetic-password".to_vec())
        }
        fn put(&self, _: &CredentialKey, _: &[u8]) -> Result<(), StoreError> {
            panic!("reading address books never stores a credential")
        }
        fn delete(&self, _: &CredentialKey) -> Result<(), StoreError> {
            panic!("reading address books never deletes a credential")
        }
    }
    let account = "imap:person@example.test";
    // The IMAP host is now mail.example.test, which the local peer answers.
    let _fixture = crate::mail::tests::account_fixture(json!({"version":1,"activeId":account,
        "accounts":[{"provider":"imap","email":"person@example.test",
          "imap":{"imapHost":"mail.example.test","imapPort":993,"username":"person@example.test"}}]}));
    let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let _store = crate::credentials::tests::isolated_store(CountingStore(reads.clone()));
    let (server, client) = peer().await;
    let root = crate::platform::dirs::AppDirs::discover().unwrap().cache;
    let saved = || {
        refreshed_from(
            &root,
            account,
            "old.example.test",
            true,
            Ok(json!({"accountId":account,"books":[],
                "contacts":[{"name":"Ada","email":"ada@example.org"}]})),
            1,
        )
        .unwrap();
    };
    saved();
    let find = call_with(
        &json!({"accountId":account,"operation":"refresh","server":"mail.example.test"}),
        &client,
    )
    .await;
    assert_eq!(
        reads.load(Ordering::SeqCst),
        0,
        "Refresh naming the new host read the keyring"
    );
    assert!(
        server.requests().is_empty(),
        "Refresh naming the new host contacted it: {:?}",
        server.requests()
    );
    assert_eq!(
        find,
        Err("contacts_server_changed"),
        "Refresh naming the new host"
    );
    saved();
    let background = call_with(&json!({"accountId":account,"operation":"refresh"}), &client).await;
    assert_eq!(
        background,
        Err("contacts_server_changed"),
        "the background refresh"
    );
    assert_eq!(reads.load(Ordering::SeqCst), 0, "the keyring was read");
    assert!(
        server.requests().is_empty(),
        "the new host was contacted: {:?}",
        server.requests()
    );
    assert_eq!(
        read(&root, account).unwrap(),
        None,
        "the old server's books are gone"
    );
}
