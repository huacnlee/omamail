use super::{Account, Provider};

pub fn resolve_account(wanted: &str) -> Result<Account, &'static str> {
    let summary = crate::account::list_readonly()?;
    let id = if wanted.trim().is_empty() {
        summary["activeId"].as_str().unwrap_or("").to_owned()
    } else {
        wanted.trim().to_lowercase()
    };
    if id.is_empty() {
        return Err("mail_account_unknown");
    }
    let row = summary["accounts"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == id))
        .ok_or("mail_account_unknown")?;
    Ok(Account {
        id,
        provider: Provider::try_from(row["provider"].as_str().unwrap_or(""))?,
    })
}
