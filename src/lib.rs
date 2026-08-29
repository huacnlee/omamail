use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

extern crate self as omamail;

pub mod attachment_host;
pub mod effects;
pub mod gmail_setup;
pub mod hey_setup;
pub mod host_context;
pub mod imap_host;
pub mod imap_setup;
pub mod native_groupware_runtime;
pub mod native_provider_runtime;
pub mod platform;
pub mod provider_effects;
pub mod providers;

pub const APP_ID: &str = "com.omarchy.omamail";
pub const COMPANION_MAX_AGE_MS: u64 = 120_000;
pub const COMPANION_HEARTBEAT_INTERVAL_MS: u64 = 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApplicationPaths {
    pub explicit: Option<PathBuf>,
    pub executable: PathBuf,
    pub manifest_dir: PathBuf,
}

pub fn application_dir(paths: &ApplicationPaths) -> Result<PathBuf, String> {
    if let Some(explicit) = &paths.explicit {
        return is_application_dir(explicit)
            .then_some(explicit.clone())
            .ok_or_else(|| "OMAMAIL_APP_DIR does not contain gpui-shell.json".to_owned());
    }

    let binary_dir = paths
        .executable
        .parent()
        .ok_or_else(|| "the executable has no parent directory".to_owned())?;
    let bundle_root = binary_dir.parent().unwrap_or(binary_dir);
    let candidates = [
        bundle_root.join("Resources").join("app"),
        bundle_root.join("share").join("app"),
        bundle_root.join("app"),
        binary_dir.join("app"),
        paths.manifest_dir.join("app"),
    ];

    candidates
        .into_iter()
        .find(|candidate| is_application_dir(candidate))
        .ok_or_else(|| {
            format!(
                "no app/gpui-shell.json was found beside {} or in the development checkout",
                paths.executable.display()
            )
        })
}

fn is_application_dir(path: &Path) -> bool {
    path.join("gpui-shell.json").is_file()
}

pub fn omarchy_palette_path(home: Option<&Path>, platform: &str) -> Option<PathBuf> {
    if platform != "linux" {
        return None;
    }
    home.map(|root| root.join(".local/state/omarchy/current/theme/colors.toml"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompanionStatus {
    pub unread: u64,
    pub running: bool,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompanionStatusState {
    unread: u64,
    running: bool,
}

impl CompanionStatusState {
    pub fn running() -> Self {
        Self {
            unread: 0,
            running: true,
        }
    }

    pub fn set_unread(&mut self, unread: u64) {
        self.unread = unread;
    }

    pub fn stop(&mut self) {
        self.running = false;
    }

    pub fn should_publish(&self) -> bool {
        self.running
    }

    pub fn snapshot(&self, updated_at: u64) -> CompanionStatus {
        CompanionStatus {
            unread: self.unread,
            running: self.running,
            updated_at,
        }
    }
}

pub fn companion_status_path(
    state_home: Option<&Path>,
    home: Option<&Path>,
    platform: &str,
) -> Option<PathBuf> {
    if platform != "linux" {
        return None;
    }
    state_home
        .filter(|root| !root.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .or_else(|| home.map(|root| root.join(".local/state")))
        .map(|root| root.join("omamail/status.json"))
}

pub fn write_companion_status(path: &Path, status: CompanionStatus) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "the companion status path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("create companion status directory: {error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("protect companion status directory: {error}"))?;
    }

    let temporary = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("status.json")
    ));
    let body = format!(
        "{{\"version\":1,\"unread\":{},\"running\":{},\"updatedAt\":{}}}\n",
        status.unread, status.running, status.updated_at
    );
    let mut output = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("open companion status temporary file: {error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        output
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("protect companion status temporary file: {error}"))?;
    }

    output
        .write_all(body.as_bytes())
        .and_then(|()| output.sync_all())
        .map_err(|error| format!("write companion status: {error}"))?;
    drop(output);
    fs::rename(&temporary, path).map_err(|error| format!("publish companion status: {error}"))
}
