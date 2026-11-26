//! `ProcessBackend` over real pipes, against a script that answers as
//! `omamail serve` does: plain responses, a chunked one, an error, a
//! pushed event, and a request it never answers.
#![cfg(unix)]

use std::{
    future::Future,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    pin::pin,
    sync::Arc,
    task::{Context, Poll, Wake, Waker},
    thread::Thread,
};

use omamail_nsh::backend::{Backend, Pins, handshake, process::ProcessBackend};
use serde_json::json;

struct Unpark(Thread);

impl Wake for Unpark {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

fn block_on<T>(future: impl Future<Output = T>) -> T {
    let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut future = pin!(future);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        std::thread::park();
    }
}

const SERVER: &str = r#"#!/usr/bin/env python3
import json, sys
VERSION, API = sys.argv[2], int(sys.argv[3])
def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n"); sys.stdout.flush()
for line in sys.stdin:
    req = json.loads(line)
    rid, method = req.get("id"), req.get("method")
    if method == "system.info":
        send({"jsonrpc": "2.0", "id": rid, "result": {"version": VERSION, "protocol": 1, "apiVersion": API, "methods": ["system.info"]}})
    elif method == "big":
        whole = json.dumps({"jsonrpc": "2.0", "id": rid, "result": {"text": "é" * 50}})
        parts = [whole[i:i + 16] for i in range(0, len(whole), 16)]
        size = len(whole.encode("utf-16-le")) // 2
        for i, part in enumerate(parts):
            send({"jsonrpc": "2.0", "method": "transport.chunk", "params": {"transfer": "7", "index": i, "total": len(parts), "size": size, "data": part}})
    elif method == "fail":
        send({"jsonrpc": "2.0", "id": rid, "error": {"code": -32000, "message": "mail_account_unknown"}})
    elif method == "notify":
        send({"jsonrpc": "2.0", "method": "mail.updated", "params": {"accountId": "a"}})
        send({"jsonrpc": "2.0", "id": rid, "result": {}})
    elif method == "system.quit":
        send({"jsonrpc": "2.0", "id": rid, "result": {}})
        break
"#;

/// The script, executable, run as `<script> serve <version> <api>`
/// through a wrapper that passes the pins.
fn server() -> PathBuf {
    let pins = Pins::compiled();
    let dir = std::env::temp_dir().join(format!("omamail-nsh-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("server.py");
    std::fs::write(&script, SERVER).unwrap();
    let wrapper = dir.join("omamail");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nexec python3 '{}' \"$1\" '{}' '{}'\n",
            script.display(),
            pins.version,
            pins.api_version
        ),
    )
    .unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    wrapper
}

#[test]
fn a_process_backend_speaks_the_protocol() {
    let backend = ProcessBackend::spawn(&server()).expect("the script starts");
    block_on(async {
        let info = handshake(&backend, &Pins::compiled())
            .await
            .expect("the handshake is accepted");
        assert_eq!(info.version, Pins::compiled().version);

        let big = backend
            .call("big", json!({}))
            .await
            .expect("the chunked answer arrives");
        assert_eq!(big["text"], "é".repeat(50));

        let error = backend.call("fail", json!({})).await.unwrap_err();
        assert_eq!(error.message, "mail_account_unknown");

        backend.call("notify", json!({})).await.unwrap();
        let event = backend.next_event().await.expect("the pushed event");
        assert_eq!(event.method, "mail.updated");
        assert_eq!(event.params["accountId"], "a");
    });
    backend.shutdown();
}

#[test]
fn a_backend_that_exits_fails_its_pending_calls() {
    let backend = ProcessBackend::spawn(&server()).expect("the script starts");
    block_on(async {
        backend.call("system.quit", json!({})).await.unwrap();
        let error = backend.call("never.answered", json!({})).await.unwrap_err();
        assert!(
            matches!(
                error.message.as_str(),
                "backend_exited" | "backend_unavailable"
            ),
            "{error}"
        );
    });
}

/// The real backend, when `OMAMAIL_BIN` names a build of this checkout:
/// the handshake is accepted and an empty profile lists no accounts.
/// Skipped otherwise. Run with
/// `OMAMAIL_BIN=../target/debug/omamail cargo test --test process`.
#[test]
fn the_real_backend_accepts_the_handshake() {
    let Some(binary) = std::env::var_os("OMAMAIL_BIN") else {
        eprintln!("OMAMAIL_BIN is not set: skipped");
        return;
    };
    let home = std::env::temp_dir().join(format!("omamail-nsh-real-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    // An empty profile: the test never reads the user's accounts.
    // SAFETY: set before the child starts, and no other test reads these.
    unsafe {
        std::env::set_var("XDG_CONFIG_HOME", home.join("config"));
        std::env::set_var("XDG_DATA_HOME", home.join("data"));
        std::env::set_var("XDG_CACHE_HOME", home.join("cache"));
        std::env::set_var("XDG_STATE_HOME", home.join("state"));
    }
    let backend = ProcessBackend::spawn(std::path::Path::new(&binary)).expect("the backend starts");
    block_on(async {
        let info = handshake(&backend, &Pins::compiled())
            .await
            .expect("the handshake is accepted");
        assert!(info.methods.iter().any(|m| m == "mail.list"));
        let accounts = backend
            .call("accounts.list", json!({}))
            .await
            .expect("accounts are listed");
        assert_eq!(accounts["accounts"], json!([]));
    });
    backend.shutdown();
}
