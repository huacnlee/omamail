//! Windows remains fail-closed until the handle-relative reparse checks,
//! current-user DACLs, atomic replace and exclusive-sharing lock implementation
//! have native regression evidence. Never substitute std::fs path operations.
use std::{ffi::OsStr, fs::File, path::Path};
type Result<T> = std::result::Result<T, &'static str>;
pub(crate) struct ExclusiveLock;
pub(crate) fn directories(_: &Path, _: &[&str], _: bool) -> Result<Option<File>> {
    Err("platform_private_storage_unsupported")
}
pub(crate) fn directories_readonly(_: &Path, _: &[&str]) -> Result<Option<File>> {
    Err("platform_private_storage_unsupported")
}
pub(crate) fn open_dir(_: &File, _: &OsStr, _: bool, _: bool) -> Result<Option<File>> {
    Err("platform_private_storage_unsupported")
}
pub(crate) fn regular(_: &File, _: &str, _: bool) -> Result<Option<File>> {
    Err("platform_private_storage_unsupported")
}
pub(crate) fn regular_readonly(_: &File, _: &str) -> Result<Option<File>> {
    Err("platform_private_storage_unsupported")
}
pub(crate) fn atomic_replace(_: &File, _: &str, _: &[u8]) -> Result<()> {
    Err("platform_private_storage_unsupported")
}
pub(crate) fn remove_owned(_: &File, _: &str) -> Result<()> {
    Err("platform_private_storage_unsupported")
}
pub(crate) fn lock_exclusive(_: &File, _: &str) -> Result<ExclusiveLock> {
    Err("platform_private_storage_unsupported")
}
pub(crate) fn names(_: &File) -> Result<Vec<String>> {
    Err("platform_private_storage_unsupported")
}

pub(crate) fn open_external(_: &Path) -> Result<File> {
    Err("platform_private_storage_unsupported")
}
pub(crate) fn same_file_version(_: &std::fs::Metadata, _: &std::fs::Metadata) -> bool {
    false
}
