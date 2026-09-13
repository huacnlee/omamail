use super::ReadRequest;
use crate::message::html::{MAX_DEPTH, MAX_NODES};
use serde_json::{Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) trait ReadAdapter: Send + Sync {
    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>>;
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn request_id() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = REQUEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("mail-read-{}-{stamp}-{sequence}", std::process::id())
}

fn safe_attachment(value: &Value) -> Result<Value, &'static str> {
    let attachment = value.as_object().ok_or("mail_read_invalid_reader")?;
    let attachment_id = attachment
        .get("attachmentId")
        .and_then(Value::as_str)
        .ok_or("mail_read_invalid_reader")?;
    let filename = attachment
        .get("filename")
        .and_then(Value::as_str)
        .ok_or("mail_read_invalid_reader")?;
    let mime_type = attachment
        .get("mimeType")
        .and_then(Value::as_str)
        .ok_or("mail_read_invalid_reader")?;
    let size = attachment
        .get("size")
        .and_then(Value::as_u64)
        .ok_or("mail_read_invalid_reader")?;
    if [attachment_id, filename, mime_type]
        .iter()
        .any(|value| value.chars().any(char::is_control))
    {
        return Err("mail_read_invalid_reader");
    }
    Ok(json!({
        "attachmentId":attachment_id,
        "filename":filename,
        "mimeType":mime_type,
        "size":size,
    }))
}

fn safe_body(value: &Value) -> Result<Value, &'static str> {
    let body = value.as_object().ok_or("mail_read_invalid_reader")?;
    let text = body
        .get("text")
        .and_then(Value::as_str)
        .ok_or("mail_read_invalid_reader")?;
    let source = body
        .get("source")
        .and_then(Value::as_str)
        .filter(|source| matches!(*source, "" | "plain" | "html"))
        .ok_or("mail_read_invalid_reader")?;
    let direction = body
        .get("bodyDirection")
        .and_then(Value::as_str)
        .filter(|direction| matches!(*direction, "" | "ltr" | "rtl"))
        .ok_or("mail_read_invalid_reader")?;
    Ok(json!({"text":text,"source":source,"bodyDirection":direction}))
}

fn safe_render(value: &Value) -> Result<Value, &'static str> {
    let render = value.as_object().ok_or("mail_read_invalid_reader")?;
    if render.contains_key("html")
        || render
            .get("reader")
            .and_then(Value::as_object)
            .is_some_and(|reader| reader.contains_key("html"))
    {
        return Err("mail_read_unsafe_reader");
    }
    let document = render
        .get("document")
        .filter(|document| document.is_object())
        .ok_or("mail_read_invalid_reader")?;
    fn document_node(value: &Value, depth: usize, left: &mut usize) -> Result<Value, &'static str> {
        if depth > MAX_DEPTH || *left == 0 {
            return Err("mail_read_invalid_reader");
        }
        *left -= 1;
        let node = value.as_object().ok_or("mail_read_invalid_reader")?;
        let kind = node
            .get("type")
            .and_then(Value::as_str)
            .ok_or("mail_read_invalid_reader")?;
        if kind == "text" {
            return Ok(json!({
                "type":"text",
                "text":node.get("text").and_then(Value::as_str).ok_or("mail_read_invalid_reader")?,
            }));
        }
        if !matches!(kind, "root" | "element") {
            return Err("mail_read_invalid_reader");
        }
        let children = node
            .get("children")
            .and_then(Value::as_array)
            .ok_or("mail_read_invalid_reader")?
            .iter()
            .map(|child| document_node(child, depth + 1, left))
            .collect::<Result<Vec<_>, _>>()?;
        if kind == "root" {
            return Ok(json!({"type":"root","children":children}));
        }
        let name = node
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| {
                !name.is_empty() && name.len() <= 128 && !name.chars().any(char::is_control)
            })
            .ok_or("mail_read_invalid_reader")?;
        Ok(json!({
            "type":"element",
            "name":name,
            "selfClosing":node.get("selfClosing").and_then(Value::as_bool).unwrap_or(false),
            "attrs":[],
            "children":children,
        }))
    }
    let mut nodes_left = MAX_NODES;
    Ok(json!({"document":document_node(document, 0, &mut nodes_left)?}))
}

fn safe_message(request: &ReadRequest, value: Value) -> Result<(Value, Vec<String>), &'static str> {
    if value["id"] != request.id {
        return Err("mail_read_message_mismatch");
    }
    let summary = value["nativeSummary"]
        .as_object()
        .ok_or("mail_read_invalid_reader")?;
    if summary.get("id") != Some(&Value::String(request.id.clone())) {
        return Err("mail_read_message_mismatch");
    }
    let content = value["nativeContent"]
        .as_object()
        .ok_or("mail_read_invalid_reader")?;
    if content.contains_key("html") {
        return Err("mail_read_unsafe_reader");
    }
    let body = safe_body(content.get("body").ok_or("mail_read_invalid_reader")?)?;
    let attachments = content
        .get("attachments")
        .and_then(Value::as_array)
        .ok_or("mail_read_invalid_reader")?
        .iter()
        .map(safe_attachment)
        .collect::<Result<Vec<_>, _>>()?;
    let members = summary
        .get("thread")
        .and_then(|thread| thread.get("memberIds"))
        .and_then(Value::as_array)
        .map(|members| {
            members
                .iter()
                .map(|member| {
                    member
                        .as_str()
                        .filter(|member| {
                            !member.is_empty()
                                && member.len() <= 8192
                                && !member.chars().any(char::is_control)
                        })
                        .map(str::to_owned)
                        .ok_or("mail_read_invalid_reader")
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    let render = safe_render(&value["nativeRender"])?;
    let content = json!({"body":body,"attachments":attachments});
    Ok((
        json!({
            "id":request.id,
            "summary":summary,
            "nativeContent":content,
            "nativeRender":render,
            "attachments":content["attachments"],
        }),
        members,
    ))
}

async fn conversation(
    request: &ReadRequest,
    message: &Value,
    expected: Vec<String>,
    adapter: &impl ReadAdapter,
) -> Result<Vec<Value>, &'static str> {
    if expected.is_empty() {
        return Ok(Vec::new());
    }
    if !expected.iter().any(|member| member == &request.id) {
        return Err("mail_read_conversation_mismatch");
    }
    let result = adapter
        .call(
            "account.conversation",
            json!({
                "operation":"project",
                "thread":message["summary"]["thread"],
                "summaries":{request.id.clone():message["summary"]},
                "selectedId":request.id,
            }),
        )
        .await?;
    let members = result["memberIds"]
        .as_array()
        .ok_or("mail_read_invalid_conversation")?;
    if members.iter().any(|member| {
        member
            .as_str()
            .is_none_or(|member| !expected.iter().any(|expected| expected == member))
    }) {
        return Err("mail_read_conversation_mismatch");
    }
    Ok(members.clone())
}

pub(crate) async fn read_with(
    request: ReadRequest,
    adapter: &impl ReadAdapter,
) -> Result<Value, &'static str> {
    let opened = adapter
        .call(
            "reader.open",
            json!({
                "accountId":request.account.id,
                "id":request.id,
                "requestId":request_id(),
                "cacheOnly":false,
                "now":now(),
                "options":{"allowRemoteImages":false,"withReader":true},
            }),
        )
        .await?;
    let (message, members) = safe_message(&request, opened)?;
    let conversation = conversation(&request, &message, members, adapter).await?;
    Ok(json!({
        "accountId":request.account.id,
        "message":message,
        "conversation":conversation,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaf_nodes(count: usize) -> Vec<Value> {
        (0..count)
            .map(|_| json!({"type":"text","text":"x"}))
            .collect()
    }

    fn nested_document(depth: usize) -> Value {
        let mut node = json!({"type":"element","name":"span","children":[]});
        for _ in 1..depth {
            node = json!({"type":"element","name":"span","children":[node]});
        }
        json!({"type":"root","children":[node]})
    }

    #[test]
    fn safe_render_matches_the_native_document_node_limit() {
        let at_limit = json!({"document":{"type":"root","children":leaf_nodes(MAX_NODES - 1)}});
        let projected = safe_render(&at_limit).unwrap();
        assert_eq!(
            projected["document"]["children"].as_array().unwrap().len(),
            MAX_NODES - 1
        );
        drop(projected);

        let above_limit = json!({"document":{"type":"root","children":leaf_nodes(MAX_NODES)}});
        assert_eq!(
            safe_render(&above_limit).unwrap_err(),
            "mail_read_invalid_reader"
        );
    }

    #[test]
    fn safe_render_matches_the_native_document_depth_limit() {
        assert!(safe_render(&json!({"document":nested_document(MAX_DEPTH)})).is_ok());
        assert_eq!(
            safe_render(&json!({"document":nested_document(MAX_DEPTH + 1)})).unwrap_err(),
            "mail_read_invalid_reader"
        );
    }
}
