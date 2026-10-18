use super::*;

#[test]
fn native_sessions_are_validated_for_their_provider() {
    let uuid = "11111111-2222-3333-4444-555555555555";
    assert!(Provider::Codex.session(uuid));
    assert!(Provider::Claude.session(uuid));
    assert!(!Provider::OpenCode.session(uuid));
    assert!(Provider::OpenCode.session("ses_f13832da5ffe1XDBt4dxwJ0DeM"));
    assert!(Provider::Hermes.session("20250305_091523_a1b2c3"));
    assert!(Provider::Hermes.session("20250305_091523_a1b2c3d4"));
    assert!(Provider::Hermes.session("local-a1b2c3"));
    assert!(Provider::Hermes.session("local-ABCDEF"));
    assert!(Provider::Hermes.session(&format!("local-{}", "ab".repeat(32))));
    assert!(!Provider::Hermes.session(uuid));
    assert!(!Provider::Hermes.session("latest"));
    assert!(!Provider::Hermes.session("local-latest"));
    assert!(!Provider::Hermes.session("local-"));
    assert!(!Provider::Hermes.session("local-a/b"));
    assert!(!Provider::Hermes.session(&format!("local-{}", "a".repeat(65))));
    assert!(!Provider::Hermes.session("20250305_091523_a1b2c3d"));
    for id in [
        "",
        "ses_",
        "ses_../evil",
        "ses_\n",
        "--last",
        "ses_$(touch)",
    ] {
        for provider in [
            Provider::Claude,
            Provider::Codex,
            Provider::OpenCode,
            Provider::Hermes,
        ] {
            assert!(!provider.session(id), "{id}");
        }
    }
    assert_eq!(Provider::of_job(&json!({})).unwrap(), Provider::Claude);
    assert!(Provider::of_job(&json!({"provider":"shell"})).is_err());
}

#[test]
fn model_arguments_cannot_be_options_or_shell_input() {
    for model in [
        "",
        "provider/model#variant",
        "gpt-5.4",
        "sonnet",
        "local/model:tag",
        "a",
    ] {
        assert!(validate_model(model).is_ok());
    }
    for model in [
        "--auto",
        "a b",
        "x\n",
        "x\r",
        "x\0",
        "$(touch p)",
        "x\"",
        "x\\",
        "модель",
    ] {
        assert!(validate_model(model).is_err(), "{model}");
    }
    assert!(validate_model(&"x".repeat(201)).is_err());
}

#[test]
fn commands_use_stdin_exact_continuations_and_noninteractive_permissions() {
    for provider in [Provider::Claude, Provider::Codex] {
        let resume = if provider == Provider::OpenCode {
            "ses_test"
        } else {
            "11111111-2222-3333-4444-555555555555"
        };
        let command = provider
            .command(Path::new("/private"), resume, "chosen-model", "")
            .unwrap();
        let args = command
            .get_args()
            .map(|s| s.to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            Path::new(command.get_program()).file_name().unwrap(),
            provider.name()
        );
        assert_eq!(
            args[args.iter().position(|s| *s == "--model").unwrap() + 1],
            "chosen-model"
        );
        assert!(args.contains(&resume));
        assert!(!args.contains(&"--last"));
        match provider {
            Provider::Claude => {
                assert!(args.contains(&"--resume"));
                assert!(!args.contains(&"--fork-session"));
                assert!(args.contains(&"dontAsk"));
            }
            Provider::OpenCode => unreachable!("OpenCode uses its owned broker"),
            Provider::Codex => {
                assert!(args.contains(&"resume"));
                assert!(!args.contains(&"fork"));
                assert!(args.contains(&"read-only"));
                assert!(args.contains(&"approval_policy=\"never\""));
                assert!(args.contains(&"-"));
            }
            Provider::Hermes => unreachable!("Hermes is asserted below"),
        }
        assert!(
            provider
                .command(Path::new("/private"), "../../evil", "", "")
                .is_err()
        );
        let default = provider.command(Path::new("/private"), "", "", "").unwrap();
        assert!(!default.get_args().any(|arg| arg == "--model"));
    }
    assert_eq!(
        Provider::OpenCode
            .command(Path::new("/private"), "", "", "")
            .unwrap_err(),
        "agent_server_required"
    );
    let hermes_id = "20250305_091523_a1b2c3";
    let hermes = Provider::Hermes
        .command(
            Path::new("/private"),
            hermes_id,
            "chosen-model",
            "xai-oauth",
        )
        .unwrap();
    let args = hermes
        .get_args()
        .map(|s| s.to_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        Path::new(hermes.get_program()).file_name().unwrap(),
        "hermes"
    );
    assert_eq!(
        args,
        vec![
            "chat",
            "--oneshot",
            "--format",
            "stream-json",
            "--query-file",
            "-",
            "--ignore-rules",
            "--ignore-user-config",
            "--source",
            "tool",
            "-t",
            "todo",
            "--resume",
            hermes_id,
            "--provider",
            "xai-oauth",
            "--model",
            "chosen-model",
        ]
    );
    assert!(!args.contains(&"-z"));
    assert!(!args.contains(&"--yolo"));
    assert!(!args.contains(&"--continue"));
    assert!(!args.contains(&"--pass-session-id"));
    assert_eq!(
        Provider::Hermes
            .command(Path::new("/private"), "latest", "grok-4.7", "xai-oauth")
            .unwrap_err(),
        "agent_invalid_session"
    );
    assert_eq!(
        Provider::Hermes
            .command(Path::new("/private"), "", "", "")
            .unwrap_err(),
        "agent_hermes_endpoint"
    );
    assert_eq!(
        Provider::Hermes
            .command(Path::new("/private"), "", "grok-4.7", "--bad")
            .unwrap_err(),
        "agent_invalid_model"
    );
    let local = "local-a1b2c3d4";
    let fresh = Provider::Hermes
        .command(Path::new("/private"), local, "grok-4.7", "xai-oauth")
        .unwrap();
    let fresh_args = fresh
        .get_args()
        .map(|arg| arg.to_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        fresh_args[fresh_args
            .iter()
            .position(|arg| *arg == "--resume")
            .unwrap()
            + 1],
        local
    );
    assert_eq!(
        fresh_args[fresh_args
            .iter()
            .position(|arg| *arg == "--provider")
            .unwrap()
            + 1],
        "xai-oauth"
    );
    assert_eq!(
        fresh_args[fresh_args.iter().position(|arg| *arg == "--model").unwrap() + 1],
        "grok-4.7"
    );
    assert!(!fresh_args.iter().any(|arg| arg.contains("SECRET")));
}
