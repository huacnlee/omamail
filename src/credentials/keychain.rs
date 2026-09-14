//! Generic-password items through Apple's Security framework; no CLI helpers.
use super::*;
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};
const SERVICE: &str = "org.omamail.credentials.v1";

fn error(error: security_framework::base::Error) -> Error {
    // errSecItemNotFound. Authorization denial, locked keychains and other
    // platform errors are failures, never a claim that an account is signed out.
    if error.code() == -25300 {
        Error::Missing
    } else {
        Error::Unavailable
    }
}
pub(super) fn get(key: &CredentialKey) -> Result<Secret, Error> {
    Secret::new(get_generic_password(SERVICE, &key.native_id()?).map_err(error)?)
}
pub(super) fn put(key: &CredentialKey, secret: &[u8]) -> Result<(), Error> {
    set_generic_password(SERVICE, &key.native_id()?, secret).map_err(error)
}
pub(super) fn delete(key: &CredentialKey) -> Result<(), Error> {
    delete_generic_password(SERVICE, &key.native_id()?).map_err(error)
}
