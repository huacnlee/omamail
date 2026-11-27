//! macOS cancellation uses an owned IPC endpoint, never a potentially reused PID.
use std::path::PathBuf;
pub fn path(id: &str) -> Result<PathBuf, &'static str> {
    super::storage::check_id(id)?;
    let base = std::env::var_os("XDG_STATE_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|v| PathBuf::from(v).join(".local/state")))
        .ok_or("agent_state_home_invalid")?;
    crate::cache::directories(&base, &["omamail", "agent-runtime"], true)?
        .ok_or("agent_storage_unavailable")?;
    Ok(base
        .join("omamail/agent-runtime")
        .join(format!("{id}.sock")))
}
pub struct Control {
    listener: tokio::net::UnixListener,
    path: PathBuf,
}
impl Control {
    pub fn bind(id: &str) -> Result<Self, &'static str> {
        let path = path(id)?;
        let listener =
            tokio::net::UnixListener::bind(&path).map_err(|_| "agent_worker_unavailable")?;
        Ok(Self { listener, path })
    }
    pub async fn cancelled(&self) {
        use tokio::io::AsyncReadExt;
        loop {
            if let Ok((mut stream, _)) = self.listener.accept().await {
                let mut message = [0u8; 4];
                if tokio::time::timeout(
                    std::time::Duration::from_secs(1),
                    stream.read_exact(&mut message),
                )
                .await
                .is_ok_and(|v| v.is_ok())
                    && message == *b"stop"
                {
                    return;
                }
            }
        }
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
