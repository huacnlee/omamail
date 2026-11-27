//! The agent's worker processes, run by the app's own executable.
//!
//! The `omamail` library starts an AI job by launching the running
//! executable again (`std::env::current_exe()`) with a hidden subcommand:
//! `agent-worker <id>` for the job, `agent-mcp <id>` for the draft tool the
//! AI CLI talks to, and `agent-opencode-server` for OpenCode's shared server.
//! In `omamail serve` that executable is `omamail`. Inside the NSH host it is
//! the app, whose `main` is NSH's and knows no such subcommands, so the job
//! would start the whole app a second time instead of its worker.
//!
//! This module gives the app's executable the same three entry points: a
//! constructor, run by the loader before `main`, looks at argv and, when the
//! process was started as one of these, runs it through the library's own
//! CLI handling and exits before NSH starts. Any other argv leaves the
//! process untouched. Because the worker runs the very executable the
//! backend runs, the job's ownership checks (the worker's argv against
//! `current_exe()` on Linux) hold unchanged, and no second binary needs
//! packaging, locating or version matching.

#[cfg(all(not(test), any(target_os = "macos", target_os = "linux")))]
mod imp {
    use std::ffi::{CStr, OsString, c_char, c_int};
    use std::os::unix::ffi::OsStringExt;

    /// The library's hidden subcommands that re-launch `current_exe()`.
    const ENTRIES: [&[u8]; 3] = [b"agent-worker", b"agent-mcp", b"agent-opencode-server"];

    /// Called by the loader with the process's argv: glibc passes
    /// `(argc, argv, envp)` to `.init_array` functions, dyld the same to
    /// `__mod_init_func` ones. Rust's own argv capture may not have run yet,
    /// so this reads the arguments it is given.
    extern "C" fn enter(argc: c_int, argv: *const *const c_char) {
        if argc < 2 || argv.is_null() {
            return;
        }
        // SAFETY: the loader passes `argc` valid NUL-terminated strings.
        let args: Vec<OsString> = (0..argc as usize)
            .map(|i| unsafe { *argv.add(i) })
            .take_while(|arg| !arg.is_null())
            .map(|arg| OsString::from_vec(unsafe { CStr::from_ptr(arg) }.to_bytes().to_vec()))
            .collect();
        let Some(first) = args.get(1) else { return };
        if !ENTRIES.contains(&first.as_encoded_bytes()) {
            return;
        }
        // `omamail`'s `main` runs with SIGPIPE ignored, as every Rust
        // binary does; the MCP server writes to a pipe its client may close.
        unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
        omamail::cli::run_from(args);
        std::process::exit(0);
    }

    #[used]
    #[cfg_attr(target_os = "linux", unsafe(link_section = ".init_array"))]
    #[cfg_attr(target_vendor = "apple", unsafe(link_section = "__DATA,__mod_init_func"))]
    static ENTER: extern "C" fn(c_int, *const *const c_char) = enter;

    /// Keeps the constructor in the linked executable: the linker drops an
    /// object nothing refers to, `#[used]` statics and all. This refers to
    /// the function, which sits in the static's object; taking the static's
    /// own address would not link, as the loader's list is no ordinary data.
    #[inline(never)]
    pub fn keep() {
        std::hint::black_box(enter as extern "C" fn(c_int, *const *const c_char));
    }
}

/// Makes the agent's worker subcommands run in this executable (see the
/// module documentation). Called from the module registration, which every
/// host runs, so the entry is linked wherever the backend is.
pub fn keep() {
    #[cfg(all(not(test), any(target_os = "macos", target_os = "linux")))]
    imp::keep();
}
