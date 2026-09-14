//! Local-only named pipes with protected current-user DACLs. The first instance
//! refuses namespace squatting; a replacement instance is opened before handing
//! off a connection so there is no unowned namespace gap during the lease.
use crate::platform::{private_fs, windows_security as security};
use std::{
    fs::File,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::Path,
    ptr,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions},
    sync::Mutex,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    Storage::FileSystem::SECURITY_IDENTIFICATION,
    System::{Pipes::*, Threading::*},
};
type Result<T> = std::result::Result<T, &'static str>;
const HANDSHAKE: u8 = 1;

pub(crate) struct LocalEndpoint {
    dir: File,
    name: String,
}
impl LocalEndpoint {
    pub(crate) fn outbox(root: &Path) -> Result<Self> {
        let dir = private_fs::directories_readonly(root, &["omamail"])?
            .ok_or("outbox_owner_unavailable")?;
        private_fs::validate_owned_root(&dir)?;
        let (volume, id, _) = private_fs::file_id(&dir)?;
        let sid = security::sid_text(&security::current_user()?)?;
        Ok(Self {
            dir,
            name: format!(r"\\.\pipe\omamail-{sid}-{volume:08x}-{id:016x}-outbox"),
        })
    }
    pub(crate) fn listen(&self) -> Result<LocalListener> {
        private_fs::validate_owned_root(&self.dir)?;
        let pending = create_server(&self.name, true)?;
        Ok(LocalListener {
            _dir: self
                .dir
                .try_clone()
                .map_err(|_| "outbox_owner_unavailable")?,
            name: self.name.clone(),
            pending: Mutex::new(pending),
        })
    }
    pub(crate) async fn connect(&self) -> Result<NamedPipeClient> {
        private_fs::validate_owned_root(&self.dir)?;
        let mut stream = loop {
            match ClientOptions::new()
                .security_qos_flags(SECURITY_IDENTIFICATION)
                .open(&self.name)
            {
                Ok(stream) => break stream,
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
                    tokio::time::sleep(Duration::from_millis(10)).await
                }
                Err(_) => return Err("outbox_owner_unavailable"),
            }
        };
        // Validate the actual pipe's owner/DACL and server process token before
        // sending even the handshake, let alone message content. Identification
        // QoS prevents a server from using the client's token to act as it.
        security::validate(stream.as_raw_handle(), true).map_err(|_| "outbox_owner_unavailable")?;
        let mut pid = 0;
        if unsafe { GetNamedPipeServerProcessId(stream.as_raw_handle(), &mut pid) } == 0 {
            return Err("outbox_owner_unavailable");
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return Err("outbox_owner_unavailable");
        }
        let process = unsafe { OwnedHandle::from_raw_handle(process) };
        if !security::same_sid(
            &security::current_user()?,
            &security::process_user(process.as_raw_handle())?,
        ) {
            return Err("outbox_owner_unavailable");
        }
        stream
            .write_u8(HANDSHAKE)
            .await
            .map_err(|_| "outbox_owner_unavailable")?;
        Ok(stream)
    }
}
fn create_server(name: &str, first: bool) -> Result<NamedPipeServer> {
    let descriptor = security::private_descriptor()?;
    let mut attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    };
    let server = unsafe {
        ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .in_buffer_size(64 * 1024)
            .out_buffer_size(64 * 1024)
            .create_with_security_attributes_raw(
                name,
                (&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
            )
    }
    .map_err(|_| "outbox_owner_unavailable")?;
    security::validate(server.as_raw_handle(), true)?;
    Ok(server)
}
pub(crate) struct LocalListener {
    _dir: File,
    name: String,
    pending: Mutex<NamedPipeServer>,
}
impl LocalListener {
    pub(crate) async fn accept(&self) -> std::io::Result<(NamedPipeServer, ())> {
        let mut pending = self.pending.lock().await;
        pending.connect().await?;
        let next = create_server(&self.name, false).map_err(std::io::Error::other)?;
        Ok((std::mem::replace(&mut *pending, next), ()))
    }
}

/// The server authenticates the token attached to bytes actually read, rather
/// than a claimed SID or a recyclable PID. No await occurs while impersonating.
/// The outbox's existing whole-request timeout bounds this one-byte handshake.
pub(crate) async fn authenticate(stream: &mut NamedPipeServer) -> Result<()> {
    if stream
        .read_u8()
        .await
        .map_err(|_| "outbox_owner_unavailable")?
        != HANDSHAKE
    {
        return Err("outbox_owner_unavailable");
    }
    check_peer(stream)
}
pub(crate) fn check_peer(stream: &NamedPipeServer) -> Result<()> {
    let user = security::current_user()?;
    if unsafe { ImpersonateNamedPipeClient(stream.as_raw_handle()) } == 0 {
        return Err("outbox_owner_unavailable");
    }
    struct Revert;
    impl Drop for Revert {
        fn drop(&mut self) {
            // Continuing on a pooled executor thread with an attacker token is
            // unsafe. There is no recovery if reverting to the process fails.
            if unsafe { RevertToSelf() } == 0 {
                std::process::abort();
            }
        }
    }
    let _revert = Revert;
    let mut token = ptr::null_mut();
    if unsafe { OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, 1, &mut token) } == 0 {
        return Err("outbox_owner_unavailable");
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    if !security::same_sid(&user, &security::token_user(token.as_raw_handle())?) {
        return Err("outbox_owner_unavailable");
    }
    Ok(())
}
