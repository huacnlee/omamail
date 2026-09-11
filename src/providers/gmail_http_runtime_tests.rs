//! Exercise actual curl header/stdin and redirect behavior on a controlled local
//! HTTP server. Test-only origin/protocol replacement does NOT verify TLS.
use super::*;
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};

fn local_request(status: &str, refresh: bool) -> (Result<Value, &'static str>, Vec<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let finished = Arc::new(AtomicBool::new(false));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let thread_finished = Arc::clone(&finished);
    let thread_seen = Arc::clone(&seen);
    let response = format!(
        "HTTP/1.1 {status}\r\nLocation: http://127.0.0.1:{port}/forbidden\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{{\"ok\":true}}"
    );
    let server = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !thread_finished.load(Ordering::Acquire) && Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = Vec::new();
                    let mut byte = [0];
                    while !request.ends_with(b"\r\n\r\n") && request.len() < 16384 {
                        if stream.read(&mut byte).unwrap_or(0) == 0 {
                            break;
                        }
                        request.push(byte[0]);
                    }
                    let headers = String::from_utf8(request.clone()).unwrap();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            if key.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    assert!(length < 16384);
                    let mut body = vec![0; length];
                    stream.read_exact(&mut body).unwrap();
                    request.extend(body);
                    thread_seen
                        .lock()
                        .unwrap()
                        .push(String::from_utf8(request).unwrap());
                    stream.write_all(response.as_bytes()).unwrap();
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2))
                }
                Err(error) => panic!("local test listener: {error}"),
            }
        }
    });
    let mut request = if refresh {
        prepare_refresh("synthetic-id", "quote\"\\", "synthetic+&=token").unwrap()
    } else {
        prepare_get(&["messages", "abc"], &[], "synthetic-runtime-token").unwrap()
    };
    // Mutate the private test request only; production still fixes HTTPS origins.
    for index in 0..request.args.len() - 1 {
        if request.args[index] == "--proto" {
            request.args[index + 1] = "=http".into();
        }
    }
    *request.args.last_mut().unwrap() = format!("http://127.0.0.1:{port}/messages/abc");
    let result = execute(request);
    finished.store(true, Ordering::Release);
    server.join().unwrap();
    let requests = seen.lock().unwrap().clone();
    (result, requests)
}

#[test]
fn real_curl_reads_authorization_from_stdin() {
    let (result, requests) = local_request("200 OK", false);
    assert_eq!(result.unwrap()["ok"], true);
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("GET /messages/abc HTTP/1.1\r\n"));
    assert!(requests[0].contains("\r\nAuthorization: Bearer synthetic-runtime-token\r\n"));
}

#[test]
fn real_curl_does_not_follow_redirect_with_authorization() {
    let (result, requests) = local_request("302 Found", false);
    assert_eq!(result, Err("gmail_http_failed"));
    assert_eq!(requests.len(), 1, "redirect must not make another request");
    assert!(!requests[0].contains("/forbidden"));
}

#[test]
fn real_curl_posts_form_bytes_from_stdin() {
    let (result, requests) = local_request("200 OK", true);
    assert_eq!(result.unwrap()["ok"], true);
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("POST /messages/abc HTTP/1.1\r\n"));
    assert!(requests[0].ends_with("\r\n\r\ngrant_type=refresh_token&client_id=synthetic-id&client_secret=quote%22%5C&refresh_token=synthetic%2B%26%3Dtoken"));
}
