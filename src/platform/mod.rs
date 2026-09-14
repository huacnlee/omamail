//! Operating-system boundaries shared by backend features.
pub mod dirs;
pub(crate) mod ipc;
pub(crate) mod private_fs;
#[cfg(test)]
mod tests;
