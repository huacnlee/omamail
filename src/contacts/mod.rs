//! Bounded, read-only contact discovery. No subprocesses or network access.
use serde_json::{Value, json};
use std::os::unix::fs::OpenOptionsExt;
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

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
fn collect(book: &mut Book, name: &str, email: &str) {
    let email = email.trim();
    if !address(email) || book.len() >= MAX_CONTACTS {
        return;
    }
    let name: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    let key = email.to_lowercase();
    if !book.contains_key(&key) || (book[&key]["name"] == "" && !name.is_empty()) {
        book.insert(key, json!({"name":name,"email":email}));
    }
}
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
fn vcard(book: &mut Book, text: &str) {
    let text = text
        .replace("\r\n", "\n")
        .replace("\n ", "")
        .replace("\n\t", "");
    let mut name = "";
    let mut emails = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some((property, value)) = line.split_once(':') else {
            continue;
        };
        match property.split(';').next().unwrap_or("") {
            "BEGIN" if value == "VCARD" => {
                name = "";
                emails.clear();
            }
            "FN" => name = value.trim(),
            "EMAIL" => emails.push(value.trim()),
            "END" if value == "VCARD" => {
                for email in emails.drain(..) {
                    collect(book, name, email)
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
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or("home_missing")?;
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let cached = std::env::var_os("XDG_CACHE_HOME")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".cache"));
    if !config.is_absolute() || !cached.is_absolute() {
        return Err("home_invalid");
    }
    Ok(discover(&home, &config, &cached))
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
    #[test]
    fn named_contact_replaces_inferred_empty_name() {
        let mut b = Book::new();
        collect(&mut b, "", "A@example.com");
        collect(&mut b, "Alice", "a@example.com");
        assert_eq!(b.len(), 1);
        assert_eq!(b["a@example.com"]["name"], "Alice");
    }
}
