use super::summarize;
use serde_json::json;

#[test]
fn registry_identity_repair_and_secret_projection() {
    let source = json!({"version":1,"activeId":"IMAP:A@EXAMPLE.ORG","accounts":[
        {"email":"A@example.org","id":"forged","clientSecret":"synthetic-secret"},
        {"email":"a@example.org","provider":"gmail"},
        {"email":"broken","provider":"imap","imap":{"username":"A@example.org","password":"synthetic-password"}},
        {"email":"","provider":"hey","pending":true}
    ]});
    let result = summarize(source.to_string().as_bytes()).unwrap();
    assert_eq!(result["accounts"].as_array().unwrap().len(), 3);
    assert_eq!(result["accounts"][0]["id"], "a@example.org");
    assert_eq!(result["accounts"][1]["id"], "imap:a@example.org");
    assert_eq!(result["activeId"], "imap:a@example.org");
    assert_eq!(result["accounts"][2]["pending"], true);
    let output = result.to_string();
    for forbidden in ["synthetic", "clientSecret", "password", "forged"] {
        assert!(!output.contains(forbidden));
    }
}

#[test]
fn a_microsoft_365_mailbox_is_listed_by_its_own_id_without_its_application_id() {
    let source = json!({"version":1,"activeId":"m365:a@example.org","accounts":[
        {"provider":"m365","email":"A@Example.org","label":"Work","clientId":"00000000-1111-2222-3333-444444444444"}
    ]});
    let result = summarize(source.to_string().as_bytes()).unwrap();
    assert_eq!(result["accounts"][0]["id"], "m365:a@example.org");
    assert_eq!(result["accounts"][0]["provider"], "m365");
    assert_eq!(result["activeId"], "m365:a@example.org");
    assert!(!result.to_string().contains("00000000"));
}

#[test]
fn corrupt_registry_is_an_error_not_empty_success() {
    assert_eq!(summarize(b"secret"), Err("accounts_invalid"));
    assert_eq!(
        summarize(b"{\"version\":2,\"accounts\":[]}"),
        Err("accounts_version_unsupported")
    );
    assert_eq!(summarize(b"{\"version\":1}"), Err("accounts_invalid"));
}

#[test]
fn unknown_registry_provider_is_not_projected_as_gmail() {
    let source = json!({"version":1,"activeId":"person@example.org","accounts":[
        {"provider":"mystery","email":"person@example.org"}
    ]});
    let result = summarize(source.to_string().as_bytes()).unwrap();
    assert_eq!(result["accounts"], json!([]));
    assert_eq!(result["activeId"], "");
}
