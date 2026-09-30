//! Bounded stdio MCP transport. The launch binds ownership, not tool arguments.
use super::{jobs, proposals, storage::Store};
use serde_json::{Value, json};
use std::io::{BufRead, Write};

pub fn run(id: &str) -> Result<(), &'static str> {
    if id == "workspace" {
        let cwd = std::env::current_dir().map_err(|_| "agent_unsafe_storage")?;
        let job = cwd
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("agent_invalid_id")?;
        super::storage::check_id(job)?;
        {
            let store = Store::open()?;
            if cwd != store.path().join(job) {
                return Err("agent_unsafe_storage");
            }
        }
        return run(job);
    }
    super::storage::check_id(id)?;
    serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        |arguments, _meta| {
            let content = proposals::validate(arguments)?;
            let store = Store::open()?;
            let job = jobs::refresh(&store, id)?;
            if job["state"] != "running"
                || job["kind"] == "events"
                || store.read_json(id, "cancel.json", 64)?.is_some()
            {
                return Err("agent_proposal_inactive");
            }
            let mut proposals = store
                .read_json(id, "proposals.json", proposals::MAX_BYTES)?
                .unwrap_or_else(|| json!([]));
            let list = proposals.as_array_mut().ok_or("agent_invalid_proposal")?;
            if list.len() >= proposals::MAX_PROPOSALS {
                return Err("agent_proposal_limit");
            }
            let proposal_id = format!("{id}-{}", list.len());
            let display = jobs::saved_display(&store, id)?;
            let after_turn = display["transcript"].as_array().map_or(0, Vec::len);
            list.push(
                json!({"id":proposal_id,"jobId":id,"accountId":job["accountId"],
            "afterTurn":after_turn,
            "draftKey":job["draftKey"],"messageId":job["messageId"],
            "subject":content["subject"],"body":content["body"]}),
            );
            if serde_json::to_vec(&proposals)
                .map_err(|_| "agent_invalid_proposal")?
                .len()
                > proposals::MAX_BYTES
            {
                return Err("agent_proposal_limit");
            }
            store.write_json(id, "proposals.json", &proposals)?;
            Ok(proposal_id)
        },
    )
}

fn serve(
    mut input: impl BufRead,
    mut output: impl Write,
    mut accept: impl FnMut(&Value, &Value) -> Result<String, &'static str>,
) -> Result<(), &'static str> {
    let mut initialized = false;
    let mut processed = 0;
    // Same request IDs are replay-safe for this connection; bound memory too.
    let mut replies: Vec<(Value, Value)> = Vec::new();
    loop {
        let mut line = Vec::new();
        let size = std::io::Read::take(&mut input, 128 * 1024 + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| "agent_mcp_io")?;
        if size == 0 {
            return Ok(());
        }
        if size > 128 * 1024 || line.last() != Some(&b'\n') {
            return Err("agent_mcp_limit");
        }
        processed += 1;
        if processed > 256 {
            return Err("agent_mcp_limit");
        }
        let request: Value = serde_json::from_slice(&line).map_err(|_| "agent_mcp_invalid")?;
        if request["jsonrpc"] != "2.0" {
            return Err("agent_mcp_invalid");
        }
        let Some(id) = request.get("id") else {
            continue;
        };
        if !(id.is_number() || id.as_str().is_some_and(|s| s.len() <= 128)) {
            return Err("agent_mcp_invalid");
        }
        let response = if let Some((_, response)) = replies.iter().find(|(known, _)| known == id) {
            response.clone()
        } else {
            let result = match request["method"].as_str().unwrap_or("") {
                "initialize" => {
                    initialized = true;
                    Ok(
                        json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},
                        "serverInfo":{"name":"omamail","version":env!("CARGO_PKG_VERSION")}}),
                    )
                }
                "ping" => Ok(json!({})),
                "tools/list" if initialized => Ok(json!({"tools":[proposals::tool()]})),
                "resources/list" if initialized => Ok(json!({"resources":[]})),
                "resources/templates/list" if initialized => Ok(json!({"resourceTemplates":[]})),
                "tools/call" if initialized && request["params"]["name"] == "propose_draft" => {
                    let args = &request["params"]["arguments"];
                    match proposals::validate(args)
                        .and_then(|_| accept(args, &request["params"]["_meta"]))
                    {
                        Ok(proposal) => Ok(
                            json!({"content":[{"type":"text","text":format!("Proposal {proposal} recorded for review. No mail was edited or sent.")}]}),
                        ),
                        Err(reason) => Ok(
                            json!({"isError":true,"content":[{"type":"text","text":format!("Proposal refused ({reason}). Check subject/body and whether this turn is still active.")}]}),
                        ),
                    }
                }
                _ => Err(json!({"code":-32601,"message":"Unsupported MCP method or tool"})),
            };
            let response = match result {
                Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
                Err(error) => json!({"jsonrpc":"2.0","id":id,"error":error}),
            };
            replies.push((id.clone(), response.clone()));
            response
        };
        serde_json::to_writer(&mut output, &response).map_err(|_| "agent_mcp_io")?;
        output
            .write_all(b"\n")
            .and_then(|_| output.flush())
            .map_err(|_| "agent_mcp_io")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_and_replayed_calls_cannot_create_extra_proposals() {
        let request = |id, method, params| {
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string() + "\n"
        };
        let valid = request(
            3,
            "tools/call",
            json!({"name":"propose_draft","arguments":{"subject":"Hello","body":"Text"}}),
        );
        let wire = request(1, "initialize", json!({}))
            + &request(
                2,
                "tools/call",
                json!({"name":"propose_draft","arguments":{"subject":"Hello\nBcc: injected","body":"Text"}}),
            )
            + &valid
            + &valid
            + &request(4, "tools/call", json!({"name":"send_email","arguments":{}}));
        let mut effects = 0;
        let mut output = Vec::new();
        serve(wire.as_bytes(), &mut output, |_, _| {
            effects += 1;
            Ok("synthetic-1".into())
        })
        .unwrap();
        assert_eq!(effects, 1);
        let responses: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(responses[1]["result"]["isError"], true);
        assert_eq!(responses[2], responses[3]);
        assert!(responses[4].get("error").is_some());
    }

    #[test]
    fn oversized_input_is_refused_before_any_effect() {
        let bytes = vec![b'x'; 128 * 1024 + 1];
        assert!(
            serve(bytes.as_slice(), Vec::new(), |_, _| panic!(
                "must not execute"
            ))
            .is_err()
        );
    }
}
