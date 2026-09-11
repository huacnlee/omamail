use super::*;
use serde_json::json;

fn parser() -> ClaudeStream {
    ClaudeStream::new(vec![json!({"role":"user","text":"Synthetic prompt"})]).unwrap()
}
fn fake(script: &str) -> Command {
    let mut command = Command::new("python3");
    command.args(["-c", script]);
    command
}
async fn run_fake(script: &str) -> (Outcome, ClaudeStream) {
    let mut parser = parser();
    let result = execute(
        fake(script),
        b"Synthetic secret on stdin",
        &mut parser,
        Duration::from_secs(5),
        std::future::pending(),
        |_| Ok(()),
    )
    .await;
    (result, parser)
}

#[tokio::test]
async fn full_duplex_drains_diagnostics_without_persisting_and_requires_success() {
    let script = r#"import sys,json
sys.stderr.write('hidden credential/tool diagnostics'*20000);sys.stderr.flush()
data=sys.stdin.buffer.read()
assert data==b'x'*900000
assert len(sys.argv)==1
print(json.dumps({'type':'result','subtype':'success','result':'Visible answer'}))
"#;
    let mut parser = parser();
    let result = execute(
        fake(script),
        &vec![b'x'; 900000],
        &mut parser,
        Duration::from_secs(5),
        std::future::pending(),
        |_| Ok(()),
    )
    .await;
    assert!(!result.cancelled);
    assert_eq!(result.failure, None);
    assert_eq!(parser.display()["output"], "Visible answer");
    assert!(!parser.display().to_string().contains("hidden credential"));
}

#[tokio::test]
async fn incomplete_nonzero_and_invalid_events_cannot_succeed() {
    for script in [
        "print('{}')",
        "import sys;sys.stdout.write('{')",
        "print('not JSON')",
        "import json,sys;print(json.dumps({'type':'result','subtype':'success','result':'Answer'}));sys.exit(3)",
    ] {
        let (outcome, _) = run_fake(script).await;
        assert!(outcome.failure.is_some(), "{script}");
    }
}

#[tokio::test]
async fn invalid_event_preserves_last_valid_snapshot() {
    let (outcome, parser)=run_fake("import json;print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'Safe answer'}]}}));print(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'\\x1bsecret'}]}}))").await;
    assert!(outcome.failure.is_some());
    assert_eq!(parser.display()["output"], "Safe answer");
    assert!(!parser.display().to_string().contains("secret"));
}

#[tokio::test]
async fn wire_and_unterminated_event_are_bounded() {
    let (event, _) = run_fake("import sys;sys.stdout.write('x'*524289);sys.stdout.flush()").await;
    assert_eq!(
        event.failure,
        Some("The AI stream event exceeded its size limit.")
    );
    let (wire, _) = run_fake("import sys;sys.stderr.write('x'*9000000);sys.stderr.flush()").await;
    assert_eq!(
        wire.failure,
        Some("The AI stream exceeded its size limit. Ask for a shorter answer.")
    );
}

#[tokio::test]
async fn cancellation_and_deadline_kill_process_group() {
    for cancel in [false, true] {
        let folder = std::env::temp_dir().join(format!(
            "omamail-worker-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&folder).unwrap();
        let pidpath = folder.join("pid");
        let script = format!(
            "import os,signal,time\npid=os.fork()\nif pid==0:\n signal.signal(signal.SIGTERM,signal.SIG_IGN)\n open({},'w').write(str(os.getpid()))\n while True: time.sleep(1)\nwhile True: time.sleep(1)",
            serde_json::to_string(&pidpath.to_string_lossy()).unwrap()
        );
        let mut parser = parser();
        let cancel_future = async {
            if cancel {
                tokio::time::sleep(Duration::from_millis(150)).await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        let start = std::time::Instant::now();
        let outcome = execute(
            fake(&script),
            b"input",
            &mut parser,
            Duration::from_millis(300),
            cancel_future,
            |_| Ok(()),
        )
        .await;
        assert_eq!(outcome.cancelled, cancel);
        if !cancel {
            assert_eq!(
                outcome.failure,
                Some("The AI request reached its one-hour limit.")
            );
        }
        assert!(start.elapsed() < Duration::from_secs(3));
        let pid = std::fs::read_to_string(pidpath).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await;
        let status = std::fs::read_to_string(format!("/proc/{pid}/stat"));
        assert!(
            status.is_err() || status.unwrap().split_whitespace().nth(2) == Some("Z"),
            "group descendant still running"
        );
        std::fs::remove_dir_all(folder).unwrap();
    }
}

#[tokio::test]
async fn successful_leader_stays_reserved_until_descendant_cleanup() {
    let folder = std::env::temp_dir().join(format!(
        "omamail-worker-cleanup-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&folder).unwrap();
    let ready = folder.join("ready");
    let term = folder.join("term");
    let script = format!(
        r#"import os,sys,signal,time,json
pid=os.fork()
if pid==0:
 os.dup2(os.open('/dev/null',os.O_WRONLY),1)
 os.dup2(os.open('/dev/null',os.O_WRONLY),2)
 signal.signal(signal.SIGTERM,lambda *args: open({term},'w').write('terminated'))
 open({ready},'w').write(str(os.getpid()))
 while True: time.sleep(1)
while not os.path.exists({ready}): time.sleep(.005)
sys.stdin.buffer.read()
print(json.dumps({{'type':'result','subtype':'success','result':'Done'}}))
"#,
        term = serde_json::to_string(&term.to_string_lossy()).unwrap(),
        ready = serde_json::to_string(&ready.to_string_lossy()).unwrap()
    );
    let start = std::time::Instant::now();
    let (outcome, _) = run_fake(&script).await;
    assert_eq!(outcome.failure, None);
    assert!(start.elapsed() >= Duration::from_millis(200));
    assert_eq!(std::fs::read_to_string(term).unwrap(), "terminated");
    let pid = std::fs::read_to_string(ready).unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    let status = std::fs::read_to_string(format!("/proc/{pid}/stat"));
    assert!(status.is_err() || status.unwrap().split_whitespace().nth(2) == Some("Z"));
    std::fs::remove_dir_all(folder).unwrap();
}

#[tokio::test]
async fn oversized_prompt_refuses_before_process_start() {
    let path = std::env::temp_dir().join(format!(
        "omamail-worker-forbidden-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let script = format!(
        "open({},'w').write('forbidden')",
        serde_json::to_string(&path.to_string_lossy()).unwrap()
    );
    let mut parser = parser();
    let outcome = execute(
        fake(&script),
        &vec![b'x'; INPUT_LIMIT + 1],
        &mut parser,
        Duration::from_secs(2),
        std::future::pending(),
        |_| Ok(()),
    )
    .await;
    assert!(outcome.failure.is_some());
    assert!(!path.exists());
}
