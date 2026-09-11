//! HEY writes through the published CLI, with message bodies on stdin.
use serde_json::{Value, json};
use std::time::Duration;

const LIMIT: usize = 16 * 1024 * 1024;

fn numeric(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().all(|b| b.is_ascii_digit())
}

fn field<'a>(params: &'a Value, key: &str) -> Result<&'a str, &'static str> {
    match params.get(key) {
        None => Ok(""),
        Some(Value::String(value))
            if value.len() <= 8192 && !value.chars().any(char::is_control) =>
        {
            Ok(value)
        }
        _ => Err("Invalid HEY field"),
    }
}

fn prepare(method: &str, params: &Value) -> Result<(Vec<String>, Vec<u8>), &'static str> {
    let fields = params.as_object().ok_or("Invalid HEY parameters")?;
    let allowed: &[&str] = match method {
        "hey.act" => &["verb", "ids"],
        "hey.send" => &["to", "cc", "bcc", "subject", "body", "replyTo"],
        _ => return Err("Unknown HEY mutation"),
    };
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err("Unknown HEY parameter");
    }
    let mut args = Vec::new();
    let mut input = Vec::new();
    if method == "hey.act" {
        let verb = field(params, "verb")?;
        args.push(
            match verb {
                "markRead" | "seen" => "seen",
                "markUnread" | "unseen" => "unseen",
                "trash" => "trash",
                "spam" => "spam",
                "untrash" => "move",
                _ => return Err("Unsupported HEY action"),
            }
            .into(),
        );
        let ids = params["ids"].as_array().ok_or("Invalid HEY message ids")?;
        if ids.is_empty() || ids.len() > 1000 {
            return Err("Invalid HEY message ids");
        }
        for id in ids {
            let (posting, topic) = id
                .as_str()
                .and_then(|id| id.split_once(':'))
                .ok_or("Invalid HEY message id")?;
            if !numeric(posting) || !numeric(topic) {
                return Err("Invalid HEY message id");
            }
            if !args.iter().any(|arg| arg == posting) {
                args.push(posting.into());
            }
        }
        if verb == "untrash" {
            args.extend(["--to".into(), "imbox".into()]);
        }
    } else {
        let to = field(params, "to")?;
        let cc = field(params, "cc")?;
        let bcc = field(params, "bcc")?;
        let subject = field(params, "subject")?;
        let reply = field(params, "replyTo")?;
        let body = params["body"].as_str().ok_or("Invalid HEY body")?;
        if body.is_empty() || body.len() > LIMIT || body.contains('\0') {
            return Err("Invalid HEY body");
        }
        if !reply.is_empty() {
            if !numeric(reply)
                || !to.is_empty()
                || !cc.is_empty()
                || !bcc.is_empty()
                || !subject.is_empty()
            {
                return Err("HEY replies take a topic and body only");
            }
            args.extend(["reply".into(), reply.into()]);
        } else {
            if to.trim().is_empty() {
                return Err("HEY requires a recipient");
            }
            args.extend([
                "compose".into(),
                "--to".into(),
                to.into(),
                "--subject".into(),
                subject.into(),
            ]);
            for (flag, value) in [("--cc", cc), ("--bcc", bcc)] {
                if !value.is_empty() {
                    args.extend([flag.into(), value.into()]);
                }
            }
        }
        input.extend_from_slice(body.as_bytes());
    }
    args.push("--json".into());
    Ok((args, input))
}

fn execute(
    method: &str,
    params: &Value,
    run: impl FnOnce(&[String], &[u8]) -> Result<Vec<u8>, &'static str>,
) -> Result<Value, &'static str> {
    // Validate the complete batch before a subprocess can start.
    let (args, input) = prepare(method, params)?;
    let bytes = run(&args, &input)?;
    let answer: Value = serde_json::from_slice(&bytes).map_err(|_| "HEY returned invalid JSON")?;
    if answer["ok"] != true {
        return Err("HEY refused the request");
    }
    // Mutation output is only an acknowledgement; do not forward diagnostics.
    Ok(json!({"ok":true}))
}

pub fn call(method: &str, params: &Value) -> Result<Value, &'static str> {
    execute(method, params, |args, input| {
        crate::process::run(
            &super::hey_access::program()?,
            args,
            input,
            Duration::from_secs(60),
            LIMIT,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actions_use_postings_once_and_restore_to_imbox() {
        for (verb, command) in [
            ("markRead", "seen"),
            ("markUnread", "unseen"),
            ("trash", "trash"),
            ("spam", "spam"),
        ] {
            let (args, input) = prepare(
                "hey.act",
                &json!({"verb":verb,"ids":["12:34","12:56","78:90"]}),
            )
            .unwrap();
            assert_eq!(args, [command, "12", "78", "--json"]);
            assert!(input.is_empty());
        }
        assert_eq!(
            prepare("hey.act", &json!({"verb":"untrash","ids":["12:34"]}))
                .unwrap()
                .0,
            ["move", "12", "--to", "imbox", "--json"]
        );
    }

    #[test]
    fn entire_batch_is_rejected_before_process() {
        for id in [
            "--help:2", "1:2\n", "1:2\r", "1:2\r\n", "1:2\0", "1", "draft:2", "1:2:3", "１:2",
        ] {
            assert!(
                execute(
                    "hey.act",
                    &json!({"verb":"trash","ids":["1:2",id]}),
                    |_, _| panic!("process must not start")
                )
                .is_err()
            );
        }
        for verb in ["archive", "star", "", "trash\n"] {
            assert!(
                execute(
                    "hey.act",
                    &json!({"verb":verb,"ids":["1:2"]}),
                    |_, _| panic!("process must not start")
                )
                .is_err()
            );
        }
    }

    #[test]
    fn compose_preserves_body_only_on_stdin() {
        let body = "Private body\r\n世界\nquote ' and \\\"";
        let (args, input) = prepare("hey.send", &json!({"to":"A <a@example.org>","cc":"b@example.org","subject":"Quote \" \\ 世界","body":body})).unwrap();
        assert_eq!(input, body.as_bytes());
        assert!(!args.iter().any(|arg| arg.contains("Private body")));
        assert_eq!(&args[..3], ["compose", "--to", "A <a@example.org>"]);
        assert_eq!(
            prepare("hey.send", &json!({"replyTo":"42","body":body}))
                .unwrap()
                .0,
            ["reply", "42", "--json"]
        );
    }

    #[test]
    fn unsafe_send_and_false_success_do_not_escape() {
        for params in [
            json!({"to":"a@example.org\n","body":"body"}),
            json!({"to":"a@example.org","body":"body","attachments":["/secret"]}),
            json!({"replyTo":"42","to":"a@example.org","body":"body"}),
        ] {
            assert!(execute("hey.send", &params, |_, _| panic!("process must not start")).is_err());
        }
        assert_eq!(
            execute(
                "hey.act",
                &json!({"verb":"trash","ids":["1:2"]}),
                |_, _| Ok(br#"{"ok":false,"error":"synthetic-secret"}"#.to_vec())
            ),
            Err("HEY refused the request")
        );
    }
}
