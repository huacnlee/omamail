//! Native action planning and submission. Mutations are never retried.
use super::read::{Mailboxes, mailboxes, message_id, resolve};
use super::*;
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use std::collections::BTreeMap;
fn ids(p: &Value) -> Result<BTreeMap<String, Vec<u32>>> {
    let entries = p["ids"].as_array().ok_or("invalid_params")?;
    if entries.len() > 500 {
        return Err("invalid_params");
    }
    let mut groups: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for id in entries {
        let (uid, folder) = message_id(id.as_str().ok_or("invalid_params")?)?;
        groups.entry(folder).or_default().push(uid);
    }
    Ok(groups)
}
fn strings(p: &Value, key: &str) -> Result<Vec<String>> {
    p[key]
        .as_array()
        .ok_or("invalid_params")?
        .iter()
        .map(|v| {
            let value = v.as_str().ok_or("invalid_params")?;
            quote(value)?;
            Ok(value.to_owned())
        })
        .collect()
}
fn plan(
    method: &str,
    p: &Value,
    boxes: &Mailboxes,
) -> Result<(Vec<String>, Vec<String>, Option<String>)> {
    if method == "imap.trash" {
        return Ok((vec![], vec![], Some(resolve(boxes, "\\Trash")?)));
    }
    if method == "imap.untrash" {
        return Ok((vec![], vec!["\\Deleted".into()], Some("INBOX".into())));
    }
    let added = strings(p, "addLabelIds")?;
    let removed = strings(p, "removeLabelIds")?;
    let has = |items: &[String], name: &str| items.iter().any(|v| v.eq_ignore_ascii_case(name));
    let target = if has(&removed, "INBOX") {
        added.first().cloned()
    } else {
        None
    };
    let mut add = Vec::new();
    let mut remove = Vec::new();
    let mut destination = None;
    if target.is_none() && has(&added, "UNREAD") {
        remove.push("\\Seen".into())
    }
    if has(&removed, "UNREAD") {
        add.push("\\Seen".into())
    }
    if target.is_none() && has(&added, "STARRED") {
        add.push("\\Flagged".into())
    }
    if has(&removed, "STARRED") {
        remove.push("\\Flagged".into())
    }
    if has(&removed, "INBOX") {
        destination = Some(if let Some(target) = target.clone() {
            quote(&target)?;
            target
        } else {
            resolve(boxes, "\\Archive")?
        });
    }
    if target.is_none() {
        for (label, folder) in [("INBOX", "INBOX"), ("TRASH", "\\Trash"), ("SPAM", "\\Junk")] {
            if has(&added, label) {
                destination = Some(resolve(boxes, folder)?);
            }
        }
    }
    Ok((add, remove, destination))
}
fn encoded_mailbox(name: &str) -> Result<String> {
    if name.trim().is_empty() || name.len() > 4096 || !safe(name) {
        return Err("invalid_params");
    }
    let mut out = String::new();
    let mut run = Vec::new();
    fn flush(out: &mut String, run: &mut Vec<u8>) {
        if !run.is_empty() {
            out.push('&');
            out.push_str(&STANDARD_NO_PAD.encode(&*run).replace('/', ","));
            out.push('-');
            run.clear();
        }
    }
    for ch in name.chars() {
        if ch.is_ascii() {
            flush(&mut out, &mut run);
            if ch == '&' {
                out.push_str("&-")
            } else {
                out.push(ch)
            }
        } else {
            let mut buf = [0; 2];
            for unit in ch.encode_utf16(&mut buf) {
                run.extend_from_slice(&unit.to_be_bytes());
            }
        }
    }
    flush(&mut out, &mut run);
    Ok(out)
}
async fn append(w: &mut Wire, folder: &str, body: &[u8], flag: &str) -> Result<()> {
    write(
        w,
        format!(
            "O1 APPEND {} ({flag}) {{{}}}\r\n",
            quote(folder)?,
            body.len()
        )
        .as_bytes(),
    )
    .await?;
    let answer = line(w).await?;
    if !answer.starts_with(b"+") {
        return Err("imap_command_failed");
    }
    write(w, body).await?;
    write(w, b"\r\n").await?;
    response(w, "O1", false).await?;
    Ok(())
}
async fn delete_uid(w: &mut Wire, uid: u32) -> Result<()> {
    command(w, &format!("UID STORE {uid} +FLAGS.SILENT (\\Deleted)")).await?;
    command(w, &format!("UID EXPUNGE {uid}")).await?;
    Ok(())
}
fn raw(p: &Value) -> Result<Vec<u8>> {
    let text = string(p, "raw")?;
    if text.len() > LIMIT * 4 / 3 + 4 {
        return Err("invalid_params");
    }
    let body = URL_SAFE_NO_PAD.decode(text).map_err(|_| "invalid_params")?;
    if body.is_empty() || body.len() > crate::message::MAX_MESSAGE {
        return Err("invalid_params");
    }
    Ok(body)
}
fn envelope(body: &[u8], fallback: &str) -> Result<(String, Vec<String>)> {
    use mailparse::MailHeaderMap;
    let parsed = mailparse::parse_mail(body).map_err(|_| "invalid_message")?;
    fn addresses(value: &str) -> Result<Vec<String>> {
        let mut out = Vec::new();
        for address in mailparse::addrparse(value)
            .map_err(|_| "invalid_message")?
            .iter()
        {
            match address {
                mailparse::MailAddr::Single(addr) => out.push(addr.addr.clone()),
                mailparse::MailAddr::Group(group) => {
                    out.extend(group.addrs.iter().map(|a| a.addr.clone()))
                }
            }
        }
        Ok(out)
    }
    let from = parsed
        .headers
        .get_first_value("From")
        .map(|v| addresses(&v))
        .transpose()?
        .and_then(|v| v.into_iter().next())
        .unwrap_or_else(|| fallback.into());
    let mut recipients = Vec::new();
    for key in ["To", "Cc", "Bcc"] {
        for header in parsed.headers.get_all_values(key) {
            for address in addresses(&header)? {
                if !recipients.contains(&address) {
                    recipients.push(address);
                }
            }
        }
    }
    if recipients.is_empty() {
        return Err("smtp_no_recipients");
    }
    Ok((from, recipients))
}
fn without_bcc(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len());
    let mut headers = true;
    let mut omit = false;
    for line in body.split_inclusive(|b| *b == b'\n') {
        if headers {
            let content = line
                .strip_suffix(b"\n")
                .unwrap_or(line)
                .strip_suffix(b"\r")
                .unwrap_or(line.strip_suffix(b"\n").unwrap_or(line));
            if content.is_empty() {
                headers = false;
                omit = false;
            } else if !matches!(line.first(), Some(b' ' | b'\t')) {
                omit = content
                    .iter()
                    .position(|b| *b == b':')
                    .is_some_and(|at| content[..at].trim_ascii().eq_ignore_ascii_case(b"Bcc"));
            }
        }
        if !omit {
            out.extend_from_slice(line)
        }
    }
    out
}
pub(super) fn validate(method: &str, p: &Value) -> Result<()> {
    match method {
        "imap.createFolder" => {
            encoded_mailbox(string(p, "name")?)?;
        }
        "imap.renameFolder" => {
            let id = string(p, "id")?;
            if id.is_empty() {
                return Err("invalid_params");
            }
            quote(id)?;
            encoded_mailbox(string(p, "name")?)?;
        }
        "imap.deleteFolder" => {
            let id = string(p, "id")?;
            if id.is_empty() {
                return Err("invalid_params");
            }
            quote(id)?;
        }
        "imap.modify" => {
            ids(p)?;
            strings(p, "addLabelIds")?;
            strings(p, "removeLabelIds")?;
        }
        "imap.trash" | "imap.untrash" => {
            ids(p)?;
        }
        "imap.deleteDraft" => {
            message_id(string(p, "id")?)?;
        }
        "imap.saveDraft" | "imap.send" => {
            let body = raw(p)?;
            if method == "imap.saveDraft"
                && let Some(value) = p.get("draftId")
            {
                let id = value.as_str().ok_or("invalid_params")?;
                if !id.is_empty() {
                    message_id(id)?;
                }
            }
            if method == "imap.send" {
                smtp_data(&body)?;
                envelope(&body, "unused@example.org")?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub(super) async fn call(
    method: &str,
    p: &Value,
    sent: &std::sync::atomic::AtomicBool,
) -> Result<Value> {
    if method == "imap.send" {
        let body = raw(p)?;
        if p["oauth"] == true && p["settings"]["send"] == "graph" {
            let result = crate::auth::Session::default()
                .call(
                    "outlook.graphSend",
                    &json!({"accountId":p["accountId"],"raw":p["raw"]}),
                )
                .await?;
            sent.store(true, std::sync::atomic::Ordering::SeqCst);
            return Ok(result);
        }
        let (from, recipients) = envelope(&body, string(&p["settings"], "username")?)?;
        let mut submit = p.clone();
        submit["from"] = json!(from);
        submit["recipients"] = json!(recipients);
        submit["body"] = json!(STANDARD.encode(without_bcc(&body)));
        super::send(&submit).await?;
        sent.store(true, std::sync::atomic::Ordering::SeqCst);
        let copy = async {
            let (mut w, key) = acquire(p).await?;
            let boxes = mailboxes(&mut w, p).await?;
            let folder = resolve(&boxes, "\\Sent")?;
            append(&mut w, &folder, &body, "\\Seen").await?;
            release(w, key).await;
            Ok::<_, &'static str>(())
        }
        .await;
        return Ok(
            json!({"sent":true,"warning":if copy.is_ok(){""}else{"Sent, but the copy for the Sent folder could not be saved"}}),
        );
    }
    // Validate every mutation's identifiers and bytes before connecting.
    let folder_command = match method {
        "imap.createFolder" => Some(format!(
            "CREATE {}",
            quote(&encoded_mailbox(string(p, "name")?)?)?
        )),
        "imap.renameFolder" => Some(format!(
            "RENAME {} {}",
            quote(string(p, "id")?)?,
            quote(&encoded_mailbox(string(p, "name")?)?)?
        )),
        "imap.deleteFolder" => {
            let id = string(p, "id")?;
            if id.is_empty() {
                return Err("invalid_params");
            }
            Some(format!("DELETE {}", quote(id)?))
        }
        _ => None,
    };
    let groups = if matches!(method, "imap.modify" | "imap.trash" | "imap.untrash") {
        let groups = ids(p)?;
        if method == "imap.modify" {
            strings(p, "addLabelIds")?;
            strings(p, "removeLabelIds")?;
        }
        Some(groups)
    } else {
        None
    };
    let draft = if method == "imap.saveDraft" {
        Some(raw(p)?)
    } else {
        None
    };
    let deleting = if method == "imap.deleteDraft" {
        Some(message_id(string(p, "id")?)?)
    } else {
        None
    };
    let (mut w, key) = acquire(p).await?;
    let result = if let Some(command_text) = folder_command {
        command(&mut w, &command_text).await?;
        read::invalidate().await;
        json!({})
    } else {
        let boxes = mailboxes(&mut w, p).await?;
        if let Some(groups) = groups {
            let (add, remove, destination) = plan(method, p, &boxes)?;
            for (folder, uids) in groups {
                command(&mut w, &format!("SELECT {}", quote(&folder)?)).await?;
                let set = uids
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(",");
                for (mode, flags) in [("+", &add), ("-", &remove)] {
                    if !flags.is_empty() {
                        command(
                            &mut w,
                            &format!("UID STORE {set} {mode}FLAGS.SILENT ({})", flags.join(" ")),
                        )
                        .await?;
                    }
                }
                if let Some(target) = &destination
                    && target != &folder
                {
                    if boxes
                        .capabilities
                        .iter()
                        .any(|v| v.eq_ignore_ascii_case("MOVE"))
                    {
                        command(&mut w, &format!("UID MOVE {set} {}", quote(target)?)).await?;
                    } else {
                        command(&mut w, &format!("UID COPY {set} {}", quote(target)?)).await?;
                        command(
                            &mut w,
                            &format!("UID STORE {set} +FLAGS.SILENT (\\Deleted)"),
                        )
                        .await?;
                        command(&mut w, &format!("UID EXPUNGE {set}")).await?;
                    }
                }
            }
            json!({})
        } else if let Some(body) = draft {
            let folder = resolve(&boxes, "\\Drafts")?;
            append(&mut w, &folder, &body, "\\Draft").await?;
            let warning = if let Some(id) = p["draftId"].as_str().filter(|id| !id.is_empty()) {
                if let Ok((uid, previous_folder)) = message_id(id)
                    && previous_folder == folder
                {
                    let cleanup = async {
                        command(&mut w, &format!("SELECT {}", quote(&folder)?)).await?;
                        delete_uid(&mut w, uid).await
                    }
                    .await;
                    if cleanup.is_ok() {
                        ""
                    } else {
                        "The updated draft was saved, but the old copy could not be removed"
                    }
                } else {
                    "The updated draft was saved, but the old copy could not be identified"
                }
            } else {
                ""
            };
            json!({"saved":true,"warning":warning})
        } else if let Some((uid, folder)) = deleting {
            command(&mut w, &format!("SELECT {}", quote(&folder)?)).await?;
            delete_uid(&mut w, uid).await?;
            json!({})
        } else {
            return Err("method_not_found");
        }
    };
    release(w, key).await;
    Ok(result)
}
#[cfg(test)]
mod tests;
