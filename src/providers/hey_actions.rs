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
        "hey.send" | "hey.saveDraft" => &[
            "to",
            "cc",
            "bcc",
            "subject",
            "body",
            "replyTo",
            "draftId",
            "attachments",
        ],
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
        if (body.is_empty() && method == "hey.send") || body.len() > LIMIT || body.contains('\0') {
            return Err("Invalid HEY body");
        }
        let draft = field(params, "draftId")?;
        if !draft.is_empty() {
            let id = draft.strip_prefix("draft:").unwrap_or(draft);
            if method != "hey.saveDraft" || !numeric(id) {
                return Err("Invalid HEY draft id");
            }
            // Newer official clients accept draft edit body from stdin, like compose.
            // Never put private body text in --message / the process table.
            args.extend(["draft".into(), "edit".into(), id.into()]);
            for (flag, value) in [
                ("--to", to),
                ("--cc", cc),
                ("--bcc", bcc),
                ("--subject", subject),
            ] {
                args.extend([flag.into(), value.into()]);
            }
        } else if !reply.is_empty() {
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
            if to.trim().is_empty() && method == "hey.send" {
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
        if method == "hey.saveDraft" && draft.is_empty() {
            args.push("--draft".into());
        }
        if let Some(files) = params.get("attachments") {
            let files = files
                .as_array()
                .filter(|v| v.len() <= 32)
                .ok_or("Invalid HEY attachments")?;
            for file in files {
                let path = file
                    .as_str()
                    .or_else(|| file["path"].as_str())
                    .ok_or("Invalid HEY attachment")?;
                if !path.starts_with('/') || path.chars().any(char::is_control) || path.len() > 8192
                {
                    return Err("Invalid HEY attachment");
                }
                let metadata = std::fs::metadata(path).map_err(|_| "HEY attachment unavailable")?;
                if !metadata.is_file() || metadata.len() > LIMIT as u64 {
                    return Err("Invalid HEY attachment");
                }
                args.extend(["--attach".into(), path.into()]);
            }
        }
        input.extend_from_slice(body.as_bytes());
    }
    args.push("--json".into());
    Ok((args, input))
}

#[cfg(test)]
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

fn decode_message(params: &Value) -> Result<Value, &'static str> {
    use base64::Engine;
    use mailparse::MailHeaderMap;
    let fields = params.as_object().ok_or("Invalid HEY parameters")?;
    if fields
        .keys()
        .any(|key| !["raw", "threadId", "draftId", "attachments"].contains(&key.as_str()))
    {
        return Err("Unknown HEY parameter");
    }
    let encoded = params["raw"]
        .as_str()
        .filter(|v| v.len() <= LIMIT * 4 / 3 + 4)
        .ok_or("Invalid HEY message")?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "Invalid HEY encoding")?;
    let mail = mailparse::parse_mail(&bytes).map_err(|_| "Invalid HEY message")?;
    fn plain(mail: &mailparse::ParsedMail<'_>) -> Option<String> {
        if mail.ctype.mimetype == "text/plain" {
            return mail.get_body().ok();
        }
        mail.subparts.iter().find_map(plain)
    }
    fn attachments(mail: &mailparse::ParsedMail<'_>) -> usize {
        usize::from(
            mail.get_content_disposition().disposition == mailparse::DispositionType::Attachment,
        ) + mail.subparts.iter().map(attachments).sum::<usize>()
    }
    if attachments(&mail)
        > params
            .get("attachments")
            .and_then(Value::as_array)
            .map_or(0, Vec::len)
    {
        return Err("HEY attachments need local files");
    }
    let thread = params.get("threadId").and_then(Value::as_str).unwrap_or("");
    let thread = thread
        .split_once(':')
        .map(|(_, topic)| topic)
        .unwrap_or(thread);
    let mut out = json!({"body":plain(&mail).unwrap_or_default(),
        "attachments":params.get("attachments").cloned().unwrap_or(json!([])),
        "draftId":params.get("draftId").cloned().unwrap_or(json!(""))});
    if thread.is_empty() {
        for (key, header) in [
            ("to", "To"),
            ("cc", "Cc"),
            ("bcc", "Bcc"),
            ("subject", "Subject"),
        ] {
            out[key] = json!(mail.headers.get_first_value(header).unwrap_or_default());
        }
    } else {
        out["replyTo"] = json!(thread);
    }
    Ok(out)
}

pub async fn call(method: &str, params: &Value) -> Result<Value, &'static str> {
    let decoded;
    let params = if params.get("raw").is_some() {
        decoded = decode_message(params)?;
        &decoded
    } else {
        params
    };
    let (args, input) = prepare(method, params)?;
    if args.first().is_some_and(|arg| arg == "draft")
        && args.get(1).is_some_and(|arg| arg == "edit")
    {
        let help = crate::process::async_run::run(
            &super::hey_access::program()?,
            &["draft".into(), "edit".into(), "--help".into()],
            b"",
            Duration::from_secs(5),
            65536,
        )
        .await?;
        if !help.success
            || !String::from_utf8_lossy(&help.stdout)
                .to_ascii_lowercase()
                .contains("stdin")
        {
            return Err("This HEY CLI cannot securely edit draft bodies from stdin");
        }
    }
    let output = crate::process::async_run::run(
        &super::hey_access::program()?,
        &args,
        &input,
        Duration::from_secs(20),
        LIMIT,
    )
    .await?;
    if !output.success {
        return Err("HEY refused the request");
    }
    let answer: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "HEY returned invalid JSON")?;
    if answer["ok"] != true {
        return Err("HEY refused the request");
    }
    Ok(if method == "hey.saveDraft" {
        answer["data"].clone()
    } else {
        json!({"ok":true})
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_message_decoding_retains_bcc_and_private_body() {
        use base64::Engine;
        let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
            b"To: a@example.org\r\nBcc: hidden@example.org\r\nSubject: Hello\r\n\r\nPrivate body",
        );
        let fields = decode_message(&json!({"raw":raw})).unwrap();
        assert_eq!(fields["bcc"], "hidden@example.org");
        let (args, input) = prepare("hey.send", &fields).unwrap();
        assert_eq!(input, b"Private body");
        assert!(!args.iter().any(|arg| arg.contains("Private body")));
        assert!(args.iter().any(|arg| arg == "hidden@example.org"));
    }

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
