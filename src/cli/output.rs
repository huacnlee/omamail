use serde_json::{Value, json};
use std::collections::BTreeSet;
use tabled::{
    builder::Builder,
    settings::{Style, Width, peaker::PriorityMax},
};

pub(super) fn print_result(result: Result<Value, &'static str>, json: bool, envelope: bool) {
    match result {
        Ok(value) => {
            if json {
                let value = if envelope {
                    json!({"ok":true,"result":value})
                } else {
                    value
                };
                println!("{}", serde_json::to_string_pretty(&value).unwrap());
            } else {
                print!("{}", pretty(&value));
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
