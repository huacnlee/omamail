use clap::{CommandFactory, Parser, Subcommand};
use std::io::{self, Read};
mod call;
mod output;

#[derive(Parser)]
#[command(
    name = "omamail",
    version,
    about = "Mail backend and command-line client"
)]
struct Cli {
    /// Print machine-readable JSON instead of human-readable tables
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Serve JSON-RPC 2.0 on persistent stdin/stdout pipes
    Serve,
    #[command(hide = true)]
    AgentWorker { id: String },
    /// Report backend version and implemented methods
    Info,
    /// Print the executable version
    Version,
    /// Inspect desktop accounts without exposing credentials
    Accounts {
        #[command(subcommand)]
        command: ListCommand,
    },
    /// Inspect mail provider capabilities
    Providers {
        #[command(subcommand)]
        command: ListCommand,
    },
    /// Inspect a mail message
    Message {
        #[command(subcommand)]
        command: MessageCommand,
    },
    /// Call a backend method with JSON parameters on stdin (maximum 1 MiB)
    #[command(
        long_about = "Call a backend method with JSON parameters on stdin (maximum 1 MiB).\nEmpty stdin means {}. Errors exit 1. With --json, prints an ok/result or\nok/error envelope. Each invocation has its own session; use serve for\nstateful upload sequences. Mutations are never automatically retried."
    )]
    Call { method: String },
}

#[derive(Subcommand)]
enum ListCommand {
    /// List available entries
    List,
}

#[derive(Subcommand)]
enum MessageCommand {
    /// Read RFC 822 bytes from stdin (maximum 16 MiB) and print the MIME payload
    Parse,
}

fn parse_message() -> Result<serde_json::Value, &'static str> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(crate::message::MAX_MESSAGE as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "message_input_failed")?;
    crate::message::parse(&bytes)
}

pub fn run() {
    let cli = Cli::parse();
    let Some(command) = cli.command else {
        Cli::command().print_help().expect("print help");
        println!();
        return;
    };
    if matches!(command, Command::Serve) {
        if cli.json {
            Cli::command()
                .error(
                    clap::error::ErrorKind::ArgumentConflict,
                    "serve already uses JSON-RPC; --json is only for CLI output",
                )
                .exit();
        }
        if crate::backend::stdio::serve().is_err() {
            eprintln!("omamail: backend I/O failed");
            std::process::exit(1);
        }
        return;
    }
    if let Command::AgentWorker { ref id } = command {
        let result = crate::backend::runtime()
            .map_err(|_| "agent_runtime_failed")
            .and_then(|runtime| runtime.block_on(crate::agent::worker::run(id)));
        if result.is_err() {
            std::process::exit(1);
        }
        return;
    }
    let session = crate::backend::Session::default();
    let runtime = crate::backend::runtime().unwrap_or_else(|_| {
        eprintln!("omamail: could not start async runtime");
        std::process::exit(1);
    });
    let empty = serde_json::json!({});
    let envelope = matches!(command, Command::Call { .. });
    let result = match command {
        Command::Info => runtime.block_on(session.dispatch("system.info", &empty)),
        Command::Accounts { .. } => runtime.block_on(session.dispatch("accounts.list", &empty)),
        Command::Providers { .. } => runtime.block_on(session.dispatch("providers.list", &empty)),
        Command::Message { .. } => parse_message(),
        Command::Version => {
            if !cli.json {
                println!("omamail {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            Ok(serde_json::json!({"version":env!("CARGO_PKG_VERSION")}))
        }
        Command::Call { method } => call::read_params(io::stdin())
            .and_then(|params| runtime.block_on(session.dispatch(&method, &params))),
        Command::Serve | Command::AgentWorker { .. } => unreachable!(),
    };
    output::print_result(result, cli.json, envelope);
}
