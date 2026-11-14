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
