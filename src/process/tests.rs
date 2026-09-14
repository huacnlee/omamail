//! Real native children exercise argument, pipe, and process-tree boundaries.
use super::*;
use std::time::{Duration, Instant};

fn python() -> &'static str {
    if cfg!(windows) { "python" } else { "python3" }
}
fn args(script: &str) -> Vec<String> {
    vec!["-c".into(), script.into()]
}
#[test]
fn exact_input_and_full_duplex_output() {
    let mut input = vec![42; 512 * 1024];
    input.extend_from_slice(b"\0\r\n\xff");
    assert_eq!(
        run(
            python(),
            &args("import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())"),
            &input,
            Duration::from_secs(5),
            input.len()
        )
        .unwrap(),
        input
    );
}
#[tokio::test]
async fn streams_are_separate_and_individually_bounded() {
    let output = async_run::run(
        python(),
        &args("import sys; sys.stdout.buffer.write(b'a'*64); sys.stderr.buffer.write(b'b'*64)"),
        b"",
        Duration::from_secs(5),
        64,
    )
    .await
    .unwrap();
    assert!(output.success);
    assert_eq!(output.stdout, vec![b'a'; 64]);
    assert_eq!(output.stderr, vec![b'b'; 64]);
    for stream in ["stdout", "stderr"] {
        let script = format!("import sys; sys.{stream}.buffer.write(b'x'*65)");
        assert!(matches!(
            async_run::run(python(), &args(&script), b"", Duration::from_secs(5), 64).await,
            Err("process_output_too_large")
        ));
        assert_eq!(
            run(python(), &args(&script), b"", Duration::from_secs(5), 64),
            Err("process_output_too_large")
        );
    }
}
#[test]
fn hostile_arguments_are_one_unchanged_argument() {
    let marker = std::env::temp_dir().join(format!("omamail-argv-{}", std::process::id()));
    let hostile = format!(
        "\"; touch '{}'; $(touch '{}') & echo injected > \"{}\" \\ 日本語\n",
        marker.display(),
        marker.display(),
        marker.display()
    );
    let mut argv = args(
        "import sys; assert len(sys.argv)==2; sys.stdout.buffer.write(sys.argv[1].encode('utf-8'))",
    );
    argv.push(hostile.clone());
    assert_eq!(
        run(python(), &argv, b"", Duration::from_secs(5), 4096).unwrap(),
        hostile.as_bytes()
    );
    assert!(
        !marker.exists(),
        "arguments must never execute as shell syntax"
    );
}
#[test]
fn deadline_closes_descendant_inherited_pipes() {
    let start = Instant::now();
    assert_eq!(
        run(
            python(),
            &args(
                "import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'])"
            ),
            b"",
            Duration::from_millis(500),
            4096
        ),
        Err("process_timed_out")
    );
    assert!(start.elapsed() < Duration::from_secs(3));
}
#[test]
fn managed_termination_closes_descendant_pipes() {
    use std::io::Read;
    let mut child = spawn_managed(python(), &args("import subprocess,sys; subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); sys.stdout.buffer.write(b'ready\\n'); sys.stdout.buffer.flush(); import time; time.sleep(30)")).unwrap();
    let mut stdout = child.take_stdout().unwrap();
    let mut ready = [0; 6];
    stdout.read_exact(&mut ready).unwrap();
    assert_eq!(&ready, b"ready\n");
    let start = Instant::now();
    child.terminate_tree(Duration::from_secs(1)).unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut tail = Vec::new();
        let result = stdout.read_to_end(&mut tail);
        let _ = sender.send(result);
    });
    assert_eq!(
        receiver
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap(),
        0
    );
    assert!(start.elapsed() < Duration::from_secs(3));
}
#[tokio::test]
async fn cancellation_terminates_descendants_before_their_side_effect() {
    let root = std::env::temp_dir().join(format!("omamail-process-cancel-{}", std::process::id()));
    std::fs::create_dir(&root).unwrap();
    let ready = root.join("ready");
    let forbidden = root.join("forbidden");
    let mut argv = args(
        "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import sys,time,pathlib; pathlib.Path(sys.argv[1]).write_text(\"ready\"); time.sleep(1); pathlib.Path(sys.argv[2]).write_text(\"escaped\")',sys.argv[1],sys.argv[2]]); time.sleep(30)",
    );
    argv.extend([
        ready.to_str().unwrap().into(),
        forbidden.to_str().unwrap().into(),
    ]);
    let task = tokio::spawn(async move {
        async_run::run(python(), &argv, b"", Duration::from_secs(30), 4096).await
    });
    let start = Instant::now();
    while !ready.exists() && start.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(ready.exists(), "descendant must start before cancellation");
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(
        !forbidden.exists(),
        "cancelled descendant must never write its file"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_input_is_refused_before_process_creation() {
    assert_eq!(
        run(
            "missing-synthetic-executable",
            &[],
            b"xx",
            Duration::from_secs(1),
            1
        ),
        Err("process_input_too_large")
    );
}
#[tokio::test]
async fn blocked_stdin_cannot_defeat_the_deadline() {
    let input = vec![42; 1024 * 1024];
    let argv = args("import time; time.sleep(30)");
    let start = Instant::now();
    assert_eq!(
        run(
            python(),
            &argv,
            &input,
            Duration::from_millis(100),
            input.len()
        ),
        Err("process_timed_out")
    );
    assert!(matches!(
        async_run::run(
            python(),
            &argv,
            &input,
            Duration::from_millis(100),
            input.len()
        )
        .await,
        Err("process_timed_out")
    ));
    assert!(start.elapsed() < Duration::from_secs(3));
}
#[tokio::test]
async fn failures_never_return_stderr_as_an_error_code() {
    let argv = args("import sys; sys.stderr.write('synthetic-secret'); sys.exit(7)");
    assert_eq!(
        run(python(), &argv, b"", Duration::from_secs(5), 1024),
        Err("process_failed")
    );
    let output = async_run::run(python(), &argv, b"", Duration::from_secs(5), 1024)
        .await
        .unwrap();
    assert!(!output.success);
    assert_eq!(output.stderr, b"synthetic-secret");
    assert!(output.stdout.is_empty());
}
