use omamail::{
    effects::EffectHost,
    hey_setup::{
        HeySetupDispatcher, HeySetupOutput, HeySetupRunner, ProductionHeySetup,
        TerminalLaunchError, TerminalLaunchPlan, TerminalLauncher, resolve_hey_executable,
    },
    platform::commands::{CommandError, PreparedCommand},
};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Mutex, time::Duration};

struct Runner {
    commands: Mutex<Vec<(PathBuf, Vec<String>, Duration)>>,
    replies: Mutex<Vec<HeySetupOutput>>,
}
impl Runner {
    fn new(replies: Vec<HeySetupOutput>) -> Self {
        Self {
            commands: Mutex::new(vec![]),
            replies: Mutex::new(replies),
        }
    }
}
impl HeySetupRunner for Runner {
    fn run_bounded(
        &self,
        command: PreparedCommand,
        _: usize,
        _: usize,
    ) -> Result<HeySetupOutput, CommandError> {
        self.commands.lock().unwrap().push((
            command.program().to_owned(),
            command.arguments().to_vec(),
            command.deadline(),
        ));
        Ok(self.replies.lock().unwrap().remove(0))
    }
}

#[derive(Default)]
struct Launcher(Mutex<Vec<TerminalLaunchPlan>>);
impl TerminalLauncher for Launcher {
    fn launch(&self, plan: TerminalLaunchPlan) -> Result<(), TerminalLaunchError> {
        self.0.lock().unwrap().push(plan);
        Ok(())
    }
}

struct UnavailableLauncher;
impl TerminalLauncher for UnavailableLauncher {
    fn launch(&self, _: TerminalLaunchPlan) -> Result<(), TerminalLaunchError> {
        Err(TerminalLaunchError::PlatformUnavailable)
    }
}

struct UnavailableRunner;
impl HeySetupRunner for UnavailableRunner {
    fn run_bounded(
        &self,
        _: PreparedCommand,
        _: usize,
        _: usize,
    ) -> Result<HeySetupOutput, CommandError> {
        Err(CommandError::PlatformUnavailable)
    }
}

fn dispatch(dispatcher: &HeySetupDispatcher<'_>, value: Value) -> Value {
    serde_json::from_str(&dispatcher.dispatch(&value.to_string())).unwrap()
}

#[test]
fn status_and_accounts_use_only_fixed_bounded_json_commands() {
    let runner = Runner::new(vec![
        HeySetupOutput::success(br#"{"ok":true,"data":{"authenticated":true,"expired":false,"token":"drop"}}"#.to_vec()),
        HeySetupOutput::success(br#"{"ok":true,"data":[{"id":"all"},{"id":"1","email":"Ada@Example.test"},{"id":"2","email":"second@example.test"}]}"#.to_vec()),
    ]);
    let launcher = Launcher::default();
    let host = HeySetupDispatcher::new(PathBuf::from("/opt/hey"), &runner, &launcher);
    assert_eq!(
        dispatch(
            &host,
            json!({"operation":"hey.auth.status","deadlineMs":900})
        ),
        json!({"ok":true,"data":{"authenticated":true,"expired":false}})
    );
    assert_eq!(
        dispatch(
            &host,
            json!({"operation":"hey.auth.accounts","deadlineMs":800})
        ),
        json!({"ok":true,"data":{"accounts":[{"id":"hey:ada@example.test","address":"ada@example.test"},{"id":"hey:second@example.test","address":"second@example.test"}]}})
    );
    let commands = runner.commands.lock().unwrap();
    assert_eq!(commands[0].1, ["auth", "status", "--json"]);
    assert_eq!(commands[1].1, ["accounts", "list", "--json"]);
    assert_eq!(commands[0].2, Duration::from_millis(900));
}

#[test]
fn login_is_a_fixed_terminal_plan_and_logout_is_machine_global() {
    let runner = Runner::new(vec![HeySetupOutput::success(
        br#"{"ok":true,"data":null}"#.to_vec(),
    )]);
    let launcher = Launcher::default();
    let host = HeySetupDispatcher::new(PathBuf::from("/opt/hey"), &runner, &launcher);
    assert_eq!(
        dispatch(&host, json!({"operation":"hey.auth.login"})),
        json!({"ok":true,"data":{"launched":true}})
    );
    let plans = launcher.0.lock().unwrap();
    assert_eq!(plans[0].program(), PathBuf::from("/opt/hey"));
    assert_eq!(plans[0].arguments(), ["auth", "login"]);
    drop(plans);
    assert_eq!(
        dispatch(
            &host,
            json!({"operation":"hey.auth.logout","deadlineMs":700})
        ),
        json!({"ok":true,"data":{"machineGlobal":true}})
    );
    assert_eq!(
        runner.commands.lock().unwrap()[0].1,
        ["auth", "logout", "--json"]
    );
}

#[test]
fn schema_output_and_diagnostics_are_closed_and_redacted() {
    let runner = Runner::new(vec![HeySetupOutput::success(
        br#"{"ok":false,"error":"Bearer secret-token"}"#.to_vec(),
    )]);
    let launcher = Launcher::default();
    let host = HeySetupDispatcher::new(PathBuf::from("/opt/hey"), &runner, &launcher);
    for hostile in [
        json!({"operation":"hey.auth.status","deadlineMs":0}),
        json!({"operation":"hey.auth.status","deadlineMs":1,"extra":"token"}),
        json!({"operation":"hey.auth.unknown","deadlineMs":1}),
        json!({"operation":"hey.auth.login","password":"secret"}),
        json!({"operation":"hey.auth.login","deadlineMs":1}),
    ] {
        let reply = dispatch(&host, hostile);
        assert_eq!(reply["ok"], false);
        assert!(!reply.to_string().contains("secret"));
    }
    let failed = dispatch(
        &host,
        json!({"operation":"hey.auth.status","deadlineMs":1000}),
    );
    assert_eq!(failed, json!({"ok":false,"error":"HEY setup failed"}));
}

#[test]
fn oversized_or_invalid_cli_json_fails_closed_without_launching_or_retrying() {
    let runner = Runner::new(vec![
        HeySetupOutput::success(vec![b'x'; 256 * 1024 + 1]),
        HeySetupOutput::success(
            br#"{"ok":true,"data":[{"id":"1","email":"bad\naddress@example.test"}]}"#.to_vec(),
        ),
        HeySetupOutput::success(
            br#"{"ok":true,"data":[{"id":"1","email":"same@example.test"},{"id":"2","email":"SAME@example.test"}]}"#.to_vec(),
        ),
    ]);
    let launcher = Launcher::default();
    let host = HeySetupDispatcher::new(PathBuf::from("/opt/hey"), &runner, &launcher);
    assert_eq!(
        dispatch(
            &host,
            json!({"operation":"hey.auth.status","deadlineMs":1000})
        )["ok"],
        false
    );
    assert_eq!(
        dispatch(
            &host,
            json!({"operation":"hey.auth.accounts","deadlineMs":1000})
        )["ok"],
        false
    );
    assert_eq!(
        dispatch(
            &host,
            json!({"operation":"hey.auth.accounts","deadlineMs":1000})
        )["ok"],
        false
    );
    assert_eq!(
        runner.commands.lock().unwrap().len(),
        3,
        "setup never retries an unknown or malformed CLI reply"
    );
    assert!(launcher.0.lock().unwrap().is_empty());
}

#[test]
fn setup_auth_operations_are_not_reachable_from_generic_effects() {
    for operation in [
        "hey.auth.status",
        "hey.auth.accounts",
        "hey.auth.login",
        "hey.auth.logout",
    ] {
        assert!(
            EffectHost::parse(&json!({"operation":operation,"deadlineMs":1000}).to_string())
                .is_err()
        );
    }
}

#[test]
fn production_paths_and_platform_unavailable_are_explicit_and_module_is_independent() {
    assert!(
        ProductionHeySetup::new(
            vec![PathBuf::from("hey")],
            PathBuf::from("/usr/bin/xdg-terminal-exec")
        )
        .is_err()
    );
    let missing = ProductionHeySetup::new(
        vec![PathBuf::from("/definitely-missing/hey")],
        PathBuf::from("/usr/bin/xdg-terminal-exec"),
    )
    .ok()
    .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(
            &missing
                .dispatch(&json!({"operation":"hey.auth.status","deadlineMs":1000}).to_string())
        )
        .unwrap(),
        json!({"ok":false,"error":"HEY setup is unavailable"})
    );
    assert!(
        ProductionHeySetup::new(vec![PathBuf::from("/opt/hey")], PathBuf::from("terminal"))
            .is_err()
    );
    let runner = Runner::new(vec![]);
    let host = HeySetupDispatcher::new(PathBuf::from("/opt/hey"), &runner, &UnavailableLauncher);
    assert_eq!(
        dispatch(&host, json!({"operation":"hey.auth.login"})),
        json!({"ok":false,"error":"HEY setup is unavailable"})
    );
    let launcher = Launcher::default();
    let host = HeySetupDispatcher::new(PathBuf::from("/opt/hey"), &UnavailableRunner, &launcher);
    assert_eq!(
        dispatch(
            &host,
            json!({"operation":"hey.auth.status","deadlineMs":1000})
        ),
        json!({"ok":false,"error":"HEY setup is unavailable"})
    );
    let effects = std::fs::read_to_string("src/effects.rs").unwrap();
    assert!(effects.contains("HostModule::new(\"omamail-hey-setup\")"));
}

#[cfg(unix)]
#[test]
fn executable_resolution_uses_first_explicit_regular_executable_and_rejects_symlinks() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = std::env::temp_dir().join(format!("omamail-hey-resolve-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir(&root).unwrap();
    let wrong = root.join("not-hey");
    std::fs::write(&wrong, b"#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&wrong, std::fs::Permissions::from_mode(0o700)).unwrap();
    let hey = root.join("hey");
    std::fs::write(&hey, b"#!/bin/sh\n").unwrap();
    std::fs::set_permissions(&hey, std::fs::Permissions::from_mode(0o700)).unwrap();
    let link = root.join("link").join("hey");
    std::fs::create_dir(root.join("link")).unwrap();
    symlink(&hey, &link).unwrap();

    assert_eq!(
        resolve_hey_executable(&[wrong, link, hey.clone()]),
        Some(hey)
    );
    assert_eq!(
        resolve_hey_executable(&[root.join("missing").join("hey")]),
        None
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn production_re_resolves_after_cli_is_installed() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!(
        "omamail-hey-production-resolve-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir(&root).unwrap();
    let hey = root.join("hey");
    let setup = ProductionHeySetup::new(
        vec![hey.clone()],
        PathBuf::from("/usr/bin/xdg-terminal-exec"),
    )
    .ok()
    .unwrap();
    let request = json!({"operation":"hey.auth.status","deadlineMs":1000}).to_string();
    assert_eq!(
        serde_json::from_str::<Value>(&setup.dispatch(&request)).unwrap()["ok"],
        false
    );
    std::fs::write(
        &hey,
        b"#!/bin/sh\nprintf '%s' '{\"ok\":true,\"data\":{\"authenticated\":true,\"expired\":false}}'\n",
    )
    .unwrap();
    std::fs::set_permissions(&hey, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&setup.dispatch(&request)).unwrap(),
        json!({"ok":true,"data":{"authenticated":true,"expired":false}})
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn production_pins_the_first_resolved_executable_for_its_lifetime() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("omamail-hey-pin-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let first_dir = root.join("first");
    let second_dir = root.join("second");
    std::fs::create_dir_all(&first_dir).unwrap();
    std::fs::create_dir_all(&second_dir).unwrap();
    let first = first_dir.join("hey");
    let second = second_dir.join("hey");
    for (path, authenticated) in [(&first, true), (&second, false)] {
        std::fs::write(path, format!("#!/bin/sh\nprintf '%s' '{{\"ok\":true,\"data\":{{\"authenticated\":{authenticated},\"expired\":false}}}}'\n")).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let setup = ProductionHeySetup::new(
        vec![first.clone(), second],
        PathBuf::from("/usr/bin/xdg-terminal-exec"),
    )
    .ok()
    .unwrap();
    let request = json!({"operation":"hey.auth.status","deadlineMs":1000}).to_string();
    assert_eq!(
        serde_json::from_str::<Value>(&setup.dispatch(&request)).unwrap()["data"]["authenticated"],
        true
    );
    std::fs::remove_file(first).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&setup.dispatch(&request)).unwrap(),
        json!({"ok":false,"error":"HEY setup is unavailable"}),
        "a pinned workflow must not switch to a different candidate"
    );
    std::fs::remove_dir_all(root).unwrap();
}
