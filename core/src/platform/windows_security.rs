//! Handle-based Windows security. Private objects have a protected DACL granting
//! only the process user's SID access, including when a parent has inheritable ACEs.
use std::{
    mem::offset_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::Threading::*,
};
type Result<T> = std::result::Result<T, &'static str>;

pub(super) struct LocalAllocation(pub PSECURITY_DESCRIPTOR);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

/// TokenUser is copied into owned, aligned storage; no token-buffer pointer escapes.
pub(super) fn token_user(token: HANDLE) -> Result<Vec<u32>> {
    let mut length = 0;
    unsafe {
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length);
    }
    if length == 0 || length > 65536 {
        return Err("cache_unsafe_path");
    }
    let mut buffer = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err("cache_unsafe_path");
    }
    let sid = unsafe { (*(buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
    if unsafe { IsValidSid(sid) } == 0 {
        return Err("cache_unsafe_path");
    }
    let size = unsafe { GetLengthSid(sid) };
    let mut out = vec![0u32; (size as usize).div_ceil(4)];
    if unsafe { CopySid(size, out.as_mut_ptr().cast(), sid) } == 0 {
        return Err("cache_unsafe_path");
    }
    Ok(out)
}
pub(super) fn process_user(process: HANDLE) -> Result<Vec<u32>> {
    let mut token = ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err("cache_unsafe_path");
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    token_user(token.as_raw_handle())
}
pub(super) fn current_user() -> Result<Vec<u32>> {
    process_user(unsafe { GetCurrentProcess() })
}
pub(super) fn same_sid(left: &[u32], right: &[u32]) -> bool {
    left == right
}

pub(super) fn sid_text(sid: &[u32]) -> Result<String> {
    let mut raw = ptr::null_mut();
    if unsafe { ConvertSidToStringSidW(sid.as_ptr().cast_mut().cast(), &mut raw) } == 0 {
        return Err("cache_unsafe_path");
    }
    let allocation = LocalAllocation(raw.cast());
    let mut length = 0;
    while unsafe { *raw.add(length) } != 0 {
        length += 1;
    }
    let result = String::from_utf16(unsafe { std::slice::from_raw_parts(raw, length) })
        .map_err(|_| "cache_unsafe_path");
    drop(allocation);
    result
}
pub(super) fn descriptor(sddl: &str) -> Result<LocalAllocation> {
    let text: Vec<_> = sddl.encode_utf16().chain(Some(0)).collect();
    let mut raw = ptr::null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text.as_ptr(),
            SDDL_REVISION_1,
            &mut raw,
            ptr::null_mut(),
        )
    } == 0
    {
        return Err("cache_unsafe_path");
    }
    Ok(LocalAllocation(raw))
}
pub(super) fn private_descriptor() -> Result<LocalAllocation> {
    let sid = sid_text(&current_user()?)?;
    descriptor(&format!("O:{sid}D:P(A;OICI;FA;;;{sid})"))
}

fn trusted(sid: PSID, user: &[u32]) -> bool {
    // Windows servicing owns some volume/system ancestors as TrustedInstaller.
    let installer: Vec<_> = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut raw = ptr::null_mut();
    let installer_owner = if unsafe { ConvertStringSidToSidW(installer.as_ptr(), &mut raw) } != 0 {
        let _allocation = LocalAllocation(raw);
        unsafe { EqualSid(sid, raw) != 0 }
    } else {
        false
    };
    installer_owner
        || unsafe {
            EqualSid(sid, user.as_ptr().cast_mut().cast()) != 0
                || IsWellKnownSid(sid, WinLocalSystemSid) != 0
                || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
        }
}

/// Ancestors may be system owned and publicly readable. Foreign delete-child,
/// delete, DACL/owner changes or reparse-changing rights must never be granted.
/// Create-subdirectory alone is allowed (the normal volume-root ACL); the new
/// directory is opened without following reparses and its owner is checked.
pub(super) fn validate(handle: HANDLE, private: bool) -> Result<()> {
    let user = current_user()?;
    let mut owner = ptr::null_mut();
    let mut dacl = ptr::null_mut();
    let mut raw = ptr::null_mut();
    if unsafe {
        GetSecurityInfo(
            handle,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut raw,
        )
    } != ERROR_SUCCESS
    {
        return Err("cache_unsafe_path");
    }
    let _allocation = LocalAllocation(raw);
    if owner.is_null() || dacl.is_null() || unsafe { IsValidAcl(dacl) } == 0 {
        return Err("cache_unsafe_path");
    }
    let own = unsafe { EqualSid(owner, user.as_ptr().cast_mut().cast()) } != 0;
    if (private && !own) || (!private && !trusted(owner, &user)) {
        return Err("cache_unsafe_path");
    }
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(raw, &mut control, &mut revision) } == 0
        || private && control & SE_DACL_PROTECTED == 0
    {
        return Err("cache_unsafe_path");
    }
    let mut has_user = false;
    for index in 0..unsafe { (*dacl).AceCount } as u32 {
        let mut ace = ptr::null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
            return Err("cache_unsafe_path");
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        // Unknown/callback/object ACEs are refused, never interpreted as harmless.
        if header.AceType != 0 /* ACCESS_ALLOWED_ACE_TYPE */ && header.AceType != 1
        /* ACCESS_DENIED_ACE_TYPE */
        {
            return Err("cache_unsafe_path");
        }
        if header.AceType == 1 /* ACCESS_DENIED_ACE_TYPE */ || header.AceFlags as u32 & INHERIT_ONLY_ACE != 0
        {
            continue;
        }
        if (header.AceSize as usize) < size_of::<ACCESS_ALLOWED_ACE>() {
            return Err("cache_unsafe_path");
        }
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        let sid: PSID = (&allowed.SidStart as *const u32).cast_mut().cast();
        if unsafe { IsValidSid(sid) } == 0
            || unsafe { GetLengthSid(sid) } as usize + offset_of!(ACCESS_ALLOWED_ACE, SidStart)
                > header.AceSize as usize
        {
            return Err("cache_unsafe_path");
        }
        let own_ace = unsafe { EqualSid(sid, user.as_ptr().cast_mut().cast()) } != 0;
        has_user |= own_ace && allowed.Mask & FILE_GENERIC_READ == FILE_GENERIC_READ;
        if private {
            if !own_ace && allowed.Mask != 0 {
                return Err("cache_unsafe_path");
            }
        } else if !trusted(sid, &user)
            && allowed.Mask
                & (DELETE
                    | WRITE_DAC
                    | WRITE_OWNER
                    | FILE_DELETE_CHILD
                    | FILE_WRITE_DATA
                    | FILE_WRITE_EA
                    | FILE_WRITE_ATTRIBUTES
                    | GENERIC_WRITE
                    | GENERIC_ALL)
                != 0
        {
            return Err("cache_unsafe_path");
        }
    }
    if private && !has_user {
        return Err("cache_unsafe_path");
    }
    Ok(())
}
