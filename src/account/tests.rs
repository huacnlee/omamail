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
fn corrupt_registry_is_an_error_not_empty_success() {
    assert_eq!(summarize(b"secret"), Err("accounts_invalid"));
    assert_eq!(
        summarize(b"{\"version\":2,\"accounts\":[]}"),
        Err("accounts_version_unsupported")
    );
    assert_eq!(summarize(b"{\"version\":1}"), Err("accounts_invalid"));
}
