//! CPU-bound message preparation shared by CLI and the persistent UI session.
use crate::{cache::render::RenderCache, message};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) fn call(
    method: &str,
    params: &Value,
    cache: &Arc<Mutex<RenderCache>>,
) -> Result<Value, &'static str> {
    match method {
        "message.prepareCached" => {
            crate::cache::validate_params(params, true)?;
            let resource = crate::cache::call("cache.resourceRead", params)?;
            if resource.is_null() {
                return Ok(Value::Null);
            }
            prepared_projection(resource, params.get("now"))
        }
        "message.parse" => message::request(params),
        "message.compose" => message::compose::request(params),
        "message.prepare" | "message.summarize" | "message.summaries" | "message.composeText" => {
            message::content::request(method, params)
        }
        "message.render" => render(params, cache, None),
        "message.direction" => {
            let source = params["text"].as_str().ok_or("invalid_params")?;
            let mode = params["mode"].as_str().unwrap_or("Auto");
            let direction = match params["kind"].as_str().unwrap_or("text") {
                "subject" => message::direction::resolve_subject(source, mode),
                "body" => message::direction::resolve_body(source, mode),
                "text" => message::direction::resolve(source, mode),
                _ => return Err("invalid_params"),
            };
            Ok(
                json!({"direction":direction,"attribute":message::direction::attribute_for(direction),
                "startEdge":message::direction::start_edge(direction),"endEdge":message::direction::end_edge(direction)}),
            )
        }
        "message.signatureImport" => {
            let data = params["data"].as_str().ok_or("invalid_params")?;
            match params["kind"].as_str() {
                Some("html") => message::signature::import_html(data, &params["options"]),
                Some("image") => Ok(message::signature::import_image(data, &params["options"])),
                _ => Err("invalid_params"),
            }
        }
        "message.signatureInline" => Ok(message::signature::inline_parts(
            params["html"].as_str().ok_or("invalid_params")?,
            params["prefix"].as_str().unwrap_or("signature"),
        )),
        _ => Err("unknown_method"),
    }
}

// The cached MIME tree stays native. The reader receives decoded content and
// attachment locators, not base64 payloads it would immediately upload again.
fn prepared_projection(mut resource: Value, now: Option<&Value>) -> Result<Value, &'static str> {
    let mut params = json!({"message":resource});
    if let Some(now) = now {
        params["now"] = now.clone();
    }
    let prepared = message::content::request("message.prepare", &params)?;
    // Release the temporary input copy before constructing the reader result.
    drop(params);
    fn strip(part: &mut Value, depth: usize, remaining: &mut usize) -> Result<(), &'static str> {
        if depth > 32 || *remaining == 0 {
            return Err("too_many_mime_parts");
        }
        *remaining -= 1;
        let calendar = part["mimeType"]
            .as_str()
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("text/calendar");
        if !calendar && let Some(body) = part["body"].as_object_mut() {
            body.remove("data");
        }
        if let Some(parts) = part["parts"].as_array_mut() {
            for child in parts {
                strip(child, depth + 1, remaining)?;
            }
        }
        Ok(())
    }
    strip(&mut resource["payload"], 0, &mut 4096)?;
    resource["nativeSummary"] = prepared["summary"].clone();
    resource["nativeContent"] = prepared;
    Ok(resource)
}

pub(super) fn render(
    params: &Value,
    cache: &Arc<Mutex<RenderCache>>,
    live: Option<&Arc<Mutex<bool>>>,
) -> Result<Value, &'static str> {
    let account = params["accountId"].as_str().unwrap_or("");
    let id = params["messageId"].as_str().unwrap_or("");
    let source = params["html"].as_str().ok_or("invalid_params")?;
    let mut policy = params.clone();
    let object = policy.as_object_mut().ok_or("invalid_params")?;
    for field in ["accountId", "messageId", "html"] {
        object.remove(field);
    }
    if !account.is_empty()
        && !id.is_empty()
        && let Some(value) = cache
            .lock()
            .map_err(|_| "session_failed")?
            .get(account, id, source, &policy)
    {
        return Ok(value);
    }
    let value = message::html::request(params)?;
    let guard = live
        .map(|live| live.lock().map_err(|_| "session_failed"))
        .transpose()?;
    if guard.as_ref().is_some_and(|v| !**v) {
        return Err("reader_cancelled");
    }
    if !account.is_empty() && !id.is_empty() {
        let _ = cache.lock().map_err(|_| "session_failed")?.put(
            account,
            id,
            source,
            &policy,
            value.clone(),
        );
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

    #[test]
    fn cached_reader_projection_keeps_content_and_locators_without_attachment_octets() {
        let bytes = URL_SAFE_NO_PAD.encode(vec![b'x'; 1024 * 1024]);
        let resource = json!({"id":"one", "payload":{"mimeType":"multipart/mixed", "headers":[], "parts":[
            {"mimeType":"text/plain","body":{"data":URL_SAFE_NO_PAD.encode("hello")}},
            {"mimeType":"application/octet-stream","filename":"large.bin","body":{"attachmentId":"download-one","size":1048576,"data":bytes}},
            {"mimeType":"text/calendar","body":{"data":URL_SAFE_NO_PAD.encode("BEGIN:VCALENDAR\r\nEND:VCALENDAR")}}
        ]}});
        let result = prepared_projection(resource, Some(&json!(0))).unwrap();
        assert_eq!(result["nativeContent"]["body"]["text"], "hello");
        assert_eq!(
            result["nativeContent"]["attachments"][0]["attachmentId"],
            "download-one"
        );
        assert!(result["payload"]["parts"][0]["body"].get("data").is_none());
        assert!(result["payload"]["parts"][1]["body"].get("data").is_none());
        assert!(result["payload"]["parts"][2]["body"]["data"].is_string());
        assert!(serde_json::to_vec(&result).unwrap().len() < 8192);
    }

    #[test]
    fn cached_projection_refuses_invalid_clock() {
        assert!(prepared_projection(json!({"payload":{}}), Some(&json!("invalid"))).is_err());
    }
}
