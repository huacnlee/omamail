//! Generic-password items through Apple's Security framework; no CLI helpers.
use super::*;
#[cfg(not(target_os = "ios"))]
use security_framework::passwords::set_generic_password;
use security_framework::passwords::{delete_generic_password, get_generic_password};
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
#[cfg(not(target_os = "ios"))]
pub(super) fn put(key: &CredentialKey, secret: &[u8]) -> Result<(), Error> {
    set_generic_password(SERVICE, &key.native_id()?, secret).map_err(error)
}

/// iOS items default to "when unlocked", so background sync on a locked phone
/// could not read the account's token. Store them as "after first unlock,
/// this device only": readable in the background once the user has unlocked
/// the phone after boot, never synced to iCloud or restored to another device.
/// An existing item is updated in place, which also moves an older item to
/// this class; only a missing item is added.
#[cfg(target_os = "ios")]
pub(super) fn put(key: &CredentialKey, secret: &[u8]) -> Result<(), Error> {
    use core_foundation::{
        base::{CFType, TCFType},
        boolean::CFBoolean,
        data::CFData,
        dictionary::CFDictionary,
        string::CFString,
    };
    use security_framework_sys::{
        access_control::kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        base::errSecItemNotFound,
        item::{
            kSecAttrAccount, kSecAttrService, kSecAttrSynchronizable, kSecClass,
            kSecClassGenericPassword, kSecValueData,
        },
        keychain_item::{SecItemAdd, SecItemUpdate},
    };
    // security-framework-sys does not export the attribute key itself.
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        static kSecAttrAccessible: core_foundation::string::CFStringRef;
    }
    let constant = |value| unsafe { CFString::wrap_under_get_rule(value) };
    let account = key.native_id()?;
    let query = [
        (
            constant(unsafe { kSecClass }),
            constant(unsafe { kSecClassGenericPassword }).as_CFType(),
        ),
        (
            constant(unsafe { kSecAttrService }),
            CFString::new(SERVICE).as_CFType(),
        ),
        (
            constant(unsafe { kSecAttrAccount }),
            CFString::new(&account).as_CFType(),
        ),
    ];
    let attributes: [(CFString, CFType); 3] = [
        (
            constant(unsafe { kSecValueData }),
            CFData::from_buffer(secret).as_CFType(),
        ),
        (
            constant(unsafe { kSecAttrAccessible }),
            constant(unsafe { kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly }).as_CFType(),
        ),
        (
            constant(unsafe { kSecAttrSynchronizable }),
            CFBoolean::false_value().as_CFType(),
        ),
    ];
    let search = CFDictionary::from_CFType_pairs(&query);
    let update = CFDictionary::from_CFType_pairs(&attributes);
    // SAFETY: both dictionaries are valid CF objects for the call's duration.
    let status =
        unsafe { SecItemUpdate(search.as_concrete_TypeRef(), update.as_concrete_TypeRef()) };
    let status = if status == errSecItemNotFound {
        let item: Vec<_> = query.iter().chain(attributes.iter()).cloned().collect();
        let item = CFDictionary::from_CFType_pairs(&item);
        unsafe { SecItemAdd(item.as_concrete_TypeRef(), std::ptr::null_mut()) }
    } else {
        status
    };
    if status == 0 {
        Ok(())
    } else {
        Err(error(security_framework::base::Error::from_code(status)))
    }
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

    #[test]
    #[cfg(target_os = "ios")]
    #[ignore = "requires a signed iOS app process; simctl spawn has no keychain entitlement"]
    fn credentials_native_ios_put_updates_in_place() {
        let key = CredentialKey {
            provider: "imap".into(),
            account_id: "imap:smoke@example.org".into(),
            kind: CredentialKind::ImapPassword,
        };
        let _ = delete(&key);
        assert_eq!(get(&key).err(), Some(Error::Missing));
        put(&key, b"first").unwrap();
        put(&key, b"second").unwrap();
        assert_eq!(get(&key).unwrap().as_slice(), b"second");
        delete(&key).unwrap();
        assert_eq!(get(&key).err(), Some(Error::Missing));
    }
}
