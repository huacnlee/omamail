//! Validate a semantic message once; previews own no mutable service or storage.
use super::{Account, Provider, SendRequest};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs::File, future::Future, io::Read, path::Path, pin::Pin};

pub(crate) const MAX_BODY: usize = 16 * 1024 * 1024;
const MAX_HEADER: usize = 8192;
const MAX_ATTACHMENTS: usize = 32;
const MAX_BYTES: usize = crate::attachment::MAX_BYTES;
type Result<T> = std::result::Result<T, &'static str>;

pub(crate) trait IdentityLookup: Send + Sync {
    /// Read-only provider aliases, already scoped to this registered account.
    fn identities<'a>(
        &'a self,
        account: &'a Account,
    ) -> Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>>;
}

pub(crate) struct Prepared {
    pub account: Account,
    fields: Value,
    preview: Value,
}

fn header(value: &str) -> Result<()> {
    // Inputs are decoded text. The composer owns encoded words; accepting one
    // here lets a downstream MIME decoder change a previewed name or envelope.
    if value.len() > MAX_HEADER || value.chars().any(char::is_control) || value.contains("=?") {
        Err("mail_send_invalid_header")
    } else {
        Ok(())
    }
}

fn address(value: &str) -> Result<()> {
    if value.len() > 254 || !value.is_ascii() {
        return Err("mail_send_invalid_address");
    }
    let Some((local, domain)) = value.split_once('@') else {
        return Err("mail_send_invalid_address");
    };
    if local.len() > 64
        || !local.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-/=?^_`{|}~".contains(&b))
        })
        || !domain.contains('.')
        || !domain.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err("mail_send_invalid_address");
    }
    Ok(())
}

fn display(email: &str, name: &str) -> String {
    if name.is_empty() {
        return email.into();
    }
    let name = if name.chars().any(|c| "\"\\,;<>@():[]".contains(c)) {
        format!("\"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        name.to_owned()
    };
    format!("{name} <{email}>")
}

fn parsed(value: &str) -> Result<Vec<(String, String)>> {
    header(value)?;
    let values = mailparse::addrparse(value).map_err(|_| "mail_send_invalid_address")?;
    if values.is_empty() {
        return Err("mail_send_invalid_address");
    }
    values
        .iter()
        .map(|value| {
            let mailparse::MailAddr::Single(single) = value else {
                return Err("mail_send_invalid_address");
            };
            address(&single.addr)?;
            let name = single.display_name.as_deref().unwrap_or("");
            header(name)?;
            Ok((single.addr.clone(), name.to_owned()))
        })
        .collect()
}

fn recipients(values: &[String], seen: &mut HashSet<String>) -> Result<Vec<String>> {
    if values.len() > 1000 {
        return Err("mail_send_recipient_limit");
    }
    let mut out = Vec::new();
    for value in values {
        for (email, name) in parsed(value)? {
            if seen.insert(email.to_ascii_lowercase()) {
                if seen.len() > 1000 {
                    return Err("mail_send_recipient_limit");
                }
                out.push(display(&email, &name));
            }
        }
    }
    header(&out.join(", "))?;
    Ok(out)
}

/// Walk descriptors so neither the last component nor an ancestor can be a
/// symlink. NONBLOCK prevents a named pipe from hanging before fstat rejects it.
fn open_file(path: &Path) -> Result<File> {
    crate::platform::private_fs::open_external(path)
}

fn attachment(input: &super::AttachmentInput, total: &mut usize) -> Result<Value> {
    header(&input.name)?;
    if input.name.is_empty()
        || input.name.len() > 240
        || matches!(input.name.as_str(), "." | "..")
        || input.name.contains('/')
    {
        return Err("mail_send_attachment_name");
    }
    let file = open_file(&input.path)?;
    let before = file
        .metadata()
        .map_err(|_| "mail_send_attachment_unreadable")?;
    if !before.is_file() {
        return Err("mail_send_attachment_not_regular");
    }
    if before.len() > MAX_BYTES as u64 || before.len() > (MAX_BYTES - *total) as u64 {
        return Err("mail_send_attachment_too_large");
    }
    if before.len() != input.size {
        return Err("mail_send_attachment_changed");
    }
    let mut bytes = Vec::new();
    (&file)
        .take((MAX_BYTES - *total + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "mail_send_attachment_unreadable")?;
    let after = file
        .metadata()
        .map_err(|_| "mail_send_attachment_unreadable")?;
    if bytes.len() > MAX_BYTES - *total {
        return Err("mail_send_attachment_too_large");
    }
    if bytes.len() as u64 != before.len()
        || before.len() != after.len()
        || !crate::platform::private_fs::same_file_version(&before, &after)
    {
        return Err("mail_send_attachment_changed");
    }
    *total += bytes.len();
    Ok(
        json!({"filename":input.name,"size":bytes.len(),"mimeType":"application/octet-stream","data":STANDARD.encode(bytes)}),
    )
}

pub(crate) fn prepare(request: &SendRequest, aliases: &Value) -> Result<Prepared> {
    header(&request.from)?;
    header(&request.subject)?;
    if request.body.len() > MAX_BODY || request.body.contains('\0') {
        return Err("mail_send_invalid_body");
    }
    if request.attachments.len() > MAX_ATTACHMENTS {
        return Err("mail_send_attachment_limit");
    }
    let mut seen = HashSet::new();
    let to = recipients(&request.to, &mut seen)?;
    let cc = recipients(&request.cc, &mut seen)?;
    let bcc = recipients(&request.bcc, &mut seen)?;
    if seen.is_empty() {
        return Err("mail_send_no_recipients");
    }
    let aliases = aliases
        .as_array()
        .filter(|rows| rows.len() <= 1024)
        .ok_or("mail_send_identities_invalid")?;
    let wanted = if request.from.is_empty() {
        None
    } else {
        let parsed = parsed(&request.from)?;
        if parsed.len() != 1 {
            return Err("mail_send_invalid_address");
        }
        Some(parsed[0].0.clone())
    };
    let chosen = if let Some(wanted) = wanted {
        aliases.iter().find(|alias| {
            alias["email"]
                .as_str()
                .is_some_and(|email| email.eq_ignore_ascii_case(&wanted))
        })
    } else {
        aliases
            .iter()
            .find(|alias| alias["isDefault"] == true)
            .or_else(|| aliases.iter().find(|alias| alias["isPrimary"] == true))
            .or_else(|| aliases.first())
    }
    .ok_or("mail_send_sender_unavailable")?;
    // The account-qualified merger is the same identity path the composer uses.
    let merged = crate::account::senders::request(
        &json!({"mailboxes":[{"id":request.account.id,"ready":true,"aliases":[chosen]}]}),
    )?;
    let identity = &merged["identities"][0];
    let email = identity["email"]
        .as_str()
        .ok_or("mail_send_sender_unavailable")?;
    let name = identity["displayName"]
        .as_str()
        .ok_or("mail_send_sender_unavailable")?;
    header(email)?;
    header(name)?;
    address(email)?;
    // Do not silently trim provider-controlled header bytes before validation.
    header(
        chosen["email"]
            .as_str()
            .ok_or("mail_send_sender_unavailable")?,
    )?;
    let mut total = 0;
    let attachments = request
        .attachments
        .iter()
        .map(|input| attachment(input, &mut total))
        .collect::<Result<Vec<_>>>()?;
    Ok(Prepared {
        account: request.account.clone(),
        fields: json!({"from":email,"fromName":name,"to":to.join(", "),"cc":cc.join(", "),"bcc":bcc.join(", "),"subject":request.subject,"body":request.body,"attachments":attachments}),
        preview: json!({"dryRun":true,"executed":false,"accountId":request.account.id,"from":display(email,name),"to":to,"cc":cc,"bcc":bcc,"subject":request.subject,"body":request.body,"attachments":attachments.iter().map(|file|json!({"name":file["filename"],"size":file["size"]})).collect::<Vec<_>>()}),
    })
}

impl Prepared {
    pub(crate) fn preview(&self) -> Value {
        self.preview.clone()
    }

    /// Timestamp and seed are retained by the outbox for explicit send IDs, so
    /// duplicate requests use its original digest even after payload removal.
    pub(crate) fn payload(&self, stamp: u64, seed: &str) -> Result<Value> {
        let mut fields = self.fields.clone();
        let digest = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!([fields, stamp, seed])).map_err(|_| "invalid_params")?
            )
        );
        fields["boundary"] = json!(format!("=_Omamail_{}", &digest[..40]));
        fields["messageId"] = json!(format!("<{digest}@omamail.invalid>"));
        fields["date"] = json!(
            chrono::DateTime::from_timestamp_millis(
                i64::try_from(stamp).map_err(|_| "invalid_params")?
            )
            .ok_or("invalid_params")?
            .format("%a, %d %b %Y %H:%M:%S %z")
            .to_string()
        );
        let payload = crate::message::compose::build(&fields)?;
        let encoded = payload["raw"].as_str().ok_or("invalid_params")?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "invalid_message")?;
        validate_size(self.account.provider, bytes.len(), encoded.len())?;
        verify_envelope(&bytes, &self.fields)?;
        Ok(payload)
    }
}

pub(super) fn verify_envelope(bytes: &[u8], fields: &Value) -> Result<()> {
    let (headers, _) = mailparse::parse_headers(bytes).map_err(|_| "invalid_message")?;
    if crate::message::envelope::sender(&headers)?.as_deref() != fields["from"].as_str() {
        return Err("mail_send_envelope_mismatch");
    }
    for (field, name) in [("to", "To"), ("cc", "Cc"), ("bcc", "Bcc")] {
        let text = fields[field].as_str().unwrap_or("");
        let expected: Vec<_> = if text.is_empty() {
            vec![]
        } else {
            parsed(text)?
                .into_iter()
                .map(|(address, _)| address)
                .collect()
        };
        if crate::message::envelope::addresses(&headers, name)? != expected {
            return Err("mail_send_envelope_mismatch");
        }
    }
    Ok(())
}

pub(super) fn validate_size(
    provider: Provider,
    decoded_len: usize,
    encoded_len: usize,
) -> Result<()> {
    if (provider == Provider::Hey && encoded_len > 16 * 1024 * 1024 * 4 / 3)
        || (provider == Provider::Jmap && encoded_len > 24 * 1024 * 1024)
        || (matches!(provider, Provider::Imap | Provider::Outlook)
            && decoded_len > crate::message::MAX_MESSAGE)
    {
        return Err("message_too_large");
    }
    Ok(())
}

pub(crate) async fn send_with(
    request: SendRequest,
    lookup: &impl IdentityLookup,
    outbox: &crate::outbox::Outbox,
) -> Result<Value> {
    let aliases = lookup.identities(&request.account).await?;
    let execute = request.execute;
    let send_id = request.send_id.clone();
    let prepared = tokio::task::spawn_blocking(move || prepare(&request, &aliases))
        .await
        .map_err(|_| "worker_failed")??;
    if !execute {
        prepared.payload(0, "preview")?;
        return Ok(prepared.preview());
    }
    outbox.enqueue_mail(prepared, send_id.as_deref()).await
}
