use super::mailbox::{Context, SUBMISSION, Snapshot, argument, fill, ids};
use super::query::string;
use super::*;
use serde_json::Map;
fn has(values: &Value, wanted: &str) -> bool {
    values
        .as_array()
        .into_iter()
        .flatten()
        .any(|v| string(v).eq_ignore_ascii_case(wanted))
}
fn patch(
    added: &Value,
    removed: &Value,
    roles: &Value,
    membership: Option<&Value>,
) -> Result<Value, &'static str> {
    let mut result = Map::new();
    for (label, key, on, off) in [
        ("UNREAD", "keywords/$seen", Value::Null, json!(true)),
        ("STARRED", "keywords/$flagged", json!(true), Value::Null),
    ] {
        if has(added, label) {
            result.insert(key.into(), on);
        }
        if has(removed, label) {
            result.insert(key.into(), off);
        }
    }
    let mut movement = None;
    if has(removed, "INBOX") {
        movement = Some(("archive", "inbox", false));
    }
    if has(added, "INBOX") {
        movement = Some(("inbox", "archive", false));
    }
    if has(removed, "TRASH") {
        movement = Some(("inbox", "trash", false));
    }
    if has(added, "TRASH") {
        movement = Some(("trash", "", true));
    }
    if has(added, "SPAM") {
        movement = Some(("junk", "", true));
    }
    if let Some((to, from, replace)) = movement {
        let destination = string(&roles[to]);
        if destination.is_empty() {
            return Err("jmap_missing_mailbox");
        }
        let member_has = |role: &str| membership.is_some_and(|v| v[string(&roles[role])] == true);
        if membership.is_some()
            && ((to == "archive" && !string(&roles["inbox"]).is_empty() && !member_has("inbox"))
                || (to == "junk" && member_has("sent")))
        {
            return Ok(Value::Object(result));
        }
        if replace {
            result.insert("mailboxIds".into(), json!({destination:true}));
        } else {
            result.insert(format!("mailboxIds/{}", pointer(destination)), json!(true));
            let source = string(&roles[from]);
            if !source.is_empty() && source != destination {
                result.insert(format!("mailboxIds/{}", pointer(source)), Value::Null);
            }
        }
        if to == "junk" {
            result.insert("keywords/$junk".into(), json!(true));
            result.insert("keywords/$notjunk".into(), Value::Null);
        }
    }
    Ok(Value::Object(result))
}
fn pointer(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}
fn can_send(snapshot: &Snapshot) -> bool {
    snapshot.document["capabilities"][SUBMISSION].is_object()
        && snapshot.document["accounts"][&snapshot.account]["accountCapabilities"][SUBMISSION]
            .is_object()
}
fn learns_junk(snapshot: &Snapshot) -> bool {
    snapshot.document["capabilities"]["urn:stalwart:jmap"].is_object()||snapshot.document["accounts"][&snapshot.account]["accountCapabilities"]["urn:stalwart:jmap"].is_object()
        ||url(string(&snapshot.document["apiUrl"])).ok().and_then(|u|u.host_str().map(str::to_owned)).is_some_and(|h|h.ends_with(".fastmail.com"))
}
impl Session {
    pub(super) async fn mutation(
        &self,
        context: &Context,
        snapshot: &Snapshot,
        method: &str,
        params: &Value,
    ) -> Result<Value, &'static str> {
        match method {
            "jmap.modify" | "jmap.batchModify" | "jmap.trash" | "jmap.untrash" => {
                let targets = if params["ids"].is_array() {
                    ids(&params["ids"])?
                } else {
                    vec![text(params, "id")?.to_owned()]
                };
                let mut added = params["addLabelIds"].clone();
                let mut removed = params["removeLabelIds"].clone();
                if method == "jmap.trash" {
                    added = json!(["TRASH"]);
                    removed = json!([]);
                }
                if method == "jmap.untrash" {
                    added = json!([]);
                    removed = json!(["TRASH"]);
                }
                if has(&added, "SPAM") && !learns_junk(snapshot) {
                    return Err("jmap_spam_unavailable");
                }
                let mut updates = Map::new();
                {
                    let held = context.memberships.lock().map_err(|_| "session_failed")?;
                    for id in &targets {
                        let patch = patch(
                            &added,
                            &removed,
                            &snapshot.roles,
                            if targets.len() > 1 {
                                held.get(id)
                            } else {
                                None
                            },
                        )?;
                        if patch.as_object().is_some_and(|v| !v.is_empty()) {
                            updates.insert(id.clone(), patch);
                        }
                    }
                }
                let changes: Vec<_> = updates.into_iter().collect();
                for chunk in changes.chunks(snapshot.limit("maxObjectsInSet", 128)) {
                    let update: Map<String, Value> = chunk.iter().cloned().collect();
                    let reply=self.api(context,snapshot,json!([["Email/set",{"accountId":snapshot.account,"update":update},"0"]]),false).await?;
                    let result = argument(&reply, "0", "Email/set")?;
                    if let Some(errors) = result["notUpdated"].as_object() {
                        for error in errors.values() {
                            if !(targets.len() > 1 && error["type"] == "notFound") {
                                return Err("jmap_update_failed");
                            }
                        }
                    }
                }
                context
                    .summaries
                    .lock()
                    .map_err(|_| "session_failed")?
                    .clear();
                context.blocks.lock().map_err(|_| "session_failed")?.clear();
                Ok(Value::Null)
            }
            "jmap.sendAs" => self.identities(context, snapshot).await,
            "jmap.send" | "jmap.saveDraft" => {
                self.compose(context, snapshot, params, method == "jmap.send")
                    .await
            }
            _ => Err("method_not_found"),
        }
    }
    async fn identities(
        &self,
        context: &Context,
        snapshot: &Snapshot,
    ) -> Result<Value, &'static str> {
        if !can_send(snapshot) {
            return Ok(json!([]));
        }
        let reply = self
            .api(
                context,
                snapshot,
                json!([["Identity/get",{"accountId":snapshot.account,"ids":null},"0"]]),
                true,
            )
            .await?;
        let rows = argument(&reply, "0", "Identity/get")?["list"]
            .as_array()
            .ok_or("jmap_invalid_response")?;
        Ok(json!(rows.iter().filter(|v|!string(&v["id"]).is_empty()&&!string(&v["email"]).is_empty()).map(|v|json!({"id":v["id"],"email":v["email"],"displayName":string(&v["name"]),"isPrimary":string(&v["email"]).eq_ignore_ascii_case(&snapshot.address),"isDefault":string(&v["email"]).eq_ignore_ascii_case(&snapshot.address)})).collect::<Vec<_>>()))
    }
    async fn compose(
        &self,
        context: &Context,
        snapshot: &Snapshot,
        params: &Value,
        send: bool,
    ) -> Result<Value, &'static str> {
        let raw = text(params, "raw")?;
        if raw.is_empty() || raw.len() > 24 * 1024 * 1024 {
            return Err("jmap_invalid_message");
        }
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(raw.trim_end_matches('='))
            .map_err(|_| "jmap_invalid_message")?;
        let ceiling = snapshot.document["capabilities"][mailbox::CORE]["maxSizeUpload"]
            .as_u64()
            .unwrap_or(0);
        if bytes.len() > MAX_BODY || (ceiling > 0 && bytes.len() as u64 > ceiling) {
            return Err("jmap_request_too_large");
        }
        if string(&snapshot.roles["drafts"]).is_empty()
            || (send && string(&snapshot.roles["sent"]).is_empty())
        {
            return Err("jmap_missing_mailbox");
        }
        if send && !can_send(snapshot) {
            return Err("jmap_send_unavailable");
        }
        let identity = if send {
            let identities = self.identities(context, snapshot).await?;
            let (headers, _) =
                mailparse::parse_headers(&bytes).map_err(|_| "jmap_invalid_message")?;
            use mailparse::MailHeaderMap;
            let from = headers.get_first_value("From").unwrap_or_default();
            let wanted = mailparse::addrparse(&from)
                .ok()
                .and_then(|addresses| addresses.extract_single_info())
                .map(|a| a.addr)
                .unwrap_or_default();
            let rows = identities.as_array().ok_or("jmap_invalid_response")?;
            let chosen = rows
                .iter()
                .find(|v| string(&v["email"]).eq_ignore_ascii_case(&wanted))
                .or_else(|| rows.iter().find(|v| v["isDefault"] == true))
                .or_else(|| rows.first());
            chosen.map(|v| string(&v["id"])).unwrap_or("").to_owned()
        } else {
            String::new()
        };
        let endpoint = fill(
            string(&snapshot.document["uploadUrl"]),
            &[("accountId", &snapshot.account)],
        );
        let mut request = prepare(
            &json!({"verb":"upload","url":endpoint,"credential":snapshot.credential,"body":""}),
        )?;
        request.body = Some(bytes);
        mailbox::active(context)?;
        let uploaded = {
            let _slot = snapshot
                .uploads
                .acquire()
                .await
                .map_err(|_| "session_failed")?;
            mailbox::active(context)?;
            execute(self.client.as_ref().map_err(|e| *e)?, request).await?
        };
        if uploaded["status"] == 401 {
            return Err("jmap_unauthorized");
        }
        if !uploaded["status"]
            .as_u64()
            .is_some_and(|s| (200..300).contains(&s))
        {
            return Err("jmap_upload_failed");
        }
        let blob: Value =
            serde_json::from_str(string(&uploaded["body"])).map_err(|_| "jmap_invalid_response")?;
        let blob = string(&blob["blobId"]);
        if blob.is_empty() {
            return Err("jmap_upload_failed");
        }
        let imported=self.api(context,snapshot,json!([["Email/import",{"accountId":snapshot.account,"emails":{"draft":{"blobId":blob,"mailboxIds":{string(&snapshot.roles["drafts"]):true},"keywords":{"$draft":true,"$seen":true}}}},"0"]]),false).await?;
        let imported = argument(&imported, "0", "Email/import")?;
        if imported["notCreated"]["draft"].is_object() {
            return Err("jmap_import_failed");
        }
        let new_id = string(&imported["created"]["draft"]["id"]);
        if new_id.is_empty() {
            return Err("jmap_import_failed");
        }
        let old_id = params["draftId"].as_str().unwrap_or("");
        if !send {
            let warning = if !old_id.is_empty()
                && old_id != new_id
                && self.destroy(context, snapshot, old_id).await.is_err()
            {
                "The draft was saved, but its previous copy could not be removed"
            } else {
                ""
            };
            return Ok(json!({"saved":true,"draftId":new_id,"warning":warning}));
        }
        let mut moved = Map::new();
        moved.insert(
            format!("mailboxIds/{}", pointer(string(&snapshot.roles["sent"]))),
            json!(true),
        );
        moved.insert(
            format!("mailboxIds/{}", pointer(string(&snapshot.roles["drafts"]))),
            Value::Null,
        );
        moved.insert("keywords/$draft".into(), Value::Null);
        let submitted=self.api(context,snapshot,json!([["EmailSubmission/set",{"accountId":snapshot.account,"create":{"send":{"emailId":new_id,"identityId":identity}},"onSuccessUpdateEmail":{"#send":moved}},"0"]]),true).await.map_err(|_|"jmap_submission_unconfirmed")?;
        let submitted = argument(&submitted, "0", "EmailSubmission/set")
            .map_err(|_| "jmap_submission_unconfirmed")?;
        if submitted["notCreated"]["send"].is_object() {
            let _ = self.destroy(context, snapshot, new_id).await;
            return Err("jmap_submission_failed");
        }
        if string(&submitted["created"]["send"]["id"]).is_empty() {
            return Err("jmap_submission_unconfirmed");
        }
        if !old_id.is_empty() {
            if self.destroy(context, snapshot, old_id).await.is_ok() {
                return Ok(json!({"draftRemoved": true}));
            }
            return Ok(json!({"warning": "Sent, but the original draft could not be removed"}));
        }
        Ok(json!({}))
    }
    async fn destroy(
        &self,
        context: &Context,
        snapshot: &Snapshot,
        id: &str,
    ) -> Result<(), &'static str> {
        // Cleanup survives cancellation of the composer request. Dropping a
        // JoinHandle detaches its owned task; no UI/request borrow outlives it.
        let body = json!({"using":[mailbox::CORE,mailbox::MAIL],"methodCalls":[["Email/set",{"accountId":snapshot.account,"destroy":[id]},"0"]]});
        let request = prepare(
            &json!({"verb":"call","url":snapshot.document["apiUrl"],"credential":snapshot.credential,"body":body.to_string()}),
        )?;
        mailbox::active(context)?;
        let retired = context.retired.clone();
        let client = self.client.as_ref().map_err(|e| *e)?.clone();
        let slots = snapshot.slots.clone();
        tokio::spawn(async move {
            let _slot = slots.acquire().await.map_err(|_| "session_failed")?;
            if retired.load(std::sync::atomic::Ordering::Acquire) {
                return Err("jmap_cancelled");
            }
            let reply = execute(&client, request).await?;
            if reply["status"] != 200 {
                return Err("jmap_cleanup_failed");
            }
            let result: Value =
                serde_json::from_str(string(&reply["body"])).map_err(|_| "jmap_cleanup_failed")?;
            let args = argument(&result, "0", "Email/set")?;
            if args["notDestroyed"]
                .as_object()
                .is_some_and(|errors| errors.values().any(|v| v["type"] != "notFound"))
            {
                return Err("jmap_cleanup_failed");
            }
            Ok(())
        })
        .await
        .map_err(|_| "worker_failed")?
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn conversation_move_does_not_archive_sent_or_train_on_own_reply() {
        let roles = json!({"inbox":"I","archive":"A","sent":"S","junk":"J","trash":"T"});
        assert_eq!(
            patch(
                &json!([]),
                &json!(["INBOX"]),
                &roles,
                Some(&json!({"S":true}))
            )
            .unwrap(),
            json!({})
        );
        assert_eq!(
            patch(
                &json!(["SPAM"]),
                &json!([]),
                &roles,
                Some(&json!({"S":true}))
            )
            .unwrap(),
            json!({})
        );
        assert_eq!(
            patch(&json!(["UNREAD"]), &json!([]), &roles, None).unwrap(),
            json!({"keywords/$seen":null})
        );
        assert!(patch(&json!(["TRASH"]), &json!([]), &json!({}), None).is_err());
    }
}
