use omamail::host_context::{ContextError, HostContext, HostContextRegistry};

fn configured() -> HostContextRegistry {
    let registry = HostContextRegistry::new();
    registry.replace_json(r#"[
      {"kind":"gmail","accountId":"me@example.test","clientId":"client.apps.googleusercontent.com","grant":"gmail.modify gmail.send calendar.events"},
      {"kind":"imap","accountId":"imap:work@example.test","email":"work@example.test","username":"work-user","imapHost":"imap.example.test","imapPort":993,"smtpHost":"smtp.example.test","smtpPort":465,"insecure":false},
      {"kind":"calendar","sourceId":"primary","accountId":"me@example.test","provider":"google"},
      {"kind":"calendar","sourceId":"team","accountId":"imap:work@example.test","provider":"caldav","sourceUrl":"https://calendar.example.test/users/work/"}
    ]"#).unwrap();
    registry
}

#[test]
fn resolves_typed_contexts_and_builds_imap_urls_from_validated_fields() {
    let registry = configured();
    assert!(matches!(
        registry.resolve_account("me@example.test").unwrap(),
        HostContext::Gmail(_)
    ));
    match registry.resolve_account("imap:work@example.test").unwrap() {
        HostContext::Imap(value) => {
            assert_eq!(value.imap_url(), "imaps://imap.example.test:993/");
            assert_eq!(value.smtp_url(), "smtps://smtp.example.test:465/");
        }
        _ => panic!("wrong context"),
    }
    let calendar = registry.resolve_source("team").unwrap();
    assert_eq!(calendar.account_id(), "imap:work@example.test");
    assert_eq!(
        calendar.source_url(),
        Some("https://calendar.example.test/users/work/")
    );
    assert_eq!(
        registry
            .resolve_source("primary")
            .unwrap()
            .remote_calendar_id(),
        Some("primary")
    );
}

#[test]
fn google_local_and_remote_calendar_identities_are_distinct() {
    let registry = HostContextRegistry::new();
    registry.replace_json(r#"[{"kind":"gmail","accountId":"me@example.test","clientId":"client.apps.googleusercontent.com","grant":"gmail.modify gmail.send calendar.events"},{"kind":"calendar","sourceId":"work-local","remoteCalendarId":"team@example.test","accountId":"me@example.test","provider":"google"}]"#).unwrap();
    assert_eq!(
        registry
            .resolve_source("work-local")
            .unwrap()
            .remote_calendar_id(),
        Some("team@example.test")
    );
}

#[test]
fn schema_rejects_secrets_unknown_fields_and_invalid_identity_or_transport_policy() {
    let registry = HostContextRegistry::new();
    for request in [
        r#"[{"kind":"gmail","accountId":"me@example.test","clientId":"client.apps.googleusercontent.com","grant":"gmail.modify","clientSecret":"secret"}]"#,
        r#"[{"kind":"gmail","accountId":"not-email","clientId":"client.apps.googleusercontent.com","grant":"gmail.modify"}]"#,
        r#"[{"kind":"imap","accountId":"imap:x@example.test","email":"x@example.test","username":"x","imapHost":"https://evil.test/x","imapPort":993,"smtpHost":"smtp.example.test","smtpPort":465,"insecure":false}]"#,
        r#"[{"kind":"imap","accountId":"imap:x@example.test","email":"x@example.test","username":"x","imapHost":"mail.example.test","imapPort":143,"smtpHost":"smtp.example.test","smtpPort":25,"insecure":true}]"#,
        r#"[{"kind":"calendar","sourceId":"x","accountId":"missing@example.test","provider":"caldav","sourceUrl":"http://calendar.example.test/"}]"#,
    ] {
        assert!(
            registry.replace_json(request).is_err(),
            "accepted {request}"
        );
    }
}

#[test]
fn replacement_is_atomic_and_unknown_contexts_are_refused() {
    let registry = configured();
    let before = registry.snapshot();
    let error = registry.replace_json(r#"[
      {"kind":"gmail","accountId":"new@example.test","clientId":"new.apps.googleusercontent.com","grant":"gmail.modify"},
      {"kind":"calendar","sourceId":"broken","accountId":"missing@example.test","provider":"google"}
    ]"#).unwrap_err();
    assert_eq!(error, ContextError::UnknownAccount);
    assert_eq!(registry.snapshot(), before);
    assert_eq!(
        registry
            .resolve_account("missing@example.test")
            .unwrap_err(),
        ContextError::UnknownAccount
    );
    assert_eq!(
        registry.resolve_source("missing").unwrap_err(),
        ContextError::UnknownSource
    );
}

#[test]
fn diagnostics_hide_user_content_and_credentials_but_may_name_hosts() {
    let registry = configured();
    let debug = format!(
        "{registry:?} {:?}",
        registry.resolve_account("imap:work@example.test").unwrap()
    );
    assert!(debug.contains("imap.example.test"));
    for private in [
        "work-user",
        "work@example.test",
        "client.apps",
        "gmail.modify",
    ] {
        assert!(!debug.contains(private));
    }
}

#[test]
fn imap_hosts_are_canonicalized_and_ipv6_urls_are_bracketed() {
    let registry = HostContextRegistry::new();
    registry.replace_json(r#"[{"kind":"imap","accountId":"imap:v6@example.test","email":"v6@example.test","username":"v6","imapHost":"2001:4860:4860::8888","imapPort":993,"smtpHost":"bücher.example","smtpPort":465,"insecure":false}]"#).unwrap();
    match registry.resolve_account("imap:v6@example.test").unwrap() {
        HostContext::Imap(value) => {
            assert_eq!(value.imap_url(), "imaps://[2001:4860:4860::8888]:993/");
            assert_eq!(value.smtp_url(), "smtps://xn--bcher-kva.example:465/");
        }
        _ => panic!("wrong context"),
    }
    assert!(registry.replace_json(r#"[{"kind":"imap","accountId":"imap:x@example.test","email":"x@example.test","username":"x","imapHost":"bad host.example","imapPort":993,"smtpHost":"smtp.example","smtpPort":465,"insecure":false}]"#).is_err());
}

// A mailbox with no SMTP server is one that reads and cannot answer, which is
// what `Imap.validateSettings` has always accepted and `Imap.smtpUrl` answers
// "" for. The absence is the only thing waived: a named server still faces the
// canonicalisation, the port and the loopback rule it faced before.
#[test]
fn an_imap_account_with_no_smtp_server_resolves_and_carries_no_send_url() {
    let registry = HostContextRegistry::new();
    registry.replace_json(r#"[{"kind":"imap","accountId":"imap:read@example.test","email":"read@example.test","username":"read","imapHost":"imap.example.test","imapPort":993,"smtpHost":"","smtpPort":0,"insecure":false}]"#).unwrap();
    match registry.resolve_account("imap:read@example.test").unwrap() {
        HostContext::Imap(value) => {
            assert_eq!(value.imap_url(), "imaps://imap.example.test:993/");
            assert_eq!(value.smtp_url(), "");
        }
        _ => panic!("wrong context"),
    }
    // Loopback IMAP, no SMTP: the clear-text session is still on this machine,
    // so nothing was relaxed by the server that is missing.
    registry.replace_json(r#"[{"kind":"imap","accountId":"imap:local@example.test","email":"local@example.test","username":"local","imapHost":"127.0.0.1","imapPort":1143,"smtpHost":"","smtpPort":0,"insecure":true}]"#).unwrap();
    match registry.resolve_account("imap:local@example.test").unwrap() {
        HostContext::Imap(value) => assert_eq!(value.smtp_url(), ""),
        _ => panic!("wrong context"),
    }
    // And an insecure account that does name a remote SMTP server is still
    // refused, which is the check the empty case must not have opened a hole in.
    assert!(registry.replace_json(r#"[{"kind":"imap","accountId":"imap:x@example.test","email":"x@example.test","username":"x","imapHost":"127.0.0.1","imapPort":1143,"smtpHost":"smtp.example.test","smtpPort":587,"insecure":true}]"#).is_err());
    // An unusable SMTP host is not an absent one.
    assert!(registry.replace_json(r#"[{"kind":"imap","accountId":"imap:x@example.test","email":"x@example.test","username":"x","imapHost":"imap.example.test","imapPort":993,"smtpHost":"bad host.example","smtpPort":465,"insecure":false}]"#).is_err());
    // A named server with no port is still a mailbox nobody can send from and
    // is refused rather than quietly becoming a read-only one.
    assert!(registry.replace_json(r#"[{"kind":"imap","accountId":"imap:x@example.test","email":"x@example.test","username":"x","imapHost":"imap.example.test","imapPort":993,"smtpHost":"smtp.example.test","smtpPort":0,"insecure":false}]"#).is_err());
}
