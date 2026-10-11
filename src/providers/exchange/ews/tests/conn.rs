//! The connection: sign-in, scheme choice, and the boundaries it keeps (TLS, redirects, sizes,
//! deadlines, the latch after a refused password).

use std::{sync::Arc, time::Duration};

use rustls::RootCertStore;
use zeroize::Zeroizing;

use super::super::{Choice, Client, Config, Role, endpoint};
use super::fake::{self, Fake, LOGIN, Offer, Out, PASSWORD};

pub fn config(url: &str, choice: Choice, password: &str) -> Config {
    Config {
        url: endpoint(url).unwrap(),
        choice,
        login: LOGIN.to_owned(),
        password: Zeroizing::new(password.to_owned()),
        roots: fake::roots(),
    }
}

pub fn client(fake: &Fake, choice: Choice, password: &str) -> Client {
    Client::new(Arc::new(config(&fake.url(), choice, password)))
}

fn mailbox(fake_op: &fake::Soap) -> Out {
    match fake_op.op.as_str() {
        "GetFolder" => Out::Xml(fake::folders()),
        _ => Out::Drop,
    }
}

#[tokio::test]
async fn ntlm_proves_the_password_on_one_connection_to_a_server_that_checks_everything() {
    // The fake refuses a wrong NTLMv2 proof, MIC, channel binding or service name.
    let fake = Fake::start(Offer::Ntlm, mailbox).await;
    let mut client = client(&fake, Choice::Auto, PASSWORD);
    let folders = client.refresh().await.unwrap();
    assert_eq!(folders.get(Role::Inbox).unwrap().total, 120);
    assert_eq!(client.scheme(), "ntlm");
    assert_eq!(client.version(), Some("15.2.2562"));
    // One stream carried the probe, both NTLM legs and the request (the binding is for that
    // stream), and it spoke HTTP/1.1: IIS refuses connection-bound NTLM over h2.
    assert_eq!(
        fake.log
            .connections
            .load(std::sync::atomic::Ordering::SeqCst),
        1
    );
    assert_eq!(*fake.log.alpn.lock().unwrap(), ["http/1.1"]);
    let schemes: Vec<String> = fake
        .log
        .requests
        .lock()
        .unwrap()
        .iter()
        .map(|r| r.1.clone())
        .collect();
    assert_eq!(schemes, ["", "NTLM", "NTLM"]);
    assert_eq!(fake.log.ops(), ["GetFolder"]);
}

#[tokio::test]
async fn every_request_says_its_length_the_empty_probe_and_leg_included() {
    // IIS answers a POST without a Content-Length with 411 before it looks at anything else, which
    // reads as a server with no usable scheme: the fake does the same, for every offer.
    for offer in [Offer::Ntlm, Offer::Basic] {
        let fake = Fake::start(offer, mailbox).await;
        let mut client = client(&fake, Choice::Auto, PASSWORD);
        assert!(client.refresh().await.is_ok());
    }
}

#[tokio::test]
async fn a_stream_the_server_closed_after_the_probe_is_replaced_before_ntlm_starts_on_it() {
    let fake = Fake::start(Offer::ClosesAfterProbe, mailbox).await;
    let mut client = client(&fake, Choice::Auto, PASSWORD);
    assert!(client.refresh().await.is_ok());
    assert_eq!(
        fake.log
            .connections
            .load(std::sync::atomic::Ordering::SeqCst),
        2
    );
}

#[tokio::test]
async fn a_refused_password_is_tried_once_and_then_latched() {
    let fake = Fake::start(Offer::Ntlm, mailbox).await;
    let mut client = client(&fake, Choice::Ntlm, "not the password");
    assert_eq!(client.refresh().await.err(), Some("exchange_unauthorized"));
    let seen = fake.log.requests.lock().unwrap().len();
    // A directory that counts failed logons would lock the account: nothing more is sent.
    for _ in 0..3 {
        assert_eq!(client.refresh().await.err(), Some("exchange_unauthorized"));
    }
    assert_eq!(fake.log.requests.lock().unwrap().len(), seen);
    assert!(client.rejected());
}

#[tokio::test]
async fn the_scheme_is_chosen_from_what_the_server_offers_and_no_password_goes_where_it_is_not_asked_for()
 {
    // (what the user chose, what the server offers, the scheme or the failure, schemes the server saw)
    let table = [
        (Choice::Auto, Offer::Basic, Ok("basic"), vec!["", "Basic"]),
        (
            Choice::Auto,
            Offer::Both,
            Ok("ntlm"),
            vec!["", "NTLM", "NTLM"],
        ),
        (Choice::Basic, Offer::Both, Ok("basic"), vec!["", "Basic"]),
        (
            Choice::Ntlm,
            Offer::Basic,
            Err("exchange_auth_scheme_unsupported"),
            vec!["NTLM"],
        ),
        (
            Choice::Basic,
            Offer::Ntlm,
            Err("exchange_auth_scheme_unsupported"),
            vec![""],
        ),
        // Both schemes on one header line are read like two lines.
        (
            Choice::Auto,
            Offer::Joined,
            Ok("ntlm"),
            vec!["", "NTLM", "NTLM"],
        ),
        (
            Choice::Ntlm,
            Offer::Joined,
            Ok("ntlm"),
            vec!["NTLM", "NTLM"],
        ),
        // A server that offers only Negotiate is refused, and nothing but the NTLM
        // NEGOTIATE_MESSAGE (no credential) ever leaves the client.
        (
            Choice::Auto,
            Offer::NegotiateOnly,
            Err("exchange_auth_scheme_unsupported"),
            vec![""],
        ),
        (
            Choice::Ntlm,
            Offer::NegotiateOnly,
            Err("exchange_auth_scheme_unsupported"),
            vec!["NTLM"],
        ),
        (
            Choice::Basic,
            Offer::NegotiateOnly,
            Err("exchange_auth_scheme_unsupported"),
            vec![""],
        ),
    ];
    for (choice, offer, expected, schemes) in table {
        let fake = Fake::start(offer, mailbox).await;
        let mut client = client(&fake, choice, PASSWORD);
        let result = client.refresh().await.map(|_| client.scheme());
        assert_eq!(result, expected.map_err(|code: &str| code), "{choice:?}");
        let seen: Vec<String> = fake
            .log
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.1.clone())
            .collect();
        assert_eq!(seen, schemes);
    }
}

#[tokio::test]
async fn a_client_that_signed_in_with_ntlm_never_sends_basic_to_a_later_stream() {
    let fake = Fake::start(Offer::NtlmThenBasic, mailbox).await;
    let mut client = client(&fake, Choice::Auto, PASSWORD);
    client.refresh().await.unwrap();
    assert_eq!(client.scheme(), "ntlm");
    // The stream is gone (an `exchange.invalidate`, a server that closed it); the next one is
    // offered Basic alone and gets the NTLM NEGOTIATE, which carries nothing secret.
    client.forget();
    assert_eq!(
        client.refresh().await.err(),
        Some("exchange_auth_scheme_unsupported")
    );
    let later: Vec<String> = fake
        .log
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.0 == 1)
        .map(|r| r.1.clone())
        .collect();
    assert_eq!(later, ["NTLM"]);
}

#[tokio::test]
async fn a_client_that_signed_in_with_basic_keeps_preferring_ntlm_on_a_later_stream() {
    let fake = Fake::start(Offer::BasicThenBoth, mailbox).await;
    let mut client = client(&fake, Choice::Auto, PASSWORD);
    client.refresh().await.unwrap();
    assert_eq!(client.scheme(), "basic");
    // One stream that was offered Basic alone does not make Basic the client's method.
    client.forget();
    client.refresh().await.unwrap();
    assert_eq!(client.scheme(), "ntlm");
}

#[tokio::test]
async fn a_redirect_is_refused_and_never_followed() {
    let elsewhere = Fake::start(Offer::Basic, mailbox).await;
    let target = elsewhere.url();
    let fake = Fake::start(Offer::Basic, move |_| {
        Out::Status(302, vec![("Location", target.clone())])
    })
    .await;
    let mut client = client(&fake, Choice::Basic, PASSWORD);
    assert_eq!(
        client.refresh().await.err(),
        Some("exchange_redirect_refused")
    );
    assert_eq!(
        elsewhere
            .log
            .connections
            .load(std::sync::atomic::Ordering::SeqCst),
        0
    );
}

#[tokio::test]
async fn the_server_is_verified_before_a_byte_is_sent() {
    let fake = Fake::start(Offer::Basic, mailbox).await;
    // A chain that ends in an authority nobody here trusts, and a name the certificate lacks.
    let mut untrusted = config(&fake.url(), Choice::Basic, PASSWORD);
    untrusted.roots = Arc::new(RootCertStore::empty());
    let by_address = config(
        &fake.url().replace("localhost", "127.0.0.1"),
        Choice::Basic,
        PASSWORD,
    );
    for config in [untrusted, by_address] {
        let mut client = Client::new(Arc::new(config));
        assert_eq!(client.refresh().await.err(), Some("exchange_tls_failed"));
    }
    assert!(fake.log.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn answers_and_headers_are_bounded() {
    let big = Fake::start(Offer::Basic, |_| Out::Xml("x".repeat(37 * 1024 * 1024))).await;
    assert_eq!(
        client(&big, Choice::Basic, PASSWORD).refresh().await.err(),
        Some("exchange_response_too_large")
    );
    let wide = Fake::start(Offer::Basic, |_| {
        Out::Status(503, vec![("X-Long", "y".repeat(300_000))])
    })
    .await;
    assert_eq!(
        client(&wide, Choice::Basic, PASSWORD).refresh().await.err(),
        Some("exchange_connection_closed")
    );
    let torn = Fake::start(Offer::Basic, |_| Out::Torn).await;
    assert_eq!(
        client(&torn, Choice::Basic, PASSWORD).refresh().await.err(),
        Some("exchange_connection_closed")
    );
}

#[tokio::test(start_paused = true)]
async fn a_server_that_never_answers_ends_at_the_deadline() {
    let fake = Fake::start(Offer::Basic, |_| Out::Hang).await;
    let started = tokio::time::Instant::now();
    assert_eq!(
        client(&fake, Choice::Basic, PASSWORD).refresh().await.err(),
        Some("exchange_timeout")
    );
    assert!(
        started.elapsed() >= Duration::from_secs(20) && started.elapsed() < Duration::from_secs(25)
    );
}

#[test]
fn only_https_endpoints_with_the_ews_path_and_no_embedded_credentials_are_taken() {
    for good in [
        "https://mail.example.org/EWS/Exchange.asmx",
        "https://mail.example.org:444/ews/exchange.asmx",
        "https://[::1]/a/EWS/Exchange.asmx",
    ] {
        assert!(endpoint(good).is_ok(), "{good}");
    }
    for bad in [
        "http://mail.example.org/EWS/Exchange.asmx",
        "https://user:pw@mail.example.org/EWS/Exchange.asmx",
        "https://mail.example.org/EWS/Exchange.asmx?x=1",
        "https://mail.example.org/EWS/Exchange.asmx#f",
        "https://mail.example.org/",
        "https://mail.example.org/fooEWS/Exchange.asmx.evil",
        "ftp://mail.example.org/EWS/Exchange.asmx",
        "mail.example.org/EWS/Exchange.asmx",
        "https:///EWS/Exchange.asmx",
        "",
    ] {
        assert_eq!(endpoint(bad).err(), Some("exchange_url_invalid"), "{bad}");
    }
}
