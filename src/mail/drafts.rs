//! Content-addressed private snapshots: approval names the exact frozen content.
use crate::mail::send::Prepared;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::Read;

const LIMIT: usize = 64 * 1024 * 1024;

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn save(prepared: Prepared) -> Result<Value, &'static str> {
    let bytes = serde_json::to_vec(&prepared.record()).map_err(|_| "mail_draft_invalid")?;
    if bytes.len() > LIMIT {
        return Err("mail_draft_too_large");
    }
    let id = digest(&bytes);
    let root = crate::platform::dirs::AppDirs::discover()?.state;
    let dir = crate::cache::directories(&root, &["omamail", "cli-drafts"], true)?
        .ok_or("mail_draft_unavailable")?;
    crate::platform::private_fs::atomic_replace(&dir, &format!("{id}.json"), &bytes)?;
    preview(&prepared, &id)
}

pub(crate) fn preview(prepared: &Prepared, id: &str) -> Result<Value, &'static str> {
    use base64::Engine;
    let mut preview = prepared.preview();
    let record = prepared.record();
    let attachments = record["fields"]["attachments"]
        .as_array()
        .ok_or("mail_draft_invalid")?;
    preview["attachments"] = json!(
        attachments
            .iter()
            .map(|file| {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(file["data"].as_str().ok_or("mail_draft_invalid")?)
                    .map_err(|_| "mail_draft_invalid")?;
                Ok::<_, &'static str>(
                    json!({"name":file["filename"],"size":file["size"],"sha256":digest(&bytes)}),
                )
            })
            .collect::<Result<Vec<_>, _>>()?
    );
    preview["draftId"] = json!(id);
    preview["sendId"] = json!(format!("draft-{id}"));
    preview["frozen"] = json!(true);
    Ok(preview)
}

pub(crate) fn load(id: &str) -> Result<Prepared, &'static str> {
    if id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("mail_draft_invalid_id");
    }
    let root = crate::platform::dirs::AppDirs::discover()?.state;
    let dir = crate::cache::directories(&root, &["omamail", "cli-drafts"], false)?
        .ok_or("mail_draft_not_found")?;
    let file =
        crate::cache::regular(&dir, &format!("{id}.json"), false)?.ok_or("mail_draft_not_found")?;
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "mail_draft_unavailable")?;
    if bytes.len() > LIMIT || digest(&bytes) != id {
        return Err("mail_draft_changed");
    }
    Prepared::restore(serde_json::from_slice(&bytes).map_err(|_| "mail_draft_invalid")?)
}
