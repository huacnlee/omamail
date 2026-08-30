//! The socket half of the single-instance door.
//!
//! The parsing and the vocabulary are unit-tested beside the module. What only
//! a real socket can answer is the question the whole thing exists for: does a
//! second launch reach the first one, and does the first one refuse what it
//! should refuse once the bytes are actually on the wire.

use std::{
    io::Write as _,
    os::unix::net::UnixStream,
    time::{Duration, Instant},
};

use omamail::command_router::{Command, CommandQueue, MAX_COMMAND_LINE, deliver, listen};

/// The router runs on a thread of its own, so a test that read the queue once
/// would be racing it. Waiting for a change with a deadline is the difference
/// between a test that proves delivery and one that proves timing.
fn next_command(queue: &CommandQueue) -> Option<Command> {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Some(command) = queue.take() {
            return Some(command);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    None
}

#[test]
fn a_second_launch_reaches_the_window_that_is_already_open() {
    let root = tempfile::tempdir().expect("socket fixture");
    let socket = root.path().join("nested/command.sock");
    let queue = CommandQueue::new();
    listen(&socket, queue.clone()).expect("listen");

    let link = Command::compose("mailto:jane@example.com?subject=Say \"hi\"").unwrap();
    assert!(
        deliver(&socket, &link),
        "the running instance took the link"
    );
    assert_eq!(next_command(&queue), Some(link));

    assert!(deliver(&socket, &Command::refresh()));
    assert_eq!(next_command(&queue), Some(Command::refresh()));
}

#[test]
fn nothing_is_listening_before_a_window_opens() {
    let root = tempfile::tempdir().expect("socket fixture");
    let socket = root.path().join("command.sock");
    assert!(
        !deliver(&socket, &Command::open()),
        "a missing socket means this process becomes the window"
    );

    // What a crash leaves behind. It has to read as "nobody home" rather than
    // as a running instance, or every later launch is silently swallowed.
    std::fs::write(&socket, "").expect("stale socket file");
    assert!(!deliver(&socket, &Command::open()));
}

#[test]
fn the_socket_is_reachable_only_by_its_owner() {
    use std::os::unix::fs::PermissionsExt as _;

    let root = tempfile::tempdir().expect("socket fixture");
    let socket = root.path().join("private/command.sock");
    listen(&socket, CommandQueue::new()).expect("listen");
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&socket), 0o600);
    assert_eq!(mode(socket.parent().unwrap()), 0o700);
}

#[test]
fn a_peer_cannot_talk_the_router_into_anything_else() {
    let root = tempfile::tempdir().expect("socket fixture");
    let socket = root.path().join("command.sock");
    let queue = CommandQueue::new();
    listen(&socket, queue.clone()).expect("listen");

    // Every one of these is something a process running as this user could
    // write to the socket. None of them may become a command.
    for line in [
        String::from("not json\n"),
        String::from("{\"verb\":\"quit\"}\n"),
        String::from("{\"verb\":\"compose-mailto\",\"payload\":\"file:///etc/passwd\"}\n"),
        String::from("{\"verb\":\"open\",\"program\":\"/bin/sh\"}\n"),
        // No newline at all: the read is bounded, so this ends as a short line
        // that parses to nothing rather than as an unbounded string.
        format!(
            "{{\"verb\":\"open\",\"payload\":\"{}",
            "x".repeat(MAX_COMMAND_LINE * 2)
        ),
    ] {
        let mut stream = UnixStream::connect(&socket).expect("connect");
        let _ = stream.write_all(line.as_bytes());
        drop(stream);
    }

    // A legitimate command after all of them, so the assertion is "the queue
    // holds this and nothing before it" rather than "the queue is empty yet".
    assert!(deliver(&socket, &Command::refresh()));
    assert_eq!(next_command(&queue), Some(Command::refresh()));
    assert_eq!(queue.take(), None);
}
