//! A scripted EWS server over TLS (the repository's synthetic `localhost` certificate) with real
//! HTTP/1.1 framing of its own, NTLM and Basic sign-in, and per-connection logs. NTLM verification
//! is written here from MS-NLMP independently of `ntlm.rs`, so a client that gets the response,
//! the MIC or the channel binding wrong is refused, as IIS would.

use std::sync::{
    Arc, Mutex, OnceLock,
    atomic::{AtomicUsize, Ordering},
};

use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, KeyInit, Mac};
use md4::Md4;
use md5::{Digest as _, Md5};
use rustls::{
    RootCertStore, ServerConfig,
    pki_types::{CertificateDer, PrivateKeyDer, pem::PemObject},
};
use sha2::{Digest as _, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use tokio_rustls::TlsAcceptor;

pub const LOGIN: &str = "EXAMPLE\\ada";
pub const PASSWORD: &str = "synthetic-Passw0rd";
const CA: &str = include_str!("../../../testdata/tls/ca.pem");
const SERVER: &str = include_str!("../../../testdata/tls/server.pem");
const KEY: &str = include_str!("../../../testdata/tls/server-key.pem");

/// Roots that trust the synthetic CA (production roots would not).
pub fn roots() -> Arc<RootCertStore> {
    static ROOTS: OnceLock<Arc<RootCertStore>> = OnceLock::new();
    ROOTS
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            roots
                .add(CertificateDer::from_pem_slice(CA.as_bytes()).unwrap())
                .unwrap();
            Arc::new(roots)
        })
        .clone()
}

pub fn server_cert() -> Vec<u8> {
    CertificateDer::from_pem_slice(SERVER.as_bytes())
        .unwrap()
        .to_vec()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Offer {
    /// `Negotiate` and `NTLM` on two header lines, exactly as the real IIS answers.
    Ntlm,
    /// The same two schemes joined into one header line.
    Joined,
    /// `Negotiate` alone: nothing this client speaks.
    NegotiateOnly,
    Basic,
    /// NTLM and Basic both.
    Both,
    /// NTLM, but a stream that has only been asked for its schemes is closed afterwards.
    ClosesAfterProbe,
    /// NTLM on the first connection and Basic alone on every later one, as a node behind the same
    /// address that was set up differently would.
    NtlmThenBasic,
    /// Basic alone on the first connection (something in between stripped NTLM) and both later.
    BasicThenBoth,
}

/// An authenticated SOAP request as the script sees it.
pub struct Soap {
    /// The operation element of the Body (`GetFolder`, `FindItem`, ...).
    pub op: String,
    pub body: String,
    /// Which connection (0 first).
    pub conn: usize,
}

pub enum Out {
    Xml(String),
    Status(u16, Vec<(&'static str, String)>),
    /// Close the connection without answering.
    Drop,
    /// Answer, then close the connection (an idle stream the server gave up on).
    XmlClose(String),
    /// Never answer.
    Hang,
    /// Answer after this many milliseconds.
    Later(u64, String),
    /// Write only the beginning of an answer, then close.
    Torn,
}

#[derive(Default)]
pub struct Log {
    pub connections: AtomicUsize,
    /// (connection, authorization scheme or "", operation) of every request that reached the script
    /// or was refused at sign-in; the operation is empty for sign-in legs.
    pub requests: Mutex<Vec<(usize, String, String)>>,
    pub alpn: Mutex<Vec<String>>,
}

impl Log {
    pub fn ops(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.2.clone())
            .filter(|op| !op.is_empty())
            .collect()
    }
    pub fn count(&self, op: &str) -> usize {
        self.ops().iter().filter(|seen| *seen == op).count()
    }
}

pub struct Fake {
    pub port: u16,
    pub log: Arc<Log>,
}

type Script = Arc<dyn Fn(&Soap) -> Out + Send + Sync>;

impl Fake {
    pub async fn start(
        offer: Offer,
        script: impl Fn(&Soap) -> Out + Send + Sync + 'static,
    ) -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Log::default());
        let mut tls =
            ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![CertificateDer::from_pem_slice(SERVER.as_bytes()).unwrap()],
                    PrivateKeyDer::from_pem_slice(KEY.as_bytes()).unwrap(),
                )
                .unwrap();
        tls.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let (acceptor, script, seen) = (
            TlsAcceptor::from(Arc::new(tls)),
            Arc::new(script) as Script,
            log.clone(),
        );
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let (acceptor, script, log) = (acceptor.clone(), script.clone(), seen.clone());
                let conn = log.connections.fetch_add(1, Ordering::SeqCst);
                let offer = match offer {
                    Offer::NtlmThenBasic if conn == 0 => Offer::Ntlm,
                    Offer::NtlmThenBasic => Offer::Basic,
                    Offer::BasicThenBoth if conn == 0 => Offer::Basic,
                    Offer::BasicThenBoth => Offer::Both,
                    offer => offer,
                };
                tokio::spawn(async move {
                    if let Ok(tls) = acceptor.accept(tcp).await {
                        let alpn = tls
                            .get_ref()
                            .1
                            .alpn_protocol()
                            .map(|p| String::from_utf8_lossy(p).into_owned());
                        log.alpn.lock().unwrap().push(alpn.unwrap_or_default());
                        serve(tls, offer, script, log, conn).await;
                    }
                });
            }
        });
        Fake { port, log }
    }

    pub fn url(&self) -> String {
        format!("https://localhost:{}/EWS/Exchange.asmx", self.port)
    }
}

struct Req {
    /// Request line and headers, as received.
    head: String,
    body: Vec<u8>,
}

impl Req {
    fn header(&self, name: &str) -> Option<&str> {
        self.head.lines().skip(1).find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then_some(value.trim())
        })
    }
}

async fn read_request<S: AsyncReadExt + Unpin>(stream: &mut S) -> Option<Req> {
    let mut buf = Vec::new();
    let end = loop {
        if let Some(at) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break at + 4;
        }
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let length = head
        .lines()
        .find_map(|l| {
            l.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|v| v.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = buf[end..].to_vec();
    while body.len() < length {
        let mut chunk = [0u8; 65536];
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some(Req { head, body })
}

/// An answer with the headers IIS and Exchange put on every one (`Server`, `request-id`,
/// `X-Powered-By`, `X-FEServer`, `Date`). A 200 is chunked and sets two cookies, as EWS does; anything
/// else has a `Content-Length`, a 401 included (zero).
async fn respond<S: AsyncWriteExt + Unpin>(
    stream: &mut S,
    status: u16,
    headers: &[(&str, String)],
    body: &[u8],
) {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        411 => "Length Required",
        _ => "X",
    };
    let mut out = format!(
        "HTTP/1.1 {status} {reason}\r\nServer: Microsoft-IIS/10.0\r\nrequest-id: 5b0c2a54-7a52-4f6e-9d51-000000000001\r\nX-OWA-Version: 15.2.2562.53\r\n"
    );
    for (name, value) in headers {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("X-Powered-By: ASP.NET\r\nX-FEServer: EXCHANGE-2025\r\nDate: Sun, 11 Oct 2026 08:00:00 GMT\r\n");
    let chunked = status == 200;
    if chunked {
        out.push_str("Set-Cookie: X-BackEndCookie=S-1-5-21=abc; path=/EWS; secure; HttpOnly\r\nSet-Cookie: X-BackEndCookie2=def; path=/EWS; secure; HttpOnly\r\nTransfer-Encoding: chunked\r\n\r\n");
        let _ = stream.write_all(out.as_bytes()).await;
        for piece in body.chunks(if body.len() > 100_000 { 65536 } else { 1000 }) {
            let _ = stream
                .write_all(format!("{:x}\r\n", piece.len()).as_bytes())
                .await;
            let _ = stream.write_all(piece).await;
            let _ = stream.write_all(b"\r\n").await;
        }
        let _ = stream.write_all(b"0\r\n\r\n").await;
    } else {
        out.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        let _ = stream.write_all(out.as_bytes()).await;
        let _ = stream.write_all(body).await;
    }
    let _ = stream.flush().await;
}

fn operation(body: &str) -> String {
    let at = body.find("<soap:Body>").map_or(0, |at| at + 11);
    let rest = &body[at..];
    let name: String = rest
        .trim_start_matches('<')
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != '>' && *c != '/')
        .collect();
    name.rsplit(':').next().unwrap_or_default().to_owned()
}

async fn serve<S>(mut stream: S, offer: Offer, script: Script, log: Arc<Log>, conn: usize)
where
    S: AsyncReadExt + AsyncWriteExt + Unpin,
{
    let challenges = |ntlm: Option<&str>| -> Vec<(&'static str, String)> {
        let mut headers = Vec::new();
        // The CHALLENGE answers on a line of its own, as IIS does.
        if let Some(token) = ntlm {
            return vec![("WWW-Authenticate", format!("NTLM {token}"))];
        }
        match offer {
            Offer::Basic => {}
            Offer::Joined => headers.push(("WWW-Authenticate", "Negotiate, NTLM".to_owned())),
            Offer::NegotiateOnly => headers.push(("WWW-Authenticate", "Negotiate".to_owned())),
            _ => {
                headers.push(("WWW-Authenticate", "Negotiate".to_owned()));
                headers.push(("WWW-Authenticate", "NTLM".to_owned()));
            }
        }
        if matches!(offer, Offer::Basic | Offer::Both) {
            headers.push(("WWW-Authenticate", "Basic realm=\"mail\"".to_owned()));
        }
        headers
    };
    let (mut authed, mut types) = (false, (Vec::new(), Vec::new()));
    while let Some(req) = read_request(&mut stream).await {
        // IIS refuses a POST that does not say how long it is, before it looks at anything else.
        if req.header("content-length").is_none() {
            respond(&mut stream, 411, &[], b"").await;
            return;
        }
        let auth = req.header("authorization").map(str::to_owned);
        let scheme = auth
            .as_deref()
            .and_then(|a| a.split(' ').next())
            .unwrap_or("")
            .to_owned();
        let mut passed = authed;
        if !authed {
            match (scheme.to_ascii_lowercase().as_str(), auth.as_deref()) {
                ("ntlm", Some(value)) if !matches!(offer, Offer::Basic | Offer::NegotiateOnly) => {
                    let message = STANDARD
                        .decode(value.split(' ').nth(1).unwrap_or(""))
                        .unwrap_or_default();
                    match message.get(8) {
                        Some(1) => {
                            types.0 = message;
                            types.1 = challenge(true);
                            log.requests
                                .lock()
                                .unwrap()
                                .push((conn, scheme, String::new()));
                            respond(
                                &mut stream,
                                401,
                                &challenges(Some(&STANDARD.encode(&types.1))),
                                b"",
                            )
                            .await;
                            continue;
                        }
                        Some(3) if verify(&message, &types.0, &types.1).is_ok() => {
                            authed = true;
                            passed = true;
                        }
                        _ => {}
                    }
                }
                ("basic", Some(value))
                    if !matches!(
                        offer,
                        Offer::Ntlm
                            | Offer::Joined
                            | Offer::NegotiateOnly
                            | Offer::ClosesAfterProbe
                    ) =>
                {
                    let expected = STANDARD.encode(format!("{LOGIN}:{PASSWORD}"));
                    passed = value.split(' ').nth(1) == Some(expected.as_str());
                }
                _ => {}
            }
        } else if offer == Offer::Basic {
            passed = scheme.eq_ignore_ascii_case("basic");
        }
        if !passed {
            log.requests
                .lock()
                .unwrap()
                .push((conn, scheme, String::new()));
            let closing = offer == Offer::ClosesAfterProbe && auth.is_none();
            let mut headers = challenges(None);
            headers.push(("Persistent-Auth", "true".to_owned()));
            if closing {
                headers.push(("Connection", "close".to_owned()));
            }
            respond(&mut stream, 401, &headers, b"").await;
            if closing {
                return;
            }
            continue;
        }
        let body = String::from_utf8_lossy(&req.body).into_owned();
        let soap = Soap {
            op: operation(&body),
            body,
            conn,
        };
        log.requests
            .lock()
            .unwrap()
            .push((conn, scheme, soap.op.clone()));
        match script(&soap) {
            Out::Xml(xml) => {
                respond(
                    &mut stream,
                    200,
                    &[("Content-Type", "text/xml".into())],
                    xml.as_bytes(),
                )
                .await
            }
            Out::Status(status, headers) => {
                respond(&mut stream, status, &headers, b"<html>no</html>").await
            }
            Out::Drop => return,
            Out::XmlClose(xml) => {
                respond(&mut stream, 200, &[], xml.as_bytes()).await;
                return;
            }
            Out::Hang => std::future::pending::<()>().await,
            Out::Later(ms, xml) => {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                respond(&mut stream, 200, &[], xml.as_bytes()).await;
            }
            Out::Torn => {
                let _ = stream
                    .write_all(b"HTTP/1.1 200 X\r\nContent-Length: 500\r\n\r\n<soap")
                    .await;
                return;
            }
        }
    }
}

const SERVER_CHALLENGE: [u8; 8] = *b"01234567";
const TIME: [u8; 8] = [0x80, 0x3e, 0xd5, 0xde, 0xb1, 0x9d, 0xdc, 0x01];

fn wide(text: &str) -> Vec<u8> {
    text.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

fn pair(id: u16, value: &[u8]) -> Vec<u8> {
    [
        &id.to_le_bytes()[..],
        &(value.len() as u16).to_le_bytes(),
        value,
    ]
    .concat()
}

/// A CHALLENGE_MESSAGE as Exchange 2019 sends it: flags 0xe2898215, a TargetName, a Version and a
/// TargetInfo of the NetBIOS and DNS names, the tree name and the MsvAvTimestamp (or without it).
pub fn challenge(timestamp: bool) -> Vec<u8> {
    let stamp = if timestamp {
        pair(7, &TIME)
    } else {
        Vec::new()
    };
    let info = [
        pair(2, &wide("EXAMPLE")),
        pair(1, &wide("MAIL")),
        pair(4, &wide("example.org")),
        pair(3, &wide("mail.example.org")),
        pair(5, &wide("example.org")),
        stamp,
        pair(0, &[]),
    ]
    .concat();
    let name = wide("EXAMPLE");
    let mut m = b"NTLMSSP\0".to_vec();
    m.extend(2u32.to_le_bytes());
    m.extend((name.len() as u16).to_le_bytes().repeat(2));
    m.extend(56u32.to_le_bytes());
    m.extend(0xe289_8215u32.to_le_bytes());
    m.extend(SERVER_CHALLENGE);
    m.extend([0; 8]);
    m.extend((info.len() as u16).to_le_bytes().repeat(2));
    m.extend((56 + name.len() as u32).to_le_bytes());
    m.extend([10, 0, 0x63, 0x45, 0, 0, 0, 15]);
    m.extend(name);
    m.extend(info);
    m
}

fn mac(key: &[u8], parts: &[&[u8]]) -> [u8; 16] {
    let mut mac = <Hmac<Md5> as KeyInit>::new_from_slice(key).unwrap();
    parts.iter().for_each(|part| mac.update(part));
    mac.finalize().into_bytes().into()
}

/// What IIS with Extended Protection checks of an AUTHENTICATE_MESSAGE: the NTLMv2 proof for the
/// password, the MIC over the three messages, the channel binding of this server's certificate and
/// the service name.
pub fn verify(message: &[u8], negotiate: &[u8], challenge: &[u8]) -> Result<(), String> {
    let field = |at: usize| {
        let len = u16::from_le_bytes([message[at], message[at + 1]]) as usize;
        let offset = u32::from_le_bytes(message[at + 4..at + 8].try_into().unwrap()) as usize;
        &message[offset..offset + len]
    };
    let (lm, nt, domain, user) = (field(12), field(20), field(28), field(36));
    let upper: Vec<u16> = String::from_utf16(
        &user
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect::<Vec<_>>(),
    )
    .unwrap()
    .to_uppercase()
    .encode_utf16()
    .collect();
    let identity: Vec<u8> = upper
        .iter()
        .flat_map(|u| u.to_le_bytes())
        .chain(domain.iter().copied())
        .collect();
    let key = mac(&Md4::digest(wide(PASSWORD)), &[&identity]);
    let (proof, blob) = nt.split_at(16);
    if mac(&key, &[&SERVER_CHALLENGE, blob]) != proof {
        return Err("proof".into());
    }
    if lm != [0; 24] {
        return Err("lm".into());
    }
    // Blob: 8 header, 8 time, 8 client challenge, 4 zero, AV pairs, 4 zero.
    let (mut pairs, mut at) = (Vec::new(), 28);
    loop {
        let (id, len) = (
            u16::from_le_bytes([blob[at], blob[at + 1]]),
            u16::from_le_bytes([blob[at + 2], blob[at + 3]]) as usize,
        );
        pairs.push((id, blob[at + 4..at + 4 + len].to_vec()));
        at += 4 + len;
        if id == 0 {
            break;
        }
    }
    let value = |id: u16| pairs.iter().find(|p| p.0 == id).map(|p| p.1.clone());
    let end_point = Sha256::digest(server_cert());
    let data = [b"tls-server-end-point:".as_slice(), &end_point].concat();
    let binding = Md5::digest([&[0u8; 16][..], &(data.len() as u32).to_le_bytes(), &data].concat());
    if value(10).as_deref() != Some(&binding[..]) {
        return Err("channel binding".into());
    }
    if value(9) != Some(wide("HTTP/localhost")) || value(7) != Some(TIME.to_vec()) {
        return Err("service name or time".into());
    }
    if u32::from_le_bytes(value(6).ok_or("no flags")?.try_into().unwrap()) & 2 == 0 {
        return Err("mic flag".into());
    }
    let mut zeroed = message.to_vec();
    zeroed[72..88].fill(0);
    let session_base_key = mac(&key, &[proof]);
    if mac(&session_base_key, &[negotiate, challenge, &zeroed]) != message[72..88] {
        return Err("mic".into());
    }
    Ok(())
}

// ---- EWS answers ---------------------------------------------------------------------------

pub fn envelope(body: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header><h:ServerVersionInfo xmlns:h="http://schemas.microsoft.com/exchange/services/2006/types" MajorVersion="15" MinorVersion="2" MajorBuildNumber="2562" MinorBuildNumber="49"/></s:Header><s:Body xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">{body}</s:Body></s:Envelope>"#
    )
}

/// One response message of `kind` (`GetFolder`...) with the given class, code and inner XML.
pub fn message(kind: &str, class: &str, code: &str, inner: &str) -> String {
    format!(
        r#"<m:{kind}ResponseMessage ResponseClass="{class}"><m:ResponseCode>{code}</m:ResponseCode>{inner}</m:{kind}ResponseMessage>"#
    )
}

pub fn response(kind: &str, messages: &[String]) -> String {
    envelope(&format!(
        "<m:{kind}Response><m:ResponseMessages>{}</m:ResponseMessages></m:{kind}Response>",
        messages.concat()
    ))
}

pub fn ok(kind: &str, inner: &str) -> String {
    message(kind, "Success", "NoError", inner)
}

pub fn fault(code: &str) -> String {
    envelope(&format!(
        r#"<s:Fault><faultcode>a:{code}</faultcode><faultstring>x</faultstring><detail><e:ResponseCode xmlns:e="http://schemas.microsoft.com/exchange/services/2006/errors">{code}</e:ResponseCode></detail></s:Fault>"#
    ))
}

/// An EWS id (base64 of `n` bytes starting with `seed`) of a fake item.
pub fn ews_id(seed: u8) -> String {
    STANDARD.encode([seed; 40])
}

pub fn omamail_id(seed: u8) -> String {
    super::super::super::ids::encode(&ews_id(seed)).unwrap()
}

/// `GetFolder` answer with these (id, total, unread) for Inbox, Sent, Drafts, Trash, Junk.
pub fn folders() -> String {
    folders_without("")
}

/// The same with one folder the server says is not there.
pub fn folders_without(missing: &str) -> String {
    let rows = [
        ("inbox", 120, 7),
        ("sent", 30, 0),
        ("drafts", 2, 0),
        ("trash", 9, 1),
        ("junk", 0, 0),
    ];
    let messages: Vec<String> = rows
        .iter()
        .map(|(id, total, unread)| {
            if *id == missing {
                return message("GetFolder", "Error", "ErrorFolderNotFound", "");
            }
            ok("GetFolder", &format!(r#"<m:Folders><t:Folder><t:FolderId Id="{id}"/><t:TotalCount>{total}</t:TotalCount><t:UnreadCount>{unread}</t:UnreadCount></t:Folder></m:Folders>"#))
        })
        .collect();
    response("GetFolder", &messages)
}

/// An item element: `seed` makes the id, `ts` the received time (seconds after a fixed instant).
pub fn item(seed: u8, folder: &str, ts: u32) -> String {
    item_with(
        seed,
        folder,
        ts,
        &format!("Subject {seed}"),
        "Ada",
        "ada@example.org",
    )
}

/// The same with text the server wrote (already XML-escaped).
pub fn item_with(
    seed: u8,
    folder: &str,
    ts: u32,
    subject: &str,
    name: &str,
    address: &str,
) -> String {
    format!(
        r#"<t:Message><t:ItemId Id="{}" ChangeKey="ck{seed}"/><t:ParentFolderId Id="{folder}"/><t:Subject>{subject}</t:Subject><t:DateTimeReceived>2026-10-01T10:{:02}:{:02}Z</t:DateTimeReceived><t:Size>1000</t:Size><t:IsRead>false</t:IsRead><t:From><t:Mailbox><t:Name>{name}</t:Name><t:EmailAddress>{address}</t:EmailAddress></t:Mailbox></t:From></t:Message>"#,
        ews_id(seed),
        ts / 60,
        ts % 60
    )
}

pub fn find(items: &[String], last: bool, total: usize) -> String {
    response(
        "FindItem",
        &[ok(
            "FindItem",
            &format!(
                r#"<m:RootFolder TotalItemsInView="{total}" IncludesLastItemInRange="{last}"><t:Items>{}</t:Items></m:RootFolder>"#,
                items.concat()
            ),
        )],
    )
}

/// One `GetItem` answer: the item of this seed, with MIME when given.
pub fn item_message(seed: u8, mime: Option<&[u8]>) -> String {
    let mime = mime.map_or_else(String::new, |mime| {
        format!(
            "<t:MimeContent CharacterSet=\"UTF-8\">{}</t:MimeContent></t:Message>",
            STANDARD.encode(mime)
        )
    });
    let item = item(seed, "inbox", 5);
    ok(
        "GetItem",
        &format!(
            "<m:Items>{}</m:Items>",
            if mime.is_empty() {
                item
            } else {
                item.replace("</t:Message>", &mime)
            }
        ),
    )
}

/// `GetItem` answering with these seeds' items.
pub fn items(seeds: &[u8]) -> String {
    response(
        "GetItem",
        &seeds
            .iter()
            .map(|seed| item_message(*seed, None))
            .collect::<Vec<_>>(),
    )
}

/// A bare success for each of `count` items of `kind` (`UpdateItem`, `MoveItem`, `CreateItem`).
pub fn done(kind: &str, count: usize) -> String {
    response(kind, &vec![ok(kind, ""); count])
}
