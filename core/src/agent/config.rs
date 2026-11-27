//! Read provider configuration as data. Never load plugins or MCP integrations
//! merely to discover model settings, and never put configuration on argv.
use serde_json::{Value, json};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

fn merge(target: &mut Value, source: &Value) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        for (key, value) in source {
            if value.is_object() && target.get(key).is_some_and(Value::is_object) {
                merge(target.get_mut(key).unwrap(), value);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}
fn read(path: &Path) -> Result<Value, &'static str> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(_) => return Err("agent_config_unavailable"),
    };
    let mut text = String::new();
    file.take(1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|_| "agent_config_invalid")?;
    if text.len() > 1024 * 1024 {
        return Err("agent_config_invalid");
    }
    json5::from_str(&text).map_err(|_| "agent_config_invalid")
}
pub(super) fn opencode() -> Result<Value, &'static str> {
    let home = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|s| PathBuf::from(s).join(".config")))
        .ok_or("agent_config_unavailable")?;
    let mut settings = json!({});
    for file in ["opencode.json", "opencode.jsonc"] {
        merge(&mut settings, &read(&home.join("opencode").join(file))?);
    }
    if let Some(path) = std::env::var_os("OPENCODE_CONFIG").filter(|s| !s.is_empty()) {
        merge(&mut settings, &read(Path::new(&path))?);
    }
    if let Ok(text) = std::env::var("OPENCODE_CONFIG_CONTENT") {
        if text.len() > 1024 * 1024 {
            return Err("agent_config_invalid");
        }
        merge(
            &mut settings,
            &json5::from_str::<Value>(&text).map_err(|_| "agent_config_invalid")?,
        );
    }
    Ok(provider_settings(&settings))
}
fn provider_settings(source: &Value) -> Value {
    let mut selected = json!({});
    for key in ["model", "providers", "provider", "compaction"] {
        if let Some(value) = source.get(key) {
            selected[key] = value.clone();
        }
    }
    selected
}

pub(super) fn claude(command: &mut std::process::Command, id: &str) -> Result<(), &'static str> {
    let home = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")))
        .ok_or("agent_config_unavailable")?;
    let source = read(&home.join("settings.json"))?;
    let mut selected = json!({"disableAllHooks":true,"enabledPlugins":{}});
    for key in [
        "model",
        "effortLevel",
        "apiKeyHelper",
        "awsAuthRefresh",
        "awsCredentialExport",
        "forceLoginMethod",
        "forceLoginOrgUUID",
    ] {
        if let Some(value) = source.get(key) {
            selected[key] = value.clone();
        }
    }
    if let Some(env) = source["env"].as_object() {
        let mut keep = json!({});
        for (key, value) in env {
            if key.starts_with("ANTHROPIC_")
                || key.starts_with("AWS_")
                || key.starts_with("GOOGLE_")
                || key.starts_with("VERTEX_")
                || key.starts_with("CLAUDE_CODE_USE_")
            {
                keep[key] = value.clone();
            }
        }
        selected["env"] = keep;
    }
    let store = super::storage::Store::open()?;
    store.write_json(id, "claude-settings.json", &selected)?;
    command
        .args([
            "--setting-sources",
            "",
            "--disable-slash-commands",
            "--no-chrome",
            "--settings",
        ])
        .arg(store.path().join(id).join("claude-settings.json"));
    Ok(())
}

pub(super) struct ClaudeSettings(pub PathBuf);
impl Drop for ClaudeSettings {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_model_configuration_crosses_into_mail_runtime() {
        let source = json!({"model":"fixture/test","providers":{"fixture":{"settings":{"apiKey":"synthetic"}}},
            "plugins":["unrelated-plugin"],"mcp":{"servers":{"unrelated":{"command":["touch","forbidden"]}}},
            "skills":["https://invalid.example"],"warming":true,"agents":{"omamail":{"system":"replace"}},"compaction":{"auto":true}});
        assert_eq!(
            provider_settings(&source),
            json!({"model":"fixture/test","providers":source["providers"],"compaction":{"auto":true}})
        );
    }
}
