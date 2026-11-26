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
    pub fn session_id(&self) -> &str {
        self.display.session_id()
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
