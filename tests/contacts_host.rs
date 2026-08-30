use omamail::contacts_host::{ContactSource, ContactsError, read_contacts};

// Where the recipient completion's addresses come from when the mailbox itself
// has none to offer — a first message to somebody this account has never heard
// from. `scripts/contact-suggestions.py` reads Thunderbird's and Betterbird's
// own SQLite address books read-only, and `tests/test_contacts.py` covers what
// it finds; this covers what the window is allowed to believe about the answer.

struct Source(&'static str);
impl ContactSource for Source {
    fn read(&self) -> Result<Vec<u8>, ContactsError> {
        Ok(self.0.as_bytes().to_vec())
    }
}
struct Missing;
impl ContactSource for Missing {
    fn read(&self) -> Result<Vec<u8>, ContactsError> {
        Err(ContactsError)
    }
}

fn answer(source: &dyn ContactSource) -> serde_json::Value {
    serde_json::from_str(&read_contacts(source)).unwrap()
}

#[test]
fn reads_the_address_book_the_script_prints() {
    let value = answer(&Source(
        r#"[{"name":"Grace Hopper","email":"grace@example.test"},{"name":"","email":"morgan@example.test"}]"#,
    ));
    assert_eq!(value["ok"], serde_json::Value::Bool(true));
    assert_eq!(value["contacts"][0]["name"], "Grace Hopper");
    assert_eq!(value["contacts"][0]["email"], "grace@example.test");
    assert_eq!(value["contacts"][1]["name"], "");
}

#[test]
fn a_missing_book_is_an_empty_list_rather_than_a_message() {
    // No Thunderbird, no Python and no script at all land in the same place.
    // None of them is worth saying: the completion falls back to the senders on
    // the open mailbox, which is what it has always had.
    for source in [&Missing as &dyn ContactSource, &Source("not json")] {
        let value = answer(source);
        assert_eq!(value["ok"], serde_json::Value::Bool(false));
        assert_eq!(value["contacts"].as_array().unwrap().len(), 0);
    }
}

#[test]
fn an_entry_that_could_write_a_header_never_reaches_the_completion() {
    // Every name and address here was typed by whoever owns the address book,
    // and accepting one into a To field is one step from writing it into a
    // header — where a line break ends the header and starts another.
    let value = answer(&Source(
        r#"[{"name":"Ada\r\nBcc: stolen@example.net","email":"ada@example.test"},
            {"name":"Bad","email":"grace@example.test\nBcc: x@y.test"},
            {"name":"No address","email":"not-an-address"},
            {"name":"Fine","email":"fine@example.test"}]"#,
    ));
    let contacts = value["contacts"].as_array().unwrap();
    assert_eq!(contacts.len(), 1);
    assert_eq!(contacts[0]["email"], "fine@example.test");
}
