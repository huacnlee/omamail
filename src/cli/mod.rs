use std::io::{self, Read};
mod call;

pub fn run() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["call", method] => {
            let result = call::read_params(io::stdin())
                .and_then(|params| crate::backend::Session::default().dispatch(method, &params));
            call::print_result(result);
            Ok(())
        }
        ["message", "parse"] => {
            let mut bytes = Vec::new();
            if io::stdin()
                .take(crate::message::MAX_MESSAGE as u64 + 1)
                .read_to_end(&mut bytes)
                .is_err()
            {
                eprintln!("omamail: message input failed");
                std::process::exit(1);
            }
            match crate::message::parse(&bytes) {
                Ok(value) => println!("{value}"),
                Err(code) => {
                    eprintln!("omamail: {code}");
                    std::process::exit(1);
                }
            }
            Ok(())
        }
        ["--backend"] => crate::backend::stdio::serve(),
        ["info"] | ["accounts", "list"] | ["providers", "list"] => {
            let method = if args[0] == "info" {
                "system.info"
            } else if args[0] == "providers" {
                "providers.list"
            } else {
                "accounts.list"
            };
            match crate::backend::Session::default().dispatch(method, &serde_json::json!({})) {
                Ok(value) => println!("{value}"),
                Err(code) => {
                    eprintln!("omamail: {code}");
                    std::process::exit(1);
                }
            }
            Ok(())
        }
        ["--help"] | ["-h"] | [] => {
            println!(
                "Usage: omamail info | accounts list | providers list | message parse | call METHOD | --backend\n\ninfo            Report backend version and supported methods as JSON\naccounts list   List desktop accounts without credentials as JSON\nproviders list  List provider capabilities as JSON\nmessage parse   Read RFC 822 bytes from stdin and print a MIME payload as JSON\ncall METHOD     Call a backend method with JSON params on stdin (maximum 1 MiB)\n                Empty stdin means {{}}. Prints an ok/result or ok/error JSON envelope.\n                Errors exit 1. One session per invocation; use --backend for stateful sequences.\n--backend       Serve JSON-RPC 2.0 on persistent stdin/stdout pipes"
            );
            Ok(())
        }
        _ => {
            eprintln!("omamail: unknown command; use --help");
            std::process::exit(2);
        }
    };
    if result.is_err() {
        eprintln!("omamail: backend I/O failed");
        std::process::exit(1);
    }
}
