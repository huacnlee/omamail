//! The reminder ledger is independent of the evictable view cache. A locked,
//! atomic claim is shared by shell and standalone instances on this machine.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path};

const LIMIT: usize = 4 * 1024 * 1024;
type Result<T> = std::result::Result<T, &'static str>;

fn key(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn validate(params: &Value) -> Result<()> {
    let fields = params.as_object().ok_or("invalid_params")?;
    if fields.keys().any(|field| {
        ![
            "operation",
            "candidates",
            "now",
            "lastCheck",
            "key",
            "minutes",
        ]
        .contains(&field.as_str())
    }) {
        return Err("invalid_params");
    }
    if !params["now"].as_i64().is_some_and(|now| now > 0) {
        return Err("invalid_params");
    }
    match params["operation"].as_str() {
        Some("poll") => {
            let candidates = params["candidates"].as_array().ok_or("invalid_params")?;
            if candidates.len() > 5000 {
                return Err("calendar_too_many_reminders");
            }
            for candidate in candidates {
                for field in [
                    "key",
                    "occurrence",
                    "eventId",
                    "sourceId",
                    "title",
                    "accountId",
                ] {
                    let text = candidate[field].as_str().ok_or("invalid_params")?;
                    if text.len() > 8192 || text.contains('\0') {
                        return Err("invalid_params");
                    }
                }
                for field in ["start", "end", "due"] {
                    if !candidate[field].as_i64().is_some_and(|time| time > 0) {
                        return Err("invalid_params");
                    }
                }
                if candidate["end"].as_i64() <= candidate["start"].as_i64() {
                    return Err("invalid_params");
                }
            }
        }
        Some("snooze" | "dismiss" | "failed") => {
            let id = params["key"].as_str().ok_or("invalid_params")?;
            if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err("invalid_params");
            }
            if params["operation"] == "snooze"
                && !params["minutes"]
                    .as_i64()
                    .is_some_and(|n| (1..=1440).contains(&n))
            {
                return Err("invalid_params");
            }
        }
        _ => return Err("invalid_params"),
    }
    if serde_json::to_vec(params)
        .map_err(|_| "invalid_params")?
        .len()
        > LIMIT
    {
        return Err("calendar_too_many_reminders");
    }
    Ok(())
}

pub fn call(params: &Value) -> Result<Value> {
    validate(params)?;
    let root = crate::platform::dirs::AppDirs::discover()?.config;
    call_at(&root, params)
}

fn call_at(root: &Path, params: &Value) -> Result<Value> {
    validate(params)?;
    let dir = crate::cache::directories(root, &["omamail"], true)?
        .ok_or("calendar_reminders_unavailable")?;
    let _lock = match crate::platform::private_fs::lock_exclusive(&dir, ".calendar-reminders.lock")
    {
        Ok(lock) => lock,
        Err("private_fs_busy") if params["operation"] == "poll" => {
            return Ok(json!({"notifications":[],"retry":true}));
        }
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::new();
    if let Some(file) = crate::cache::regular(&dir, "calendar-reminders.json", false)? {
        file.take(LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "calendar_reminders_unavailable")?;
    }
    if bytes.len() > LIMIT {
        return Err("calendar_too_many_reminders");
    }
    let mut ledger: Value = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&bytes).map_err(|_| "calendar_reminders_invalid")?
    };
    let entries = ledger.as_object_mut().ok_or("calendar_reminders_invalid")?;
    let now = params["now"].as_i64().ok_or("invalid_params")?;
    entries.retain(|_, entry| entry["end"].as_i64().unwrap_or(0).saturating_add(86400000) > now);
    let mut notifications: Vec<Value> = Vec::new();
    if params["operation"] == "poll" {
        let candidates = params["candidates"].as_array().ok_or("invalid_params")?;
        let last_check = params["lastCheck"].as_i64().unwrap_or(0);
        let mut caught_up = std::collections::HashSet::new();
        for candidate in candidates {
            let id = key(candidate["key"].as_str().unwrap());
            let occurrence = key(candidate["occurrence"].as_str().unwrap());
            let start = candidate["start"].as_i64().unwrap();
            let end = candidate["end"].as_i64().unwrap();
            if end <= now {
                continue;
            }
            let previous = entries.get(&id);
            let pending =
                previous.filter(|record| record["start"] == start && record["pending"] == true);
            if previous.is_some_and(|record| record["start"] == start && record["pending"] != true)
            {
                continue;
            }
            let due = pending
                .and_then(|record| record["due"].as_i64())
                .unwrap_or(candidate["due"].as_i64().unwrap());
            let on_time =
                due <= now && now - due <= 60000 && (pending.is_some() || due > last_check);
            let catch_up = due <= now && start <= now && now - start <= 600000;
            if !on_time && !catch_up {
                continue;
            }
            if !on_time
                && catch_up
                && (!caught_up.insert(occurrence.clone())
                    || entries.values().any(|entry| {
                        entry["occurrence"] == occurrence
                            && entry["start"] == start
                            && entry["pending"] != true
                    }))
            {
                continue;
            }
            let mut record = candidate.clone();
            record["key"] = json!(id);
            record["occurrence"] = json!(occurrence);
            record["pending"] = json!(false);
            entries.insert(id, record.clone());
            notifications.push(record);
        }
    } else {
        let id = params["key"].as_str().unwrap();
        // One action owns one reminder, including entries from an older ledger
        // that grouped unrelated events under relatedKeys.
        let record = entries.get_mut(id).ok_or("calendar_reminder_not_found")?;
        record["pending"] = json!(params["operation"] != "dismiss");
        if params["operation"] != "dismiss" {
            let minutes = if params["operation"] == "failed" {
                1
            } else {
                params["minutes"].as_i64().unwrap()
            };
            record["due"] = json!(now.saturating_add(minutes * 60000));
        }
    }
    let bytes = serde_json::to_vec(&ledger).map_err(|_| "calendar_reminders_invalid")?;
    if bytes.len() > LIMIT {
        return Err("calendar_too_many_reminders");
    }
    crate::platform::private_fs::atomic_replace(&dir, "calendar-reminders.json", &bytes)?;
    Ok(json!({"notifications":notifications}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_root(name: &str) -> std::path::PathBuf {
        // macOS exposes its temporary directory through /var, a symlink to
        // /private/var. Resolve the trusted fixture parent before exercising
        // the production no-symlink storage boundary.
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("omamail-reminders-{name}-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // CI may use a group-writable umask; the fixture itself must obey
            // the same private-directory policy as the real config root.
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        root
    }

    #[test]
    fn simultaneous_reminders_keep_each_event_and_action_independent() {
        let root = fixture_root("simultaneous");
        let candidates: Vec<Value> = (1..=2)
            .map(|i| {
                json!({
                    "key":format!("event-{i}"), "occurrence":format!("event-{i}"),
                    "start":2000000, "end":5600000, "due":1400000,
                    "eventId":format!("event-{i}"), "sourceId":"calendar",
                    "accountId":"synthetic", "title":format!("Meeting {i}")
                })
            })
            .collect();
        let mut poll =
            json!({"operation":"poll","now":1400000,"lastCheck":1300000,"candidates":candidates});
        let result = call_at(&root, &poll).unwrap();
        let notices = result["notifications"].as_array().unwrap();
        assert_eq!(notices.len(), 2);
        assert_eq!(notices[0]["eventId"], "event-1");
        assert_eq!(notices[1]["eventId"], "event-2");
        assert_eq!(notices[1]["title"], "Meeting 2");
        assert!(
            call_at(&root, &poll).unwrap()["notifications"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        // An older ledger may still carry a bundled action target. It must not
        // let dismissing one event overwrite the other event's later snooze.
        let path = root.join("omamail/calendar-reminders.json");
        let mut ledger: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let first = notices[0]["key"].as_str().unwrap();
        let second = notices[1]["key"].as_str().unwrap();
        ledger[first]["relatedKeys"] = json!([second]);
        std::fs::write(&path, serde_json::to_vec(&ledger).unwrap()).unwrap();
        call_at(
            &root,
            &json!({"operation":"snooze","now":1400000,"key":second,"minutes":5}),
        )
        .unwrap();
        call_at(
            &root,
            &json!({"operation":"dismiss","now":1400000,"key":first}),
        )
        .unwrap();
        poll["now"] = json!(1700000);
        let result = call_at(&root, &poll).unwrap();
        let notices = result["notifications"].as_array().unwrap();
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0]["eventId"], "event-2");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn claims_are_durable_and_snooze_never_replays_an_ended_event() {
        let root = fixture_root("durable");
        let candidate = json!({"key":"occurrence\n10", "occurrence":"occurrence", "start":2000000,
            "end":5600000,"due":1400000,"eventId":"event","sourceId":"calendar","accountId":"synthetic","title":"Planning"});
        let mut poll =
            json!({"operation":"poll","now":1400000,"lastCheck":1300000,"candidates":[candidate]});
        let peer_root = root.clone();
        let peer_poll = poll.clone();
        let peer = std::thread::spawn(move || call_at(&peer_root, &peer_poll).unwrap());
        let local = call_at(&root, &poll).unwrap();
        let remote = peer.join().unwrap();
        assert_eq!(
            local["notifications"].as_array().unwrap().len()
                + remote["notifications"].as_array().unwrap().len(),
            1,
            "concurrent shell and standalone claimers must not both deliver"
        );
        let first = if local["notifications"].as_array().unwrap().is_empty() {
            remote
        } else {
            local
        };
        assert_eq!(first["notifications"].as_array().unwrap().len(), 1);
        assert!(
            call_at(&root, &poll).unwrap()["notifications"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let id = first["notifications"][0]["key"].clone();
        call_at(
            &root,
            &json!({"operation":"snooze","now":1400000,"key":id,"minutes":5}),
        )
        .unwrap();
        poll["now"] = json!(1700000);
        assert_eq!(
            call_at(&root, &poll).unwrap()["notifications"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        call_at(
            &root,
            &json!({"operation":"snooze","now":1700000,"key":id,"minutes":120}),
        )
        .unwrap();
        poll["now"] = json!(8900000);
        assert!(
            call_at(&root, &poll).unwrap()["notifications"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let refused = root.join("not-created");
        assert!(
            call_at(
                &refused,
                &json!({"operation":"dismiss","now":1,"key":"../escape"})
            )
            .is_err()
        );
        assert!(!refused.exists());
        #[cfg(unix)]
        {
            let outside = root.join("outside");
            std::fs::write(&outside, b"private marker").unwrap();
            let ledger = root.join("omamail/calendar-reminders.json");
            std::fs::remove_file(&ledger).unwrap();
            std::os::unix::fs::symlink(&outside, &ledger).unwrap();
            assert!(call_at(&root, &poll).is_err());
            assert_eq!(std::fs::read(&outside).unwrap(), b"private marker");
            assert!(
                std::fs::symlink_metadata(&ledger)
                    .unwrap()
                    .file_type()
                    .is_symlink()
            );
        }
        std::fs::remove_dir_all(&root).unwrap();
    }
}
