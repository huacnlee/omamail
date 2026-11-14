use clap::{CommandFactory, Parser, Subcommand};
use std::io::{self, Read};
mod call;
use crate::mail::drafts;
mod mail;
mod output;

#[derive(Parser)]
#[command(
    name = "omamail",
    version,
    about = "Mail backend and command-line client",
    after_help = "Examples:\n  omamail list --account me@example.org --json\n  omamail read MESSAGE_ID --json\n  omamail mark star MESSAGE_ID\n  omamail archive MESSAGE_ID\n  omamail archive MESSAGE_ID --execute\n  printf 'Hello\\n' | omamail send --to you@example.org --subject Hello --json\n\nMutations preview by default. Add --execute to apply them.\nOmitted --account uses the active account; message IDs and page tokens are opaque."
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
    /// List messages (Inbox, 25 rows by default)
    List(mail::List),
    /// Read safe message content without changing its read state
    Read(mail::ReadMessage),
    /// Preview a read or star change; use --execute to apply it
    Mark(mail::Mark),
    /// Preview archiving messages; use --execute to apply it
    Archive(mail::Action),
    /// Preview moving messages to trash; use --execute to apply it
    Trash(mail::Action),
    /// Preview reporting spam; use --execute to apply it
    Spam(mail::Action),
    /// Preview a message with UTF-8 body on stdin (maximum 16 MiB); --execute sends
    Send(mail::Send),
    /// Freeze a message and its attachments for later approval (body on stdin)
    Prepare(mail::Message),
    /// Prepare a threaded reply to a message (body on stdin)
    Reply {
        #[arg(value_name = "MESSAGE_ID")]
        id: String,
        #[command(flatten)]
        message: mail::Message,
    },
    /// Prepare a threaded reply to sender and visible recipients (body on stdin)
    ReplyAll {
        #[arg(value_name = "MESSAGE_ID")]
        id: String,
        #[command(flatten)]
        message: mail::Message,
    },
    /// Review or explicitly send the frozen draft; retries reuse its send ID
    SendPrepared {
        #[arg(value_name = "DRAFT_ID")]
        id: String,
        /// Approve sending this exact draft
        #[arg(long)]
        execute: bool,
    },
    /// Look up one send, including acknowledged entries and a running desktop outbox
    Status {
        #[command(flatten)]
        account: mail::AccountArg,
        #[arg(value_name = "SEND_ID")]
        id: String,
    },
    /// Discover sender aliases for a registered account
    Senders(mail::AccountArg),
    /// Search local contacts with source information; never select a recipient automatically
    Contacts { query: String },
    /// Serve JSON-RPC 2.0 on persistent stdin/stdout pipes
    Serve,
    #[cfg(all(feature = "agent", unix))]
    #[command(hide = true)]
    AgentWorker { id: String },
    #[cfg(all(feature = "agent", unix))]
    #[command(hide = true)]
    AgentMcp { id: String },
    #[cfg(all(feature = "agent", unix))]
    #[command(hide = true)]
    AgentOpencodeServer,
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
    #[cfg(all(feature = "agent", unix))]
    if let Command::AgentWorker { ref id } = command {
        let result = crate::backend::runtime()
            .map_err(|_| "agent_runtime_failed")
            .and_then(|runtime| runtime.block_on(crate::agent::worker::run(id)));
        if result.is_err() {
            std::process::exit(1);
        }
        return;
    }
    #[cfg(all(feature = "agent", unix))]
    if let Command::AgentMcp { ref id } = command {
        if crate::agent::mcp::run(id).is_err() {
            std::process::exit(1);
        }
        return;
    }
    #[cfg(all(feature = "agent", unix))]
    if matches!(command, Command::AgentOpencodeServer) {
        let result = crate::backend::runtime()
            .map_err(|_| "agent_runtime_failed")
            .and_then(|runtime| runtime.block_on(crate::agent::opencode::serve()));
        if let Err(error) = result {
            eprintln!("omamail: {error}");
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
    let envelope = matches!(
        command,
        Command::Call { .. }
            | Command::List(_)
            | Command::Read(_)
            | Command::Mark(_)
            | Command::Archive(_)
            | Command::Trash(_)
            | Command::Spam(_)
            | Command::Send(_)
            | Command::Prepare(_)
            | Command::Reply { .. }
            | Command::ReplyAll { .. }
            | Command::SendPrepared { .. }
            | Command::Status { .. }
            | Command::Senders(_)
            | Command::Contacts { .. }
    );
    let reply_all = matches!(command, Command::ReplyAll { .. });
    let result = match command {
        Command::List(args) => runtime.block_on(session.dispatch("mail.list", &args.params())),
        Command::Read(args) => runtime.block_on(session.dispatch("mail.read", &args.params())),
        Command::Mark(args) => runtime.block_on(session.dispatch("mail.act", &args.params())),
        Command::Archive(args) => {
            runtime.block_on(session.dispatch("mail.act", &args.params("archive")))
        }
        Command::Trash(args) => {
            runtime.block_on(session.dispatch("mail.act", &args.params("trash")))
        }
        Command::Spam(args) => runtime.block_on(session.dispatch("mail.act", &args.params("spam"))),
        Command::Send(args) => args
            .params(io::stdin())
            .and_then(|params| runtime.block_on(call::dispatch(&session, "mail.send", &params))),
        Command::Prepare(args) => args.params(io::stdin()).and_then(|params| {
            runtime.block_on(session.cli_prepare(&params, None)).and_then(drafts::save)
        }),
        Command::Reply { id, message } | Command::ReplyAll { id, message } => {
            message.params(io::stdin()).and_then(|params| {
                runtime.block_on(session.cli_prepare(&params, Some((&id, reply_all)))).and_then(drafts::save)
            })
        }
        Command::SendPrepared { id, execute } => drafts::load(&id).and_then(|prepared| {
            if execute { runtime.block_on(session.cli_send_prepared(prepared, &format!("draft-{id}"))) }
            else {
                drafts::preview(&prepared, &id)
            }
        }),
        Command::Status { account, id } => crate::mail::resolve_account(account.account.as_deref().unwrap_or(""))
            .and_then(|account| runtime.block_on(session.cli_status(&account, &id))),
        Command::Senders(args) => crate::mail::resolve_account(args.account.as_deref().unwrap_or("")).and_then(|account| {
            let aliases = runtime.block_on(session.cli_identities(&account))?;
            let mut result = crate::account::senders::request(&serde_json::json!({"mailboxes":[{"id":account.id,"ready":true,"aliases":aliases}]}))?;
            result["accountId"] = serde_json::json!(account.id);
            result["provider"] = serde_json::json!(account.provider.id());
            if let Some(rows) = aliases.as_array() {
                result["defaultEmail"] = rows.iter().find(|row| row["isDefault"] == true)
                    .or_else(|| rows.iter().find(|row| row["isPrimary"] == true))
                    .or_else(|| rows.first()).map(|row| row["email"].clone()).unwrap_or(serde_json::Value::Null);
            }
            Ok(result)
        }),
        Command::Contacts { query } => crate::contacts::search(&query),
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
            .and_then(|params| runtime.block_on(call::dispatch(&session, &method, &params))),
        Command::Serve => unreachable!(),
        #[cfg(all(feature = "agent", unix))]
        Command::AgentWorker { .. } => unreachable!(),
        #[cfg(all(feature = "agent", unix))]
        Command::AgentMcp { .. } => unreachable!(),
        #[cfg(all(feature = "agent", unix))]
        Command::AgentOpencodeServer => unreachable!(),
    };
    output::print_result(result, cli.json, envelope);
}
