//! Native CLI protocols. Only fixed programs/flags and validated session IDs cross argv.
use serde_json::{Value, json};
use std::{path::Path, process::Command};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Claude,
    OpenCode,
    Codex,
    Hermes,
}

impl Provider {
    pub(super) fn executable(self) -> std::ffi::OsString {
        use std::os::unix::fs::PermissionsExt;
        let name = self.name();
        let executable = |path: &std::path::Path| {
            path.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        };
        if std::env::var_os("PATH").is_some_and(|path| {
            std::env::split_paths(&path).any(|directory| executable(&directory.join(name)))
        }) {
            return name.into();
        }
        // GUI-launched standalone apps on macOS do not inherit a login shell's
        // PATH. Discover standard CLI install locations without executing one.
        let mut directories = Vec::new();
        if let Some(home) = std::env::var_os("HOME") {
            directories.push(std::path::PathBuf::from(home).join(".local/bin"));
        }
        #[cfg(target_os = "macos")]
        directories.extend([
            std::path::PathBuf::from("/opt/homebrew/bin"),
            std::path::PathBuf::from("/usr/local/bin"),
        ]);
        directories
            .into_iter()
            .map(|p| p.join(name))
            .find(|p| executable(p))
            .map(|p| p.into_os_string())
            .unwrap_or_else(|| name.into())
    }
    pub fn isolated_command(
        self,
        path: &Path,
        resume: &str,
        model: &str,
        inference: &str,
        id: &str,
        proposals: bool,
    ) -> Result<Command, &'static str> {
        super::storage::check_id(id)?;
        let exe = std::env::current_exe().map_err(|_| "agent_worker_unavailable")?;
        let mut command = self.command(path, resume, model, inference)?;
        match self {
            Self::Claude => {
                command.args(["--tools", "", "--strict-mcp-config"]);
                let servers = if proposals {
                    command.args(["--allowedTools", "mcp__omamail__propose_draft"]);
                    json!({"omamail":{"type":"stdio","command":exe,"args":["agent-mcp",id]}})
                } else {
                    json!({})
                };
                command.args(["--mcp-config", &json!({"mcpServers":servers}).to_string()]);
                command.args(["--system-prompt", super::worker::MAIL_ROLE]);
                super::config::claude(&mut command, id)?;
            }
            Self::Codex => {
                // Auth remains in CODEX_HOME; user tool/plugin customizations do
                // not become authority to act on mail-supplied instructions.
                command.args([
                    "--ignore-user-config",
                    "-c",
                    "features.shell_tool=false",
                    "-c",
                    "features.multi_agent=false",
                    "-c",
                    "web_search=\"disabled\"",
                ]);
                if proposals {
                    command.arg("-c").arg(format!("mcp_servers.omamail={{command={},args=[\"agent-mcp\",{}],env_vars=[\"XDG_STATE_HOME\"],enabled_tools=[\"propose_draft\"],required=true,tools={{propose_draft={{approval_mode=\"approve\"}}}}}}",json!(exe).to_string(),json!(id).to_string()));
                }
                for setting in [
                    "features.goals=false",
                    "features.view_image=false",
                    "tools.experimental_request_user_input.enabled=false",
                    "features.plugins=false",
                    "features.apps=false",
                    "features.hooks=false",
                    "features.codex_hooks=false",
                    "features.plugin_hooks=false",
                    "features.multi_agent_v2=false",
                    "agents.enabled=false",
                    "features.skip_host_skill_discovery=true",
                    "skills.bundled.enabled=false",
                    // Keep the sole mail tool visible even when model metadata
                    // requires code-mode-only tools. No general tool discovery.
                    "features.code_mode={enabled=false,direct_only_tool_namespaces=[\"mcp__omamail\"]}",
                    "features.tool_search=false",
                ] {
                    command.args(["-c", setting]);
                }
                super::codex::Profile::create(id)?.configure(&mut command)?;
            }
            Self::OpenCode | Self::Hermes => {}
        }
        Ok(command)
    }
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "claude" => Some(Self::Claude),
            "opencode" => Some(Self::OpenCode),
            "codex" => Some(Self::Codex),
            "hermes" => Some(Self::Hermes),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::OpenCode => "opencode",
            Self::Codex => "codex",
            Self::Hermes => "hermes",
        }
    }
    pub fn of_job(job: &Value) -> Result<Self, &'static str> {
        match job.get("provider") {
            None => Ok(Self::Claude), // Before provider metadata, every task was Claude.
            Some(value) => value
                .as_str()
                .and_then(Self::parse)
                .ok_or("agent_invalid_provider"),
        }
    }
    pub fn session(self, id: &str) -> bool {
        if self == Self::OpenCode {
            id.strip_prefix("ses_").is_some_and(|s| {
                (1..=128).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
            })
        } else if self == Self::Hermes {
            hermes_session(id)
        } else {
            super::jobs::session(id)
        }
    }
    fn command(
        self,
        path: &Path,
        resume: &str,
        model: &str,
        inference: &str,
    ) -> Result<Command, &'static str> {
        validate_model(model)?;
        validate_model(inference)?;
        if !resume.is_empty() && !self.session(resume) {
            return Err("agent_invalid_session");
        }
        let mut command = Command::new(self.executable());
        command.current_dir(path);
        match self {
            Self::Claude => {
                command.args([
                    "-p",
                    "--verbose",
                    "--output-format",
                    "stream-json",
                    "--include-partial-messages",
                    "--permission-mode",
                    "dontAsk",
                ]);
                if !resume.is_empty() {
                    command.args(["--resume", resume]);
                }
            }
            Self::OpenCode => {
                return Err("agent_server_required");
            }
            Self::Codex => {
                command.args([
                    "exec",
                    "--json",
                    "--skip-git-repo-check",
                    "--sandbox",
                    "read-only",
                    "-c",
                    "approval_policy=\"never\"",
                ]);
                // Admission serializes a conversation; never resume --last.
                if !resume.is_empty() {
                    command.args(["resume", resume]);
                }
                command.arg("-");
            }
            Self::Hermes => {
                // `hermes -z PROMPT` is the plain-text one-shot, but the prompt
                // would cross argv and stdout has no session id. `chat` reads
                // the untrusted body from stdin and emits stream-json, including
                // the id `--resume` needs. Never `--continue` or `latest`.
                // User MCP, hooks and tool selection stay unloaded. `todo` is
                // the only built-in toolset and cannot send mail or run a shell.
                // Hermes has no per-launch MCP config, so propose_draft is not
                // attached; the answer stays text for the owner to apply.
                // `--ignore-user-config` hides the profile default, so both
                // flags are required. Callers resolve blanks from the config.
                if model.is_empty() || inference.is_empty() {
                    return Err("agent_hermes_endpoint");
                }
                command.args([
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
                ]);
                if !resume.is_empty() {
                    command.args(["--resume", resume]);
                }
                command.args(["--provider", inference, "--model", model]);
            }
        }
        if self != Self::Hermes && !model.is_empty() {
            command.args(["--model", model]);
        }
        Ok(command)
    }
}

fn hermes_session(id: &str) -> bool {
    // Dated CLI ids use a 6-hex suffix; gateway ids use 8. One-shot stdout
    // also names `local-<hex>`. Titles, `latest` and prefixes stay rejected.
    let bytes = id.as_bytes();
    let dated = matches!(bytes.len(), 22 | 24)
        && bytes[8] == b'_'
        && bytes[15] == b'_'
        && bytes[..8].iter().all(u8::is_ascii_digit)
        && bytes[9..15].iter().all(u8::is_ascii_digit)
        && bytes[16..].iter().all(u8::is_ascii_hexdigit);
    let local = id.strip_prefix("local-").is_some_and(|suffix| {
        (1..=64).contains(&suffix.len()) && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    });
    dated || local
}

pub fn validate_model(model: &str) -> Result<(), &'static str> {
    if model.is_empty()
        || (model.len() <= 200
            && model.as_bytes()[0].is_ascii_alphanumeric()
            && model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._/:#@+".contains(&b)))
    {
        Ok(())
    } else {
        Err("agent_invalid_model")
    }
}

#[cfg(test)]
#[path = "provider_tests.rs"]
mod tests;
