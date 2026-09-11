//! Provider capability ceilings shared by backend operations and CLI discovery.
//!
//! Account refusals may remove a capability but cannot grant one. The serialized
//! names match the existing UI registry so clients need no provider-specific map.

use serde_json::{Map, Value, json};
pub mod domain;
pub mod gmail;
pub mod gmail_credentials;
pub mod gmail_http;
pub mod hey;
pub mod hey_access;
pub mod hey_actions;
pub mod imap;
pub mod jmap;

const CAPABILITIES: &[&str] = &[
    "labels",
    "move",
    "threads",
    "conversations",
    "archive",
    "spam",
    "star",
    "batch",
    "web",
    "webBox",
    "search",
    "manageLabels",
    "send",
];

struct Provider {
    id: &'static str,
    name: &'static str,
    summary: &'static str,
    auth: &'static str,
    capabilities: &'static [&'static str],
}

const IMAP_CAPABILITIES: &[&str] = &[
    "move",
    "manageLabels",
    "archive",
    "star",
    "batch",
    "search",
    "send",
];

const PROVIDERS: &[Provider] = &[
    Provider {
        id: "gmail",
        name: "Gmail",
        summary: "Google's own API. Needs an OAuth client you create once.",
        auth: "oauth",
        capabilities: &[
            "labels",
            "manageLabels",
            "move",
            "threads",
            "archive",
            "spam",
            "star",
            "batch",
            "web",
            "webBox",
            "search",
            "send",
        ],
    },
    Provider {
        id: "outlook",
        name: "Outlook",
        summary: "Outlook.com and Hotmail, signed in securely with Microsoft.",
        auth: "oauth",
        capabilities: IMAP_CAPABILITIES,
    },
    Provider {
        id: "hey",
        name: "HEY",
        summary: "37signals' own mailbox, read through the HEY CLI they publish.",
        auth: "cli",
        capabilities: &[
            "labels",
            "threads",
            "conversations",
            "spam",
            "batch",
            "web",
            "search",
            "send",
        ],
    },
    Provider {
        id: "jmap",
        name: "JMAP",
        summary: "Any server that speaks JMAP",
        auth: "password",
        capabilities: &[
            "threads",
            "conversations",
            "archive",
            "spam",
            "star",
            "batch",
            "search",
            "send",
        ],
    },
    Provider {
        id: "imap",
        name: "IMAP",
        summary: "Any standard mailbox — Fastmail, iCloud, Zoho, your own server.",
        auth: "password",
        capabilities: IMAP_CAPABILITIES,
    },
];

/// Provider discovery in the same chooser order as the desktop.
pub fn list() -> Value {
    Value::Array(
        PROVIDERS
            .iter()
            .map(|provider| {
                let capabilities: Map<String, Value> = CAPABILITIES
                    .iter()
                    .map(|name| {
                        (
                            (*name).to_owned(),
                            Value::Bool(provider.capabilities.contains(name)),
                        )
                    })
                    .collect();
                json!({
                    "id": provider.id,
                    "name": provider.name,
                    "summary": provider.summary,
                    "auth": provider.auth,
                    "capabilities": capabilities,
                })
            })
            .collect(),
    )
}

/// Whether this provider and account permit an operation.
///
/// Unlike presentation fallback in the legacy registry, unknown providers are
/// refused: a typo must never authorize an operation using Gmail's ceiling.
pub fn can(provider: &str, capability: &str, refusals: &Value) -> bool {
    let Some(provider) = PROVIDERS
        .iter()
        .find(|entry| entry.id.eq_ignore_ascii_case(provider.trim()))
    else {
        return false;
    };
    provider.capabilities.contains(&capability)
        && refusals.get(capability).is_none_or(Value::is_null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_operations_are_never_granted() {
        for operation in ["archive", "star", "move", "manageLabels", "webBox"] {
            assert!(!can("hey", operation, &Value::Null));
            assert!(!can("hey", operation, &json!({operation: null})));
        }
        for provider in ["imap", "outlook"] {
            assert!(!can(provider, "spam", &Value::Null));
            assert!(!can(provider, "threads", &Value::Null));
            assert!(can(provider, "move", &Value::Null));
        }
        assert!(!can("jmap", "move", &Value::Null));
        assert!(!can("unknown", "send", &Value::Null));
        assert!(!can("gmail", "unknown", &Value::Null));
        assert!(can(" GMAIL ", "send", &Value::Null));
    }

    #[test]
    fn presence_of_non_null_refusal_removes_capability() {
        for reason in [
            json!("No Archive mailbox"),
            json!(""),
            json!(false),
            json!(0),
        ] {
            assert!(!can("jmap", "archive", &json!({"archive": reason})));
        }
        assert!(can("jmap", "archive", &json!({"archive": null})));
        assert!(can("jmap", "archive", &json!({"send": "Read only"})));
    }

    #[test]
    fn discovery_is_complete_and_in_chooser_order() {
        let value = list();
        let providers = value.as_array().unwrap();
        assert_eq!(
            providers
                .iter()
                .map(|p| p["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["gmail", "outlook", "hey", "jmap", "imap"]
        );
        for provider in providers {
            assert_eq!(
                provider["capabilities"].as_object().unwrap().len(),
                CAPABILITIES.len()
            );
            for capability in CAPABILITIES {
                assert_eq!(
                    provider["capabilities"][capability],
                    can(provider["id"].as_str().unwrap(), capability, &Value::Null)
                );
            }
        }
        assert_eq!(providers[0]["capabilities"]["conversations"], false);
        assert_eq!(providers[2]["capabilities"]["conversations"], true);
    }
}
