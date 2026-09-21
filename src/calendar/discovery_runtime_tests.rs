use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::SocketAddr;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;

struct Peer {
    process: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
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
    fn new() -> Self {
        let mut process = Command::new("python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/calendar/discovery_tls_test.py"
            ))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = process.stdin.take().unwrap();
        let mut output = BufReader::new(process.stdout.take().unwrap());
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        let info: Value = serde_json::from_str(&line).unwrap();
        let address: SocketAddr = format!("127.0.0.1:{}", info["port"]).parse().unwrap();
        let certificate = reqwest::Certificate::from_pem(
            &std::fs::read(info["certificate"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        let client = super::super::client_builder()
            .dns_resolver(Arc::new(LoopbackDns(address)))
            .add_root_certificate(certificate)
            .build()
            .unwrap();
        Self {
            process,
            input,
            output,
            client,
            port: address.port(),
        }
    }

    fn command(&mut self, value: Value) -> Value {
        writeln!(self.input, "{value}").unwrap();
        self.input.flush().unwrap();
        let mut line = String::new();
        self.output.read_line(&mut line).unwrap();
        serde_json::from_str(&line).unwrap()
    }

    fn responses(&mut self, responses: Value) {
        self.command(json!({"responses": responses}));
    }

    fn requests(&mut self) -> Vec<Value> {
        let report = self.command(json!({}));
        let requests = report["requests"].as_array().unwrap().clone();
        assert_eq!(
            report["connections"].as_u64().unwrap(),
            requests.len() as u64,
            "an unexpected connection occurred even though TLS prevented an HTTP request"
        );
        requests
    }

    async fn dav(&self) -> Result<(Url, String), &'static str> {
        dav_propfind_with_client(
            &self.client,
            icloud_url("https://caldav.icloud.com/principal/").unwrap(),
            "synthetic@example.test",
            "synthetic-password",
            "0",
            "<propfind>\n</propfind>",
            &resolve_icloud,
        )
        .await
    }

    async fn caldav_server(&self, url: &str) -> Result<Value, &'static str> {
        caldav_server_with_client(
            &self.client,
            url,
            "synthetic@example.test",
            "synthetic-password",
        )
        .await
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = writeln!(self.input, "{{\"stop\":true}}");
        let _ = self.input.flush();
        let _ = self.process.wait();
    }
}

#[tokio::test]
async fn https_icloud_redirects_never_send_credentials_to_foreign_origins() {
    let mut peer = Peer::new();
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
    let mut peer = Peer::new();
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

// Reproduces Fastmail's actual behaviour: the bare server address 404s, and
// only `/.well-known/caldav` on that same host says where the real service
// lives. The well-known probe's own redirect target is treated only as
// "discovery has a root now" — resolve_caldav_root discards that response
// and the principal is queried fresh at the resolved root — so this walk
// makes five requests, not three, for one discovered calendar.
#[tokio::test]
async fn a_fastmail_like_bare_address_resolves_through_its_own_well_known_redirect() {
    let mut peer = Peer::new();
    peer.responses(json!([
        {"status":301,"location":"/dav/calendars"},
        {"status":207,"body":"<multistatus/>"},
        {"status":207,"body":r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/calendars</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/dav/principals/user/me@fastmail.com/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>"#},
        {"status":207,"body":r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/principals/user/me@fastmail.com/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/dav/calendars/user/me@fastmail.com/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>"#},
        {"status":207,"body":r#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/calendars/user/me@fastmail.com/abc123/</d:href><d:propstat><d:prop><d:displayname>Personal</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:write-content/></d:privilege></d:current-user-privilege-set></d:prop></d:propstat></d:response></d:multistatus>"#}
    ]));
    let result = peer
        .caldav_server("https://caldav.fastmail.com/")
        .await
        .unwrap();
    assert_eq!(result["calendars"][0]["name"], "Personal");
    assert_eq!(
        result["calendars"][0]["url"],
        "https://caldav.fastmail.com/dav/calendars/user/me@fastmail.com/abc123/"
    );
    assert_eq!(result["calendars"][0]["readOnly"], false);
    let requests = peer.requests();
    assert_eq!(requests.len(), 5, "{requests:?}");
    for request in &requests {
        assert_eq!(request["host"], "caldav.fastmail.com");
        assert!(
            request["authorization"]
                .as_str()
                .unwrap()
                .starts_with("Basic ")
        );
    }
}

// The well-known redirect is exactly the hop `https_icloud_redirects_never_
// send_credentials_to_foreign_origins` already distrusts a server-supplied
// address at — generic discovery must refuse it just as strictly, and must
// not paper over the refusal as "no well-known here" and silently fall back
// to the entered address.
#[tokio::test]
async fn a_well_known_redirect_leaving_the_entered_origin_is_refused_not_swallowed() {
    let mut peer = Peer::new();
    for location in [
        "https://outside.example.test/stolen",
        "//outside.example.test/stolen",
        "http://caldav.fastmail.com/stolen",
    ] {
        peer.responses(json!([{"status":301,"location":location}]));
        assert_eq!(
            peer.caldav_server("https://caldav.fastmail.com/")
                .await
                .err(),
            Some("calendar_origin_refused"),
            "{location}"
        );
        assert_eq!(peer.requests().len(), 1, "{location}");
    }
}
