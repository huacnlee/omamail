//! Account-qualified sender identities. Reply account filtering stays a view concern.
use super::unified::{rows, text};
use serde_json::{Value, json};
use std::collections::HashSet;
fn value(v: &Value) -> String {
    if v.is_null() || v == false || v == 0 {
        String::new()
    } else {
        text(v)
    }
}
pub fn request(params: &Value) -> Result<Value, &'static str> {
    let boxes = rows(&params["mailboxes"]);
    if boxes.len() > 128
        || serde_json::to_vec(params)
            .map_err(|_| "invalid_params")?
            .len()
            > 4 * 1024 * 1024
    {
        return Err("identities_limit");
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut output_bytes = 32usize;
    for account in boxes {
        if account["ready"] != true || account["canSend"] == false {
            continue;
        }
        let account_id = value(&account["id"]);
        if account_id.is_empty() {
            continue;
        }
        let fallback = [
            json!({"email":value(&account["email"]).trim(),"displayName":value(&account["displayName"])}),
        ];
        let aliases = if rows(&account["aliases"]).is_empty() {
            &fallback[..]
        } else {
            rows(&account["aliases"])
        };
        if aliases.len() > 1024 {
            return Err("identities_limit");
        }
        for alias in aliases {
            let email = value(&alias["email"]).trim().to_owned();
            if email.is_empty() || !seen.insert((account_id.clone(), email.to_lowercase())) {
                continue;
            }
            let display_name = value(&alias["displayName"]);
            let label = value(&account["label"]);
            let identity = json!({"accountId":account_id,"email":email,"displayName":display_name,"label":label});
            output_bytes = output_bytes.saturating_add(
                serde_json::to_vec(&identity)
                    .map_err(|_| "invalid_params")?
                    .len()
                    + 1,
            );
            if output_bytes > 4 * 1024 * 1024 {
                return Err("identities_limit");
            }
            out.push(identity);
        }
    }
    Ok(json!({"identities":out}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::Write,
        process::{Command, Stdio},
    };
    #[test]
    fn identity_merge_matches_legacy_oracle_and_is_account_qualified() {
        let fixtures = json!([
            [],
            [{"id":"a","ready":true,"email":" a@example.org ","displayName":"Alice","label":"Work"}],
            [{"id":"a","ready":true,"canSend":false,"email":"a@example.org"},{"id":"b","ready":false,"email":"b@example.org"}],
            [{"id":"a","ready":true,"aliases":[{"email":"Alias@example.org","displayName":"First"},{"email":" alias@example.org ","displayName":"Duplicate"},{"email":"other@example.org"}]},{"id":"imap:a","ready":true,"aliases":[{"email":"alias@example.org"}]}]
        ]);
        let mut node=Command::new("node").args(["-e",r#"const S=require('./ui/tests/load').load('tests/oracles/Senders.js');let p=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(p.map(S.identities)));"#]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        node.stdin
            .take()
            .unwrap()
            .write_all(fixtures.to_string().as_bytes())
            .unwrap();
        let output = node.wait_with_output().unwrap();
        assert!(output.status.success());
        let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
        for (index, mailboxes) in rows(&fixtures).iter().enumerate() {
            assert_eq!(
                request(&json!({"mailboxes":mailboxes})).unwrap()["identities"],
                expected[index]
            );
        }
        assert_eq!(expected[3].as_array().unwrap().len(), 3);
    }
}

#[cfg(test)]
mod expansion_tests {
    use super::*;
    #[test]
    fn escaped_identity_labels_are_counted_before_repeated_output_is_retained() {
        let aliases: Vec<_> = (0..100)
            .map(|n| json!({"email":format!("alias{n}@example.org")}))
            .collect();
        let params = json!({"mailboxes":[{"id":"a","ready":true,"label":"\u{0001}".repeat(8192),"aliases":aliases}]});
        assert_eq!(request(&params), Err("identities_limit"));
    }
}
