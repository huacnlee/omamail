use omamail::{
    host_context::HostContextRegistry,
    platform::{
        commands::{CommandError, PreparedCommand, SystemProcessRunner},
        secrets::{MemorySecretStore, Secret, SecretKey, SecretStore},
    },
    providers::caldav_transport::{
        CaldavError, CaldavOperation, CaldavProcessOutput, CaldavProcessRunner, CaldavResolver,
        CaldavTransport,
    },
};
use std::{
    fs,
    net::{IpAddr, Ipv4Addr},
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
fn context() -> omamail::host_context::CalendarContext {
    let r = HostContextRegistry::new();
    r.replace_json(r#"[{"kind":"imap","accountId":"imap:me@example.test","email":"me@example.test","username":"me","imapHost":"mail.example.test","imapPort":993,"smtpHost":"mail.example.test","smtpPort":465,"insecure":false},{"kind":"calendar","sourceId":"work","accountId":"imap:me@example.test","provider":"caldav","sourceUrl":"https://calendar.lan/users/me/"}]"#).unwrap();
    r.resolve_source("work").unwrap()
}
struct Resolver(Vec<IpAddr>);
impl CaldavResolver for Resolver {
    fn resolve(&self, _: &str, _: u16) -> std::io::Result<Vec<IpAddr>> {
        Ok(self.0.clone())
    }
}
type SeenCommand = (Vec<String>, bool, usize, usize);
struct Runner {
    seen: Mutex<Vec<SeenCommand>>,
    result: Mutex<Option<Result<CaldavProcessOutput, CommandError>>>,
}
impl CaldavProcessRunner for Runner {
    fn run_bounded(
        &self,
        c: PreparedCommand,
        o: usize,
        e: usize,
    ) -> Result<CaldavProcessOutput, CommandError> {
        self.seen
            .lock()
            .unwrap()
            .push((c.arguments().to_vec(), c.has_stdin(), o, e));
        self.result.lock().unwrap().take().unwrap()
    }
}
fn store() -> MemorySecretStore {
    let s = MemorySecretStore::default();
    s.set(
        &SecretKey::caldav("omamail", "work").unwrap(),
        Secret::new("user:password-secret"),
    )
    .unwrap();
    s
}
#[test]
fn private_origin_is_pinned_and_bounded() {
    let r = Runner {
        seen: Mutex::new(vec![]),
        result: Mutex::new(Some(Ok(CaldavProcessOutput::new(
            Some(0),
            b"<d:multistatus xmlns:d=\"DAV:\"/>\nOMAMAIL-STATUS:207\n".to_vec(),
            vec![],
        )))),
    };
    let dns = Resolver(vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 7))]);
    let s = store();
    let t =
        CaldavTransport::new(context(), &s, "omamail", PathBuf::from("curl"), &r, &dns).unwrap();
    assert_eq!(
        t.execute(
            CaldavOperation::List {
                start_ms: 0,
                end_ms: 86400000
            },
            Duration::from_secs(2)
        )
        .unwrap()
        .status(),
        207
    );
    assert_eq!(
        r.seen.lock().unwrap()[0],
        (
            vec!["-q".into(), "--config".into(), "-".into()],
            true,
            1_048_608,
            65_536
        )
    );
}
#[derive(Default)]
struct Counting(AtomicUsize);
impl SecretStore for Counting {
    fn get(
        &self,
        _: &SecretKey,
    ) -> Result<Option<Secret>, omamail::platform::secrets::SecretStoreError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(None)
    }
    fn set(
        &self,
        _: &SecretKey,
        _: Secret,
    ) -> Result<(), omamail::platform::secrets::SecretStoreError> {
        Ok(())
    }
    fn delete(&self, _: &SecretKey) -> Result<(), omamail::platform::secrets::SecretStoreError> {
        Ok(())
    }
}
#[test]
fn cross_origin_precedes_secret() {
    let r = Runner {
        seen: Mutex::new(vec![]),
        result: Mutex::new(None),
    };
    let dns = Resolver(vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 7))]);
    let s = Counting::default();
    let t =
        CaldavTransport::new(context(), &s, "omamail", PathBuf::from("curl"), &r, &dns).unwrap();
    assert_eq!(
        t.execute(
            CaldavOperation::Write {
                target: "https://evil.test/x.ics".into(),
                payload: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
                    .into()
            },
            Duration::from_secs(1)
        )
        .unwrap_err(),
        CaldavError::OriginRefused
    );
    assert_eq!(s.0.load(Ordering::SeqCst), 0)
}
#[cfg(unix)]
#[test]
fn fake_curl_gets_basic_auth_and_all_pins_only_in_config() {
    use std::os::unix::fs::PermissionsExt as _;
    let d = tempfile::tempdir().unwrap();
    let curl = d.path().join("curl");
    let cap = d.path().join("cap");
    let args = d.path().join("args");
    fs::write(&curl,format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\ncat > '{}'\nprintf '<d:multistatus xmlns:d=\"DAV:\"/>\\nOMAMAIL-STATUS:207\\n'\n",args.display(),cap.display())).unwrap();
    fs::set_permissions(&curl, fs::Permissions::from_mode(0o700)).unwrap();
    let dns = Resolver(vec![
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, 7)),
        IpAddr::V4(Ipv4Addr::new(192, 168, 1, 8)),
    ]);
    let s = store();
    let t =
        CaldavTransport::new(context(), &s, "omamail", curl, &SystemProcessRunner, &dns).unwrap();
    t.execute(
        CaldavOperation::List {
            start_ms: 0,
            end_ms: 1,
        },
        Duration::from_secs(1),
    )
    .unwrap();
    let a = fs::read_to_string(args).unwrap();
    let c = fs::read_to_string(cap).unwrap();
    assert_eq!(a.lines().collect::<Vec<_>>(), ["-q", "--config", "-"]);
    assert!(c.contains("user = \"user:password-secret\""));
    assert!(c.contains("request = \"REPORT\""));
    assert!(c.contains("header = \"Depth: 1\""));
    assert_eq!(c.matches("resolve =").count(), 2);
    assert!(c.contains("noproxy = \"*\"") && c.contains("max-redirs = 0"));
    assert!(!format!("{t:?}").contains("password-secret"));
}

#[test]
fn report_requires_207_multistatus_and_maps_authentication() {
    let dns = Resolver(vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 4))]);
    let s = store();
    for (reply, expected) in [
        (
            "<d:multistatus xmlns:d=\"DAV:\"/>\nOMAMAIL-STATUS:200\n",
            CaldavError::InvalidResponse,
        ),
        (
            "not xml\nOMAMAIL-STATUS:207\n",
            CaldavError::InvalidResponse,
        ),
        (
            "<evil:multistatus xmlns:evil=\"https://attacker.test/\"/>\nOMAMAIL-STATUS:207\n",
            CaldavError::InvalidResponse,
        ),
        (
            "<d:multistatus xmlns:d=\"DAV:\"><d:response></d:multistatus>\nOMAMAIL-STATUS:207\n",
            CaldavError::InvalidResponse,
        ),
        ("denied\nOMAMAIL-STATUS:401\n", CaldavError::AuthRequired),
        ("denied\nOMAMAIL-STATUS:403\n", CaldavError::AuthRequired),
    ] {
        let r = Runner {
            seen: Mutex::new(vec![]),
            result: Mutex::new(Some(Ok(CaldavProcessOutput::new(
                Some(0),
                reply.as_bytes().to_vec(),
                vec![],
            )))),
        };
        let t = CaldavTransport::new(context(), &s, "omamail", "curl".into(), &r, &dns).unwrap();
        assert_eq!(
            t.execute(
                CaldavOperation::List {
                    start_ms: 0,
                    end_ms: 1
                },
                Duration::from_secs(1)
            )
            .unwrap_err(),
            expected
        );
    }
}

#[test]
fn write_requires_one_crlf_bounded_vevent_calendar() {
    let dns = Resolver(vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 4))]);
    let s = Counting::default();
    let r = Runner {
        seen: Mutex::new(vec![]),
        result: Mutex::new(None),
    };
    let t = CaldavTransport::new(context(), &s, "omamail", "curl".into(), &r, &dns).unwrap();
    for payload in [
        "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        "BEGIN:VCALENDAR\nBEGIN:VEVENT\nEND:VEVENT\nEND:VCALENDAR\n",
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nbad\0value\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    ] {
        assert_eq!(
            t.execute(
                CaldavOperation::Write {
                    target: "event.ics".into(),
                    payload: payload.into()
                },
                Duration::from_secs(1)
            )
            .unwrap_err(),
            CaldavError::InvalidRequest
        );
    }
    assert_eq!(s.0.load(Ordering::SeqCst), 0);
}

#[test]
fn malformed_framing_and_http_failure_are_rejected_without_diagnostics() {
    let dns = Resolver(vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 4))]);
    let s = store();
    for (stdout, expected) in [
        (
            b"unframed password-secret".to_vec(),
            CaldavError::InvalidResponse,
        ),
        (
            b"body\nOMAMAIL-STATUS:302\n".to_vec(),
            CaldavError::InvalidResponse,
        ),
    ] {
        let r = Runner {
            seen: Mutex::new(vec![]),
            result: Mutex::new(Some(Ok(CaldavProcessOutput::new(
                Some(0),
                stdout,
                b"password-secret".to_vec(),
            )))),
        };
        let t = CaldavTransport::new(context(), &s, "omamail", PathBuf::from("curl"), &r, &dns)
            .unwrap();
        let error = t
            .execute(
                CaldavOperation::List {
                    start_ms: 0,
                    end_ms: 1,
                },
                Duration::from_secs(1),
            )
            .unwrap_err();
        assert_eq!(error, expected);
        assert!(!format!("{error:?}").contains("password-secret"));
    }
}

#[cfg(unix)]
#[test]
fn write_uses_calendar_content_type() {
    use std::os::unix::fs::PermissionsExt as _;
    let d = tempfile::tempdir().unwrap();
    let curl = d.path().join("curl");
    let cap = d.path().join("cap");
    fs::write(
        &curl,
        format!(
            "#!/bin/sh\ncat > '{}'\nprintf 'ok\\nOMAMAIL-STATUS:204\\n'\n",
            cap.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&curl, fs::Permissions::from_mode(0o700)).unwrap();
    let dns = Resolver(vec![IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))]);
    let s = store();
    CaldavTransport::new(context(), &s, "omamail", curl, &SystemProcessRunner, &dns)
        .unwrap()
        .execute(
            CaldavOperation::Write {
                target: "event.ics".into(),
                payload: "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
                    .into(),
            },
            Duration::from_secs(1),
        )
        .unwrap();
    let config = fs::read_to_string(cap).unwrap();
    assert!(config.contains("request = \"PUT\""));
    assert!(config.contains("Content-Type: text/calendar; charset=utf-8"));
}
