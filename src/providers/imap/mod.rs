//! Native asynchronous IMAP and SMTP. Credentials never cross a process boundary.
mod cancel;
mod mutation;
mod read;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpStream,
};
use tokio_rustls::{
    TlsConnector,
    rustls::{ClientConfig, RootCertStore, pki_types::ServerName},
};
const LIMIT: usize = 32 * 1024 * 1024;
type Result<T> = std::result::Result<T, &'static str>;
trait Socket: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Socket for T {}
type Wire = BufReader<Box<dyn Socket>>;
struct Idle {
    key: String,
    wire: Wire,
    since: Instant,
}
static POOL: OnceLock<tokio::sync::Mutex<Vec<Idle>>> = OnceLock::new();
async fn acquire(p: &Value) -> Result<(Wire, String)> {
    let key = serde_json::to_string(&json!([p["settings"], p["credential"], p["oauth"]]))
        .map_err(|_| "invalid_params")?;
    {
        let mut pool = POOL.get_or_init(Default::default).lock().await;
        pool.retain(|entry| entry.since.elapsed() < Duration::from_secs(45));
        if let Some(index) = pool.iter().position(|entry| entry.key == key) {
            return Ok((pool.swap_remove(index).wire, key));
        }
    }
    let mut wire = connect(&p["settings"], false).await?;
    login(&mut wire, p).await?;
    // Capabilities are negotiated afresh after authentication/TLS, and ID is
    // sent once on this connection before any mailbox can be selected.
    let capabilities = command(&mut wire, "CAPABILITY").await?;
    if advertises_id(&capabilities) {
        command(&mut wire, "ID (\"name\" \"Omamail\")").await?;
    }
    Ok((wire, key))
}
fn advertises_id(response: &[u8]) -> bool {
    response.split(|b| *b == b'\n').any(|line| {
        let mut words = line
            .split(|b| b.is_ascii_whitespace())
            .filter(|word| !word.is_empty());
        words.next() == Some(b"*".as_slice())
            && words
                .next()
                .is_some_and(|word| word.eq_ignore_ascii_case(b"CAPABILITY"))
            && words.any(|word| word.eq_ignore_ascii_case(b"ID"))
    })
}
async fn release(wire: Wire, key: String) {
    let mut pool = POOL.get_or_init(Default::default).lock().await;
    if pool.len() < 32 {
        pool.push(Idle {
            key,
            wire,
            since: Instant::now(),
        });
    }
}
fn string<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p.get(key).and_then(Value::as_str).ok_or("invalid_params")
}
fn safe(s: &str) -> bool {
    !s.bytes().any(|b| b < 32 || b == 127)
}
fn quote(s: &str) -> Result<String> {
    if !safe(s) {
        return Err("invalid_params");
    }
    Ok(format!(
        "\"{}\"",
        s.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}
async fn write(w: &mut Wire, bytes: &[u8]) -> Result<()> {
    w.write_all(bytes)
        .await
        .map_err(|_| "mail_network_failed")?;
    w.flush().await.map_err(|_| "mail_network_failed")
}
async fn line(w: &mut Wire) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let buf = w.fill_buf().await.map_err(|_| "mail_network_failed")?;
        if buf.is_empty() {
            return Err("mail_connection_closed");
        }
        let n = buf
            .iter()
            .position(|b| *b == b'\n')
            .map_or(buf.len(), |n| n + 1);
        if out.len() + n > 65536 {
            return Err("mail_response_too_large");
        }
        out.extend_from_slice(&buf[..n]);
        w.consume(n);
        if out.ends_with(b"\n") {
            return Ok(out);
        }
    }
}
async fn response(w: &mut Wire, tag: &str, continuation: bool) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let l = line(w).await?;
        if out.len() + l.len() > LIMIT {
            return Err("mail_response_too_large");
        }
        let text = String::from_utf8_lossy(&l);
        if text.starts_with(&format!("{tag} ")) {
            if !text[tag.len() + 1..]
                .to_ascii_uppercase()
                .starts_with("OK ")
                && text[tag.len() + 1..].trim() != "OK"
            {
                return Err("imap_command_failed");
            }
            out.extend_from_slice(&l);
            return Ok(out);
        }
        if text.starts_with("* BYE") {
            return Err("mail_connection_closed");
        }
        if text.starts_with('+') {
            if continuation {
                return Ok(out);
            }
            return Err("imap_unexpected_continuation");
        }
        let literal = text
            .trim_end_matches(['\r', '\n'])
            .rsplit_once('{')
            .and_then(|(_, s)| s.strip_suffix('}'))
            .map(|s| s.trim_end_matches('+').parse::<usize>());
        out.extend_from_slice(&l);
        if let Some(n) = literal {
            let n = n.map_err(|_| "imap_invalid_response")?;
            if n > LIMIT - out.len() {
                return Err("mail_response_too_large");
            }
            let start = out.len();
            out.resize(start + n, 0);
            w.read_exact(&mut out[start..])
                .await
                .map_err(|_| "mail_network_failed")?;
        }
    }
}
async fn command(w: &mut Wire, cmd: &str) -> Result<Vec<u8>> {
    write(w, format!("O1 {cmd}\r\n").as_bytes()).await?;
    response(w, "O1", false).await
}
async fn tls(w: Wire, host: &str) -> Result<Wire> {
    if !w.buffer().is_empty() {
        return Err("mail_tls_failed");
    }
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    tls_with_roots(w, host, roots).await
}
async fn tls_with_roots(w: Wire, host: &str, roots: RootCertStore) -> Result<Wire> {
    let config = ClientConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| "mail_tls_failed")?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let name = ServerName::try_from(host.to_owned()).map_err(|_| "invalid_params")?;
    let stream = TlsConnector::from(Arc::new(config))
        .connect(name, w.into_inner())
        .await
        .map_err(|_| "mail_tls_failed")?;
    Ok(BufReader::new(Box::new(stream)))
}
async fn dial_host(host: &str, port: u16) -> Result<TcpStream> {
    let addresses = async {
        if let Ok(ip) = host.parse::<std::net::IpAddr>() {
            return Ok(vec![ip]);
        }
        let resolver = hickory_resolver::TokioResolver::builder_tokio()
            .map_err(|_| "mail_dns_failed")?
            .build();
        Ok(resolver
            .lookup_ip(host)
            .await
            .map_err(|_| "mail_dns_failed")?
            .iter()
            .collect::<Vec<_>>())
    };
    dial_resolved(addresses, port).await
}
async fn dial_resolved(
    addresses: impl std::future::Future<Output = Result<Vec<std::net::IpAddr>>>,
    port: u16,
) -> Result<TcpStream> {
    for ip in addresses.await? {
        if let Ok(stream) = TcpStream::connect(std::net::SocketAddr::new(ip, port)).await {
            return Ok(stream);
        }
    }
    Err("mail_network_failed")
}
async fn connect(settings: &Value, smtp: bool) -> Result<Wire> {
    let host = string(settings, if smtp { "smtpHost" } else { "imapHost" })?;
    if host.is_empty()
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:".contains(&b))
    {
        return Err("invalid_params");
    }
    let port = settings[if smtp { "smtpPort" } else { "imapPort" }]
        .as_u64()
        .filter(|p| *p > 0 && *p <= 65535)
        .ok_or("invalid_params")? as u16;
    let local = settings["insecure"] == true && matches!(host, "127.0.0.1" | "::1" | "localhost");
    // Loopback plaintext is an explicitly configured bridge, never a TLS fallback.
    let dial = if local && host == "localhost" {
        "127.0.0.1"
    } else {
        host
    };
    let stream = dial_host(dial, port).await?;
    let mut w: Wire = BufReader::new(Box::new(stream));
    let upgrade = if smtp {
        matches!(port, 25 | 587)
    } else {
        port == 143
    };
    if !local && !upgrade {
        w = tls(w, host).await?
    }
    if smtp {
        smtp_response(&mut w, 220).await?;
    } else {
        let greeting = line(&mut w).await?;
        if !greeting.starts_with(b"* OK") {
            return Err("imap_invalid_response");
        }
    }
    if upgrade && !local {
        if smtp {
            smtp_cmd(&mut w, "EHLO omamail", 250).await?;
            smtp_cmd(&mut w, "STARTTLS", 220).await?;
        } else {
            command(&mut w, "STARTTLS").await?;
        }
        w = tls(w, host).await?;
    }
    Ok(w)
}
fn credentials(p: &Value) -> Result<(String, String)> {
    let supplied = string(p, "credential")?;
    let username = string(&p["settings"], "username")?;
    let secret = if p["oauth"] == true {
        supplied
    } else {
        supplied
            .strip_prefix(&format!("{username}:"))
            .ok_or("invalid_params")?
    };
    if username.is_empty() || secret.is_empty() || !safe(username) || !safe(secret) {
        return Err("invalid_params");
    }
    Ok((username.to_owned(), secret.to_owned()))
}
async fn login(w: &mut Wire, p: &Value) -> Result<()> {
    let (user, secret) = credentials(p)?;
    if p["oauth"] == true {
        write(w, b"O1 AUTHENTICATE XOAUTH2\r\n").await?;
        let l = line(w).await?;
        if !l.starts_with(b"+") {
            return Err("mail_auth_failed");
        }
        let auth = STANDARD.encode(format!("user={user}\x01auth=Bearer {secret}\x01\x01"));
        write(w, format!("{auth}\r\n").as_bytes()).await?;
        response(w, "O1", false)
            .await
            .map_err(|_| "mail_auth_failed")?;
    } else {
        command(w, &format!("LOGIN {} {}", quote(&user)?, quote(&secret)?))
            .await
            .map_err(|_| "mail_auth_failed")?;
    }
    Ok(())
}
pub async fn call(method: &str, p: &Value) -> Result<Value> {
    read::validate(method, p)?;
    mutation::validate(method, p)?;
    if method == "imap.cancel" {
        return cancel::cancel(p).await;
    }
    if matches!(
        method,
        "imap.folders"
            | "imap.list"
            | "imap.listContinue"
            | "imap.messages"
            | "imap.count"
            | "imap.attachment"
            | "imap.check"
    ) {
        return cancel::run(p, call_inner(method, p)).await;
    }
    call_inner(method, p).await
}
async fn call_inner(method: &str, p: &Value) -> Result<Value> {
    let sent = std::sync::atomic::AtomicBool::new(false);
    match tokio::time::timeout(Duration::from_secs(22), async {
        let resolved = resolve_account(p, method).await?;
        execute(method, &resolved, &sent).await
    })
    .await
    {
        Ok(result) => result,
        Err(_) if sent.load(std::sync::atomic::Ordering::SeqCst) => Ok(
            json!({"sent":true,"warning":"Sent, but the copy for the Sent folder could not be saved"}),
        ),
        Err(_) if matches!(method, "smtp.send" | "imap.send") => Err("smtp_delivery_unknown"),
        Err(_) => Err("request_timed_out"),
    }
}
async fn resolve_account(p: &Value, method: &str) -> Result<Value> {
    let Some(account) = p.get("accountId").and_then(Value::as_str) else {
        return Ok(p.clone());
    };
    let provider = if account.starts_with("outlook:") {
        "outlook"
    } else if account.starts_with("imap:") {
        "imap"
    } else {
        return Err("invalid_params");
    };
    let owned = account.to_owned();
    let entry = tokio::task::spawn_blocking(move || crate::auth::settings(provider, &owned))
        .await
        .map_err(|_| "worker_failed")??;
    let mut result = p.clone();
    let credential = if provider == "outlook" {
        let username = account.strip_prefix("outlook:").ok_or("invalid_params")?;
        result["settings"] = outlook_settings(&entry, username);
        result["oauth"] = json!(true);
        crate::auth::access_token(
            "outlook",
            account,
            if method == "imap.send" && result["settings"]["send"] == "graph" {
                "graph"
            } else {
                "mail"
            },
        )
        .await?
    } else {
        result["settings"] = entry["imap"].clone();
        result["oauth"] = json!(false);
        let username = string(&result["settings"], "username")?;
        format!(
            "{username}:{}",
            crate::auth::password("imap", account).await?
        )
    };
    result["credential"] = json!(credential);
    Ok(result)
}
fn outlook_settings(entry: &Value, username: &str) -> Value {
    let tenant = entry["imap"]["tenant"]
        .as_str()
        .unwrap_or("consumers")
        .trim()
        .to_ascii_lowercase();
    let work = !tenant.is_empty()
        && tenant != "consumers"
        && tenant.len() <= 255
        && !tenant.contains("..")
        && tenant
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b));
    json!({"imapHost":"outlook.office365.com","imapPort":993,"smtpHost":if work{"smtp.office365.com"}else{"smtp-mail.outlook.com"},"smtpPort":587,"username":username,"insecure":false,"send":entry["imap"]["send"]})
}
fn unsafe_fetch(command: &str) -> bool {
    let upper = command.to_ascii_uppercase();
    if !upper.starts_with("UID FETCH ") {
        return false;
    }
    upper
        .split(|c: char| c.is_whitespace() || c == '(' || c == ')')
        .any(|part| matches!(part, "RFC822" | "RFC822.TEXT" | "BODY"))
}
async fn execute(method: &str, p: &Value, sent: &std::sync::atomic::AtomicBool) -> Result<Value> {
    credentials(p)?;
    if matches!(
        method,
        "imap.folders"
            | "imap.list"
            | "imap.listContinue"
            | "imap.messages"
            | "imap.count"
            | "imap.attachment"
    ) {
        return read::call(method, p).await;
    }
    if matches!(
        method,
        "imap.modify"
            | "imap.trash"
            | "imap.untrash"
            | "imap.createFolder"
            | "imap.renameFolder"
            | "imap.deleteFolder"
            | "imap.saveDraft"
            | "imap.deleteDraft"
            | "imap.send"
    ) {
        return mutation::call(method, p, sent).await;
    }
    // Validate the entire batch and envelope before opening any socket.
    credentials(p)?;
    let folder = p["folder"].as_str().unwrap_or("");
    let quoted = quote(folder)?;
    let commands = if method == "imap.request" {
        p["commands"]
            .as_array()
            .ok_or("invalid_params")?
            .iter()
            .map(|v| {
                let s = v.as_str().ok_or("invalid_params")?;
                if !safe(s)
                    || s.len() > 65536
                    || s.eq_ignore_ascii_case("EXPUNGE")
                    || s.to_ascii_uppercase().contains("BODY[")
                    || unsafe_fetch(s)
                {
                    return Err("invalid_params");
                }
                let upper = s.to_ascii_uppercase();
                if ![
                    "CAPABILITY",
                    "LIST ",
                    "UID SEARCH ",
                    "UID FETCH ",
                    "UID STORE ",
                    "UID COPY ",
                    "UID MOVE ",
                    "UID EXPUNGE ",
                    "STATUS ",
                    "CREATE ",
                    "RENAME ",
                    "DELETE ",
                    "NOOP",
                ]
                .iter()
                .any(|prefix| upper.starts_with(prefix))
                {
                    return Err("invalid_params");
                }
                Ok(s)
            })
            .collect::<Result<Vec<_>>>()?
    } else {
        Vec::new()
    };
    if commands.len() > 512 {
        return Err("invalid_params");
    }
    if method == "smtp.send" {
        return send(p).await;
    }
    if !matches!(method, "imap.request" | "imap.append" | "imap.check") {
        return Err("method_not_found");
    }
    let append = if method == "imap.append" {
        let body = STANDARD
            .decode(string(p, "body")?)
            .map_err(|_| "invalid_params")?;
        if body.len() > LIMIT {
            return Err("invalid_params");
        }
        let flag = match string(p, "flags")? {
            "seen" => "\\Seen",
            "draft" => "\\Draft",
            _ => return Err("invalid_params"),
        };
        Some((body, flag))
    } else {
        None
    };
    let (mut w, key) = acquire(p).await?;
    if method == "imap.check" {
        let data = command(&mut w, "STATUS INBOX (UNSEEN MESSAGES UIDNEXT UIDVALIDITY)").await?;
        release(w, key).await;
        let text = String::from_utf8_lossy(&data);
        let tokens: Vec<_> = text
            .split(|c: char| c.is_whitespace() || c == '(' || c == ')')
            .collect();
        let unseen = tokens
            .windows(2)
            .find(|w| w[0].eq_ignore_ascii_case("UNSEEN"))
            .and_then(|w| w[1].parse::<u64>().ok())
            .ok_or("imap_invalid_response")?;
        return Ok(json!({"estimate":unseen,"messages":[],"fingerprint":STANDARD.encode(data)}));
    }
    let mut out = Vec::new();
    if let Some((body, flag)) = append {
        write(
            &mut w,
            format!("O1 APPEND {quoted} ({flag}) {{{}}}\r\n", body.len()).as_bytes(),
        )
        .await?;
        // APPEND must be granted a continuation before any message bytes are sent.
        let l = line(&mut w).await?;
        if !l.starts_with(b"+") {
            return Err("imap_command_failed");
        }
        write(&mut w, &body).await?;
        write(&mut w, b"\r\n").await?;
        response(&mut w, "O1", false).await?;
    } else {
        if !folder.is_empty() {
            command(&mut w, &format!("SELECT {quoted}")).await?;
        }
        let changes_folders = commands.iter().any(|cmd| {
            ["CREATE ", "RENAME ", "DELETE "]
                .iter()
                .any(|prefix| cmd.to_ascii_uppercase().starts_with(prefix))
        });
        for cmd in commands {
            let part = command(&mut w, cmd).await?;
            if out.len() + part.len() > LIMIT {
                return Err("mail_response_too_large");
            }
            out.extend(part);
        }
        if changes_folders {
            read::invalidate().await;
        }
    }
    release(w, key).await;
    Ok(json!({"data":STANDARD.encode(out)}))
}
async fn smtp_response(w: &mut Wire, wanted: u16) -> Result<()> {
    let mut total = 0;
    loop {
        let l = line(w).await?;
        total += l.len();
        if total > 65536 || l.len() < 5 {
            return Err("smtp_invalid_response");
        }
        let code = std::str::from_utf8(&l[..3])
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .ok_or("smtp_invalid_response")?;
        if code != wanted {
            return Err("smtp_command_failed");
        }
        match l[3] {
            b' ' => return Ok(()),
            b'-' => {}
            _ => return Err("smtp_invalid_response"),
        }
    }
}
async fn smtp_cmd(w: &mut Wire, cmd: &str, code: u16) -> Result<()> {
    write(w, format!("{cmd}\r\n").as_bytes()).await?;
    smtp_response(w, code).await
}
fn smtp_data(body: &[u8]) -> Result<Vec<u8>> {
    if body
        .iter()
        .enumerate()
        .any(|(i, b)| *b == b'\r' && body.get(i + 1) != Some(&b'\n'))
    {
        return Err("invalid_params");
    }
    let mut encoded = Vec::with_capacity(body.len() + 128);
    for l in body
        .strip_suffix(b"\n")
        .unwrap_or(body)
        .split(|b| *b == b'\n')
    {
        let l = l.strip_suffix(b"\r").unwrap_or(l);
        if l.starts_with(b".") {
            encoded.push(b'.')
        }
        encoded.extend_from_slice(l);
        encoded.extend_from_slice(b"\r\n");
    }
    encoded.extend_from_slice(b".\r\n");
    Ok(encoded)
}
async fn send(p: &Value) -> Result<Value> {
    let body = STANDARD
        .decode(string(p, "body")?)
        .map_err(|_| "invalid_params")?;
    if body.len() > LIMIT {
        return Err("invalid_params");
    }
    fn address(s: &str) -> Result<&str> {
        if s.is_empty() || !safe(s) || s.bytes().any(|b| b"<> ".contains(&b)) {
            Err("invalid_params")
        } else {
            Ok(s)
        }
    }
    let from = address(string(p, "from")?)?;
    let to = p["recipients"]
        .as_array()
        .ok_or("invalid_params")?
        .iter()
        .map(|v| address(v.as_str().ok_or("invalid_params")?))
        .collect::<Result<Vec<_>>>()?;
    if to.is_empty() || to.len() > 1000 {
        return Err("invalid_params");
    }
    let encoded = smtp_data(&body)?;
    let (user, secret) = credentials(p)?;
    let mut w = connect(&p["settings"], true).await?;
    smtp_cmd(&mut w, "EHLO omamail", 250).await?;
    let auth = if p["oauth"] == true {
        format!(
            "AUTH XOAUTH2 {}",
            STANDARD.encode(format!("user={user}\x01auth=Bearer {secret}\x01\x01"))
        )
    } else {
        format!(
            "AUTH PLAIN {}",
            STANDARD.encode(format!("\0{user}\0{secret}"))
        )
    };
    smtp_cmd(&mut w, &auth, 235)
        .await
        .map_err(|_| "mail_auth_failed")?;
    smtp_cmd(&mut w, &format!("MAIL FROM:<{from}>"), 250).await?;
    for recipient in to {
        smtp_cmd(&mut w, &format!("RCPT TO:<{recipient}>"), 250).await?;
    }
    smtp_cmd(&mut w, "DATA", 354).await?;
    // After DATA starts, a failed final reply cannot prove the message was not delivered.
    write(&mut w, &encoded)
        .await
        .map_err(|_| "smtp_delivery_unknown")?;
    smtp_response(&mut w, 250)
        .await
        .map_err(|_| "smtp_delivery_unknown")?;
    Ok(json!({"sent":true}))
}
#[cfg(test)]
mod tests;
