//! Private, bounded submission to the process holding the outbox lease.
//! This listener has no independent lifecycle: dropping/stopping the owning
//! outbox aborts it. Only ID-bound enqueue and payload-free snapshots cross it.
use super::{Inner, storage, text};
use serde_json::{Value, json};
use std::{
    fs::File,
    os::{
        fd::AsRawFd,
        unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    },
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
};

const MAX_REQUEST: usize = 49 * 1024 * 1024;
const MAX_REPLY: usize = 128 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);

fn location(root: &Path) -> Result<(File, String), &'static str> {
    let dir = crate::cache::directories_readonly(root, &["omamail"])?
        .ok_or("outbox_owner_unavailable")?;
    // Anchor both operations to the checked descriptor; long XDG paths must
    // not exceed sockaddr_un's 108-byte pathname limit or re-resolve ancestors.
    let path = format!("/proc/self/fd/{}/outbox.sock", dir.as_raw_fd());
    Ok((dir, path))
}

fn check_socket(path: &str) -> Result<(), &'static str> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "outbox_owner_unavailable")?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
    {
        return Err("outbox_storage_unsafe");
    }
    Ok(())
}

fn check_peer(stream: &UnixStream) -> Result<(), &'static str> {
    if stream
        .peer_cred()
        .map_err(|_| "outbox_owner_unavailable")?
        .uid()
        != unsafe { libc::geteuid() }
    {
        return Err("outbox_storage_unsafe");
    }
    Ok(())
}

pub(super) fn listen(inner: &Arc<Inner>) -> Result<(), &'static str> {
    // The caller holds the exclusive lease and the state mutex. No successor
    // can replace this socket until every in-flight durable write releases it.
    let root = inner.root.clone().map(Ok).unwrap_or_else(storage::home)?;
    let (_dir, path) = location(&root)?;
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {
            check_socket(&path)?;
            std::fs::remove_file(&path).map_err(|_| "outbox_storage_unavailable")?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err("outbox_storage_unavailable"),
    }
    let listener = UnixListener::bind(&path).map_err(|_| "outbox_storage_unavailable")?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| "outbox_storage_unavailable")?;
    let owner = Arc::downgrade(inner);
    let task = tokio::spawn(async move {
        let mut requests = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                connection = listener.accept(), if requests.len() < 2 => {
                    let Ok((mut stream, _)) = connection else { break; };
                    if check_peer(&stream).is_err() { continue; }
                    let Some(inner) = owner.upgrade() else { break; };
                    requests.spawn(async move {
                        let _ = tokio::time::timeout(TIMEOUT, async {
                            let request = read_frame(&mut stream, MAX_REQUEST).await?;
                            let result = serve_request(&inner, &request).await;
                            let reply = match result {
                                Ok(value) => json!({"result":value}),
                                Err(error) => json!({"error":error}),
                            };
                            write_frame(&mut stream, &reply, MAX_REPLY).await
                        }).await;
                    });
                }
                _ = requests.join_next(), if !requests.is_empty() => (),
            }
        }
    });
    inner
        .jobs
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push(task);
    Ok(())
}

async fn serve_request(inner: &Arc<Inner>, request: &Value) -> Result<Value, &'static str> {
    let method = request["method"].as_str().ok_or("outbox_invalid_params")?;
    let params = &request["params"];
    if !matches!(method, "outbox.enqueue" | "outbox.snapshot")
        || params.get("includePayloads").is_some()
    {
        return Err("outbox_invalid_params");
    }
    let id = text(params, "sendId")?;
    let mut result = inner.call(method, params).await?;
    if method == "outbox.enqueue" {
        // Other account entries are irrelevant to this submitting process.
        if let Some(entries) = result["snapshot"]["entries"].as_array_mut() {
            entries.retain(|entry| entry["id"] == id);
        }
    }
    Ok(result)
}

pub(super) async fn request(
    root: &Path,
    method: &str,
    params: &Value,
) -> Result<Value, &'static str> {
    tokio::time::timeout(TIMEOUT, async {
        let (_dir, path) = location(root)?;
        check_socket(&path)?;
        let mut stream = UnixStream::connect(&path)
            .await
            .map_err(|_| "outbox_owner_unavailable")?;
        check_peer(&stream)?;
        write_frame(
            &mut stream,
            &json!({"method":method,"params":params}),
            MAX_REQUEST,
        )
        .await?;
        let reply = read_frame(&mut stream, MAX_REPLY).await?;
        if let Some(error) = reply["error"].as_str() {
            // Never forward arbitrary peer diagnostics as an error code.
            const ERRORS: &[&str] = &[
                "outbox_invalid_params",
                "outbox_invalid_provider",
                "outbox_invalid_payload",
                "outbox_invalid_delay",
                "outbox_message_too_large",
                "outbox_send_id_conflict",
                "outbox_full",
                "outbox_stopping",
                "outbox_storage_unavailable",
                "outbox_storage_invalid",
                "outbox_storage_unsafe",
                "outbox_storage_too_large",
            ];
            return Err(ERRORS
                .iter()
                .copied()
                .find(|code| *code == error)
                .unwrap_or("outbox_storage_unavailable"));
        }
        reply
            .get("result")
            .cloned()
            .ok_or("outbox_owner_unavailable")
    })
    .await
    .unwrap_or(Err("outbox_owner_unavailable"))
}

async fn read_frame(stream: &mut UnixStream, limit: usize) -> Result<Value, &'static str> {
    let length = stream
        .read_u32()
        .await
        .map_err(|_| "outbox_owner_unavailable")? as usize;
    if length > limit {
        return Err("outbox_invalid_params");
    }
    let mut bytes = vec![0; length];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|_| "outbox_owner_unavailable")?;
    serde_json::from_slice(&bytes).map_err(|_| "outbox_invalid_params")
}

async fn write_frame(
    stream: &mut UnixStream,
    value: &Value,
    limit: usize,
) -> Result<(), &'static str> {
    let bytes = serde_json::to_vec(value).map_err(|_| "outbox_invalid_params")?;
    if bytes.len() > limit {
        return Err("outbox_invalid_params");
    }
    stream
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|_| "outbox_owner_unavailable")?;
    stream
        .write_all(&bytes)
        .await
        .map_err(|_| "outbox_owner_unavailable")
}
