//! An IMAP or SMTP peer that offers STARTTLS and reports what crossed it.

use crate::test_support::tls;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
    task::JoinHandle,
};
use tokio_rustls::TlsAcceptor;

/// How long the peer waits for the client to reach it.
const ACCEPT_DEADLINE: std::time::Duration = std::time::Duration::from_secs(10);

pub(crate) struct StartTlsPeer {
    pub(crate) port: u16,
    report: Option<oneshot::Receiver<String>>,
    task: JoinHandle<()>,
}

impl StartTlsPeer {
    /// Starts one peer. `mode` follows the production connection choices:
    /// `local`, `strict`, `refuse`, `malformed`, or `buffered`.
    pub(crate) async fn start(smtp: bool, mode: &str, implicit: bool) -> Self {
        let (listener, port) = tls::bind().await;
        let acceptor = TlsAcceptor::from(tls::localhost_config());
        let mode = mode.to_string();
        let (report, reported) = oneshot::channel();
        let task = tokio::spawn(async move {
            let outcome = serve(&listener, &acceptor, smtp, &mode, implicit).await;
            let _ = report.send(outcome);
        });
        Self {
            port,
            report: Some(reported),
            task,
        }
    }

    /// What the peer saw: `encrypted-credentials`, `no-credentials`, or a
    /// mismatch the caller reports as a failed expectation.
    pub(crate) async fn report(&mut self) -> String {
        self.report
            .take()
            .expect("the peer reports once")
            .await
            .expect("the peer reports one outcome for its one connection")
    }
}

impl Drop for StartTlsPeer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve(
    listener: &TcpListener,
    acceptor: &TlsAcceptor,
    smtp: bool,
    mode: &str,
    implicit: bool,
) -> String {
    let Ok(Ok((mut stream, _))) = tokio::time::timeout(ACCEPT_DEADLINE, listener.accept()).await
    else {
        return "no-connection".into();
    };
    if !implicit {
        greet(&mut stream, smtp).await;
        if smtp {
            if read_line(&mut stream).await.as_slice() != b"EHLO omamail\r\n" {
                return "client-mismatch".into();
            }
            stream
                .write_all(b"250-localhost\r\n250 STARTTLS\r\n")
                .await
                .unwrap();
        }
        let expected = if smtp {
            b"STARTTLS\r\n".as_slice()
        } else {
            b"O1 STARTTLS\r\n".as_slice()
        };
        if read_line(&mut stream).await.as_slice() != expected {
            return "client-mismatch".into();
        }
        if mode == "refuse" {
            let refuse = if smtp {
                b"454 refused\r\n".as_slice()
            } else {
                b"O1 NO refused\r\n".as_slice()
            };
            stream.write_all(refuse).await.unwrap();
            return if read_line(&mut stream).await.is_empty() {
                "no-credentials".into()
            } else {
                "client-mismatch".into()
            };
        }
        let upgrade = if smtp {
            b"220 upgrade\r\n".as_slice()
        } else {
            b"O1 OK upgrade\r\n".as_slice()
        };
        if mode == "buffered" {
            stream.write_all(upgrade).await.unwrap();
            stream
                .write_all(b"plaintext-after-upgrade\r\n")
                .await
                .unwrap();
            return credential_report(&drain(&mut stream).await);
        }
        stream.write_all(upgrade).await.unwrap();
        if mode == "malformed" {
            stream.write_all(b"not-a-tls-record").await.unwrap();
            return credential_report(&drain(&mut stream).await);
        }
    }
    match acceptor.accept(stream).await {
        Ok(mut secure) => {
            if implicit {
                greet(&mut secure, smtp).await;
            }
            let line = read_line(&mut secure).await;
            if mode != "local" {
                "peer-mismatch".into()
            } else if line.as_slice() == b"synthetic-credential\r\n" {
                "encrypted-credentials".into()
            } else {
                "credential-mismatch".into()
            }
        }
        Err(_) if mode == "strict" => "no-credentials".into(),
        Err(_) => "peer-mismatch".into(),
    }
}

fn credential_report(received: &[u8]) -> String {
    if received
        .windows(b"synthetic-credential".len())
        .any(|window| window == b"synthetic-credential")
    {
        "credential-leak".into()
    } else {
        "no-credentials".into()
    }
}

async fn greet<S: AsyncWrite + Unpin>(stream: &mut S, smtp: bool) {
    let greeting = if smtp {
        b"220 ready\r\n".as_slice()
    } else {
        b"* OK ready\r\n".as_slice()
    };
    stream.write_all(greeting).await.unwrap();
}

async fn read_line<S: AsyncRead + Unpin>(stream: &mut S) -> Vec<u8> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    while !line.ends_with(b"\r\n") {
        match stream.read(&mut byte).await {
            Ok(0) | Err(_) => break,
            Ok(_) => line.push(byte[0]),
        }
        if line.len() > 4096 {
            break;
        }
    }
    line
}

async fn drain<S: AsyncRead + Unpin>(stream: &mut S) -> Vec<u8> {
    let mut received = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => received.extend_from_slice(&buffer[..read]),
        }
    }
    received
}
