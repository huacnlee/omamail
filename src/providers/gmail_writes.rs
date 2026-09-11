//! Gmail mutation planning and bounded draft lookup. No mutation is retried.
use super::*;
use reqwest::Method;

pub(super) fn supports(method: &str) -> bool {
    matches!(
        method,
        "gmail.modify"
            | "gmail.batchModify"
            | "gmail.createLabel"
            | "gmail.renameLabel"
            | "gmail.deleteLabel"
            | "gmail.trash"
            | "gmail.untrash"
            | "gmail.send"
            | "gmail.saveDraft"
            | "gmail.updateDraft"
            | "gmail.deleteDraft"
    )
}

fn strings(params: &Value, key: &str, max: usize) -> Result<Value, &'static str> {
    let values = params
        .get(key)
        .and_then(Value::as_array)
        .ok_or("invalid_params")?;
    if values.len() > max {
        return Err("invalid_params");
    }
    for value in values {
        let s = value.as_str().ok_or("invalid_params")?;
        if s.is_empty() || s.len() > 8192 || s.chars().any(char::is_control) {
            return Err("invalid_params");
        }
    }
    Ok(Value::Array(values.clone()))
}

fn message(params: &Value) -> Result<Value, &'static str> {
    let raw = params
        .get("raw")
        .and_then(Value::as_str)
        .ok_or("invalid_params")?;
    if raw.is_empty()
        || raw.len() > 48 * 1024 * 1024
        || !raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_=".contains(&b))
    {
        return Err("invalid_params");
    }
    let mut message = json!({"raw":raw});
    let thread = field(params, "threadId", false)?;
    if !thread.is_empty() {
        message["threadId"] = json!(thread);
    }
    Ok(message)
}

struct Plan {
    method: Method,
    path: Vec<String>,
    body: Option<Value>,
    draft_message: Option<String>,
}
fn plan(method: &str, params: &Value) -> Result<Plan, &'static str> {
    let allowed: &[&str] = match method {
        "gmail.modify" => &["accountId", "id", "addLabelIds", "removeLabelIds"],
        "gmail.batchModify" => &["accountId", "ids", "addLabelIds", "removeLabelIds"],
        "gmail.createLabel" => &["accountId", "name"],
        "gmail.renameLabel" => &["accountId", "id", "name"],
        "gmail.deleteLabel" | "gmail.trash" | "gmail.untrash" | "gmail.deleteDraft" => {
            &["accountId", "id"]
        }
        "gmail.send" | "gmail.saveDraft" => &["accountId", "raw", "threadId"],
        "gmail.updateDraft" => &["accountId", "id", "raw", "threadId"],
        _ => return Err("unknown_method"),
    };
    if params
        .as_object()
        .ok_or("invalid_params")?
        .keys()
        .any(|k| !allowed.contains(&k.as_str()))
    {
        return Err("invalid_params");
    }
    let mut result = Plan {
        method: Method::POST,
        path: vec![],
        body: None,
        draft_message: None,
    };
    match method {
        "gmail.modify" | "gmail.batchModify" => {
            let mut body = json!({"addLabelIds":strings(params,"addLabelIds",100)?,"removeLabelIds":strings(params,"removeLabelIds",100)?});
            result.path = if method == "gmail.modify" {
                vec![
                    "messages".into(),
                    field(params, "id", true)?.into(),
                    "modify".into(),
                ]
            } else {
                body["ids"] = strings(params, "ids", 1000)?;
                if body["ids"].as_array().unwrap().is_empty() {
                    return Err("invalid_params");
                }
                vec!["messages".into(), "batchModify".into()]
            };
            result.body = Some(body);
        }
        "gmail.createLabel" => {
            result.path = vec!["labels".into()];
            result.body = Some(
                json!({"name":field(params,"name",true)?,"labelListVisibility":"labelShow","messageListVisibility":"show"}),
            );
        }
        "gmail.renameLabel" | "gmail.deleteLabel" => {
            result.path = vec!["labels".into(), field(params, "id", true)?.into()];
            result.method = if method == "gmail.renameLabel" {
                Method::PATCH
            } else {
                Method::DELETE
            };
            if method == "gmail.renameLabel" {
                result.body = Some(json!({"name":field(params,"name",true)?}));
            }
        }
        "gmail.trash" | "gmail.untrash" => {
            result.path = vec![
                "messages".into(),
                field(params, "id", true)?.into(),
                method.strip_prefix("gmail.").unwrap().into(),
            ]
        }
        "gmail.send" => {
            result.path = vec!["messages".into(), "send".into()];
            result.body = Some(message(params)?);
        }
        "gmail.saveDraft" => {
            result.path = vec!["drafts".into()];
            result.body = Some(json!({"message":message(params)?}));
        }
        "gmail.updateDraft" | "gmail.deleteDraft" => {
            result.draft_message = Some(field(params, "id", true)?.into());
            result.method = if method == "gmail.updateDraft" {
                Method::PUT
            } else {
                Method::DELETE
            };
            if method == "gmail.updateDraft" {
                result.body = Some(json!({"message":message(params)?}));
            }
        }
        _ => unreachable!(),
    }
    // Validate path spelling before reading credentials, including dot segments.
    for part in &result.path {
        if part == "." || part == ".." {
            return Err("invalid_params");
        }
    }
    Ok(result)
}

async fn resolve_draft<F, Fut>(message: &str, mut fetch: F) -> Result<Option<String>, &'static str>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<Value, &'static str>>,
{
    let mut seen = std::collections::HashSet::new();
    let mut cursor = String::new();
    for _ in 0..100 {
        let page = fetch(cursor).await?;
        let drafts = match page.get("drafts") {
            None => &[][..],
            Some(Value::Array(drafts)) => drafts.as_slice(),
            _ => return Err("gmail_invalid_response"),
        };
        for draft in drafts {
            if draft["message"]["id"] == message {
                let id = draft["id"]
                    .as_str()
                    .filter(|id| {
                        !id.is_empty()
                            && *id != "."
                            && *id != ".."
                            && id.len() <= 8192
                            && !id.chars().any(char::is_control)
                    })
                    .ok_or("gmail_invalid_response")?;
                return Ok(Some(id.into()));
            }
        }
        cursor = match page.get("nextPageToken") {
            None => String::new(),
            Some(Value::String(value)) => value.clone(),
            _ => return Err("gmail_invalid_response"),
        };
        if cursor.is_empty() {
            return Ok(None);
        }
        if !seen.insert(cursor.clone()) {
            return Err("gmail_invalid_response");
        }
    }
    Err("gmail_invalid_response")
}

impl Session {
    pub(super) async fn write_call(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<Value, &'static str> {
        let mut plan = plan(method, params)?;
        let account = field(params, "accountId", true)?.to_lowercase();
        let accounts = tokio::task::spawn_blocking(crate::account::list)
            .await
            .map_err(|_| "session_failed")??;
        if !accounts["accounts"].as_array().is_some_and(|entries| {
            entries
                .iter()
                .any(|a| a["id"] == account && a["provider"] == "gmail")
        }) {
            return Err("gmail_account_unknown");
        }
        let session = self.account(&account)?;
        let token = session
            .token_with(|| async {
                let (client, refresh) = tokio::task::spawn_blocking(move || {
                    let client = gmail_credentials::read_for_account(&account)?;
                    let refresh = gmail_credentials::lookup_refresh_token(&client, &account)?;
                    Ok::<_, &'static str>((client, refresh))
                })
                .await
                .map_err(|_| "session_failed")??;
                gmail_http::refresh(&client.client_id, &client.client_secret, &refresh).await
            })
            .await?;
        if let Some(message) = plan.draft_message {
            let found = resolve_draft(&message, |cursor| async {
                session.check()?;
                gmail_http::get(
                    &["drafts"],
                    &[
                        ("maxResults".into(), "500".into()),
                        ("pageToken".into(), cursor),
                    ],
                    &token.value,
                )
                .await
            })
            .await?;
            let Some(id) = found else {
                return if method == "gmail.deleteDraft" {
                    Ok(json!({}))
                } else {
                    Err("gmail_draft_missing")
                };
            };
            plan.path = vec!["drafts".into(), id];
        }
        session.check()?;
        let path: Vec<&str> = plan.path.iter().map(String::as_str).collect();
        let answer = gmail_http::write(plan.method, &path, plan.body.as_ref(), &token.value).await;
        if answer == Err("gmail_unauthorized") {
            session.reject(&token).await?;
        }
        // Delivery suppression after logout does not pretend a dispatched mutation was undone.
        session.check()?;
        answer
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_every_mutation_before_authentication() {
        for method in [
            "gmail.modify",
            "gmail.batchModify",
            "gmail.createLabel",
            "gmail.renameLabel",
            "gmail.deleteLabel",
            "gmail.trash",
            "gmail.untrash",
            "gmail.send",
            "gmail.saveDraft",
            "gmail.updateDraft",
            "gmail.deleteDraft",
        ] {
            assert!(plan(method, &json!({"unexpected":true})).is_err());
        }
        assert!(
            plan(
                "gmail.modify",
                &json!({"id":"a","addLabelIds":["x","bad\n"],"removeLabelIds":[]})
            )
            .is_err()
        );
        assert!(plan("gmail.send", &json!({"raw":"bad\r\n"})).is_err());
        assert!(plan("gmail.trash", &json!({"id":".."})).is_err());
    }
    #[test]
    fn preserves_message_bytes_and_mutation_semantics() {
        let send = plan("gmail.send", &json!({"raw":"SGVsbG8","threadId":"t"})).unwrap();
        assert_eq!(send.body, Some(json!({"raw":"SGVsbG8","threadId":"t"})));
        let rename = plan(
            "gmail.renameLabel",
            &json!({"id":"label","name":"日本語/Work \\\""}),
        )
        .unwrap();
        assert_eq!(rename.method, Method::PATCH);
        assert_eq!(rename.path, vec!["labels", "label"]);
        let update = plan("gmail.updateDraft", &json!({"id":"message","raw":"YQ"})).unwrap();
        assert_eq!(update.method, Method::PUT);
        assert_eq!(update.draft_message.as_deref(), Some("message"));
    }
}

#[cfg(test)]
mod draft_tests {
    use super::*;
    #[tokio::test]
    async fn resolves_message_to_draft_across_pages_and_rejects_cycles() {
        let mut cursors = Vec::new();
        let id = resolve_draft("message", |cursor| {
            cursors.push(cursor.clone());
            std::future::ready(Ok(if cursor.is_empty() {
                json!({"drafts":[{"id":"wrong","message":{"id":"other"}}],"nextPageToken":"next"})
            } else {
                json!({"drafts":[{"id":"draft-id","message":{"id":"message"}}]})
            }))
        })
        .await
        .unwrap();
        assert_eq!(id.as_deref(), Some("draft-id"));
        assert_eq!(cursors, vec!["", "next"]);
        let mut count = 0;
        assert_eq!(
            resolve_draft("absent", |_| {
                count += 1;
                std::future::ready(Ok(json!({"nextPageToken":"loop"})))
            })
            .await,
            Err("gmail_invalid_response")
        );
        assert_eq!(count, 2);
        assert_eq!(
            resolve_draft("absent", |_| std::future::ready(Ok(json!({})))).await,
            Ok(None)
        );
        assert_eq!(
            resolve_draft("message", |_| std::future::ready(Ok(
                json!({"drafts":[{"id":"..","message":{"id":"message"}}]})
            )))
            .await,
            Err("gmail_invalid_response")
        );
    }
}
