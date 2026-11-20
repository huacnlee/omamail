use super::*;
use crate::test_support::peers::ScriptedHttpsPeer;
use std::net::SocketAddr;
use std::sync::Arc;

struct Peer {
    server: ScriptedHttpsPeer,
    client: reqwest::Client,
    port: u16,
}

// No lookup can leave the test, even if a regression accepts a foreign host.
struct LoopbackDns(SocketAddr);
impl reqwest::dns::Resolve for LoopbackDns {
    fn resolve(&self, _: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let address = self.0;
        Box::pin(async move { Ok(Box::new(std::iter::once(address)) as reqwest::dns::Addrs) })
    }
}

impl Peer {
    async fn new() -> Self {
        let server = ScriptedHttpsPeer::start().await;
        let address: SocketAddr = format!("127.0.0.1:{}", server.port).parse().unwrap();
        let certificate = reqwest::Certificate::from_pem(
            &std::fs::read(crate::test_support::tls::testdata("discovery.pem")).unwrap(),
        )
        .unwrap();
        let client = super::super::client_builder()
            .dns_resolver(Arc::new(LoopbackDns(address)))
            .add_root_certificate(certificate)
            .build()
            .unwrap();
        Self {
            server,
            client,
            port: address.port(),
        }
    }

    fn responses(&self, responses: Value) {
        self.server.responses(responses);
    }

    fn requests(&self) -> Vec<Value> {
        self.server.requests()
    }

    async fn dav(&self) -> Result<(Url, String), &'static str> {
        dav_propfind_with_client(
            &self.client,
            icloud_url("https://caldav.icloud.com/principal/").unwrap(),
            "synthetic@example.test",
            "synthetic-password",
            "0",
            "<propfind>\n</propfind>",
        )
        .await
    }
}

#[tokio::test]
async fn https_icloud_redirects_never_send_credentials_to_foreign_origins() {
    let peer = Peer::new().await;
    let foreign_port = format!("https://p37-caldav.icloud.com:{}/stolen", peer.port);
    let loopback = format!("https://127.0.0.1:{}/stolen", peer.port);
    for status in [301, 302, 303, 307, 308] {
        for location in [
            "https://outside.example.test/stolen",
            "//outside.example.test/stolen",
            "http://outside.example.test/stolen",
            "https://caldav.icloud.com.outside.example.test/stolen",
            "https://caldav.icloud.com@outside.example.test/stolen",
            "https://outside.example.test%2f@caldav.icloud.com/stolen",
            "https://outside.example.test\\@caldav.icloud.com/stolen",
            &foreign_port,
            &loopback,
            "https://caldav.icloud.com/stolen#fragment",
        ] {
            peer.responses(json!([{"status":status,"location":location}, {"body":"stolen"}]));
            assert!(peer.dav().await.is_err(), "accepted {status}: {location}");
            let requests = peer.requests();
            assert_eq!(
                requests.len(),
                1,
                "followed {status}: {location}: {requests:?}"
            );
            assert_eq!(requests[0]["host"], "caldav.icloud.com");
            assert_eq!(requests[0]["method"], "PROPFIND");
            assert!(
                requests[0]["authorization"]
                    .as_str()
                    .unwrap()
                    .starts_with("Basic ")
            );
        }
    }
    // Positive control: a trusted Apple partition receives the same method,
    // credential and legitimate multiline body, not a rewritten GET.
    peer.responses(json!([
        {"status":307,"location":"https://p37-caldav.icloud.com/home/"},
        {"status":207,"body":"<multistatus/>"}
    ]));
    let (url, body) = peer.dav().await.unwrap();
    assert_eq!(url.as_str(), "https://p37-caldav.icloud.com/home/");
    assert_eq!(body, "<multistatus/>");
    let requests = peer.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1]["host"], "p37-caldav.icloud.com");
    for key in ["method", "authorization", "depth", "body"] {
        assert_eq!(requests[0][key], requests[1][key], "{key}");
    }
    peer.responses(Value::Array(vec![
        json!({"status":307,"location":"/loop"});
        5
    ]));
    assert_eq!(peer.dav().await.err(), Some("calendar_too_many_redirects"));
    assert_eq!(peer.requests().len(), 4);
}

#[tokio::test]
async fn https_graph_redirects_and_next_links_do_not_leak_bearer_tokens() {
    let peer = Peer::new().await;
    for status in [301, 302, 303, 307, 308] {
        peer.responses(json!([{"status":status,"location":"https://outside.example.test/stolen"}]));
        assert_eq!(
            microsoft_with_client(
                &peer.client,
                "outlook:synthetic@example.test",
                "synthetic-token"
            )
            .await,
            Err("calendar_request_failed")
        );
        assert_eq!(peer.requests().len(), 1);
    }
    for next in [
        "https://outside.example.test/v1.0/me/calendars",
        "http://graph.microsoft.com/v1.0/me/calendars",
        "https://graph.microsoft.com/v1.0/me/messages",
        "https://graph.microsoft.com/v1.0/me/calendars\n",
        "https://graph.microsoft.com/v1.0/me/calendars\r",
        "https://graph.microsoft.com/v1.0/me/calendars\r\n",
        "https://graph.microsoft.com/v1.0/me/calendars\0",
    ] {
        peer.responses(json!([{"body":json!({"value":[],"@odata.nextLink":next}).to_string()}]));
        assert!(
            microsoft_with_client(
                &peer.client,
                "outlook:synthetic@example.test",
                "synthetic-token"
            )
            .await
            .is_err()
        );
        let requests = peer.requests();
        assert_eq!(requests.len(), 1, "followed {next:?}");
        assert_eq!(requests[0]["host"], "graph.microsoft.com");
        assert_eq!(requests[0]["authorization"], "Bearer synthetic-token");
    }
    peer.responses(json!([
        {"body":json!({"value":[],"@odata.nextLink":"https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=next%2Bpage"}).to_string()},
        {"body":json!({"value":[{"id":"cal/one","name":"Work & Reise ü","canEdit":true}]}).to_string()}
    ]));
    let result = microsoft_with_client(
        &peer.client,
        "outlook:synthetic@example.test",
        "synthetic-token",
    )
    .await
    .unwrap();
    assert_eq!(result["calendars"][0]["name"], "Work & Reise ü");
    let requests = peer.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1]["path"],
        "/v1.0/me/calendars?$skiptoken=next%2Bpage"
    );
}

fn mailbox() -> Mailbox {
    Mailbox {
        origin: mailbox_origin("mail.example.test").unwrap(),
        username: "person@example.test".into(),
    }
}

const MULTISTATUS: &str =
    r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">"#;

// The shape Radicale answers in behind a path prefix: the well-known address
// redirects to the prefix, which names the principal, which is also the home.
#[tokio::test]
async fn https_mailbox_discovery_follows_well_known_and_keeps_the_password_on_the_mail_host() {
    let peer = Peer::new().await;
    let principal = format!(
        "{MULTISTATUS}<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/dav/person%40example.test/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>"
    );
    let home = format!(
        "{MULTISTATUS}<d:response><d:href>/dav/person%40example.test/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/dav/person%40example.test/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>"
    );
    let collections = format!(
        "{MULTISTATUS}<d:response><d:href>/dav/person%40example.test/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/person%40example.test/%D0%9A%D0%B0%D0%BB%D0%B5%D0%BD%D0%B4%D0%B0%D1%80%D1%8C/</d:href><d:propstat><d:prop><d:displayname>Team</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name=\"VEVENT\"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:all/></d:privilege></d:current-user-privilege-set></d:prop></d:propstat></d:response><d:response><d:href>/dav/person%40example.test/contacts/</d:href><d:propstat><d:prop><d:displayname>Contacts</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>"
    );
    peer.responses(json!([
        {"status":301,"location":"https://mail.example.test/dav/"},
        {"status":207,"body":principal},
        {"status":207,"body":home},
        {"status":207,"body":collections},
    ]));
    let found = mailbox_calendars_with(
        &peer.client,
        "imap:person@example.test",
        &mailbox(),
        "synthetic-password",
    )
    .await
    .unwrap();
    assert_eq!(found["provider"], "imap");
    let calendars = found["calendars"].as_array().unwrap();
    assert_eq!(calendars.len(), 1, "{found}");
    assert_eq!(calendars[0]["name"], "Team");
    assert_eq!(calendars[0]["readOnly"], false);
    assert_eq!(
        calendars[0]["url"],
        "https://mail.example.test/dav/person%40example.test/%D0%9A%D0%B0%D0%BB%D0%B5%D0%BD%D0%B4%D0%B0%D1%80%D1%8C/"
    );
    let requests = peer.requests();
    let paths: Vec<_> = requests.iter().map(|r| r["path"].clone()).collect();
    assert_eq!(
        paths,
        json!([
            "/.well-known/caldav",
            "/dav/",
            "/dav/person%40example.test/",
            "/dav/person%40example.test/"
        ])
        .as_array()
        .unwrap()
        .clone()
    );
    assert_eq!(requests[3]["depth"], "1");
    for request in &requests {
        assert!(
            request["host"]
                .as_str()
                .unwrap()
                .starts_with("mail.example.test")
        );
        assert_eq!(request["method"], "PROPFIND");
    }
}

#[tokio::test]
async fn https_mailbox_discovery_never_sends_the_password_off_the_mail_host() {
    let peer = Peer::new().await;
    let foreign_port = format!("https://mail.example.test:{}/stolen", peer.port);
    for location in [
        "https://outside.example.test/stolen",
        "//outside.example.test/stolen",
        "http://mail.example.test/stolen",
        "https://mail.example.test.outside.example.test/stolen",
        "https://mail.example.test@outside.example.test/stolen",
        "https://person@mail.example.test/stolen",
        "https://mail.example.test/stolen#fragment",
        &foreign_port,
    ] {
        peer.responses(json!([{"status":307,"location":location}, {"body":"stolen"}]));
        let error = mailbox_calendars_with(
            &peer.client,
            "imap:person@example.test",
            &mailbox(),
            "synthetic-password",
        )
        .await
        .unwrap_err();
        let requests = peer.requests();
        assert_eq!(requests.len(), 1, "followed {location}: {requests:?}");
        assert_eq!(requests[0]["path"], "/.well-known/caldav");
        assert!(
            matches!(
                error,
                "calendar_origin_refused" | "calendar_invalid_response"
            ),
            "{location}: {error}"
        );
    }
    // A principal or home the server names elsewhere is refused the same way.
    let principal = format!(
        "{MULTISTATUS}<d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>https://outside.example.test/p/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>"
    );
    peer.responses(json!([{"status":207,"body":principal}, {"body":"stolen"}]));
    assert_eq!(
        mailbox_calendars_with(
            &peer.client,
            "imap:person@example.test",
            &mailbox(),
            "synthetic-password",
        )
        .await
        .err(),
        Some("calendar_origin_refused")
    );
    assert_eq!(peer.requests().len(), 1);
    // A refused password is not retried at the server root.
    peer.responses(json!([{"status":401}, {"status":207,"body":"stolen"}]));
    assert_eq!(
        mailbox_calendars_with(
            &peer.client,
            "imap:person@example.test",
            &mailbox(),
            "synthetic-password",
        )
        .await
        .err(),
        Some("calendar_auth_refused")
    );
    assert_eq!(peer.requests().len(), 1);
}

// Without a well-known redirect the server root is asked, as RFC 6764 §5
// allows; nothing beyond these two starting points is guessed.
#[tokio::test]
async fn https_mailbox_discovery_falls_back_to_the_server_root_once() {
    let peer = Peer::new().await;
    peer.responses(json!([{"status":404}, {"status":404}]));
    assert!(
        mailbox_calendars_with(
            &peer.client,
            "imap:person@example.test",
            &mailbox(),
            "synthetic-password",
        )
        .await
        .is_err()
    );
    let paths: Vec<_> = peer.requests().iter().map(|r| r["path"].clone()).collect();
    assert_eq!(paths, vec![json!("/.well-known/caldav"), json!("/")]);
}
