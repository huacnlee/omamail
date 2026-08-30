use std::{
    collections::VecDeque,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use omamail::effects::ProviderRuntime;
use omamail::{
    effects::{EffectHost, EffectHostError, GroupwareRuntime, HeyCommandOutput, HeyRunner},
    platform::commands::{CommandError, PreparedCommand, ProcessOutput, ProcessRunner},
};

type SeenTransportCommand = (std::path::PathBuf, Vec<String>, bool, Duration);
struct FakeTransportRunner {
    commands: Mutex<Vec<SeenTransportCommand>>,
    replies: Mutex<VecDeque<Result<ProcessOutput, CommandError>>>,
}
impl ProcessRunner for FakeTransportRunner {
    fn run(&self, command: PreparedCommand) -> Result<ProcessOutput, CommandError> {
        self.run_bounded(command, usize::MAX, usize::MAX)
    }
    fn run_bounded(
        &self,
        command: PreparedCommand,
        _: usize,
        _: usize,
    ) -> Result<ProcessOutput, CommandError> {
        self.commands.lock().unwrap().push((
            command.program().to_owned(),
            command.arguments().to_vec(),
            command.has_stdin(),
            command.deadline(),
        ));
        self.replies.lock().unwrap().pop_front().unwrap()
    }
}

#[derive(Default)]
struct FakeProviderRuntime {
    configured: Mutex<Vec<String>>,
    requests: Mutex<Vec<String>>,
}
impl ProviderRuntime for FakeProviderRuntime {
    fn configure(&self, json: &str) -> Result<(), EffectHostError> {
        self.configured.lock().unwrap().push(json.to_owned());
        Ok(())
    }
    fn dispatch(&self, json: &str) -> String {
        self.requests.lock().unwrap().push(json.to_owned());
        r#"{"ok":true,"data":{"messages":[]},"identity":{"accountId":"me@example.test","objectId":"","revision":1}}"#.into()
    }
}
struct FakeGroupware;
impl GroupwareRuntime for FakeGroupware {
    fn dispatch(&self, _: &str) -> String {
        r#"{"ok":true,"data":{"accepted":true}}"#.into()
    }
}

struct FakeHeyRunner {
    commands: Mutex<Vec<Vec<String>>>,
    deadlines: Mutex<Vec<Duration>>,
    replies: Mutex<VecDeque<Result<HeyCommandOutput, CommandError>>>,
}

struct ComposeHeyRunner {
    commands: Mutex<Vec<(Vec<String>, bool, Duration)>>,
    replies: Mutex<VecDeque<Result<HeyCommandOutput, CommandError>>>,
}
impl HeyRunner for ComposeHeyRunner {
    fn run_hey(&self, command: PreparedCommand) -> Result<HeyCommandOutput, CommandError> {
        self.commands.lock().unwrap().push((
            command.arguments().to_vec(),
            command.has_stdin(),
            command.deadline(),
        ));
        self.replies.lock().unwrap().pop_front().unwrap()
    }
}
impl FakeHeyRunner {
    fn replying(stdout: &str) -> Self {
        Self {
            commands: Mutex::new(Vec::new()),
            deadlines: Mutex::new(Vec::new()),
            replies: Mutex::new(VecDeque::from([Ok(HeyCommandOutput::success(stdout))])),
        }
    }
}
impl HeyRunner for FakeHeyRunner {
    fn run_hey(&self, command: PreparedCommand) -> Result<HeyCommandOutput, CommandError> {
        assert!(!command.has_stdin());
        self.deadlines.lock().unwrap().push(command.deadline());
        self.commands
            .lock()
            .unwrap()
            .push(command.arguments().to_vec());
        self.replies.lock().unwrap().pop_front().unwrap()
    }
}

fn account_reply(address: &str) -> HeyCommandOutput {
    HeyCommandOutput::success(format!(
        r#"{{"ok":true,"data":[{{"id":"all"}},{{"id":"1","email":"{address}"}}]}}"#
    ))
}

fn thread_request(message_id: &str) -> String {
    format!(
        r#"{{"operation":"hey.thread","deadlineMs":1000,"accountId":"hey:me@example.test","identity":{{"accountId":"hey:me@example.test","query":"box:imbox","objectId":"{message_id}","revision":1}},"messageId":"{message_id}"}}"#
    )
}

#[test]
fn hey_operation_verifies_the_exact_first_cli_account_under_one_deadline() {
    let runner = Arc::new(FakeHeyRunner {
        commands: Mutex::new(Vec::new()),
        deadlines: Mutex::new(Vec::new()),
        replies: Mutex::new(VecDeque::from([
            Ok(account_reply("me@example.test")),
            Ok(HeyCommandOutput::success(
                r#"{"ok":true,"data":{"items":[]}}"#,
            )),
        ])),
    });
    let host = EffectHost::with_hey_runner(Path::new("/opt/omamail/app"), runner.clone());
    let request = EffectHost::parse(r#"{"operation":"hey.list","deadlineMs":1000,"accountId":"hey:me@example.test","identity":{"accountId":"hey:me@example.test","query":"box:imbox","objectId":"","revision":1},"query":{"kind":"box","box":"imbox"}}"#).unwrap();
    host.execute(request).unwrap();
    assert_eq!(
        runner.commands.lock().unwrap().as_slice(),
        [["accounts", "list", "--json"], ["box", "imbox", "--json"]]
    );
    let deadlines = runner.deadlines.lock().unwrap();
    assert!(deadlines[0] <= Duration::from_millis(1000));
    assert!(deadlines[1] <= deadlines[0]);

    assert!(EffectHost::parse(r#"{"operation":"hey.list","deadlineMs":1000,"accountId":"hey:other@example.test","identity":{"accountId":"hey:me@example.test","query":"box:imbox","objectId":"","revision":1},"query":{"kind":"box","box":"imbox"}}"#).is_err());

    let wrong = Arc::new(FakeHeyRunner {
        commands: Mutex::new(Vec::new()),
        deadlines: Mutex::new(Vec::new()),
        replies: Mutex::new(VecDeque::from([Ok(account_reply(
            "someone-else@example.test",
        ))])),
    });
    let host = EffectHost::with_hey_runner(Path::new("/opt/omamail/app"), wrong.clone());
    let request = EffectHost::parse(r#"{"operation":"hey.list","deadlineMs":1000,"accountId":"hey:me@example.test","identity":{"accountId":"hey:me@example.test","query":"box:imbox","objectId":"","revision":1},"query":{"kind":"box","box":"imbox"}}"#).unwrap();
    assert_eq!(host.execute(request), Err(EffectHostError::Failed));
    assert_eq!(
        wrong.commands.lock().unwrap().as_slice(),
        [["accounts", "list", "--json"]]
    );
}

#[test]
fn effect_host_rejects_an_oversized_request_before_json_dispatch() {
    let request = format!(
        "{{\"operation\":\"{}\",\"deadlineMs\":1000}}",
        "x".repeat(16 * 1024)
    );
    assert_eq!(
        EffectHost::parse(&request).expect_err("oversized input"),
        EffectHostError::InvalidRequest
    );
}
#[test]
fn effect_host_refuses_unknown_operations_without_echoing_untrusted_json() {
    let error = EffectHost::parse("{\"operation\":\"process.run\",\"program\":\"/bin/sh\"}")
        .expect_err("no ambient execution");
    assert_eq!(error, EffectHostError::Unsupported);
    assert!(!error.to_string().contains("/bin/sh"));
}
#[test]
fn effect_host_requires_a_bounded_deadline_for_a_closed_operation() {
    assert_eq!(
        EffectHost::parse("{\"operation\":\"hey.status\",\"deadlineMs\":0}")
            .expect_err("zero deadline"),
        EffectHostError::InvalidRequest
    );
}
#[test]
fn effect_host_marks_unimplemented_provider_effects_unsupported() {
    let request =
        EffectHost::parse("{\"operation\":\"imap.request\",\"deadlineMs\":1000}").unwrap();
    assert_eq!(
        EffectHost::dispatch(request).unwrap_err(),
        EffectHostError::Unsupported
    );
}
#[test]
fn effect_host_runs_a_closed_hey_list_and_returns_only_its_envelope_data() {
    let runner = Arc::new(FakeHeyRunner {
        commands: Mutex::new(Vec::new()),
        deadlines: Mutex::new(Vec::new()),
        replies: Mutex::new(VecDeque::from([
            Ok(account_reply("me@example.test")),
            Ok(HeyCommandOutput::success(
                r#"{"ok":true,"data":{"items":[]},"error":"token=do-not-return"}"#,
            )),
        ])),
    });
    let host = EffectHost::with_hey_runner(Path::new("/opt/omamail/app"), runner.clone());
    let request = EffectHost::parse(
        r#"{"operation":"hey.list","deadlineMs":1000,"accountId":"hey:me@example.test","identity":{"accountId":"hey:me@example.test","query":"box:imbox","objectId":"","revision":1},"query":{"kind":"box","box":"imbox"}}"#,
    )
    .unwrap();
    let response = host.execute(request).unwrap();
    assert_eq!(response, r#"{"ok":true,"data":{"items":[]}}"#);
    assert!(!response.contains("do-not-return"));
    assert_eq!(
        runner.commands.lock().unwrap().as_slice(),
        [["accounts", "list", "--json"], ["box", "imbox", "--json"]]
    );
}

#[test]
fn configured_semantic_provider_request_reaches_the_provider_runtime() {
    let runtime = Arc::new(FakeProviderRuntime::default());
    let host = EffectHost::with_runners(
        Path::new("/opt/omamail/app"),
        Arc::new(FakeHeyRunner::replying(r#"{"ok":true,"data":null}"#)),
        runtime.clone(),
    );
    host.configure(r#"[{"kind":"gmail","accountId":"me@example.test"}]"#)
        .unwrap();
    let request = r#"{"operation":"gmail.list","deadlineMs":1000,"identity":{"accountId":"me@example.test","objectId":"","revision":1},"query":"","maxResults":25}"#;
    assert!(host.execute_json(request).unwrap().contains("messages"));
    assert_eq!(runtime.requests.lock().unwrap().as_slice(), [request]);
}

#[test]
fn groupware_route_is_honestly_unsupported() {
    let runtime = Arc::new(FakeProviderRuntime::default());
    let host = EffectHost::with_runners(
        Path::new("/opt/omamail/app"),
        Arc::new(FakeHeyRunner::replying("{}")),
        runtime,
    );
    assert_eq!(
        host.execute_json(r#"{"type":"compose.send"}"#).unwrap(),
        r#"{"ok":false,"error":"groupware provider is unavailable"}"#
    );
}
#[test]
fn groupware_route_reaches_the_registered_runtime() {
    let host = EffectHost::with_host_runtimes(
        Path::new("/opt/omamail/app"),
        Arc::new(FakeHeyRunner::replying("{}")),
        Arc::new(FakeProviderRuntime::default()),
        Arc::new(FakeGroupware),
    );
    assert_eq!(
        host.execute_json(r#"{"type":"compose.send"}"#).unwrap(),
        r#"{"ok":true,"data":{"accepted":true}}"#
    );
}

#[test]
fn closed_transport_effects_use_only_policy_scripts_and_structured_results() {
    let transport = Arc::new(FakeTransportRunner {
        commands: Mutex::new(vec![]),
        replies: Mutex::new(VecDeque::from([
            Ok(ProcessOutput::new(
                Some(0),
                b"data:image/png;base64,AA==\n".to_vec(),
                vec![],
            )),
            Ok(ProcessOutput::new(Some(0), b"0 204\n".to_vec(), vec![])),
        ])),
    });
    let host = EffectHost::with_transport_runner(
        Path::new("/opt/omamail/app"),
        Arc::new(FakeHeyRunner::replying("{}")),
        Arc::new(FakeProviderRuntime::default()),
        transport.clone(),
    );
    assert_eq!(
        host.execute_json(
            r#"{"operation":"image.fetch","deadlineMs":1000,"url":"https://8.8.8.8/pixel.png"}"#
        )
        .unwrap(),
        r#"{"ok":true,"data":{"dataUri":"data:image/png;base64,AA=="}}"#,
    );
    assert_eq!(
        host.execute_json(r#"{"operation":"unsubscribe","deadlineMs":1000,"url":"https://8.8.8.8/unsubscribe","contentType":"application/x-www-form-urlencoded","body":"List-Unsubscribe=One-Click"}"#).unwrap(),
        r#"{"ok":true,"data":{"httpStatus":204,"unsubscribed":true}}"#,
    );
    let commands = transport.commands.lock().unwrap();
    assert_eq!(
        commands[0].0,
        Path::new("/opt/omamail/scripts/image-fetch.sh")
    );
    assert_eq!(
        commands[1].0,
        Path::new("/opt/omamail/scripts/unsubscribe.sh")
    );
    assert!(
        commands
            .iter()
            .all(|(_, args, stdin, deadline)| args.is_empty()
                && *stdin
                && *deadline <= Duration::from_secs(1))
    );
}

#[test]
fn closed_transport_effects_reject_extra_fields_and_private_or_non_https_targets() {
    let host = EffectHost::with_transport_runner(
        Path::new("/opt/omamail/app"),
        Arc::new(FakeHeyRunner::replying("{}")),
        Arc::new(FakeProviderRuntime::default()),
        Arc::new(FakeTransportRunner {
            commands: Mutex::new(vec![]),
            replies: Mutex::new(VecDeque::new()),
        }),
    );
    for request in [
        r#"{"operation":"image.fetch","deadlineMs":1000,"url":"http://127.0.0.1/x"}"#,
        r#"{"operation":"unsubscribe","deadlineMs":1000,"url":"http://8.8.8.8/x","contentType":"text/plain","body":"x"}"#,
    ] {
        assert!(host.execute_json(request).is_err(), "accepted {request}");
    }
    assert!(EffectHost::parse(r#"{"operation":"image.fetch","deadlineMs":1000,"url":"https://8.8.8.8/x","program":"/bin/sh"}"#).is_err());
}
#[test]
fn effect_host_uses_topic_for_threads_and_postings_for_actions() {
    let runner = Arc::new(FakeHeyRunner {
        commands: Mutex::new(Vec::new()),
        deadlines: Mutex::new(Vec::new()),
        replies: Mutex::new(VecDeque::from([
            Ok(account_reply("me@example.test")),
            Ok(HeyCommandOutput::success(r#"{"ok":true,"data":{}}"#)),
            Ok(account_reply("me@example.test")),
            Ok(HeyCommandOutput::success(r#"{"ok":true,"data":null}"#)),
        ])),
    });
    let host = EffectHost::with_hey_runner(Path::new("/opt/omamail/app"), runner.clone());
    let thread = EffectHost::parse(&thread_request("17:99")).unwrap();
    let action = EffectHost::parse(r#"{"operation":"hey.action","deadlineMs":1000,"accountId":"hey:me@example.test","identity":{"accountId":"hey:me@example.test","query":"box:imbox","objectId":"17:99","revision":1},"action":"mark-read","messageIds":["17:99","18:99","17:99"]}"#).unwrap();
    host.execute(thread).unwrap();
    host.execute(action).unwrap();
    assert_eq!(
        runner.commands.lock().unwrap().as_slice(),
        vec![
            vec!["accounts", "list", "--json"],
            vec!["threads", "99", "--allow-partial", "--html"],
            vec!["accounts", "list", "--json"],
            vec!["seen", "17", "18", "--json"],
        ]
    );
}

#[test]
fn hey_compose_uses_topic_for_reply_and_protected_stdin_under_one_deadline() {
    let runner = Arc::new(ComposeHeyRunner {
        commands: Mutex::new(Vec::new()),
        replies: Mutex::new(VecDeque::from([
            Ok(account_reply("me@example.test")),
            Ok(HeyCommandOutput::success(r#"{"ok":true,"data":{}}"#)),
        ])),
    });
    let host = EffectHost::with_hey_runner(Path::new("/opt/omamail/app"), runner.clone());
    let request = EffectHost::parse(r#"{"operation":"hey.compose","deadlineMs":1000,"accountId":"hey:me@example.test","mode":"reply","topicId":"99","to":[],"cc":[],"bcc":[],"subject":"Re: Hi","body":"secret body"}"#).unwrap();
    host.execute(request).unwrap();
    let commands = runner.commands.lock().unwrap();
    assert_eq!(commands[0].0, ["accounts", "list", "--json"]);
    assert_eq!(commands[1].0, ["reply", "99"]);
    assert!(!commands[0].1);
    assert!(commands[1].1);
    assert!(!format!("{:?}", commands[1].0).contains("secret body"));
    assert!(commands[1].2 <= commands[0].2);
}

#[test]
fn hey_forward_uses_fixed_compose_arguments_and_rejects_reply_all() {
    let runner = Arc::new(ComposeHeyRunner {
        commands: Mutex::new(Vec::new()),
        replies: Mutex::new(VecDeque::from([
            Ok(account_reply("me@example.test")),
            Ok(HeyCommandOutput::success(r#"{"ok":true,"data":null}"#)),
        ])),
    });
    let host = EffectHost::with_hey_runner(Path::new("/opt/omamail/app"), runner.clone());
    let request = EffectHost::parse(r#"{"operation":"hey.compose","deadlineMs":1000,"accountId":"hey:me@example.test","mode":"forward","topicId":"","to":["to@example.test"],"cc":["cc@example.test"],"bcc":[],"subject":"Fwd: Hi","body":"body"}"#).unwrap();
    host.execute(request).unwrap();
    assert_eq!(
        runner.commands.lock().unwrap()[1].0,
        [
            "compose",
            "--to",
            "to@example.test",
            "--cc",
            "cc@example.test",
            "--subject",
            "Fwd: Hi"
        ]
    );
    assert!(EffectHost::parse(r#"{"operation":"hey.compose","deadlineMs":1000,"accountId":"hey:me@example.test","mode":"replyAll","topicId":"99","to":[],"cc":[],"bcc":[],"subject":"","body":"body"}"#).is_err());
    assert!(EffectHost::parse(r#"{"operation":"hey.compose","deadlineMs":1000,"accountId":"hey:me@example.test","mode":"reply","topicId":"99:1","to":[],"cc":[],"bcc":[],"subject":"","body":"body"}"#).is_err());
}

#[test]
fn hey_thread_retries_only_the_named_boolean_flags_and_remembers_them() {
    let runner = Arc::new(FakeHeyRunner {
        commands: Mutex::new(Vec::new()),
        deadlines: Mutex::new(Vec::new()),
        replies: Mutex::new(VecDeque::from([
            Ok(account_reply("me@example.test")),
            Ok(HeyCommandOutput::success(
                r#"{"ok":false,"error":"unknown flag: --allow-partial"}"#,
            )),
            Ok(HeyCommandOutput::success(
                r#"{"ok":false,"error":"unknown flag: --html"}"#,
            )),
            Ok(HeyCommandOutput::success("<article>Hello</article>")),
            Ok(account_reply("me@example.test")),
            Ok(HeyCommandOutput::success("<article>Again</article>")),
        ])),
    });
    let host = EffectHost::with_hey_runner(Path::new("/opt/omamail/app"), runner.clone());
    let first = EffectHost::parse(&thread_request("17:99")).unwrap();
    let second = EffectHost::parse(&thread_request("18:100")).unwrap();

    assert_eq!(
        host.execute(first).unwrap(),
        r#"{"ok":true,"data":{"kind":"thread","html":"<article>Hello</article>","text":""}}"#
    );
    assert_eq!(
        host.execute(second).unwrap(),
        r#"{"ok":true,"data":{"kind":"thread","html":"<article>Again</article>","text":""}}"#
    );
    assert_eq!(
        runner.commands.lock().unwrap().as_slice(),
        vec![
            vec!["accounts", "list", "--json"],
            vec!["threads", "99", "--allow-partial", "--html"],
            vec!["threads", "99", "--html"],
            vec!["threads", "99"],
            vec!["accounts", "list", "--json"],
            vec!["threads", "100"],
        ]
    );
}

#[test]
fn hey_thread_never_drops_a_value_taking_flag_from_an_unknown_flag_error() {
    let runner = Arc::new(FakeHeyRunner {
        commands: Mutex::new(Vec::new()),
        deadlines: Mutex::new(Vec::new()),
        replies: Mutex::new(VecDeque::from([
            Ok(account_reply("me@example.test")),
            Ok(HeyCommandOutput::success(
                r#"{"ok":false,"error":"unknown flag: --page"}"#,
            )),
        ])),
    });
    let host = EffectHost::with_hey_runner(Path::new("/opt/omamail/app"), runner.clone());
    let request = EffectHost::parse(&thread_request("17:99")).unwrap();

    assert_eq!(host.execute(request), Err(EffectHostError::Failed));
    assert_eq!(
        runner.commands.lock().unwrap().as_slice(),
        vec![
            vec!["accounts", "list", "--json"],
            vec!["threads", "99", "--allow-partial", "--html"]
        ]
    );
}

#[test]
fn hey_thread_never_treats_successful_html_body_text_as_an_unknown_flag_error() {
    let runner = Arc::new(FakeHeyRunner {
        commands: Mutex::new(Vec::new()),
        deadlines: Mutex::new(Vec::new()),
        replies: Mutex::new(VecDeque::from([
            Ok(account_reply("me@example.test")),
            Ok(HeyCommandOutput::success(
                "Newsletter: unknown flag: --html",
            )),
            Ok(account_reply("me@example.test")),
            Ok(HeyCommandOutput::success("<p>Second thread</p>")),
        ])),
    });
    let host = EffectHost::with_hey_runner(Path::new("/opt/omamail/app"), runner.clone());
    let first = EffectHost::parse(&thread_request("17:99")).unwrap();
    let second = EffectHost::parse(&thread_request("18:100")).unwrap();

    assert_eq!(
        host.execute(first).unwrap(),
        r#"{"ok":true,"data":{"kind":"thread","html":"Newsletter: unknown flag: --html","text":""}}"#
    );
    host.execute(second).unwrap();
    assert_eq!(
        runner.commands.lock().unwrap().as_slice(),
        vec![
            vec!["accounts", "list", "--json"],
            vec!["threads", "99", "--allow-partial", "--html"],
            vec!["accounts", "list", "--json"],
            vec!["threads", "100", "--allow-partial", "--html"],
        ]
    );
}

#[test]
fn rust_thread_contract_matches_the_canonical_hey_cli_flags() {
    let canonical = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/app/providers/HeyCli.js"
    ));

    assert!(canonical.contains("return [\"threads\", topic, \"--allow-partial\", \"--html\"]"));
    assert!(canonical.contains("return name === \"--allow-partial\" || name === \"--html\""));
}
#[test]
fn effect_host_refuses_a_hey_envelope_error_without_echoing_it() {
    let runner = Arc::new(FakeHeyRunner::replying(
        r#"{"ok":false,"error":"token=do-not-return"}"#,
    ));
    let host = EffectHost::with_hey_runner(Path::new("/opt/omamail/app"), runner.clone());
    let request = EffectHost::parse(r#"{"operation":"hey.status","deadlineMs":1000}"#).unwrap();
    let error = host.execute(request).unwrap_err();
    assert_eq!(error, EffectHostError::Failed);
    assert!(!error.to_string().contains("do-not-return"));
    assert_eq!(
        runner.commands.lock().unwrap().as_slice(),
        [["auth", "status", "--json"]]
    );
}
#[test]
fn effect_host_refuses_oversized_hey_stdout_before_json_parsing() {
    let runner = Arc::new(FakeHeyRunner {
        commands: Mutex::new(Vec::new()),
        deadlines: Mutex::new(Vec::new()),
        replies: Mutex::new(VecDeque::from([Ok(HeyCommandOutput::from_stdout(
            vec![b'x'; 512 * 1024 + 1],
        ))])),
    });
    let host = EffectHost::with_hey_runner(Path::new("/opt/omamail/app"), runner);
    let request = EffectHost::parse(r#"{"operation":"hey.status","deadlineMs":1000}"#).unwrap();
    assert_eq!(host.execute(request), Err(EffectHostError::Failed));
}
