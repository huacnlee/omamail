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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_keychain_failures_do_not_mean_missing() {
        for status in [-25291, -25293, -25308, -34018] {
            assert_eq!(
                error(security_framework::base::Error::from_code(status)),
                Error::Unavailable
            );
        }
        assert_eq!(
            error(security_framework::base::Error::from_code(-25300)),
            Error::Missing
        );
    }

    #[test]
    #[ignore = "requires native macOS Keychain; mandatory in the native credential gate"]
    fn credentials_native_macos_entitlement_denial_is_not_missing() {
        use security_framework::passwords::{PasswordOptions, generic_password};
        let mut options = PasswordOptions::new_generic_password(SERVICE, "synthetic-denied-query");
        options.use_protected_keychain();
        options.set_access_group("org.omamail.synthetic.unentitled");
        let failure =
            generic_password(options).expect_err("an unentitled access group must be refused");
        assert_eq!(
            failure.code(),
            -34018,
            "native fixture did not reach the entitlement boundary"
        );
        assert_eq!(error(failure), Error::Unavailable);
    }
}
