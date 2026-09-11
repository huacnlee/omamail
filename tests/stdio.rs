use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

struct Sandbox(std::path::PathBuf);
impl Sandbox {
    fn new() -> Self {
        static SERIAL: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "omamail-stdio-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_omamail"));
        command
            .env("HOME", &self.0)
            .env("XDG_CONFIG_HOME", self.0.join("config"))
            .env("XDG_CACHE_HOME", self.0.join("cache"));
        command
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn fragmented_input_and_bytes_before_eof_are_preserved() {
    let sandbox = Sandbox::new();
    let mut child = sandbox
        .command()
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(b"{\"jsonrpc\":\"2.0\",").unwrap();
    std::thread::sleep(Duration::from_millis(20));
    input
        .write_all(b"\"id\":\"fragment\",\"method\":\"system.info\"}\n")
        .unwrap();
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["id"], "fragment");
    assert_eq!(reply["result"]["name"], "omamail");
}

#[test]
fn broken_output_stops_backend_while_input_remains_open() {
    let sandbox = Sandbox::new();
    let mut child = sandbox
        .command()
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    drop(child.stdout.take().unwrap());
    writeln!(
        input,
        "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"system.info\"}}"
    )
    .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            assert!(!status.success());
            break;
        }
        if std::time::Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("backend must stop after output fails without waiting for stdin EOF");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(input);
}

#[test]
fn backend_replies_before_eof_and_drains_requests_before_quit() {
    let sandbox = Sandbox::new();
    let mut child = sandbox
        .command()
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let output = child.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            if sender.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    writeln!(
        input,
        "{{\"jsonrpc\":\"2.0\",\"id\":\"first\",\"method\":\"system.info\"}}"
    )
    .unwrap();
    let response = receiver.recv_timeout(Duration::from_secs(5));
    if response.is_err() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("backend must flush a response while stdin remains open");
    }
    let response: serde_json::Value = serde_json::from_str(&response.unwrap()).unwrap();
    assert_eq!(response["id"], "first");
    for id in 0..40 {
        writeln!(
            input,
            "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"system.info\"}}"
        )
        .unwrap();
    }
    writeln!(
        input,
        "{{\"jsonrpc\":\"2.0\",\"id\":\"quit\",\"method\":\"system.quit\"}}"
    )
    .unwrap();
    let mut ids = std::collections::HashSet::new();
    for _ in 0..40 {
        let line = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        let response: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert!(ids.insert(response["id"].as_u64().unwrap()));
    }
    let line = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    let response: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["id"], "quit");
    drop(input);
    assert!(child.wait().unwrap().success());
    reader.join().unwrap();
}
