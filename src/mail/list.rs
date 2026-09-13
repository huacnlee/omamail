use super::{ListRequest, Mailbox};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin};

pub(crate) trait ListAdapter: Send + Sync {
    fn list<'a>(
        &'a self,
        request: &'a ListRequest,
        provider_query: String,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>>;
}

fn mailbox_name(mailbox: Mailbox) -> &'static str {
    match mailbox {
        Mailbox::Inbox => "inbox",
        Mailbox::Unread => "unread",
        Mailbox::Starred => "starred",
        Mailbox::Sent => "sent",
        Mailbox::Drafts => "drafts",
        Mailbox::Archive => "archive",
        Mailbox::Spam => "spam",
        Mailbox::Trash => "trash",
    }
}

fn provider_mailbox(request: &ListRequest) -> Option<String> {
    crate::providers::domain::query_mailbox(
        request.account.provider.id(),
        mailbox_name(request.mailbox),
    )
}

fn complete_page(page: Value) -> Result<Value, &'static str> {
    let ids = page["ids"].as_array().ok_or("mail_list_incomplete")?;
    let messages = page["messages"].as_array().ok_or("mail_list_incomplete")?;
    if ids.len() != messages.len()
        || ids.iter().zip(messages).any(|(id, message)| {
            id.as_str().is_none_or(|id| message["id"] != id) || message.get("payload").is_some()
        })
    {
        return Err("mail_list_incomplete");
    }
    let next_page_token = page["nextPageToken"]
        .as_str()
        .ok_or("mail_list_incomplete")?;
    let estimate = page["estimate"].as_u64().ok_or("mail_list_incomplete")?;
    Ok(json!({"messages":messages,"nextPageToken":next_page_token,"estimate":estimate}))
}

pub(crate) async fn list_with(
    request: ListRequest,
    adapter: &impl ListAdapter,
) -> Result<Value, &'static str> {
    let provider_mailbox = provider_mailbox(&request).ok_or("mail_mailbox_unavailable")?;
    let provider_query = crate::providers::domain::resolve(&json!({
        "operation":"query",
        "provider":request.account.provider.id(),
        "mailbox":provider_mailbox,
        "search":request.query,
    }))?["value"]
        .as_str()
        .ok_or("mail_mailbox_unavailable")?
        .to_owned();
    let page = complete_page(adapter.list(&request, provider_query).await?)?;
    Ok(json!({
        "accountId":request.account.id,
        "mailbox":mailbox_name(request.mailbox),
        "messages":page["messages"],
        "nextPageToken":page["nextPageToken"],
        "estimate":page["estimate"],
    }))
}
