//! Provider JSONL -> bounded public transcript. Never persist raw events/reasoning/tools.
use super::{provider::Provider, stream::ClaudeStream};
use serde_json::Value;
use std::collections::HashSet;

const INVALID: &str = "The AI returned an invalid stream event.";
const FAILED: &str =
    "The AI could not finish this request. Check its login or permissions and retry.";

#[derive(Clone)]
pub struct ProviderStream {
    provider: Provider,
    display: ClaudeStream,
    parts: HashSet<String>,
}

impl ProviderStream {
    pub fn new(provider: Provider, history: Vec<Value>) -> Result<Self, &'static str> {
        Ok(Self {
            provider,
            display: ClaudeStream::new(history)?,
            parts: HashSet::new(),
        })
    }
    pub fn display(&self) -> Value {
        self.display.display()
    }
    pub fn progress(&self) -> &str {
        self.display.progress()
    }
    pub fn provider(&self) -> Provider {
        self.provider
    }
    pub fn session_id(&self) -> &str {
        self.display.session_id()
    }
    /// A Hermes stdout banner such as `Session: local-<hex>`. An id that is not a
    /// Hermes session is a diagnostic and is ignored. A second, different valid id fails.
    pub(super) fn note_stdout_session(&mut self, id: &str) -> Result<bool, &'static str> {
        if !self.provider.session(id) {
            return Ok(false);
        }
        self.display.set_session(id)?;
        Ok(true)
    }
    pub fn final_seen(&self) -> bool {
        self.display.final_seen()
    }
    pub fn confirm_opencode(&mut self, value: &Value, created_ms: u64) -> Result<(), &'static str> {
        let info = &value["data"];
        if self.provider != Provider::OpenCode
            || self.session_id().is_empty()
            || info["id"].as_str() != Some(self.session_id())
            || info["outcome"] != "succeeded"
            || self.display()["output"]
                .as_str()
                .unwrap_or("")
                .trim()
                .is_empty()
            || !info["time"]["idle"]
                .as_u64()
                .is_some_and(|idle| idle >= created_ms)
        {
            return Err(FAILED);
        }
        self.finish()
    }
    pub fn accept(&mut self, value: Value) -> Result<(), &'static str> {
        if self.provider == Provider::Claude {
            return self.display.accept(value);
        }
        if !value.is_object() {
            return Err(INVALID);
        }
        if serde_json::to_vec(&value).map_err(|_| INVALID)?.len() > 512 * 1024 {
            return Err("The AI stream event exceeded its size limit.");
        }
        let mut next = self.clone();
        next.event(&value)?;
        super::stream::transcript_check(next.display.display()["transcript"].as_array().unwrap())?;
        *self = next;
        Ok(())
    }
    fn session(&mut self, value: &Value) -> Result<(), &'static str> {
        let id = value
            .as_str()
            .filter(|s| self.provider.session(s))
            .ok_or("The AI returned an invalid session ID.")?;
        self.display.set_session(id)
    }
    /// Hermes writes `session_id: ""` on the opening init and fills the id later.
    /// An empty or missing id is not a session. A non-empty invalid id still fails.
    fn note_hermes_session(&mut self, value: &Value) -> Result<(), &'static str> {
        if value.is_null() || value.as_str() == Some("") {
            return Ok(());
        }
        self.session(value)
    }
    fn answer(&mut self, part: &Value) -> Result<(), &'static str> {
        let id = part["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or(INVALID)?;
        let text = part["text"].as_str().ok_or(INVALID)?;
        if self.parts.contains(id) {
            return Err(INVALID);
        }
        if self.parts.len() >= 200 {
            return Err("The AI turn exceeded the display limit. Ask for a shorter answer.");
        }
        self.parts.insert(id.to_owned());
        self.display.answer(text, false)
    }
    fn finish(&mut self) -> Result<(), &'static str> {
        if self.session_id().is_empty() {
            return Err(FAILED);
        }
        self.display.finish();
        Ok(())
    }
    fn event(&mut self, value: &Value) -> Result<(), &'static str> {
        let kind = value["type"].as_str().ok_or(INVALID)?;
        if kind == "error" || kind == "turn.failed" {
            return Err(FAILED);
        }
        if self.provider == Provider::OpenCode {
            if value.get("sessionID").is_some() {
                self.session(&value["sessionID"])?;
            }
            if let Some(id) = value["part"].get("sessionID") {
                self.session(id)?;
            }
            match kind {
                "step_start" => self.display.begin(),
                "text" => {
                    if self.final_seen() || value["part"]["type"] != "text" {
                        return Err(INVALID);
                    }
                    self.answer(&value["part"])?;
                }
                "tool_use" => self
                    .display
                    .status(super::stream::label(&value["part"]["tool"])),
                "step_finish" => match value["part"]["reason"].as_str() {
                    Some("stop") => self.finish()?,
                    Some("tool-calls") => (),
                    _ => return Err(FAILED),
                },
                _ => (), // Reasoning and unknown metadata never enter the projection.
            }
        } else if self.provider == Provider::Hermes {
            match kind {
                "system" if value["subtype"] == "init" => {
                    self.note_hermes_session(&value["session_id"])?;
                    self.display.begin();
                }
                // v0.22.1 stream-json sends assistant deltas as type `text`.
                // `delta` is the same payload if a build names the event that way.
                "text" | "delta" => {
                    if self.final_seen() {
                        return Err(INVALID);
                    }
                    let text = value
                        .get("text")
                        .and_then(Value::as_str)
                        .or_else(|| value.get("delta").and_then(Value::as_str))
                        .ok_or(INVALID)?;
                    self.display.continue_answer(text)?;
                }
                "tool_use" | "tool_result" => {
                    self.display.status(super::stream::label(&value["name"]));
                }
                "result" => {
                    self.note_hermes_session(&value["session_id"])?;
                    let code = value["exit_code"].as_i64().ok_or(FAILED)?;
                    if code != 0 || value.get("error").is_some_and(|error| !error.is_null()) {
                        return Err(FAILED);
                    }
                    if let Some(text) = value.get("text").and_then(Value::as_str) {
                        let output = self.display()["output"].as_str().unwrap_or("").to_owned();
                        if output.is_empty() {
                            if !text.is_empty() {
                                self.display.continue_answer(text)?;
                            }
                        } else if let Some(suffix) = text.strip_prefix(&output) {
                            if !suffix.is_empty() {
                                self.display.continue_answer(suffix)?;
                            }
                        } else {
                            return Err(INVALID);
                        }
                    }
                    self.finish()?;
                }
                _ => (),
            }
        } else {
            match kind {
                "thread.started" => self.session(&value["thread_id"])?,
                "turn.started" => self.display.begin(),
                "item.completed" if value["item"]["type"] == "agent_message" => {
                    if self.final_seen() {
                        return Err(INVALID);
                    }
                    self.display.reset_message();
                    self.answer(&value["item"])?;
                }
                "item.started"
                    if matches!(
                        value["item"]["type"].as_str(),
                        Some("command_execution" | "mcp_tool_call" | "web_search" | "file_change")
                    ) =>
                {
                    self.display
                        .status(super::stream::label(&value["item"]["tool"]))
                }
                "turn.completed" => self.finish()?,
                _ => (),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "provider_stream_tests.rs"]
mod tests;
