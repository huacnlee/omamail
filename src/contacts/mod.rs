//! Bounded, read-only contact discovery. No subprocesses or network access.
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

mod dav;
mod google;

const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_CONTACTS: usize = 10000;
type Book = BTreeMap<String, Value>;

fn address(s: &str) -> bool {
    let Some((local, domain)) = s.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !local
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || "@<>,;\"\\".contains(c))
        && domain.split('.').count() >= 2
        && domain
            .split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        && domain
            .rsplit('.')
            .next()
            .is_some_and(|p| p.len() >= 2 && p.bytes().all(|b| b.is_ascii_alphabetic()))
}
// RFC 5321 bounds a usable address at 254 octets; a longer name is cut
// rather than let a server hand over a megabyte to draw.
const MAX_ADDRESS: usize = 254;
const MAX_NAME: usize = 256;

fn collect(book: &mut Book, name: &str, email: &str) {
    let email = email.trim();
    if email.len() > MAX_ADDRESS || !address(email) || book.len() >= MAX_CONTACTS {
        return;
    }
    let name: String = name
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME)
        .collect();
    let key = email.to_lowercase();
    if !book.contains_key(&key) || (book[&key]["name"] == "" && !name.is_empty()) {
        book.insert(key, json!({"name":name,"email":email}));
    }
}
#[cfg(unix)]
fn read(path: &Path) -> Option<String> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MAX_FILE).then(|| String::from_utf8_lossy(&bytes).into_owned())
}
fn json_book(book: &mut Book, raw: &Value) {
    if let Some(items) = raw.as_array() {
        for item in items {
            collect(
                book,
                item["name"].as_str().unwrap_or(""),
                item["email"].as_str().unwrap_or(""),
            );
        }
    } else if let Some(items) = raw.as_object() {
        for (key, value) in items {
            if address(key.trim()) {
                collect(book, value.as_str().unwrap_or(""), key);
            } else if let Some(email) = value.as_str() {
                collect(book, key, email);
            }
        }
    }
}
/// A text value with RFC 6350 §3.4 escapes undone; a line break is a space.
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.trim().chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push(' '),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// "Given Family" from a structured `N` value (Family;Given;Additional;...).
fn structured_name(value: &str) -> String {
    let parts: Vec<String> = value.split(';').map(unescape).collect();
    let given = parts.get(1).map(String::as_str).unwrap_or("");
    let family = parts.first().map(String::as_str).unwrap_or("");
    [given, family]
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
}

fn vcard(book: &mut Book, text: &str) {
    let text = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace("\n ", "")
        .replace("\n\t", "");
    let mut name = String::new();
    let mut structured = String::new();
    let mut emails = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((head, value)) = line.split_once(':') else {
            continue;
        };
        // `item1.EMAIL;TYPE=work`: a group before the name, parameters after.
        let property = head.split(';').next().unwrap_or("");
        let property = property.rsplit('.').next().unwrap_or("");
        match property.to_ascii_uppercase().as_str() {
            "BEGIN" if value.trim().eq_ignore_ascii_case("VCARD") => {
                name.clear();
                structured.clear();
                emails.clear();
            }
            "FN" => name = unescape(value),
            "N" => structured = structured_name(value),
            "EMAIL" => {
                let email = value.trim();
                let email = email
                    .get(..7)
                    .filter(|scheme| scheme.eq_ignore_ascii_case("mailto:"))
                    .map_or(email, |_| &email[7..]);
                emails.push(email.to_owned());
            }
            "END" if value.trim().eq_ignore_ascii_case("VCARD") => {
                let shown = if name.is_empty() { &structured } else { &name };
                for email in emails.drain(..) {
                    collect(book, shown, &email)
                }
            }
            _ => (),
        }
    }
}
fn paths(dir: &Path) -> Vec<PathBuf> {
    let mut result: Vec<_> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .take(2000)
        .map(|e| e.path())
        .collect();
    result.sort();
    result
}
fn cache(book: &mut Book, dir: &Path) {
    let mut harvested = 0;
    for file in paths(dir).into_iter().filter(|p| {
        p.file_name().is_some_and(|n| {
            n.to_string_lossy().starts_with("account-") && n.to_string_lossy().ends_with(".json")
        })
    }) {
        let Some(raw) = read(&file).and_then(|s| serde_json::from_str::<Value>(&s).ok()) else {
            continue;
        };
        let Some(queries) = raw["queries"].as_object() else {
            continue;
        };
        for entry in queries.values() {
            let rows = entry["summaries"]
                .as_array()
                .filter(|r| !r.is_empty())
                .or_else(|| entry["messages"].as_array());
            for row in rows.into_iter().flatten() {
                let mut people = vec![&row["from"], &row["replyTo"]];
                for field in ["to", "cc"] {
                    if let Some(items) = row[field].as_array().filter(|a| a.len() <= 5) {
                        people.extend(items)
                    }
                }
                for person in people {
                    let email = person["email"].as_str().unwrap_or("");
                    let name = person["name"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .or_else(|| person["display"].as_str())
                        .unwrap_or("");
                    if address(email) {
                        if harvested >= 2000 {
                            return;
                        }
                        harvested += 1;
                        collect(
                            book,
                            if email.split('@').next() == Some(name) {
                                ""
                            } else {
                                name
                            },
                            email,
                        )
                    }
                }
            }
        }
    }
}
fn thunderbird(book: &mut Book, root: &Path) {
    let mut profiles = paths(root);
    profiles.extend(paths(&root.join("Profiles")));
    if let Some(ini) = read(&root.join("profiles.ini")) {
        let mut section = false;
        let mut path = None;
        let mut relative = true;
        for line in ini.lines().chain(std::iter::once("[end]")) {
            let line = line.trim();
            if line.starts_with('[') {
                if section && let Some(p) = path.take() {
                    let p = PathBuf::from(p);
                    profiles.push(if relative { root.join(p) } else { p });
                }
                section = line.to_lowercase().starts_with("[profile");
                relative = true;
            } else if let Some(v) = line.strip_prefix("Path=") {
                path = Some(v.to_string())
            } else if line == "IsRelative=0" {
                relative = false
            }
        }
    }
    profiles.sort();
    profiles.dedup();
    for profile in profiles {
        for db in paths(&profile).into_iter().filter(|p| {
            p.file_name().is_some_and(|n| {
                let n = n.to_string_lossy();
                (n.starts_with("abook") || n.starts_with("history")) && n.ends_with(".sqlite")
            })
        }) {
            let Ok(connection) = rusqlite::Connection::open_with_flags(
                db,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            ) else {
                continue;
            };
            let _ = connection.busy_timeout(std::time::Duration::from_millis(200));
            let Ok(mut query)=connection.prepare("SELECT MAX(CASE WHEN name='DisplayName' THEN value ELSE '' END), MAX(CASE WHEN name='PrimaryEmail' THEN value ELSE '' END), MAX(CASE WHEN name='SecondEmail' THEN value ELSE '' END) FROM properties GROUP BY card LIMIT 10000") else {continue};
            let Ok(rows) = query.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            }) else {
                continue;
            };
            for (name, email, second) in rows.flatten() {
                collect(book, &name, &email);
                collect(book, &name, &second)
            }
        }
    }
}
pub fn suggest() -> Result<Value, &'static str> {
    let dirs = crate::platform::dirs::AppDirs::discover()?;
    Ok(discover(
        &crate::platform::dirs::AppDirs::home()?,
        &dirs.config,
        &dirs.cache,
    ))
}

fn discover(home: &Path, config: &Path, cached: &Path) -> Value {
    let mut book = Book::new();
    for name in [".thunderbird", ".betterbird"] {
        thunderbird(&mut book, &home.join(name))
    }
    cache(&mut book, &cached.join("omamail"));
    if let Some(raw) = read(&config.join("omamail/contacts.json"))
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    {
        json_book(&mut book, &raw)
    }
    if let Some(text) = read(&config.join("omamail/contacts.vcf")) {
        vcard(&mut book, &text)
    }
    sorted(book)
}

/// A Gmail account's Google Contacts, through the same address checks and
/// ordering as the local book: `{granted, contacts}`.
pub async fn suggest_google(token: &str) -> Result<Value, &'static str> {
    let fetched = google::fetch(token).await?;
    let mut book = Book::new();
    json_book(&mut book, &fetched["contacts"]);
    Ok(json!({"granted":fetched["granted"],"contacts":sorted(book)}))
}

/// The address books on an IMAP mailbox's own server; see `dav.rs`.
pub async fn mailbox_books(params: &Value) -> Result<Value, &'static str> {
    dav::call(params).await
}

fn sorted(book: Book) -> Value {
    let mut values: Vec<_> = book.into_values().collect();
    values.sort_by_key(|v| {
        v["name"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(v["email"].as_str().unwrap_or(""))
            .to_lowercase()
    });
    json!(values)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_real_sqlite_and_cache_without_writing_sources() {
        let root =
            std::env::temp_dir().join(format!("omamail-contacts-test-{}", std::process::id()));
        let profile = root.join(".thunderbird/profile");
        fs::create_dir_all(&profile).unwrap();
        let database = profile.join("abook.sqlite");
        {
            let db = rusqlite::Connection::open(&database).unwrap();
            db.execute_batch("CREATE TABLE properties(card TEXT,name TEXT,value TEXT); INSERT INTO properties VALUES ('1','DisplayName','Alice'),('1','PrimaryEmail','alice@example.com');").unwrap();
        }
        let before = fs::read(&database).unwrap();
        fs::create_dir_all(root.join("cache/omamail")).unwrap();
        let bulk: Vec<_> = (0..6)
            .map(|n| json!({"email":format!("bulk{n}@example.com")}))
            .collect();
        fs::write(root.join("cache/omamail/account-a.json"),json!({"queries":{"inbox":{"summaries":[{"from":{"email":"bob@example.com","name":"bob"},"bcc":[{"email":"hidden@example.com"}],"to":bulk}]}}}).to_string()).unwrap();
        let result = discover(&root, &root.join("config"), &root.join("cache"));
        assert_eq!(result.as_array().unwrap().len(), 2);
        assert_eq!(result[0]["name"], "Alice");
        assert_eq!(result[1]["name"], "");
        assert_eq!(before, fs::read(&database).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn validates_addresses_without_coercing_objects() {
        let mut b = Book::new();
        json_book(
            &mut b,
            &json!({"contacts":[{"email":"a@example.com"}],"Jane":"jane@example.com","bad":"a@example.com\nInjected"}),
        );
        assert_eq!(b.len(), 1);
        assert!(b.contains_key("jane@example.com"));
    }
    #[test]
    fn unfolds_cards_and_skips_malformed_lines() {
        let mut b = Book::new();
        vcard(
            &mut b,
            "BEGIN:VCARD\nFN:Jane\nEMAIL broken\nEMAIL:a@exam\n ple.com\nEND:VCARD\n",
        );
        assert_eq!(b["a@example.com"]["name"], "Jane");
    }
    // Cards as CardDAV servers hand them back: CRLF lines, folded values,
    // Apple's grouped properties, lower-case names, escapes and cards that
    // carry only a structured name.
    #[test]
    fn reads_server_cards_with_groups_escapes_and_structured_names() {
        let mut b = Book::new();
        vcard(
            &mut b,
            "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Doe\\, Jane\r\nitem1.EMAIL;type=INTERNET;type=pref:jane@ex\r\n ample.com\r\nitem1.X-ABLabel:work\r\nEND:VCARD\r\n\
             begin:vcard\nn:Smith;John;;;\nemail:MAILTO:john@example.com\nend:vcard\n\
             BEGIN:VCARD\nFN:\nN:Only;;;;\nEMAIL:only@example.com\nEMAIL:not an address\nEND:VCARD\n",
        );
        assert_eq!(b["jane@example.com"]["name"], "Doe, Jane");
        assert_eq!(b["john@example.com"]["name"], "John Smith");
        assert_eq!(b["only@example.com"]["name"], "Only");
        assert_eq!(b.len(), 3);
    }

    // Server-supplied lengths are untrusted: an address longer than any
    // mailbox can have is dropped and a name is cut to a drawable length.
    #[test]
    fn overlong_addresses_are_dropped_and_names_cut() {
        let mut b = Book::new();
        let long_local = "a".repeat(250);
        collect(
            &mut b,
            &"N".repeat(5000),
            &format!("{long_local}@example.com"),
        );
        collect(&mut b, &"N".repeat(5000), "ok@example.com");
        assert_eq!(b.len(), 1);
        assert_eq!(
            b["ok@example.com"]["name"].as_str().unwrap().len(),
            MAX_NAME
        );
    }

    #[test]
    fn named_contact_replaces_inferred_empty_name() {
        let mut b = Book::new();
        collect(&mut b, "", "A@example.com");
        collect(&mut b, "Alice", "a@example.com");
        assert_eq!(b.len(), 1);
        assert_eq!(b["a@example.com"]["name"], "Alice");
    }
}

#[cfg(windows)]
fn read(path: &Path) -> Option<String> {
    let file = crate::platform::private_fs::open_external(path).ok()?;
    if file.metadata().ok()?.len() > MAX_FILE {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MAX_FILE).then(|| String::from_utf8_lossy(&bytes).into_owned())
}
