use serde_json::{Value, json};
use std::collections::BTreeSet;
use tabled::{
    builder::Builder,
    settings::{Style, Width, peaker::PriorityMax},
};

pub(super) fn print_result(result: Result<Value, &'static str>, json: bool, envelope: bool) {
    match result {
        Ok(value) => {
            let failure = result_failure(&value);
            if json {
                let value = if let Some(code) = failure {
                    json!({"ok":false,"error":{"code":code},"result":value})
                } else if envelope {
                    json!({"ok":true,"result":value})
                } else {
                    value
                };
                println!("{}", serde_json::to_string_pretty(&value).unwrap());
            } else {
                print!("{}", pretty(&value));
            }
            if let Some(code) = failure {
                if !json {
                    eprintln!("omamail: {code}");
                }
                std::process::exit(1);
            }
        }
        Err(code) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({"ok":false,"error":{"code":code}}))
                        .unwrap()
                );
            } else {
                eprintln!("omamail: {code}");
            }
            std::process::exit(1);
        }
    }
}

fn result_failure(value: &Value) -> Option<&'static str> {
    if value["failedIds"]
        .as_array()
        .is_some_and(|ids| !ids.is_empty())
    {
        return Some("mail_action_failed");
    }
    if value["executed"] == true && value["sendId"].is_string() {
        let entry = value["outbox"]["entries"]
            .as_array()?
            .iter()
            .find(|entry| entry["id"] == value["sendId"])?;
        return match entry["state"].as_str() {
            Some("sent") => None,
            Some("failed") if entry["error"] == "outbox_storage_unavailable" => {
                Some("outbox_storage_unavailable")
            }
            Some("failed") => Some("outbox_send_refused"),
            Some("cancelled") => Some("outbox_stopped_unsent"),
            _ => Some("outbox_delivery_unknown"),
        };
    }
    None
}

// Sender-controlled text must not execute terminal escapes or inject table rows.
fn safe(text: &str) -> String {
    let mut result = String::new();
    for c in text.chars() {
        match c {
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            '\\' => result.push_str("\\\\"),
            '|' => result.push_str("\\|"),
            c if c.is_control()
                || matches!(c, '\u{061c}' | '\u{200e}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}') =>
            {
                result.extend(c.escape_unicode());
            }
            c => result.push(c),
        }
    }
    result
}

fn cell(value: &Value) -> String {
    match value {
        Value::Null => "-".into(),
        Value::String(text) => text.clone(),
        Value::Bool(value) => if *value { "yes" } else { "no" }.into(),
        Value::Array(values) => values.iter().map(cell).collect::<Vec<_>>().join(", "),
        Value::Object(values) => values
            .iter()
            .map(|(key, value)| format!("{key}: {}", cell(value)))
            .collect::<Vec<_>>()
            .join(", "),
        _ => value.to_string(),
    }
}

fn table(headers: Vec<String>, rows: Vec<Vec<String>>) -> String {
    let mut builder = Builder::default();
    builder.push_record(headers.iter().map(|text| safe(text)));
    for row in rows {
        builder.push_record(row.iter().map(|text| safe(text)));
    }
    format!(
        "{}\n",
        builder.build().with(Style::markdown()).with(
            Width::wrap(100)
                .priority(PriorityMax::new(false))
                .keep_words(true)
        )
    )
}

fn pretty(value: &Value) -> String {
    match value {
        Value::Object(object)
            if object.contains_key("name")
                && object.contains_key("version")
                && object.contains_key("protocol")
                && object.get("methods").is_some_and(Value::is_array) =>
        {
            let metadata = table(
                vec!["Field".into(), "Value".into()],
                object
                    .iter()
                    .filter(|(key, _)| key.as_str() != "methods")
                    .map(|(key, value)| vec![key.clone(), cell(value)])
                    .collect(),
            );
            let methods = table(
                vec!["Method".into()],
                object["methods"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|method| vec![cell(method)])
                    .collect(),
            );
            format!("{metadata}\n{methods}")
        }
        Value::Object(object)
            if object.contains_key("accounts") && object.contains_key("activeId") =>
        {
            format!(
                "Active account: {}\n\n{}",
                safe(&cell(&object["activeId"])),
                pretty(&object["accounts"])
            )
        }
        Value::Object(object) => table(
            vec!["Field".into(), "Value".into()],
            object
                .iter()
                .map(|(key, value)| vec![key.clone(), cell(value)])
                .collect(),
        ),
        Value::Array(values) if values.is_empty() => "No entries.\n".into(),
        Value::Array(values) if values.iter().all(Value::is_object) => {
            let keys: BTreeSet<&String> = values
                .iter()
                .flat_map(|value| value.as_object().unwrap().keys())
                .collect();
            if keys.is_empty() {
                return format!("{} empty entries.\n", values.len());
            }
            table(
                keys.iter().map(|key| (*key).clone()).collect(),
                values
                    .iter()
                    .map(|value| keys.iter().map(|key| cell(&value[*key])).collect())
                    .collect(),
            )
        }
        Value::Array(values) => table(
            vec!["Value".into()],
            values.iter().map(|value| vec![cell(value)]).collect(),
        ),
        value => format!("{}\n", safe(&cell(value))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_storage_failure_is_not_reported_as_a_provider_refusal() {
        let result = json!({"executed":true,"sendId":"one","outbox":{"entries":[{"id":"one","state":"failed","error":"outbox_storage_unavailable"}]}});
        assert_eq!(result_failure(&result), Some("outbox_storage_unavailable"));
    }

    #[test]
    fn sender_fields_cannot_control_the_terminal_or_inject_table_rows() {
        let result = pretty(&json!({"messages":[{
            "from":"Eve\u{1b}[31m\r\n|forged\trow\u{202e}\u{2067}工"
        }]}));
        for control in ['\u{1b}', '\r', '\t', '\u{202e}', '\u{2067}'] {
            assert!(!result.contains(control));
        }
        assert!(result.contains("\\u{1b}") && result.contains("\\u{202e}"));
        assert!(!result.lines().any(|line| line.starts_with("|forged")));
        assert!(result.contains("工"));
    }
}
