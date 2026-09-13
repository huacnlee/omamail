//! Execute only the registered account's native provider send, exactly once.
use serde_json::{Value, json};
use std::time::Duration;

/// The queued MIME owns its bytes. HEY's official CLI needs paths, so create
/// private copies only for the delivery attempt and keep them alive until it
/// exits. No caller-selected path is reopened for MIME-backed attachments.
struct HeyAttachments {
    directory: Option<std::path::PathBuf>,
    paths: Vec<Value>,
}

impl HeyAttachments {
    fn from_raw(raw: &str) -> Result<Self, &'static str> {
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
        use std::{
            io::{Read, Write},
            os::unix::fs::{DirBuilderExt, OpenOptionsExt},
        };
        if raw.len() > 16 * 1024 * 1024 * 4 / 3 + 4 {
            return Err("outbox_invalid_payload");
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(raw)
            .map_err(|_| "outbox_invalid_payload")?;
        let mail = mailparse::parse_mail(&bytes).map_err(|_| "outbox_invalid_payload")?;
        fn collect(
            mail: &mailparse::ParsedMail<'_>,
            depth: usize,
            files: &mut Vec<(String, Vec<u8>)>,
            total: &mut usize,
        ) -> Result<(), &'static str> {
            if depth > 32 {
                return Err("outbox_invalid_payload");
            }
            let disposition = mail.get_content_disposition();
            if disposition.disposition == mailparse::DispositionType::Attachment {
                let name = crate::message::content::decoded_header(
                    disposition
                        .params
                        .get("filename")
                        .map(String::as_str)
                        .unwrap_or("attachment"),
                );
                if name.is_empty()
                    || name.len() > 240
                    || name.contains('/')
                    || matches!(name.as_str(), "." | "..")
                    || name.chars().any(char::is_control)
                    || files.len() == 32
                {
                    return Err("outbox_invalid_payload");
                }
                let bytes = mail.get_body_raw().map_err(|_| "outbox_invalid_payload")?;
                *total = total.saturating_add(bytes.len());
                if bytes.len() > 16 * 1024 * 1024 || *total > crate::attachment::MAX_BYTES {
                    return Err("outbox_invalid_payload");
                }
                files.push((name, bytes));
            }
            for child in &mail.subparts {
                collect(child, depth + 1, files, total)?;
            }
            Ok(())
        }
        let mut files = Vec::new();
        collect(&mail, 0, &mut files, &mut 0)?;
        let mut staged = Self {
            directory: None,
            paths: Vec::new(),
        };
        if files.is_empty() {
            return Ok(staged);
        }
        let mut random = [0; 16];
        std::fs::File::open("/dev/urandom")
            .and_then(|mut file| file.read_exact(&mut random))
            .map_err(|_| "outbox_attachment_unavailable")?;
        let directory =
            std::env::temp_dir().join(format!("omamail-send-{}", URL_SAFE_NO_PAD.encode(random)));
        if !directory.is_absolute() {
            return Err("outbox_attachment_unavailable");
        }
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .map_err(|_| "outbox_attachment_unavailable")?;
        staged.directory = Some(directory.clone());
        for (index, (name, bytes)) in files.into_iter().enumerate() {
            let folder = directory.join(index.to_string());
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&folder)
                .map_err(|_| "outbox_attachment_unavailable")?;
            let path = folder.join(&name);
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&path)
                .map_err(|_| "outbox_attachment_unavailable")?;
            file.write_all(&bytes)
                .map_err(|_| "outbox_attachment_unavailable")?;
            staged.paths.push(json!({"path":path,"filename":name}));
        }
        Ok(staged)
    }

    fn paths(&self) -> Value {
        json!(self.paths)
    }
}

impl Drop for HeyAttachments {
    fn drop(&mut self) {
        if let Some(directory) = &self.directory {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
}

pub async fn send(
    job: &Value,
    gmail: &crate::providers::gmail::Session,
    jmap: &crate::providers::jmap::Session,
) -> Result<Value, &'static str> {
    let account = super::text(job, "accountId")?.to_owned();
    let provider = super::text(job, "provider")?.to_owned();
    let registry = tokio::task::spawn_blocking(crate::account::list)
        .await
        .map_err(|_| "outbox_account_unavailable")?
        .map_err(|_| "outbox_account_unavailable")?;
    if !registry["accounts"].as_array().is_some_and(|accounts| {
        accounts.iter().any(|entry| {
            entry["id"] == account && entry["provider"] == provider && entry["pending"] != true
        })
    }) {
        return Err("outbox_account_unavailable");
    }
    let payload = job["payload"].as_object().ok_or("outbox_invalid_payload")?;
    if payload
        .keys()
        .any(|key| !["raw", "threadId", "draftId", "attachments", "sendId"].contains(&key.as_str()))
    {
        return Err("outbox_invalid_payload");
    }
    let raw = payload
        .get("raw")
        .and_then(Value::as_str)
        .filter(|raw| !raw.is_empty())
        .ok_or("outbox_invalid_payload")?;
    let mut params = json!({"accountId":account,"raw":raw});
    if matches!(provider.as_str(), "gmail" | "jmap" | "hey")
        && let Some(thread) = payload.get("threadId")
    {
        params["threadId"] = thread.clone();
    }
    let draft = payload.get("draftId").and_then(Value::as_str).unwrap_or("");
    if draft.len() > 1024 || draft.chars().any(char::is_control) {
        return Err("outbox_invalid_payload");
    }
    if provider == "jmap" && !draft.is_empty() {
        params["draftId"] = json!(draft);
    }
    let mut answer = match provider.as_str() {
        "gmail" => gmail.call("gmail.send", &params).await?,
        "imap" | "outlook" => crate::providers::imap::call("imap.send", &params).await?,
        "jmap" => jmap.call("jmap.send", &params).await?,
        "hey" => {
            params["program"] = json!(crate::providers::hey_access::program()?);
            let raw = raw.to_owned();
            let staged = tokio::task::spawn_blocking(move || HeyAttachments::from_raw(&raw))
                .await
                .map_err(|_| "outbox_attachment_unavailable")??;
            if !staged.paths.is_empty() {
                params["attachments"] = staged.paths();
            } else if let Some(attachments) = payload.get("attachments") {
                params["attachments"] = attachments.clone();
            }
            let checked = crate::providers::hey_access::checked_params(&params).await?;
            let answer = crate::providers::hey_actions::call("hey.send", &checked).await?;
            drop(staged);
            answer
        }
        _ => return Err("outbox_invalid_provider"),
    };
    if !answer.is_object() {
        answer = json!({});
    }
    if !draft.is_empty() {
        // JMAP destroys the source draft in its successful submission flow.
        // A failed cleanup cannot turn confirmed delivery into a retryable send.
        let cleanup = async {
            let params = json!({"accountId":account,"id":draft});
            match provider.as_str() {
                "gmail" => gmail.call("gmail.deleteDraft", &params).await.map(|_| ()),
                "imap" | "outlook" => crate::providers::imap::call("imap.deleteDraft", &params)
                    .await
                    .map(|_| ()),
                "jmap" if answer["draftRemoved"] == true => Ok(()),
                _ => Err("outbox_draft_cleanup_unavailable"),
            }
        };
        if tokio::time::timeout(Duration::from_secs(5), cleanup).await == Ok(Ok(())) {
            answer["draftRemoved"] = json!(true);
        } else {
            answer["warning"] = json!("Sent, but the original draft could not be removed");
        }
    }
    Ok(answer)
}

#[cfg(test)]
mod attachment_tests {
    use super::*;
    use base64::{Engine, engine::general_purpose::STANDARD};
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn hey_materializes_the_durable_mime_bytes_and_cleans_private_files() {
        let payload = crate::message::compose::build(&json!({"to":"one@example.org","body":"private body","attachments":[{"filename":"quote\\工\".txt","data":STANDARD.encode(b"validated bytes")},{"filename":"quote\\工\".txt","data":STANDARD.encode(b"second") }]})).unwrap();
        let staged = HeyAttachments::from_raw(payload["raw"].as_str().unwrap()).unwrap();
        let paths = staged.paths();
        assert_eq!(paths.as_array().unwrap().len(), 2);
        let first = std::path::PathBuf::from(paths[0]["path"].as_str().unwrap());
        assert_eq!(first.file_name().unwrap(), "quote\\工\".txt");
        assert_eq!(std::fs::read(&first).unwrap(), b"validated bytes");
        assert_eq!(
            std::fs::metadata(&first).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(first.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::read(paths[1]["path"].as_str().unwrap()).unwrap(),
            b"second"
        );
        drop(staged);
        assert!(!first.exists());
    }

    #[test]
    fn hey_rejects_mime_filename_traversal_before_writing() {
        let payload = crate::message::compose::build(&json!({"body":"body","attachments":[{"filename":"../escape","data":STANDARD.encode(b"bad") }]})).unwrap();
        assert!(HeyAttachments::from_raw(payload["raw"].as_str().unwrap()).is_err());
    }
}
