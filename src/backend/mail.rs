use super::Session;
use crate::mail::{ActRequest, ListRequest, Provider, ReadRequest, SendRequest};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin};

#[cfg(test)]
#[path = "mail_action_tests.rs"]
mod action_tests;

struct ProviderList<'a> {
    session: &'a Session,
}

struct ProviderRead<'a> {
    session: &'a Session,
}

struct ProviderIdentities<'a> {
    session: &'a Session,
}

impl crate::mail::send::IdentityLookup for ProviderIdentities<'_> {
    fn identities<'a>(
        &'a self,
        account: &'a crate::mail::Account,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
        Box::pin(async move {
            let refusals = crate::account::refusals_readonly(&account.id)?;
            if !crate::providers::can(account.provider.id(), "send", &refusals) {
                return Err("mail_send_unavailable");
            }
            let params = json!({"accountId":account.id});
            match account.provider {
                Provider::Gmail => self.session.gmail.call("gmail.sendAs", &params).await,
                Provider::Jmap => {
                    let value = self.session.jmap.call("jmap.sendAs", &params).await?;
                    Ok(value["data"].clone())
                }
                Provider::Hey => {
                    let checked = crate::providers::hey_access::checked_params(&json!({"accountId":account.id,"program":crate::providers::hey_access::program()?})).await?;
                    crate::providers::hey::call("hey.sendAs", &checked).await
                }
                Provider::Imap | Provider::Outlook => {
                    let account = account.clone();
                    tokio::task::spawn_blocking(move || {
                        let settings = crate::auth::settings_readonly(account.provider.id(), &account.id)?;
                        let email = settings["email"].as_str().filter(|value| !value.is_empty()).or_else(|| settings["imap"]["username"].as_str()).ok_or("mail_send_sender_unavailable")?;
                        let aliases = settings["imap"]["aliases"].as_array().cloned().unwrap_or_default();
                        if aliases.len() > 1024 { return Err("mail_send_identities_invalid"); }
                        let default = aliases.iter().any(|alias| alias["isDefault"] == true);
                        let mut rows = vec![json!({"email":email,"displayName":"","isPrimary":true,"isDefault":!default})];
                        rows.extend(aliases);
                        Ok(json!(rows))
                    }).await.map_err(|_| "worker_failed")?
                }
            }
        })
    }
}

pub(crate) trait MutationAdapter: Send + Sync {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
        context: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>>;
}

struct ProviderMutation<'a> {
    session: &'a Session,
}

impl MutationAdapter for ProviderMutation<'_> {
    fn call<'a>(
        &'a self,
        method: &'a str,
        mut params: Value,
        context: &'a Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
        Box::pin(async move {
            if method.starts_with("gmail.") {
                self.session.gmail.call(method, &params).await
            } else if method.starts_with("jmap.") {
                self.session
                    .jmap
                    .execute_planned_action(method, &params, context)
                    .await
            } else if method == "hey.act" {
                params["program"] = json!(crate::providers::hey_access::program()?);
                let checked = crate::providers::hey_access::checked_params(&params).await?;
                crate::providers::hey_actions::call(method, &checked).await
            } else {
                let method = method.to_owned();
                let context = context.clone();
                tokio::spawn(async move {
                    crate::providers::imap::execute_planned_action(&method, &params, &context).await
                })
                .await
                .map_err(|_| "worker_failed")?
            }
        })
    }
}

/// Provider results are acknowledgements, never diagnostics to forward. A
/// partial response must name every requested ID exactly once; malformed or
/// contradictory acknowledgements cannot confirm any member of that call.
fn confirmed_ids(reply: Result<Value, &'static str>, ids: &[String]) -> Vec<String> {
    let Ok(reply) = reply else {
        return Vec::new();
    };
    if reply.get("succeededIds").is_none() && reply.get("failedIds").is_none() {
        return ids.to_vec();
    }
    let (Some(succeeded), Some(failed)) = (
        reply["succeededIds"].as_array(),
        reply["failedIds"].as_array(),
    ) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    for id in succeeded.iter().chain(failed) {
        let Some(id) = id.as_str() else {
            return Vec::new();
        };
        if !ids.iter().any(|target| target == id) || !seen.insert(id) {
            return Vec::new();
        }
    }
    if seen.len() != ids.len() {
        return Vec::new();
    }
    succeeded
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

pub(crate) async fn mutate_plan(
    plan: &crate::mail::action::ActionPlan,
    adapter: &impl MutationAdapter,
) -> Vec<String> {
    // Validate the complete plan before chunking: a malformed later target
    // must never permit an earlier chunk to mutate the provider or caches.
    if plan
        .target_ids
        .iter()
        .any(|id| crate::mail::action::validate_message_id(plan.account.provider, id).is_err())
    {
        return Vec::new();
    }
    let mut succeeded = Vec::new();
    // Gmail trash is a single-message primitive. Other operations preserve the
    // provider's batch primitive, including HEY posting batches and IMAP UIDs.
    let chunk_size = if plan.account.provider == Provider::Gmail && plan.operation == "trash" {
        1
    } else if matches!(plan.account.provider, Provider::Imap | Provider::Outlook) {
        500
    } else {
        1000
    };
    for ids in plan.target_ids.chunks(chunk_size) {
        let mut params = json!({"accountId":plan.account.id,"ids":ids});
        let method = match plan.account.provider {
            Provider::Hey => {
                params["verb"] = json!(
                    crate::mail::action::domain_action(&plan.operation).expect("planned operation")
                );
                "hey.act"
            }
            Provider::Gmail if plan.operation == "trash" => {
                params = json!({"accountId":plan.account.id,"id":ids[0]});
                "gmail.trash"
            }
            Provider::Jmap if plan.operation == "trash" => "jmap.trash",
            Provider::Imap | Provider::Outlook if plan.operation == "trash" => "imap.trash",
            provider => {
                params["addLabelIds"] = json!(plan.add_label_ids);
                params["removeLabelIds"] = json!(plan.remove_label_ids);
                match provider {
                    Provider::Gmail => "gmail.batchModify",
                    Provider::Jmap => "jmap.batchModify",
                    Provider::Imap | Provider::Outlook => "imap.modify",
                    Provider::Hey => unreachable!(),
                }
            }
        };
        succeeded.extend(confirmed_ids(
            adapter.call(method, params, &plan.provider_context).await,
            ids,
        ));
    }
    succeeded
}

impl crate::mail::action::ActionMutation for ProviderMutation<'_> {
    fn execute<'a>(
        &'a self,
        plan: &'a crate::mail::action::ActionPlan,
    ) -> Pin<Box<dyn Future<Output = Vec<String>> + Send + 'a>> {
        Box::pin(async move {
            let succeeded = mutate_plan(plan, self).await;
            if !succeeded.is_empty() {
                self.session
                    .invalidate_action_caches(&plan.account.id)
                    .await;
            }
            succeeded
        })
    }
}

/// The shared planner is provider-neutral. This adapter may make bounded,
/// read-only provider calls to learn live destination availability and expand
/// listings that collapse conversations, but never invokes a mutation method.
struct AccountActionLookup<'a> {
    session: &'a Session,
}

impl crate::mail::action::ActionLookup for AccountActionLookup<'_> {
    fn availability<'a>(
        &'a self,
        account: &'a crate::mail::Account,
        operation: &'a str,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<crate::mail::action::ActionAvailability, &'static str>>
                + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            if account.provider == Provider::Jmap {
                return self
                    .session
                    .jmap
                    .planned_action_availability(&account.id)
                    .await;
            }
            let refusals = crate::account::refusals_readonly(&account.id)?;
            let action = crate::mail::action::domain_action(operation)?;
            let capability = crate::account::model::capability(action);
            if matches!(account.provider, Provider::Imap | Provider::Outlook)
                && crate::account::model::action_mailbox(action).is_some()
                && (capability.is_empty()
                    || crate::providers::can(account.provider.id(), capability, &refusals))
            {
                let account = account.clone();
                return tokio::spawn(async move {
                    crate::providers::imap::planned_action_availability(&account.id, refusals).await
                })
                .await
                .map_err(|_| "worker_failed")?;
            }
            let mailboxes = ["archive", "trash", "spam"]
                .iter()
                .map(|mailbox| {
                    (
                        (*mailbox).to_owned(),
                        Value::Bool(
                            crate::providers::domain::query_mailbox(account.provider.id(), mailbox)
                                .is_some(),
                        ),
                    )
                })
                .collect();
            Ok(crate::mail::action::ActionAvailability {
                refusals,
                mailboxes: Value::Object(mailboxes),
                mailbox_required: if account.provider == Provider::Hey {
                    json!({"spam":false})
                } else {
                    Value::Null
                },
                rows_context: Value::Null,
            })
        })
    }

    fn rows<'a>(
        &'a self,
        account: &'a crate::mail::Account,
        ids: &'a [String],
        availability: &'a crate::mail::action::ActionAvailability,
        operation: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Value>, &'static str>> + Send + 'a>> {
        Box::pin(async move {
            if account.provider == Provider::Jmap {
                return self
                    .session
                    .jmap
                    .planned_action_rows(&account.id, ids, &availability.rows_context, operation)
                    .await;
            }
            Ok(ids.iter().map(|id| json!({"id":id})).collect())
        })
    }
}

fn summaries(messages: &[Value]) -> Result<Vec<Value>, &'static str> {
    let now = chrono::Utc::now().timestamp_millis();
    messages
        .iter()
        .map(|message| crate::message::content::summarize(message, now))
        .collect()
}

async fn imap_call(method: &str, params: &Value) -> Result<Value, &'static str> {
    let method = method.to_owned();
    let params = params.clone();
    tokio::spawn(async move { crate::providers::imap::call(&method, &params).await })
        .await
        .map_err(|_| "worker_failed")?
}

impl Session {
    pub(crate) async fn finish_cli_send(&self, result: &mut Value) -> Result<(), &'static str> {
        result["outbox"] = self
            .outbox
            .wait_for_send(
                result["accountId"]
                    .as_str()
                    .ok_or("outbox_invalid_params")?,
                result["sendId"].as_str().ok_or("outbox_invalid_params")?,
            )
            .await?;
        Ok(())
    }

    pub(super) async fn mail_call(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<Value, &'static str> {
        match method {
            "mail.send" => {
                let request = SendRequest::try_from(params)?;
                crate::mail::send::send_with(
                    request,
                    &ProviderIdentities { session: self },
                    &self.outbox,
                )
                .await
            }
            "mail.list" => {
                let request = ListRequest::try_from(params)?;
                crate::mail::list::list_with(request, &ProviderList { session: self }).await
            }
            "mail.read" => {
                let request = ReadRequest::try_from(params)?;
                crate::mail::read::read_with(request, &ProviderRead { session: self }).await
            }
            "mail.act" => {
                let request = ActRequest::try_from(params)?;
                crate::mail::action::act(
                    &request,
                    &AccountActionLookup { session: self },
                    &ProviderMutation { session: self },
                )
                .await
            }
            _ => Err("unknown_method"),
        }
    }

    async fn invalidate_action_caches(&self, account: &str) {
        let params = json!({"accountId":account});
        // Cache failures cannot erase confirmed delivery or invite a retry.
        if let Ok(restored) = self.queries.call("cache.queryRestore", &params).await {
            let _ = self
                .queries
                .call(
                    "cache.queryInvalidate",
                    &json!({"accountId":account,"generation":restored["generation"],"ids":[]}),
                )
                .await;
            // The one-shot CLI can exit before the cache's debounce fires.
            let _ = self
                .queries
                .call(
                    "cache.queryFlush",
                    &json!({"accountId":account,"generation":restored["generation"]}),
                )
                .await;
        }
        if let Ok(mut renders) = self.renders.lock() {
            renders.invalidate(account, None);
        }
        let _ = tokio::task::spawn_blocking(move || {
            for method in ["cache.resourceClear", "cache.bodyClear"] {
                let _ = crate::cache::call(method, &params);
            }
        })
        .await;
    }

    async fn provider_list(
        &self,
        request: &ListRequest,
        query: String,
    ) -> Result<Value, &'static str> {
        let params = json!({
            "accountId":request.account.id,
            "query":query,
            "pageSize":request.limit,
            "pageToken":request.page_token,
        });
        match request.account.provider {
            Provider::Gmail => Box::pin(self.gmail_list(&params)).await,
            Provider::Hey => Box::pin(self.hey_list(&params)).await,
            Provider::Jmap => Box::pin(self.jmap_list(&params)).await,
            Provider::Outlook | Provider::Imap => {
                Box::pin(self.imap_list(&params, request.limit)).await
            }
        }
    }

    async fn gmail_list(&self, params: &Value) -> Result<Value, &'static str> {
        let page = self.gmail.call("gmail.list", params).await?;
        let ids = page["ids"]
            .as_array()
            .ok_or("gmail_invalid_response")?
            .iter()
            .map(|id| {
                id.as_str()
                    .map(str::to_owned)
                    .ok_or("gmail_invalid_response")
            })
            .collect::<Result<Vec<_>, _>>()?;
        let messages = futures_util::future::try_join_all(ids.iter().map(|id| {
            let id = id.clone();
            async move {
                self.gmail
                    .call(
                        "gmail.read",
                        &json!({"accountId":params["accountId"],"id":id,"full":false}),
                    )
                    .await
            }
        }))
        .await?;
        Ok(json!({
            "ids":ids,
            "messages":summaries(&messages)?,
            "nextPageToken":page["nextPageToken"].as_str().unwrap_or(""),
            "estimate":page["estimate"].as_u64().unwrap_or(0),
        }))
    }

    async fn hey_list(&self, params: &Value) -> Result<Value, &'static str> {
        let program = crate::providers::hey_access::program()?;
        let checked = crate::providers::hey_access::checked_params(&json!({
            "accountId":params["accountId"],
            "program":program,
            "query":params["query"],
            "pageSize":params["pageSize"],
            "pageToken":params["pageToken"],
        }))
        .await?;
        let page = crate::providers::hey::call("hey.list", &checked).await?;
        let messages = page["messages"].as_array().ok_or("hey_invalid_response")?;
        Ok(json!({
            "ids":page["ids"],
            "messages":summaries(messages)?,
            "nextPageToken":page["nextPageToken"].as_str().unwrap_or(""),
            "estimate":page["estimate"].as_u64().unwrap_or(0),
        }))
    }

    async fn jmap_list(&self, params: &Value) -> Result<Value, &'static str> {
        let page = self
            .jmap
            .call(
                "jmap.list",
                &json!({
                    "accountId":params["accountId"],"query":params["query"],
                    "maxResults":params["pageSize"],"pageToken":params["pageToken"],
                }),
            )
            .await?;
        let data = &page["data"];
        let messages = self
            .jmap
            .call(
                "jmap.messages",
                &json!({"accountId":params["accountId"],"ids":data["ids"],"withBlocks":true}),
            )
            .await?;
        let messages = messages["data"].as_array().ok_or("jmap_invalid_response")?;
        Ok(json!({
            "ids":data["ids"],
            "messages":summaries(messages)?,
            "nextPageToken":data["nextPageToken"].as_str().unwrap_or(""),
            "estimate":data["estimate"].as_u64().unwrap_or(0),
        }))
    }

    async fn imap_list(&self, params: &Value, limit: u16) -> Result<Value, &'static str> {
        let mut request = json!({
            "accountId":params["accountId"],"query":params["query"],"limit":limit,
            "pageToken":params["pageToken"],"progressive":true,"readOnly":true,
        });
        let mut page = Box::pin(imap_call("imap.list", &request)).await?;
        if page["warning"]
            .as_str()
            .is_some_and(|warning| !warning.is_empty())
        {
            return Err("imap_list_incomplete");
        }
        if let Some(continuation) = page["continuation"]
            .as_str()
            .filter(|token| !token.is_empty())
        {
            request["continuation"] = json!(continuation);
            page = Box::pin(imap_call("imap.listContinue", &request)).await?;
            if page["warning"]
                .as_str()
                .is_some_and(|warning| !warning.is_empty())
            {
                return Err("imap_list_incomplete");
            }
            if page["continuation"]
                .as_str()
                .is_some_and(|token| !token.is_empty())
            {
                return Err("imap_list_incomplete");
            }
        }
        let provider_page = &page["page"];
        let messages = Box::pin(imap_call(
            "imap.messages",
            &json!({
                "accountId":params["accountId"],"ids":provider_page["ids"],
                "full":false,"progressive":false,"readOnly":true,
            }),
        ))
        .await?;
        if messages["warning"]
            .as_str()
            .is_some_and(|warning| !warning.is_empty())
        {
            return Err("imap_list_incomplete");
        }
        let messages = messages["messages"]
            .as_array()
            .ok_or("imap_invalid_response")?;
        Ok(json!({
            "ids":provider_page["ids"],
            "messages":summaries(messages)?,
            "nextPageToken":provider_page["nextPageToken"].as_str().unwrap_or(""),
            "estimate":provider_page["estimate"].as_u64().unwrap_or(0),
        }))
    }
}

impl crate::mail::list::ListAdapter for ProviderList<'_> {
    fn list<'a>(
        &'a self,
        request: &'a ListRequest,
        provider_query: String,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
        Box::pin(self.session.provider_list(request, provider_query))
    }
}

impl crate::mail::read::ReadAdapter for ProviderRead<'_> {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
        Box::pin(async move {
            if method == "reader.open" {
                return self.session.reader_call(method, &params).await;
            }
            if method == "account.conversation" {
                return tokio::task::spawn_blocking(move || {
                    crate::account::conversation::request(&params)
                })
                .await
                .map_err(|_| "worker_failed")?;
            }
            Err("unknown_method")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::{Account, Mailbox, Provider, ReadRequest};
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use std::{
        fs,
        future::Future,
        io::{BufRead, BufReader},
        pin::Pin,
        process::{Command, Stdio},
        sync::{Arc, Mutex},
    };

    struct ReaderProjectionAdapter {
        opened: Value,
        calls: Arc<Mutex<Vec<String>>>,
    }

    impl crate::mail::read::ReadAdapter for ReaderProjectionAdapter {
        fn call<'a>(
            &'a self,
            method: &'a str,
            _params: Value,
        ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
            self.calls.lock().unwrap().push(method.to_owned());
            Box::pin(async move {
                if method == "reader.open" {
                    Ok(self.opened.clone())
                } else {
                    Err("unexpected_method")
                }
            })
        }
    }

    fn reader_resource(html: &str, multipart: bool) -> Value {
        let html = URL_SAFE_NO_PAD.encode(html);
        let payload = if multipart {
            json!({"mimeType":"multipart/alternative","headers":[],"parts":[
                {"mimeType":"text/plain","body":{"data":URL_SAFE_NO_PAD.encode("Safe text")}},
                {"mimeType":"text/html","body":{"data":html}}
            ]})
        } else {
            json!({"mimeType":"text/html","headers":[],"body":{"data":html}})
        };
        json!({"id":"message-1","payload":payload})
    }

    async fn assert_closed_mail_read_projection(
        resource: Value,
        expected_text: &str,
        has_plain_images: bool,
    ) {
        let tracker = "https://tracker.example/pixel";
        let data_script = "data:text/html,&lt;script&gt;forbiddenDataScript&lt;/script&gt;";
        let opened = super::super::reader::projection(
            &resource,
            "reader@example.org",
            "message-1",
            "test-reader-key",
            0,
            json!({"allowRemoteImages":false,"withReader":true}),
            &Default::default(),
            None,
        )
        .unwrap();
        assert!(
            opened["nativeRender"]["remoteImageSources"]
                .to_string()
                .contains(tracker)
        );
        if has_plain_images {
            assert!(
                opened["nativeRender"]["plainText"]["images"]
                    .to_string()
                    .contains(data_script)
            );
        }

        let calls = Arc::new(Mutex::new(Vec::new()));
        let result = crate::mail::read::read_with(
            ReadRequest {
                account: Account {
                    id: "reader@example.org".into(),
                    provider: Provider::Gmail,
                },
                id: "message-1".into(),
            },
            &ReaderProjectionAdapter {
                opened,
                calls: calls.clone(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            result["message"]["nativeContent"]["body"]["text"],
            expected_text
        );
        assert!(result["message"]["nativeRender"]["document"].is_object());
        let serialized = result.to_string();
        assert!(!serialized.contains(tracker));
        assert!(!serialized.contains(data_script));
        assert_eq!(&*calls.lock().unwrap(), &["reader.open"]);
    }

    #[tokio::test]
    async fn mail_read_projects_actual_multipart_reader_output_without_image_sources() {
        assert_closed_mail_read_projection(
            reader_resource(
                "<p>Safe HTML</p><img src=\"https://tracker.example/pixel\"><img src=\"data:text/html,&lt;script&gt;forbiddenDataScript&lt;/script&gt;\">",
                true,
            ),
            "Safe text",
            false,
        )
        .await;
    }

    #[tokio::test]
    async fn mail_read_projects_actual_html_reader_output_without_image_sources() {
        assert_closed_mail_read_projection(
            reader_resource(
                "<p>Safe HTML</p><img src=\"https://tracker.example/pixel\"><img src=\"data:text/html,&lt;script&gt;forbiddenDataScript&lt;/script&gt;\">",
                false,
            ),
            "Safe HTML\n[image 1][image 2]",
            true,
        )
        .await;
    }

    #[tokio::test]
    async fn mail_read_drops_inline_raster_data_from_actual_reader_document() {
        let image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL6fQAAAABJRU5ErkJggg==";
        let opened = super::super::reader::projection(
            &reader_resource(
                &format!("<p>Visible image text</p><img src=\"{image}\">"),
                false,
            ),
            "reader@example.org",
            "message-1",
            "test-reader-key",
            0,
            json!({"allowRemoteImages":false,"withReader":true}),
            &Default::default(),
            None,
        )
        .unwrap();
        assert!(
            opened["nativeRender"]["document"]
                .to_string()
                .contains(image)
        );

        let calls = Arc::new(Mutex::new(Vec::new()));
        let result = crate::mail::read::read_with(
            ReadRequest {
                account: Account {
                    id: "reader@example.org".into(),
                    provider: Provider::Gmail,
                },
                id: "message-1".into(),
            },
            &ReaderProjectionAdapter {
                opened,
                calls: calls.clone(),
            },
        )
        .await
        .unwrap();
        assert!(
            result["message"]["nativeContent"]["body"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("Visible image text"))
        );
        let document = &result["message"]["nativeRender"]["document"];
        assert_eq!(document["children"][0]["name"], "p");
        assert!(document.to_string().contains("Visible image text"));
        assert_eq!(document["children"][1]["name"], "img");
        assert_eq!(document["children"][1]["attrs"], json!([]));
        let serialized = result.to_string();
        assert!(!serialized.contains(image));
        assert!(!serialized.contains("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"));
        assert_eq!(&*calls.lock().unwrap(), &["reader.open"]);
    }

    async fn actual_mail_read(resource: Value) -> (Value, Value) {
        let opened = super::super::reader::projection(
            &resource,
            "reader@example.org",
            "message-1",
            "test-reader-key",
            0,
            json!({"allowRemoteImages":false,"withReader":true}),
            &Default::default(),
            None,
        )
        .unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let result = crate::mail::read::read_with(
            ReadRequest {
                account: Account {
                    id: "reader@example.org".into(),
                    provider: Provider::Gmail,
                },
                id: "message-1".into(),
            },
            &ReaderProjectionAdapter {
                opened: opened.clone(),
                calls: calls.clone(),
            },
        )
        .await
        .unwrap();
        assert_eq!(&*calls.lock().unwrap(), &["reader.open"]);
        (opened, result)
    }

    fn document_node_count(node: &Value) -> usize {
        1 + node
            .get("children")
            .and_then(Value::as_array)
            .map(|children| children.iter().map(document_node_count).sum())
            .unwrap_or(0)
    }

    #[tokio::test]
    async fn mail_read_keeps_actual_reader_documents_above_the_former_node_limit() {
        let (opened, result) =
            actual_mail_read(reader_resource(&"<p>x</p>".repeat(4096), false)).await;
        assert_eq!(
            document_node_count(&opened["nativeRender"]["document"]),
            8193
        );
        assert_eq!(
            result["message"]["nativeRender"]["document"]["children"]
                .as_array()
                .unwrap()
                .len(),
            4096
        );
    }

    #[tokio::test]
    async fn mail_read_keeps_empty_body_metadata_from_an_attachment_only_reader_result() {
        let resource = json!({"id":"message-1","payload":{"mimeType":"multipart/mixed","headers":[],"parts":[
            {"mimeType":"application/octet-stream","filename":"brief.bin","body":{"data":URL_SAFE_NO_PAD.encode("attachment-bytes"),"attachmentId":"download-1","size":16}}
        ]}});
        let (opened, result) = actual_mail_read(resource).await;
        assert_eq!(opened["nativeContent"]["body"]["source"], "");
        assert_eq!(opened["nativeContent"]["body"]["bodyDirection"], "");
        assert_eq!(result["message"]["nativeContent"]["body"]["source"], "");
        assert_eq!(
            result["message"]["nativeContent"]["body"]["bodyDirection"],
            ""
        );
        assert_eq!(
            result["message"]["attachments"][0]["attachmentId"],
            "download-1"
        );
    }

    #[tokio::test]
    async fn mail_read_keeps_empty_direction_for_direction_neutral_text() {
        let resource = json!({"id":"message-1","payload":{"mimeType":"text/plain","headers":[],"body":{"data":URL_SAFE_NO_PAD.encode("  123 😀  \n")}}});
        let (opened, result) = actual_mail_read(resource).await;
        assert_eq!(opened["nativeContent"]["body"]["source"], "plain");
        assert_eq!(opened["nativeContent"]["body"]["bodyDirection"], "");
        assert_eq!(
            result["message"]["nativeContent"]["body"]["text"],
            "  123 😀  \n"
        );
        assert_eq!(
            result["message"]["nativeContent"]["body"]["bodyDirection"],
            ""
        );
    }

    #[tokio::test]
    async fn jmap_adapter_keeps_thread_state_from_nonrepresentative_members() {
        let mut peer = Command::new("python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/providers/jmap/mailbox_tls_test.py"
            ))
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(peer.stdout.take().unwrap());
        let mut port = String::new();
        output.read_line(&mut port).unwrap();
        let mut certificate = String::new();
        output.read_line(&mut certificate).unwrap();
        let jmap = std::sync::Arc::new(
            crate::providers::jmap::Session::with_test_certificate(
                &fs::read(certificate.trim()).unwrap(),
            )
            .unwrap(),
        );
        let port: u16 = port.trim().parse().unwrap();
        let boxes = vec![
            json!({"id":"I","role":"inbox"}),
            json!({"id":"S","role":"sent"}),
            json!({"id":"T","role":"trash"}),
            json!({"id":"A","role":"archive"}),
            json!({"id":"D","role":"drafts"}),
        ];
        jmap.install_snapshot_for_test(
            "jmap:user@example.test",
            json!({
                "apiUrl":format!("https://localhost:{port}/api"),
                "downloadUrl":format!("https://localhost:{port}/blob/{{blobId}}"),
                "uploadUrl":format!("https://localhost:{port}/upload"),
                "eventSourceUrl":format!("https://localhost:{port}/events"),
                "state":"s1",
                "capabilities":{
                    "urn:ietf:params:jmap:core":{"maxObjectsInGet":2,"maxObjectsInSet":2},
                    "urn:ietf:params:jmap:mail":{},
                },
                "accounts":{"account":{"accountCapabilities":{"urn:ietf:params:jmap:mail":{"emailQuerySortOptions":["receivedAt"]}}}},
                "primaryAccounts":{"urn:ietf:params:jmap:mail":"account"},
            }),
            boxes,
            json!({"scheme":"basic","username":"user","secret":"synthetic"}),
            "user@example.test",
        )
        .await
        .unwrap();
        let session = Session {
            jmap,
            ..Default::default()
        };
        let result = session
            .provider_list(
                &ListRequest {
                    account: Account {
                        id: "jmap:user@example.test".into(),
                        provider: Provider::Jmap,
                    },
                    mailbox: Mailbox::Inbox,
                    query: String::new(),
                    limit: 25,
                    page_token: String::new(),
                },
                "role:inbox".into(),
            )
            .await
            .unwrap();
        assert_eq!(
            result["messages"][0]["thread"]["memberIds"],
            json!(["e1", "e2"])
        );
        assert_eq!(result["messages"][0]["thread"]["count"], 2);
        assert_eq!(result["messages"][0]["unread"], true);
        assert_eq!(result["messages"][0]["starred"], true);
        let account = Account {
            id: "jmap:user@example.test".into(),
            provider: Provider::Jmap,
        };
        let lookup = AccountActionLookup { session: &session };
        let availability =
            crate::mail::action::ActionLookup::availability(&lookup, &account, "archive")
                .await
                .unwrap();
        assert_eq!(availability.mailboxes["archive"], true);
        assert_ne!(availability.refusals["spam"], Value::Null);
        let preview = crate::mail::action::dry_run(
            &ActRequest {
                account: account.clone(),
                operation: "archive".into(),
                ids: vec!["e1".into()],
                execute: false,
            },
            &lookup,
        )
        .await
        .unwrap();
        assert_eq!(preview["targetIds"], json!(["e1"]));
        let report_client = crate::test_net::localhost_loopback(reqwest::Client::builder())
            .add_root_certificate(
                reqwest::Certificate::from_pem(&fs::read(certificate.trim()).unwrap()).unwrap(),
            )
            .build()
            .unwrap();
        let report = report_client
            .get(format!("https://localhost:{port}/report"))
            .send()
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let report: Value = serde_json::from_slice(&report).unwrap();
        assert!(
            report.as_array().unwrap().iter().all(|request| {
                request["method"] == "POST"
                    && request["path"] == "/api"
                    && request["calls"].as_array().is_some()
            }),
            "preview used an upload, GET, or unrecognized endpoint: {report}"
        );
        assert!(
            report
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|request| { request["calls"].as_array().into_iter().flatten() })
                .all(|call| matches!(
                    call[0].as_str(),
                    Some("Mailbox/get" | "Email/query" | "Email/get" | "Thread/get")
                ))
        );
        let _ = peer.kill();
        let _ = peer.wait();
    }
}
