use super::*;

#[test]
fn native_sessions_are_validated_for_their_provider() {
    let uuid = "11111111-2222-3333-4444-555555555555";
    assert!(Provider::Codex.session(uuid));
    assert!(Provider::Claude.session(uuid));
    assert!(!Provider::OpenCode.session(uuid));
    assert!(Provider::OpenCode.session("ses_f13832da5ffe1XDBt4dxwJ0DeM"));
    for id in [
        "",
        "ses_",
        "ses_../evil",
        "ses_\n",
        "--last",
        "ses_$(touch)",
    ] {
        for provider in [Provider::Claude, Provider::Codex, Provider::OpenCode] {
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
            .command(Path::new("/private"), resume, "chosen-model")
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
        }
        assert!(
            provider
                .command(Path::new("/private"), "../../evil", "")
                .is_err()
        );
        let default = provider.command(Path::new("/private"), "", "").unwrap();
        assert!(!default.get_args().any(|arg| arg == "--model"));
    }
    assert_eq!(
        Provider::OpenCode
            .command(Path::new("/private"), "", "")
            .unwrap_err(),
        "agent_server_required"
    );
}
