//! Secret Service over D-Bus, retaining the installed plugin's exact attributes.
//! Refuse locked stores instead of waiting indefinitely for an unlock prompt.
use super::*;
use ::secret_service::{EncryptionType, blocking::SecretService};
use std::collections::HashMap;

fn connect() -> Result<SecretService<'static>, Error> {
    let connection = zbus::blocking::connection::Builder::session()
        .map_err(|_| Error::Unavailable)?
        .method_timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|_| Error::Unavailable)?;
    SecretService::connect_with_existing(EncryptionType::Dh, connection)
        .map_err(|_| Error::Unavailable)
}
fn attributes(key: &CredentialKey) -> Result<HashMap<String, String>, Error> {
    Ok(key.attributes()?.into_iter().collect())
}
fn find<'a>(
    service: &'a SecretService<'a>,
    attrs: &'a HashMap<String, String>,
) -> Result<Option<::secret_service::blocking::Item<'a>>, Error> {
    let result = service
        .search_items(
            attrs
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect(),
        )
        .map_err(|_| Error::Unavailable)?;
    if !result.locked.is_empty() {
        return Err(Error::Unavailable);
    }
    if result.unlocked.len() > 1 {
        return Err(Error::Ambiguous);
    }
    Ok(result.unlocked.into_iter().next())
}
pub(super) fn get(key: &CredentialKey) -> Result<Secret, Error> {
    let service = connect()?;
    let attrs = attributes(key)?;
    let item = find(&service, &attrs)?.ok_or(Error::Missing)?;
    Secret::new(item.get_secret().map_err(|_| Error::Unavailable)?)
}
pub(super) fn put(key: &CredentialKey, secret: &[u8]) -> Result<(), Error> {
    let service = connect()?;
    let attrs = attributes(key)?;
    if let Some(item) = find(&service, &attrs)? {
        return item
            .set_secret(secret, "application/octet-stream")
            .map_err(|_| Error::Unavailable);
    }
    let collection = service
        .get_default_collection()
        .map_err(|_| Error::Unavailable)?;
    if collection.is_locked().map_err(|_| Error::Unavailable)? {
        return Err(Error::Unavailable);
    }
    // Exact current-grant lookup above avoids libsecret's subset replacement of
    // an old grant. Do not delete a previous token before a new write succeeds.
    collection
        .create_item(
            "Omamail",
            attrs
                .iter()
                .map(|(k, v)| (k.as_str(), v.as_str()))
                .collect(),
            secret,
            false,
            "application/octet-stream",
        )
        .map_err(|_| Error::Unavailable)?;
    Ok(())
}
pub(super) fn delete(key: &CredentialKey) -> Result<(), Error> {
    let service = connect()?;
    let attrs = attributes(key)?;
    let item = find(&service, &attrs)?.ok_or(Error::Missing)?;
    item.delete().map_err(|_| Error::Unavailable)
}
