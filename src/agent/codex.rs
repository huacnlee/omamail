//! Carry model/provider settings into a process-local overlay, without
//! importing unrelated MCP servers, plugins, hooks or workspace instructions.
use std::{fs::File, io::Read, path::PathBuf};
pub struct Profile(toml_edit::DocumentMut);

// Rebuild primitives rather than formatting source values: toml_edit preserves
// comments and whitespace, which must never be copied from config into argv.
fn setting(key: &str, item: &toml_edit::Item) -> Result<toml_edit::Value, &'static str> {
    match key {
        "requires_openai_auth" | "supports_websockets" => item.as_bool().map(Into::into),
        "request_max_retries" | "stream_max_retries" | "stream_idle_timeout_ms" => {
            item.as_integer().filter(|n| *n >= 0).map(Into::into)
        }
        _ => item.as_str().map(Into::into),
    }
    .ok_or("agent_config_invalid")
}

impl Profile {
    pub fn configure(&self, command: &mut std::process::Command) -> Result<(), &'static str> {
        let source = &self.0;
        // --ignore-user-config also ignores named profiles in current Codex.
        // Only these non-secret scalar choices can safely cross argv.
        for key in [
            "model",
            "model_provider",
            "model_reasoning_effort",
            "model_reasoning_summary",
            "model_verbosity",
            "cli_auth_credentials_store",
            "forced_login_method",
            "forced_chatgpt_workspace_id",
        ] {
            if let Some(value) = source.get(key) {
                command.args(["-c", &format!("{key}={}", setting(key, value)?)]);
            }
        }
        if let Some(providers) = source
            .get("model_providers")
            .and_then(|v| v.as_table_like())
        {
            for (name, item) in providers.iter() {
                if name.is_empty()
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                {
                    return Err("agent_config_invalid");
                }
                let provider = item.as_table_like().ok_or("agent_config_invalid")?;
                let mut headers = toml_edit::InlineTable::new();
                for (key, item) in provider.iter() {
                    let prefix = format!("model_providers.{name}");
                    if key == "experimental_bearer_token" {
                        let token = item.as_str().ok_or("agent_config_invalid")?;
                        let variable = format!(
                            "OMAMAIL_CODEX_TOKEN_{}",
                            name.bytes().map(|b| format!("{b:02x}")).collect::<String>()
                        );
                        command.env(&variable, token).args([
                            "-c",
                            &format!("{prefix}.env_key={}", serde_json::json!(variable)),
                        ]);
                    } else if key == "http_headers" {
                        for (header, value) in
                            item.as_table_like().ok_or("agent_config_invalid")?.iter()
                        {
                            let variable = format!(
                                "OMAMAIL_CODEX_HEADER_{}_{}",
                                name.bytes().map(|b| format!("{b:02x}")).collect::<String>(),
                                header
                                    .bytes()
                                    .map(|b| format!("{b:02x}"))
                                    .collect::<String>()
                            );
                            command.env(&variable, value.as_str().ok_or("agent_config_invalid")?);
                            headers.insert(header, variable.into());
                        }
                    } else if key == "env_http_headers" {
                        for (header, value) in
                            item.as_table_like().ok_or("agent_config_invalid")?.iter()
                        {
                            headers.insert(
                                header,
                                value.as_str().ok_or("agent_config_invalid")?.into(),
                            );
                        }
                    } else if [
                        "name",
                        "base_url",
                        "env_key",
                        "wire_api",
                        "requires_openai_auth",
                        "supports_websockets",
                        "request_max_retries",
                        "stream_max_retries",
                        "stream_idle_timeout_ms",
                    ]
                    .contains(&key)
                    {
                        if key == "base_url" {
                            let url =
                                reqwest::Url::parse(item.as_str().ok_or("agent_config_invalid")?)
                                    .map_err(|_| "agent_config_invalid")?;
                            if !url.username().is_empty()
                                || url.password().is_some()
                                || url.query().is_some()
                                || url.fragment().is_some()
                            {
                                return Err("agent_config_invalid");
                            }
                        }
                        command.args(["-c", &format!("{prefix}.{key}={}", setting(key, item)?)]);
                    } else {
                        return Err("agent_config_invalid");
                    }
                }
                if !headers.is_empty() {
                    command.args([
                        "-c",
                        &format!("model_providers.{name}.env_http_headers={headers}"),
                    ]);
                }
            }
        }
        if let Some(value) = source
            .get("features")
            .and_then(|f| f.get("enable_request_compression"))
            .and_then(|v| v.as_bool())
        {
            command.args([
                "-c",
                &format!("features.enable_request_compression={value}"),
            ]);
        }
        Ok(())
    }
    pub fn create(id: &str) -> Result<Self, &'static str> {
        super::storage::check_id(id)?;
        let home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex")))
            .ok_or("agent_config_unavailable")?;
        let mut bytes = String::new();
        match File::open(home.join("config.toml")) {
            Ok(file) => {
                file.take(1024 * 1024 + 1)
                    .read_to_string(&mut bytes)
                    .map_err(|_| "agent_config_invalid")?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("agent_config_unavailable"),
        }
        if bytes.len() > 1024 * 1024 {
            return Err("agent_config_invalid");
        }
        let source = bytes
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| "agent_config_invalid")?;
        let mut selected = toml_edit::DocumentMut::new();
        for key in [
            "model",
            "model_provider",
            "model_providers",
            "model_reasoning_effort",
            "model_reasoning_summary",
            "model_verbosity",
            "cli_auth_credentials_store",
            "forced_login_method",
            "forced_chatgpt_workspace_id",
        ] {
            if let Some(value) = source.get(key) {
                selected[key] = value.clone();
            }
        }
        // Transport formatting is not authority and is needed by local providers.
        if let Some(value) = source
            .get("features")
            .and_then(|f| f.get("enable_request_compression"))
        {
            selected["features"]["enable_request_compression"] = value.clone();
        }
        Ok(Self(selected))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_comments_and_credentials_never_reach_argv() {
        for newline in ["\n", "\r\n"] {
            let text = r#"
model = "configured-default" # synthetic-comment-secret
model_provider = "custom" # synthetic-comment-secret
[model_providers.custom]
name = 'Quotes " and backslashes \ and Unicode café' # synthetic-comment-secret
base_url = "https://example.com/v1" # synthetic-comment-secret
env_key = "CUSTOM_KEY" # synthetic-comment-secret
wire_api = "responses" # synthetic-comment-secret
requires_openai_auth = false # synthetic-comment-secret
supports_websockets = true # synthetic-comment-secret
request_max_retries = 2 # synthetic-comment-secret
stream_max_retries = 3 # synthetic-comment-secret
stream_idle_timeout_ms = 4000 # synthetic-comment-secret
experimental_bearer_token = "synthetic-bearer-secret" # synthetic-comment-secret
http_headers = { Authorization = "synthetic-header-secret" } # synthetic-comment-secret
env_http_headers = { "X-Custom" = "CUSTOM_HEADER" } # synthetic-comment-secret
[features]
enable_request_compression = false # synthetic-comment-secret
"#
            .replace('\n', newline);
            let profile = Profile(text.parse().unwrap());
            let mut command = std::process::Command::new("never-spawned");
            profile.configure(&mut command).unwrap();
            let args: Vec<_> = command.get_args().map(|v| v.to_str().unwrap()).collect();
            assert!(!args.join(" ").contains("secret"));
            let mut settings = toml_edit::DocumentMut::new();
            for pair in args.chunks_exact(2) {
                assert_eq!(pair[0], "-c");
                let parsed = pair[1].parse::<toml_edit::DocumentMut>().unwrap();
                if let Some(model) = parsed.get("model") {
                    assert_eq!(model.as_str(), Some("configured-default"));
                }
                if parsed.get("model_providers").is_some() {
                    for (key, value) in parsed["model_providers"]["custom"]
                        .as_table_like()
                        .unwrap()
                        .iter()
                    {
                        settings[key] = value.clone();
                    }
                }
            }
            assert_eq!(
                settings["name"].as_str(),
                Some("Quotes \" and backslashes \\ and Unicode café")
            );
            assert_eq!(settings["requires_openai_auth"].as_bool(), Some(false));
            assert_eq!(settings["stream_idle_timeout_ms"].as_integer(), Some(4000));
            let env: Vec<_> = command.get_envs().filter_map(|(_, value)| value).collect();
            assert!(env.contains(&std::ffi::OsStr::new("synthetic-bearer-secret")));
            assert!(env.contains(&std::ffi::OsStr::new("synthetic-header-secret")));
        }
    }

    #[test]
    fn config_scalar_types_are_validated() {
        for text in [
            "model = { secret = 'not-a-model' }",
            "model = ['not-a-model']",
            "model = true",
            "[model_providers.custom]\nrequest_max_retries = '2'",
            "[model_providers.custom]\nstream_idle_timeout_ms = -1",
            "[model_providers.custom]\nsupports_websockets = 'true'",
            "[model_providers.custom]\nname = 123",
        ] {
            let profile = Profile(text.parse().unwrap());
            let mut command = std::process::Command::new("never-spawned");
            assert_eq!(profile.configure(&mut command), Err("agent_config_invalid"));
        }
    }
}
