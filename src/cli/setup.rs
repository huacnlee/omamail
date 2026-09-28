use std::path::PathBuf;
use std::process::Command;

/// Makes Omamail the desktop's mail client: the mailto: handler and Omarchy's
/// SUPER+SHIFT+E. The work is `scripts/default-mail.sh` in the installed
/// plugin, which the settings page runs too, so the two cannot disagree.
#[derive(clap::Args)]
pub struct Setup {
    /// Give SUPER+SHIFT+E back to Omarchy's own email binding
    #[arg(long, conflicts_with = "status")]
    undo: bool,
    /// Print whether Omamail is the default mail client
    #[arg(long)]
    status: bool,
}

fn plugin_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("OMAMAIL_PLUGIN_DIR").filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))?;
    Some(config.join("omarchy/plugins/omamail"))
}

pub fn run(args: &Setup) -> i32 {
    let Some(dir) = plugin_dir() else {
        eprintln!("omamail: HOME is not set");
        return 1;
    };
    let script = dir.join("scripts/default-mail.sh");
    if !script.is_file() {
        eprintln!(
            "omamail: {} not found; install the Omamail plugin or set OMAMAIL_PLUGIN_DIR",
            script.display()
        );
        return 1;
    }
    let mut command = Command::new("sh");
    command.arg(&script);
    if args.status {
        command.arg("status");
    } else if args.undo {
        command.arg("off");
    } else {
        command.arg("on").arg(&dir);
    }
    match command.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => {
            eprintln!("omamail: could not run {}", script.display());
            1
        }
    }
}
