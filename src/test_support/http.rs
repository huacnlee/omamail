//! The small part of HTTP the test peers need: one request, one answer.

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub(crate) struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub(crate) fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_slice(&self.body).ok()
    }
}

/// Reads one request, or `None` when the peer closed before sending any byte.
pub(crate) async fn read_request<S>(stream: &mut S) -> std::io::Result<Option<Request>>
where
    S: AsyncRead + Unpin,
{
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        if stream.read(&mut byte).await? == 0 {
            return Ok(None);
        }
        head.push(byte[0]);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
        if head.len() > 64 * 1024 {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let mut lines = head.split("\r\n");
    let mut start = lines.next().unwrap_or_default().split(' ');
    let method = start.next().unwrap_or_default().to_string();
    let path = start.next().unwrap_or_default().to_string();
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    let length: usize = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    if length > 0 {
        stream.read_exact(&mut body).await?;
    }
    Ok(Some(Request {
        method,
        path,
        headers,
        body,
    }))
}

pub(crate) async fn respond<S>(
    stream: &mut S,
    status: u16,
    content_type: Option<&str>,
    body: &[u8],
) -> std::io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    respond_with(stream, status, content_type, &[], body).await
}

pub(crate) async fn respond_with<S>(
    stream: &mut S,
    status: u16,
    content_type: Option<&str>,
    headers: &[(&str, &str)],
    body: &[u8],
) -> std::io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    let reason = match status {
        200 => "OK",
        302 => "Found",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "Unknown",
    };
    let mut head = format!("HTTP/1.1 {status} {reason}\r\n");
    if let Some(value) = content_type {
        head.push_str(&format!("Content-Type: {value}\r\n"));
    }
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str(&format!(
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ));
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}
