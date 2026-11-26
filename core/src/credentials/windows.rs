//! Generic Credential Manager blobs, persisted locally for the current user.
use super::*;
use windows_sys::Win32::{
    Foundation::{ERROR_NOT_FOUND, GetLastError},
    Security::Credentials::*,
};
use zeroize::Zeroize;

fn error() -> Error {
    if unsafe { GetLastError() } == ERROR_NOT_FOUND {
        Error::Missing
    } else {
        Error::Unavailable
    }
}
fn target(key: &CredentialKey) -> Result<Vec<u16>, Error> {
    Ok(key.native_id()?.encode_utf16().chain(Some(0)).collect())
}
pub(super) fn get(key: &CredentialKey) -> Result<Secret, Error> {
    let target = target(key)?;
    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
    // CredRead owns the returned allocation until CredFree. Never interpret the
    // opaque blob as a NUL-terminated string or write its contents to a log.
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0 {
        return Err(error());
    }
    struct Allocation(*mut CREDENTIALW);
    impl Drop for Allocation {
        fn drop(&mut self) {
            unsafe {
                let value = &mut *self.0;
                if !value.CredentialBlob.is_null() && value.CredentialBlobSize > 0 {
                    std::slice::from_raw_parts_mut(
                        value.CredentialBlob,
                        value.CredentialBlobSize as usize,
                    )
                    .zeroize();
                }
                CredFree(self.0.cast());
            }
        }
    }
    if credential.is_null() {
        return Err(Error::Unavailable);
    }
    let allocation = Allocation(credential);
    let value = unsafe { &*allocation.0 };
    if value.CredentialBlobSize > CRED_MAX_CREDENTIAL_BLOB_SIZE {
        return Err(Error::TooLarge);
    }
    let bytes = if value.CredentialBlobSize == 0 {
        Vec::new()
    } else {
        if value.CredentialBlob.is_null() {
            return Err(Error::Unavailable);
        }
        unsafe {
            std::slice::from_raw_parts(value.CredentialBlob, value.CredentialBlobSize as usize)
        }
        .to_vec()
    };
    Secret::new(bytes)
}
pub(super) fn put(key: &CredentialKey, secret: &[u8]) -> Result<(), Error> {
    if secret.len() > CRED_MAX_CREDENTIAL_BLOB_SIZE as usize {
        return Err(Error::TooLarge);
    }
    let mut target = target(key)?;
    let mut bytes = Zeroizing::new(secret.to_vec());
    let value = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: bytes.len() as u32,
        CredentialBlob: bytes.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..unsafe { std::mem::zeroed() }
    };
    if unsafe { CredWriteW(&value, 0) } == 0 {
        return Err(error());
    }
    Ok(())
}
pub(super) fn delete(key: &CredentialKey) -> Result<(), Error> {
    let target = target(key)?;
    if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0 {
        return Err(error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires native Windows Credential Manager; mandatory in the native credential gate"]
    fn credentials_native_windows_anonymous_logon_is_not_missing() {
        use windows_sys::Win32::{
            Security::{ImpersonateAnonymousToken, RevertToSelf},
            System::Threading::GetCurrentThread,
        };
        // Thread-scoped impersonation needs no test user's password and never
        // modifies the runner's actual credential set.
        assert_ne!(unsafe { ImpersonateAnonymousToken(GetCurrentThread()) }, 0);
        struct Revert;
        impl Drop for Revert {
            fn drop(&mut self) {
                if unsafe { RevertToSelf() } == 0 {
                    std::process::abort();
                }
            }
        }
        let revert = Revert;
        let key = CredentialKey {
            provider: "imap".into(),
            account_id: "imap:denied-fixture@example.invalid".into(),
            kind: CredentialKind::ImapPassword,
        };
        let read = get(&key).map(|_| ());
        let write = put(&key, b"synthetic-denied-write");
        let clear = delete(&key);
        drop(revert);
        assert_eq!(read, Err(Error::Unavailable));
        assert_eq!(write, Err(Error::Unavailable));
        assert_eq!(clear, Err(Error::Unavailable));
    }
}
