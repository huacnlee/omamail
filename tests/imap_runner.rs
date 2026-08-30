use base64::{Engine as _, engine::general_purpose::STANDARD};
use omamail::{
    imap_host::{
        Action, ImapAccount, MailOperation, MailProcessOutput, MailProcessRunner,
        MailTransportExecutor, RunnerError, execute, execute_with_runner, plan,
    },
    platform::{
        commands::{CommandError, PreparedCommand},
        secrets::Secret,
    },
};
use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

fn account() -> ImapAccount {
    ImapAccount::new(
        "imap:me@example.com",
        "me@example.com",
        "imaps://mail.example.com/",
        "smtps://mail.example.com/",
        "me@example.com",
        Secret::new("runner-secret"),
    )
    .unwrap()
}

struct FakeRunner {
    seen: Mutex<Vec<SeenCommand>>,
    result: Mutex<Option<Result<MailProcessOutput, CommandError>>>,
}

#[derive(Debug, PartialEq, Eq)]
struct SeenCommand {
    program: PathBuf,
    has_stdin: bool,
    arguments: Vec<String>,
    deadline: Duration,
    max_stdout: usize,
    max_stderr: usize,
}

impl MailProcessRunner for FakeRunner {
    fn run_bounded(
        &self,
        command: PreparedCommand,
        max_stdout: usize,
        max_stderr: usize,
    ) -> Result<MailProcessOutput, CommandError> {
        self.seen.lock().unwrap().push(SeenCommand {
            program: command.program().to_path_buf(),
            has_stdin: command.has_stdin(),
            arguments: command.arguments().to_vec(),
            deadline: command.deadline(),
            max_stdout,
            max_stderr,
        });
        self.result.lock().unwrap().take().unwrap()
    }
}

fn framed(code: i32, stdout: &[u8], stderr: &[u8]) -> Vec<u8> {
    format!(
        "{code}\n{}\n{}\n",
        STANDARD.encode(stdout),
        STANDARD.encode(stderr)
    )
    .into_bytes()
}

#[test]
fn injected_runner_receives_only_protected_stdin_and_exact_deadline() {
    let runner = FakeRunner {
        seen: Mutex::new(Vec::new()),
        result: Mutex::new(Some(Ok(MailProcessOutput::new(
            Some(0),
            framed(0, b"mail bytes", b""),
            Vec::new(),
        )))),
    };
    let planned = plan(&account(), MailOperation::List { folder: "INBOX" }).unwrap();
    let executor = MailTransportExecutor::new(PathBuf::from("/opt/omamail"));
    let reply =
        execute_with_runner(planned, &executor, Duration::from_millis(4321), &runner).unwrap();

    assert_eq!(reply.stdout(), b"mail bytes");
    assert_eq!(
        runner.seen.lock().unwrap().as_slice(),
        &[SeenCommand {
            program: PathBuf::from("/opt/omamail/scripts/mail-transport.sh"),
            has_stdin: true,
            arguments: vec![],
            deadline: Duration::from_millis(4321),
            max_stdout: 2_000_000,
            max_stderr: 2_000_000,
        }]
    );
    assert!(!format!("{reply:?}").contains("mail bytes"));
}

#[test]
fn parser_rejects_bad_framing_caps_and_transport_errors_without_echoing_stderr() {
    for output in [
        MailProcessOutput::new(Some(0), b"0\nnot-base64!\n\n".to_vec(), vec![]),
        MailProcessOutput::new(Some(0), b"0\n\n\nextra\n".to_vec(), vec![]),
        MailProcessOutput::new(Some(7), vec![], b"runner-secret".to_vec()),
        MailProcessOutput::new(Some(0), framed(28, b"", b"runner-secret"), vec![]),
        MailProcessOutput::new(Some(0), vec![b'x'; 2_000_001], vec![]),
    ] {
        let runner = FakeRunner {
            seen: Mutex::new(Vec::new()),
            result: Mutex::new(Some(Ok(output))),
        };
        let error = execute_with_runner(
            plan(&account(), MailOperation::List { folder: "INBOX" }).unwrap(),
            &MailTransportExecutor::new(PathBuf::from("/opt/omamail")),
            Duration::from_secs(1),
            &runner,
        )
        .unwrap_err();
        assert!(!format!("{error:?} {error}").contains("runner-secret"));
    }
}

fn ran(operation: MailOperation<'_>, response: &[u8]) -> Result<Vec<u8>, RunnerError> {
    let runner = FakeRunner {
        seen: Mutex::new(Vec::new()),
        result: Mutex::new(Some(Ok(MailProcessOutput::new(
            Some(0),
            framed(0, response, b""),
            Vec::new(),
        )))),
    };
    execute_with_runner(
        plan(&account(), operation).unwrap(),
        &MailTransportExecutor::new(PathBuf::from("/opt/omamail")),
        Duration::from_secs(1),
        &runner,
    )
    .map(|reply| reply.stdout().to_vec())
}

#[test]
fn an_action_the_server_refused_is_not_reported_as_done() {
    // curl exits 0 here: it delivered the command and read the answer, and
    // whether the server agreed is not curl's question. Reading only the exit
    // code reported a `UID MOVE` the server refused as an archive that
    // happened, with the row already gone from the list.
    for refusal in [
        &b"A1 NO [TRYCREATE] Mailbox does not exist\r\n"[..],
        &b"A2 BAD Invalid arguments\r\n"[..],
        &b"* OK still going\r\nA3 no over quota\r\n"[..],
        // Tab-separated, and a run of spaces: the tag and the word are fields,
        // not a fixed offset.
        &b"A4\tNO refused\r\n"[..],
        &b"A5  BAD refused\r\n"[..],
    ] {
        assert_eq!(
            ran(
                MailOperation::Action {
                    message_id: "7:INBOX",
                    action: Action::Move {
                        destination: "Archive",
                    },
                },
                refusal,
            ),
            Err(RunnerError::ServerRefused),
            "{}",
            String::from_utf8_lossy(refusal)
        );
    }
}

#[test]
fn a_message_that_merely_contains_the_word_is_still_delivered() {
    // The one thing this cannot be wrong about is where a literal ends. A
    // header a stranger wrote is not the server refusing a command, and a
    // message that could forge one by saying so is the reason this walks the
    // response rather than searching it.
    let header = b"X-Spam-Flag: NO\r\nA1 BAD not a completion\r\n";
    let mut response =
        format!("* 1 FETCH (UID 7 BODY[HEADER] {{{}}}\r\n", header.len()).into_bytes();
    response.extend_from_slice(header);
    response.extend_from_slice(b")\r\n");
    assert_eq!(
        ran(MailOperation::List { folder: "INBOX" }, &response),
        Ok(response.clone())
    );

    // Untagged and continuation lines are not completions either, and an
    // ordinary answer carries no tagged completion at all: curl strips it.
    for benign in [
        &b"* NO [ALERT] mailbox maintenance\r\n"[..],
        &b"+ NO is continuation text\r\n"[..],
        &b"* 1 FETCH (UID 7)\r\nA1 OK completed\r\n"[..],
        &b""[..],
    ] {
        assert_eq!(
            ran(MailOperation::List { folder: "INBOX" }, benign),
            Ok(benign.to_vec()),
            "{}",
            String::from_utf8_lossy(benign)
        );
    }
}

#[test]
fn an_smtp_reply_is_left_to_curl_to_judge() {
    // SMTP refuses with a reply code, which curl already turns into a non-zero
    // exit — and its transcript is not IMAP, so nothing here may read a line
    // of it as a tagged completion.
    assert_eq!(
        ran(
            MailOperation::Send {
                from: "me@example.com",
                recipients: vec!["you@example.com"],
                subject: "Hi",
                body: "Body",
            },
            b"250 NO problem\r\n",
        ),
        Ok(b"250 NO problem\r\n".to_vec())
    );
}

#[cfg(unix)]
#[test]
fn concrete_runner_executes_the_script_and_enforces_the_deadline() {
    use std::os::unix::fs::PermissionsExt as _;
    let temporary = tempfile::tempdir().unwrap();
    let scripts = temporary.path().join("scripts");
    fs::create_dir(&scripts).unwrap();
    let success = scripts.join("mail-transport.sh");
    fs::write(
        &success,
        format!(
            "#!/bin/sh\nIFS= read -r line\n[ -n \"$line\" ] || exit 9\nprintf '0\\n{}\\n\\n'\n",
            STANDARD.encode(b"actual")
        ),
    )
    .unwrap();
    fs::set_permissions(&success, fs::Permissions::from_mode(0o700)).unwrap();
    let reply = execute(
        plan(&account(), MailOperation::List { folder: "INBOX" }).unwrap(),
        &MailTransportExecutor::new(temporary.path().to_path_buf()),
        Duration::from_secs(1),
    )
    .unwrap();
    assert_eq!(reply.stdout(), b"actual");

    fs::write(&success, "#!/bin/sh\nread line\nsleep 5\n").unwrap();
    let started = Instant::now();
    let error = execute(
        plan(&account(), MailOperation::List { folder: "INBOX" }).unwrap(),
        &MailTransportExecutor::new(temporary.path().to_path_buf()),
        Duration::from_millis(30),
    )
    .unwrap_err();
    assert_eq!(error, RunnerError::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn platform_unavailable_remains_a_distinct_error() {
    let runner = FakeRunner {
        seen: Mutex::new(Vec::new()),
        result: Mutex::new(Some(Err(CommandError::PlatformUnavailable))),
    };
    let error = execute_with_runner(
        plan(&account(), MailOperation::List { folder: "INBOX" }).unwrap(),
        &MailTransportExecutor::new(PathBuf::from("/opt/omamail")),
        Duration::from_secs(1),
        &runner,
    )
    .unwrap_err();
    assert_eq!(error, RunnerError::PlatformUnavailable);
}

#[cfg(windows)]
#[test]
fn system_runner_fails_closed_as_platform_unavailable_on_windows() {
    let error = execute(
        plan(&account(), MailOperation::List { folder: "INBOX" }).unwrap(),
        &MailTransportExecutor::new(PathBuf::from(r"C:\Program Files\Omamail")),
        Duration::from_secs(1),
    )
    .unwrap_err();
    assert_eq!(error, RunnerError::PlatformUnavailable);
}

#[cfg(unix)]
#[test]
fn system_runner_stops_an_output_flood_before_the_deadline() {
    use std::os::unix::fs::PermissionsExt as _;
    let temporary = tempfile::tempdir().unwrap();
    let scripts = temporary.path().join("scripts");
    fs::create_dir(&scripts).unwrap();
    let script = scripts.join("mail-transport.sh");
    let pid_file = temporary.path().join("child.pid");
    fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nread line\nwhile :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done\n",
            pid_file.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    let started = Instant::now();
    let error = execute(
        plan(&account(), MailOperation::List { folder: "INBOX" }).unwrap(),
        &MailTransportExecutor::new(temporary.path().to_path_buf()),
        Duration::from_secs(10),
    )
    .unwrap_err();
    assert_eq!(error, RunnerError::OutputTooLarge);
    assert!(started.elapsed() < Duration::from_secs(2));
    let pid: i32 = fs::read_to_string(pid_file).unwrap().parse().unwrap();
    let missing = unsafe { libc::kill(pid, 0) } == -1
        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
    assert!(
        missing,
        "bounded runner returned before directly reaping pid {pid}"
    );
}
