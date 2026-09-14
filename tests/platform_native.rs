//! Isolated native security gate. This imports the actual platform module so
//! Windows can run its regressions independently of Unix-only legacy fixtures.
#![allow(dead_code, unused_imports)]
#[path = "../src/platform/mod.rs"]
mod platform;
