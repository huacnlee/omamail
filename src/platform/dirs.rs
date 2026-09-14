//! Platform data roots. Consumers append their existing `omamail` subdirectory,
//! retaining Linux plugin layouts. Discovery never creates or writes directories.
use std::{
    ffi::OsString,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppDirs {
    pub config: PathBuf,
    pub cache: PathBuf,
    pub state: PathBuf,
    pub runtime: PathBuf,
    pub downloads: PathBuf,
}
impl AppDirs {
    pub fn discover() -> Result<Self, &'static str> {
        Self::discover_with(|name| std::env::var_os(name), &std::env::temp_dir())
    }
    pub fn home() -> Result<PathBuf, &'static str> {
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
            Err("platform_directories_unsupported")
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
                let config = root("XDG_CONFIG_HOME", home.join(".config"));
                let downloads = root("XDG_DOWNLOAD_DIR", linux_downloads(&home, &config));
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
#[cfg(target_os = "linux")]
fn linux_downloads(home: &Path, config: &Path) -> PathBuf {
    if let Ok(text) = std::fs::read_to_string(config.join("user-dirs.dirs")) {
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
