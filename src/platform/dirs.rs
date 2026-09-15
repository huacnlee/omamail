//! Platform data roots. Consumers append their existing `omamail` subdirectory,
//! retaining Linux plugin layouts. Discovery never creates or writes directories.
use std::{
    ffi::OsString,
    path::{Component, Path, PathBuf},
};

/// Shared backend/standalone-host contract: every application-owned directory
/// is this single component below its platform-native root.
pub const APP_DIRECTORY: &str = "omamail";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppDirs {
    pub config: PathBuf,
    pub cache: PathBuf,
    pub state: PathBuf,
    pub runtime: PathBuf,
    pub downloads: PathBuf,
}

#[cfg(test)]
static TEST_OVERRIDE: std::sync::Mutex<Option<TestAppDirs>> = std::sync::Mutex::new(None);

#[cfg(test)]
#[derive(Clone)]
struct TestAppDirs {
    dirs: AppDirs,
    home: PathBuf,
}

#[cfg(test)]
pub(crate) struct TestAppDirsOverride;

#[cfg(test)]
impl Drop for TestAppDirsOverride {
    fn drop(&mut self) {
        *TEST_OVERRIDE
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }
}

#[cfg(test)]
pub(crate) fn install_test_override(
    dirs: AppDirs,
    home: PathBuf,
) -> Result<TestAppDirsOverride, &'static str> {
    let mut current = TEST_OVERRIDE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if current.is_some() {
        return Err("test_directories_override_active");
    }
    *current = Some(TestAppDirs { dirs, home });
    Ok(TestAppDirsOverride)
}

impl AppDirs {
    pub fn discover() -> Result<Self, &'static str> {
        #[cfg(test)]
        if let Some(override_dirs) = TEST_OVERRIDE
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
        {
            return Ok(override_dirs.dirs);
        }
        Self::discover_with(|name| std::env::var_os(name), &std::env::temp_dir())
    }
    pub fn home() -> Result<PathBuf, &'static str> {
        #[cfg(test)]
        if let Some(override_dirs) = TEST_OVERRIDE
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
        {
            return Ok(override_dirs.home);
        }
        #[cfg(windows)]
        {
            return known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_Profile);
        }
        #[cfg(unix)]
        absolute(
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .ok_or("home_missing")?,
        )
    }
    fn discover_with(
        env: impl Fn(&str) -> Option<OsString>,
        temporary: &Path,
    ) -> Result<Self, &'static str> {
        #[cfg(windows)]
        {
            let _ = (env, temporary);
            use windows_sys::Win32::UI::Shell::{
                FOLDERID_Downloads, FOLDERID_LocalAppData, FOLDERID_RoamingAppData,
            };
            let local = known_folder(&FOLDERID_LocalAppData)?;
            // Program files install into LocalAppData/omamail. Keep all data
            // outside that replaceable installation directory.
            Self::from_roots(
                known_folder(&FOLDERID_RoamingAppData)?,
                local.join("OmamailData/Cache"),
                local.join("OmamailData/State"),
                local.join("OmamailData/Runtime"),
                known_folder(&FOLDERID_Downloads)?,
            )
        }
        #[cfg(unix)]
        {
            let home = absolute(
                env("HOME")
                    .filter(|p| !p.is_empty())
                    .map(PathBuf::from)
                    .ok_or("home_missing")?,
            )?;
            #[cfg(target_os = "macos")]
            let (config, cache, state, runtime, downloads) = {
                let support = home.join("Library/Application Support");
                // Darwin's system temporary directory commonly uses /var, a
                // system alias of /private/var. Resolve this OS-selected root
                // before entering the no-symlink storage boundary.
                let runtime = temporary.canonicalize().map_err(|_| "home_invalid")?;
                (
                    support.clone(),
                    home.join("Library/Caches"),
                    support,
                    runtime,
                    home.join("Downloads"),
                )
            };
            #[cfg(not(target_os = "macos"))]
            let (config, cache, state, runtime, downloads) = {
                let root = |key, fallback| {
                    env(key)
                        .filter(|p| !p.is_empty())
                        .map(PathBuf::from)
                        .unwrap_or(fallback)
                };
                let config = absolute(root("XDG_CONFIG_HOME", home.join(".config")))?;
                let downloads = download_root(&env, &home, &config);
                (
                    config,
                    root("XDG_CACHE_HOME", home.join(".cache")),
                    root("XDG_STATE_HOME", home.join(".local/state")),
                    root("XDG_RUNTIME_DIR", temporary.to_owned()),
                    downloads,
                )
            };
            Self::from_roots(config, cache, state, runtime, downloads)
        }
    }
    /// Explicit injection avoids process-wide environment mutation in tests.
    pub fn from_roots(
        config: PathBuf,
        cache: PathBuf,
        state: PathBuf,
        runtime: PathBuf,
        downloads: PathBuf,
    ) -> Result<Self, &'static str> {
        Ok(Self {
            config: absolute(config)?,
            cache: absolute(cache)?,
            state: absolute(state)?,
            runtime: absolute(runtime)?,
            downloads: absolute(downloads)?,
        })
    }

    pub fn config_directory(&self) -> PathBuf {
        self.config.join(APP_DIRECTORY)
    }
}
fn absolute(path: PathBuf) -> Result<PathBuf, &'static str> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        || path.as_os_str().is_empty()
    {
        return Err("home_invalid");
    }
    Ok(path)
}
#[cfg(any(target_os = "linux", all(test, unix)))]
fn linux_downloads(home: &Path, config: &Path) -> PathBuf {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    const LIMIT: u64 = 64 * 1024;
    let read = || -> Option<String> {
        // NONBLOCK avoids opening a FIFO/device before metadata can reject it.
        // Both the metadata and the actual read are bounded against file growth.
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(config.join("user-dirs.dirs"))
            .ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() || metadata.len() > LIMIT {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(LIMIT + 1).read_to_end(&mut bytes).ok()?;
        if bytes.len() as u64 > LIMIT {
            return None;
        }
        String::from_utf8(bytes).ok()
    };
    if let Some(text) = read() {
        for line in text.lines() {
            if let Some(value) = line
                .trim()
                .strip_prefix("XDG_DOWNLOAD_DIR=")
                .and_then(|s| s.trim().strip_prefix('"'))
                .and_then(|s| s.strip_suffix('"'))
            {
                let path = PathBuf::from(value.replace("$HOME", &home.to_string_lossy()));
                if path.is_absolute() {
                    return path;
                }
            }
        }
    }
    home.join("Downloads")
}

#[cfg(any(target_os = "linux", all(test, unix)))]
fn download_root(env: &impl Fn(&str) -> Option<OsString>, home: &Path, config: &Path) -> PathBuf {
    env("XDG_DOWNLOAD_DIR")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| linux_downloads(home, config))
}
#[cfg(all(test, unix))]
mod download_tests {
    use super::*;
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    #[test]
    fn fifo_and_oversized_user_dirs_never_block_or_allocate_their_contents() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("omamail-user-dirs-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("user-dirs.dirs");
        let raw = CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o600) }, 0);
        let start = std::time::Instant::now();
        assert_eq!(linux_downloads(&root, &root), root.join("Downloads"));
        assert!(start.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(
            download_root(
                &|_| Some(OsString::from("/explicit/downloads")),
                &root,
                &root
            ),
            PathBuf::from("/explicit/downloads")
        );
        std::fs::remove_file(&path).unwrap();
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(1024 * 1024 * 1024).unwrap();
        assert_eq!(linux_downloads(&root, &root), root.join("Downloads"));
        std::fs::write(&path, b"XDG_DOWNLOAD_DIR=\"$HOME/Custom\"\n").unwrap();
        assert_eq!(linux_downloads(&root, &root), root.join("Custom"));
        let file = std::fs::File::open(&path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_accessed(std::time::UNIX_EPOCH))
            .unwrap();
        let before = file.metadata().unwrap().accessed().unwrap();
        assert_eq!(
            download_root(
                &|_| Some(OsString::from("/explicit/downloads")),
                &root,
                &root
            ),
            PathBuf::from("/explicit/downloads")
        );
        assert_eq!(
            file.metadata().unwrap().accessed().unwrap(),
            before,
            "an explicit override must not read user-dirs.dirs"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod override_tests {
    use super::*;

    #[test]
    fn scoped_override_precedes_native_directory_discovery() {
        let name = std::thread::current().name().unwrap().to_owned();
        if std::env::var("OMAMAIL_DIR_OVERRIDE_TEST_CHILD").as_deref() != Ok(name.as_str()) {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &name, "--test-threads=1", "--nocapture"])
                .env("OMAMAIL_DIR_OVERRIDE_TEST_CHILD", &name)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("omamail-dirs-override-{}", std::process::id()));
        let expected = AppDirs::from_roots(
            root.join("config"),
            root.join("cache"),
            root.join("state"),
            root.join("runtime"),
            root.join("downloads"),
        )
        .unwrap();
        let expected_home = root.join("home");
        let override_guard =
            install_test_override(expected.clone(), expected_home.clone()).unwrap();
        assert_eq!(AppDirs::discover().unwrap(), expected);
        assert_eq!(AppDirs::home().unwrap(), expected_home);
        drop(override_guard);
        assert!(
            TEST_OVERRIDE
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_none(),
            "dropping the fixture must restore native directory discovery"
        );
    }
}

#[cfg(windows)]
fn known_folder(id: &windows_sys::core::GUID) -> Result<PathBuf, &'static str> {
    use std::{os::windows::ffi::OsStringExt, ptr};
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{KF_FLAG_DONT_VERIFY, SHGetKnownFolderPath},
    };
    let mut raw = ptr::null_mut();
    // The path, not proof that it exists: every root is resolved together,
    // and a Downloads folder the user removed would otherwise take the
    // registry and the caches down with it. Whoever writes there creates it
    // or reports that it could not.
    let flags = KF_FLAG_DONT_VERIFY as u32;
    if unsafe { SHGetKnownFolderPath(id, flags, ptr::null_mut(), &mut raw) } < 0 {
        return Err("home_missing");
    }
    let mut length = 0;
    while length < 32768 && unsafe { *raw.add(length) } != 0 {
        length += 1;
    }
    let result = if length < 32768 {
        absolute(PathBuf::from(OsString::from_wide(unsafe {
            std::slice::from_raw_parts(raw, length)
        })))
    } else {
        Err("home_invalid")
    };
    unsafe {
        CoTaskMemFree(raw.cast());
    }
    result
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_Downloads, FOLDERID_LocalAppData, FOLDERID_Profile, FOLDERID_RoamingAppData,
    };
    #[test]
    fn native_known_folders_keep_data_outside_the_program_installation() {
        let dirs = AppDirs::discover().unwrap();
        assert_eq!(dirs.config, known_folder(&FOLDERID_RoamingAppData).unwrap());
        assert_eq!(dirs.downloads, known_folder(&FOLDERID_Downloads).unwrap());
        assert_eq!(
            AppDirs::home().unwrap(),
            known_folder(&FOLDERID_Profile).unwrap()
        );
        let local = known_folder(&FOLDERID_LocalAppData).unwrap();
        for root in [&dirs.cache, &dirs.state, &dirs.runtime] {
            assert!(root.is_absolute());
            assert!(root.starts_with(local.join("OmamailData")));
            assert!(!root.starts_with(local.join("omamail")));
        }
    }
}
