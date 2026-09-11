//! Owner-visible Claude stream projection. Raw events and tool inputs are never retained.
use serde_json::{Value, json};

const TRANSCRIPT_LIMIT: usize = 256 * 1024;
const RESULT_LIMIT: usize = 64 * 1024;
const EVENT_LIMIT: usize = 512 * 1024;
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone)]
pub struct ClaudeStream {
    transcript: Vec<Value>,
    output: String,
    session_id: String,
    complete: bool,
    current: Option<usize>,
    message_index: Option<usize>,
    tools_seen: usize,
    snapshot_seen: bool,
    progress: &'static str,
    final_seen: bool,
}

pub fn valid_text(value: &str) -> Result<()> {
    if value.chars().any(|c| {
        (c < ' ' && !matches!(c, '\t' | '\r' | '\n')) || ('\u{7f}'..='\u{9f}').contains(&c)
    }) {
        return Err("Text contains unsupported control characters");
    }
    Ok(())
}

pub fn transcript_check(items: &[Value]) -> Result<()> {
    if items.len() > 200 {
        return Err("Conversation limit reached. Start a new conversation.");
    }
    for item in items {
        let object = item.as_object().ok_or("Invalid conversation record")?;
        if object.len() != 2
            || !object.contains_key("text")
            || !matches!(item["role"].as_str(), Some("user" | "assistant" | "status"))
        {
            return Err("Invalid conversation record");
        }
        valid_text(item["text"].as_str().ok_or("Expected text")?)?;
    }
    // Match Python's ensure_ascii=False default separators (", ", ": ").
    let bytes = serde_json::to_vec(items)
        .map_err(|_| "Invalid conversation record")?
        .len();
    let separator_spaces = items.len().saturating_mul(4).saturating_sub(1);
    if bytes.saturating_add(separator_spaces) > TRANSCRIPT_LIMIT {
        return Err("Conversation limit reached. Start a new conversation.");
    }
    Ok(())
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64() != Some(0.0),
        Value::String(v) => !v.is_empty(),
        Value::Array(v) => !v.is_empty(),
        Value::Object(v) => !v.is_empty(),
    }
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn label(name: &Value) -> &'static str {
    match name.as_str().unwrap_or("") {
        "Bash" => "Running a command",
        "Read" => "Reading a file",
        "Write" => "Writing a file",
        "Edit" => "Editing a file",
        "Glob" => "Finding files",
        "Grep" => "Searching files",
        "WebSearch" => "Searching the web",
        "WebFetch" => "Reading a web page",
        _ => "Using a tool",
    }
}
fn text_or_empty(value: &Value) -> Result<&str> {
    if value.is_null() {
        Ok("")
    } else {
        value.as_str().ok_or("Expected text")
    }
}

impl ClaudeStream {
    pub fn new(history: Vec<Value>) -> Result<Self> {
        transcript_check(&history)?;
        Ok(Self {
            transcript: history,
            output: String::new(),
            session_id: String::new(),
            complete: false,
            current: None,
            message_index: None,
            tools_seen: 0,
            snapshot_seen: false,
            progress: "Thinking...",
            final_seen: false,
        })
    }
    pub fn display(&self) -> Value {
        json!({"transcript":self.transcript,"output":self.output,"sessionId":self.session_id,"complete":self.complete})
    }
    pub fn progress(&self) -> &str {
        self.progress
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn final_seen(&self) -> bool {
        self.final_seen
    }

    pub fn accept(&mut self, value: Value) -> Result<()> {
        if !value.is_object() {
            return Err("The AI returned an invalid stream event.");
        }
        if truthy(&value["parent_tool_use_id"]) {
            return Ok(());
        }
        if serde_json::to_vec(&value)
            .map_err(|_| "The AI returned an invalid stream event.")?
            .len()
            > EVENT_LIMIT
        {
            return Err("The AI stream event exceeded its size limit.");
        }
        let mut candidate = self.clone();
        let result = candidate
            .event(&value)
            .and_then(|()| transcript_check(&candidate.transcript));
        if result.is_ok() {
            *self = candidate;
        } else if candidate.final_seen {
            self.final_seen = true;
        }
        result
    }
    fn status(&mut self, text: &'static str) {
        self.transcript.push(json!({"role":"status","text":text}));
        self.progress = text;
        self.current = None;
    }
    fn answer(&mut self, text: &str, replace: bool) -> Result<()> {
        valid_text(text)?;
        let index = match self.current {
            Some(index) => index,
            None => {
                let index = self.transcript.len();
                self.transcript.push(json!({"role":"assistant","text":""}));
                self.current = Some(index);
                self.message_index = Some(index);
                index
            }
        };
        let existing = self.transcript[index]["text"].as_str().unwrap_or("");
        if (if replace { 0 } else { existing.len() }).saturating_add(text.len()) > RESULT_LIMIT {
            return Err("The answer exceeded 64 KiB. Ask for a shorter answer.");
        }
        self.output = if replace {
            text.to_owned()
        } else {
            format!("{existing}{text}")
        };
        self.transcript[index]["text"] = Value::String(self.output.clone());
        self.progress = "Writing...";
        Ok(())
    }
    fn reset_message(&mut self) {
        self.current = None;
        self.message_index = None;
        self.tools_seen = 0;
        self.snapshot_seen = false;
    }
    fn event(&mut self, value: &Value) -> Result<()> {
        if !value["session_id"].is_null() {
            let session = value["session_id"]
                .as_str()
                .filter(|s| uuid(s))
                .ok_or("The AI returned an invalid session ID.")?;
            if !self.session_id.is_empty() && self.session_id != session {
                return Err("The AI changed session identity unexpectedly.");
            }
            self.session_id = session.to_owned();
        }
        match value["type"].as_str().unwrap_or("") {
            "stream_event" => {
                let event = value.get("event").unwrap_or(&Value::Null);
                if !event.is_null() && !event.is_object() {
                    return Err("The AI returned an invalid stream event.");
                }
                match event["type"].as_str().unwrap_or("") {
                    "message_start" => self.reset_message(),
                    "content_block_start" => {
                        let block = &event["content_block"];
                        if !block.is_null() && !block.is_object() {
                            return Err("The AI returned an invalid stream event.");
                        }
                        match block["type"].as_str().unwrap_or("") {
                            "tool_use" => {
                                self.status(label(&block["name"]));
                                self.tools_seen += 1;
                            }
                            "text" if truthy(&block["text"]) => {
                                self.answer(text_or_empty(&block["text"])?, false)?
                            }
                            _ => (),
                        }
                    }
                    "content_block_delta" if event["delta"]["type"] == "text_delta" => {
                        self.answer(text_or_empty(&event["delta"]["text"])?, false)?
                    }
                    _ => (),
                }
            }
            "assistant" => {
                if self.snapshot_seen {
                    self.reset_message();
                }
                let blocks = match value["message"].get("content") {
                    None => &[][..],
                    Some(value) => value
                        .as_array()
                        .ok_or("The AI returned an invalid stream event.")?,
                };
                let mut text = String::new();
                let mut tools = Vec::new();
                for block in blocks {
                    if !block.is_object() {
                        return Err("The AI returned an invalid stream event.");
                    }
                    if block["type"] == "text" {
                        text.push_str(text_or_empty(&block["text"])?);
                        if text.len() > RESULT_LIMIT {
                            return Err("The answer exceeded 64 KiB. Ask for a shorter answer.");
                        }
                    } else if block["type"] == "tool_use" {
                        tools.push(block);
                    }
                }
                if !text.is_empty() {
                    self.current = self.message_index;
                    self.answer(&text, true)?;
                }
                for block in tools.iter().skip(self.tools_seen) {
                    self.status(label(&block["name"]));
                }
                self.tools_seen = tools.len();
                self.snapshot_seen = true;
            }
            "user" => {
                if value["message"]["content"]
                    .as_array()
                    .is_some_and(|blocks| {
                        blocks
                            .iter()
                            .any(|b| b.is_object() && b["type"] == "tool_result")
                    })
                {
                    self.status("Tool finished");
                }
            }
            "result" => {
                self.final_seen = true;
                if truthy(&value["is_error"]) || value["subtype"] != "success" {
                    return Err(
                        "The AI could not finish this request. Check its login or permissions and retry.",
                    );
                }
                self.answer(text_or_empty(&value["result"])?, true)?;
                self.complete = true;
            }
            _ => (),
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
