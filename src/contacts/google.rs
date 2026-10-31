//! Google Contacts for recipient suggestions: the account's saved contacts and
//! its "Other contacts" (people it has written to). Read-only, bounded, and
//! optional: a grant without the contacts scopes yields an empty list rather
//! than an error, so mail keeps working for accounts that declined them.
use reqwest::{Client, Url};
use serde_json::{Value, json};
use std::{sync::OnceLock, time::Duration};

const RESPONSE_LIMIT: usize = 8 * 1024 * 1024;
const TOTAL_LIMIT: usize = 16 * 1024 * 1024; // across every page of both listings
const DEADLINE: Duration = Duration::from_secs(60);
const MAX_CONTACTS: usize = 10000;
const MAX_PAGES: usize = 50;
static CLIENT: OnceLock<Result<Client, &'static str>> = OnceLock::new();

fn client() -> Result<&'static Client, &'static str> {
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .https_only(true)
                .hickory_dns(true)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(20))
                .build()
                .map_err(|_| "contacts_network_failed")
        })
        .as_ref()
        .map_err(|e| *e)
}

async fn body(mut response: reqwest::Response) -> Result<String, &'static str> {
    if response
        .content_length()
        .is_some_and(|size| size > RESPONSE_LIMIT as u64)
    {
        return Err("contacts_response_too_large");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "contacts_network_failed")?
    {
        if chunk.len() > RESPONSE_LIMIT - bytes.len() {
            return Err("contacts_response_too_large");
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "contacts_invalid_response")
}

/// Name and addresses of one People API person, as `{name, email}` rows.
fn rows(person: &Value, out: &mut Vec<Value>) {
    let name = person["names"]
        .as_array()
        .and_then(|names| names.first())
        .and_then(|name| name["displayName"].as_str())
        .unwrap_or("");
    for address in person["emailAddresses"].as_array().into_iter().flatten() {
        if let Some(email) = address["value"].as_str()
            && out.len() < MAX_CONTACTS
        {
            out.push(json!({"name":name,"email":email}));
        }
    }
}

/// Every page of one listing. `Ok(false)` when the grant lacks its scope.
async fn listing(
    token: &str,
    url: &str,
    query: &[(&str, &str)],
    key: &str,
    out: &mut Vec<Value>,
    bytes: &mut usize,
    each: fn(&Value, &mut Vec<Value>),
) -> Result<bool, &'static str> {
    let origin = Url::parse(url).map_err(|_| "contacts_network_failed")?;
    pages(key, out, bytes, each, |page_token| {
        let mut url = origin.clone();
        url.query_pairs_mut().extend_pairs(query);
        if !page_token.is_empty() {
            url.query_pairs_mut().append_pair("pageToken", &page_token);
        }
        async move {
            let response = client()?
                .get(url)
                .bearer_auth(token)
                .send()
                .await
                .map_err(|_| "contacts_network_failed")?;
            if !granted(response.status().as_u16())? {
                return Ok(None);
            }
            body(response).await.map(Some)
        }
    })
    .await
}

/// Whether an answer carries contacts; a 403 is a scope not granted, or the
/// People API off in the client's Cloud project: nothing broken.
fn granted(status: u16) -> Result<bool, &'static str> {
    match status {
        401 => Err("contacts_auth_refused"),
        403 => Ok(false),
        status if !(200..300).contains(&status) => Err("contacts_request_failed"),
        _ => Ok(true),
    }
}

/// The paging of one listing: `fetch` answers the body of the page with that
/// token (empty for the first), or `None` when the grant lacks the scope.
async fn pages<F, Fut>(
    key: &str,
    out: &mut Vec<Value>,
    bytes: &mut usize,
    each: fn(&Value, &mut Vec<Value>),
    mut fetch: F,
) -> Result<bool, &'static str>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<Option<String>, &'static str>>,
{
    let mut page_token = String::new();
    for _ in 0..MAX_PAGES {
        let Some(text) = fetch(page_token.clone()).await? else {
            return Ok(false);
        };
        *bytes += text.len();
        if *bytes > TOTAL_LIMIT {
            return Err("contacts_response_too_large");
        }
        let payload: Value =
            serde_json::from_str(&text).map_err(|_| "contacts_invalid_response")?;
        for person in payload[key].as_array().into_iter().flatten() {
            each(person, out);
        }
        match payload["nextPageToken"].as_str() {
            Some(next) if !next.is_empty() && next != page_token && out.len() < MAX_CONTACTS => {
                page_token = next.to_owned()
            }
            _ => return Ok(true),
        }
    }
    Ok(true)
}

pub async fn fetch(token: &str) -> Result<Value, &'static str> {
    tokio::time::timeout(DEADLINE, fetch_all(token))
        .await
        .map_err(|_| "contacts_timeout")?
}

async fn fetch_all(token: &str) -> Result<Value, &'static str> {
    let mut out = Vec::new();
    let mut bytes = 0;
    let saved = listing(
        token,
        "https://people.googleapis.com/v1/people/me/connections",
        &[
            ("personFields", "names,emailAddresses"),
            ("pageSize", "1000"),
        ],
        "connections",
        &mut out,
        &mut bytes,
        rows,
    )
    .await?;
    let other = listing(
        token,
        "https://people.googleapis.com/v1/otherContacts",
        &[("readMask", "names,emailAddresses"), ("pageSize", "1000")],
        "otherContacts",
        &mut out,
        &mut bytes,
        rows,
    )
    .await?;
    Ok(json!({"granted": saved || other, "contacts": out}))
}

fn text(value: &Value, max: usize) -> String {
    value
        .as_str()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// `{value, type}` entries of one People API field, bounded.
fn entries(list: &Value, max: usize) -> Vec<Value> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let value = text(&entry["value"], 320);
            (!value.is_empty())
                .then(|| json!({"value": value, "type": text(&entry["formattedType"], 40)}))
        })
        .take(max)
        .collect()
}

/// One person as the address book shows them. Only a photo Google serves from
/// its own content host is kept, so the window never asks another host for it.
fn person(person: &Value, saved: bool) -> Option<Value> {
    let emails = entries(&person["emailAddresses"], 20);
    let phones = entries(&person["phoneNumbers"], 20);
    let name = person["names"]
        .as_array()
        .and_then(|names| names.first())
        .map(|name| text(&name["displayName"], 200))
        .unwrap_or_default();
    if emails.is_empty() && phones.is_empty() {
        return None;
    }
    let organization = person["organizations"].as_array().and_then(|o| o.first());
    let photo = person["photos"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|photo| photo["default"] != true)
        .map(|photo| text(&photo["url"], 2048))
        .filter(|url| {
            Url::parse(url).is_ok_and(|url| {
                url.scheme() == "https"
                    && url
                        .host_str()
                        .is_some_and(|host| host.ends_with(".googleusercontent.com"))
            })
        })
        .unwrap_or_default();
    Some(json!({
        "id": text(&person["resourceName"], 200),
        "name": name,
        "emails": emails,
        "phones": phones,
        "organization": organization.map(|o| text(&o["name"], 200)).unwrap_or_default(),
        "title": organization.map(|o| text(&o["title"], 200)).unwrap_or_default(),
        "photo": photo,
        "saved": saved,
    }))
}

fn saved_person(value: &Value, out: &mut Vec<Value>) {
    if out.len() < MAX_CONTACTS
        && let Some(row) = person(value, true)
    {
        out.push(row)
    }
}

fn other_person(value: &Value, out: &mut Vec<Value>) {
    if out.len() < MAX_CONTACTS
        && let Some(row) = person(value, false)
    {
        out.push(row)
    }
}

/// The whole address book: saved contacts with their phones, organisation and
/// photo, then the people the account has written to ("Other contacts").
pub async fn people(token: &str) -> Result<Value, &'static str> {
    tokio::time::timeout(DEADLINE, people_all(token))
        .await
        .map_err(|_| "contacts_timeout")?
}

async fn people_all(token: &str) -> Result<Value, &'static str> {
    let mut out = Vec::new();
    let mut bytes = 0;
    let saved = listing(
        token,
        "https://people.googleapis.com/v1/people/me/connections",
        &[
            (
                "personFields",
                "names,emailAddresses,phoneNumbers,organizations,photos",
            ),
            ("pageSize", "1000"),
        ],
        "connections",
        &mut out,
        &mut bytes,
        saved_person,
    )
    .await?;
    let other = listing(
        token,
        "https://people.googleapis.com/v1/otherContacts",
        &[
            ("readMask", "names,emailAddresses,phoneNumbers"),
            ("pageSize", "1000"),
        ],
        "otherContacts",
        &mut out,
        &mut bytes,
        other_person,
    )
    .await?;
    Ok(json!({"granted": saved || other, "people": out}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_person_keeps_phones_organisation_and_a_google_photo_only() {
        let row = person(
            &json!({"resourceName":"people/c1","names":[{"displayName":"Ada"}],
                "emailAddresses":[{"value":"ada@example.com","formattedType":"Work"}],
                "phoneNumbers":[{"value":"+32 470 00 00 00","formattedType":"Mobile"},{"value":""}],
                "organizations":[{"name":"Analytical","title":"Engineer"}],
                "photos":[{"url":"https://lh3.googleusercontent.com/a/x"}]}),
            true,
        )
        .unwrap();
        assert_eq!(row["id"], "people/c1");
        assert_eq!(
            row["emails"],
            json!([{"value":"ada@example.com","type":"Work"}])
        );
        assert_eq!(
            row["phones"],
            json!([{"value":"+32 470 00 00 00","type":"Mobile"}])
        );
        assert_eq!(row["organization"], "Analytical");
        assert_eq!(row["title"], "Engineer");
        assert_eq!(row["photo"], "https://lh3.googleusercontent.com/a/x");
        let elsewhere = person(
            &json!({"emailAddresses":[{"value":"b@example.com"}],
                "photos":[{"url":"https://tracker.example/p.png"}]}),
            false,
        )
        .unwrap();
        assert_eq!(elsewhere["photo"], "");
        assert_eq!(elsewhere["saved"], false);
        assert!(person(&json!({"names":[{"displayName":"Nobody"}]}), true).is_none());
    }

    #[test]
    fn rows_take_the_display_name_and_every_address() {
        let mut out = Vec::new();
        rows(
            &json!({"names":[{"displayName":"Ada Lovelace"}],
                    "emailAddresses":[{"value":"ada@example.com"},{"value":"ada@work.example"}]}),
            &mut out,
        );
        rows(
            &json!({"emailAddresses":[{"value":"nameless@example.com"}]}),
            &mut out,
        );
        rows(&json!({"names":[{"displayName":"No Mail"}]}), &mut out);
        assert_eq!(
            out,
            vec![
                json!({"name":"Ada Lovelace","email":"ada@example.com"}),
                json!({"name":"Ada Lovelace","email":"ada@work.example"}),
                json!({"name":"","email":"nameless@example.com"}),
            ]
        );
    }
    fn page(people: usize, next: &str) -> String {
        let person =
            json!({"names":[{"displayName":"P"}],"emailAddresses":[{"value":"p@example.com"}]});
        json!({"connections": vec![person; people], "nextPageToken": next}).to_string()
    }

    #[tokio::test]
    async fn pages_follow_tokens_and_stop_on_a_repeat() {
        let (mut out, mut bytes, mut asked) = (Vec::new(), 0, Vec::new());
        let answers = [page(2, "b"), page(1, "b"), page(5, "c")];
        let granted = pages("connections", &mut out, &mut bytes, rows, |token| {
            let answer = answers[asked.len()].clone();
            asked.push(token);
            async move { Ok(Some(answer)) }
        })
        .await;
        assert_eq!(granted, Ok(true));
        assert_eq!(
            asked,
            ["", "b"],
            "a token handed out twice ends the listing"
        );
        assert_eq!(out.len(), 3);
    }

    #[tokio::test]
    async fn a_missing_scope_is_an_empty_listing_and_errors_stay_errors() {
        let mut out = Vec::new();
        let none = pages("connections", &mut out, &mut 0, rows, |_| async {
            Ok(None)
        })
        .await;
        assert_eq!((none, out.len()), (Ok(false), 0));
        assert_eq!(granted(403), Ok(false));
        assert_eq!(granted(200), Ok(true));
        assert_eq!(granted(401), Err("contacts_auth_refused"));
        assert_eq!(granted(500), Err("contacts_request_failed"));
        assert_eq!(granted(429), Err("contacts_request_failed"));
        let bad = pages("connections", &mut out, &mut 0, rows, |_| async {
            Ok(Some("not json".to_owned()))
        })
        .await;
        assert_eq!(bad, Err("contacts_invalid_response"));
    }

    #[tokio::test]
    async fn pages_are_bounded_in_contacts_bytes_and_calls() {
        let (mut out, mut calls) = (Vec::new(), 0);
        let full = pages("connections", &mut out, &mut 0, rows, |_| {
            calls += 1;
            let next = format!("p{calls}");
            async move { Ok(Some(page(1000, &next))) }
        })
        .await;
        assert_eq!(full, Ok(true));
        assert_eq!((out.len(), calls), (MAX_CONTACTS, MAX_CONTACTS / 1000));

        let (mut out, mut bytes, mut calls) = (Vec::new(), 0, 0);
        let endless = pages("connections", &mut out, &mut bytes, rows, |_| {
            calls += 1;
            let next = format!("p{calls}");
            async move { Ok(Some(page(0, &next))) }
        })
        .await;
        assert_eq!((endless, calls), (Ok(true), MAX_PAGES));

        let mut bytes = TOTAL_LIMIT - 10;
        let big = pages(
            "connections",
            &mut Vec::new(),
            &mut bytes,
            rows,
            |_| async { Ok(Some(page(1, ""))) },
        )
        .await;
        assert_eq!(big, Err("contacts_response_too_large"));
    }
}
