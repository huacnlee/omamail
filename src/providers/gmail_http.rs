//! Fixed-origin Gmail HTTP calls with credentials confined to subprocess stdin.
use serde_json::Value;
use std::time::Duration;

#[cfg(test)]
#[path = "gmail_http_runtime_tests.rs"]
mod runtime_tests;

struct Request {
    args: Vec<String>,
    input: Vec<u8>,
}

const MAX_INPUT: usize = 64 * 1024;
const MAX_RESPONSE: usize = 16 * 1024 * 1024;

/// Path entries are individual components, never an arbitrary URL or slash path.
pub fn get(path: &[&str], query: &[(String, String)], token: &str) -> Result<Value, &'static str> {
    execute(prepare_get(path, query, token)?)
}

pub fn refresh(id: &str, secret: &str, token: &str) -> Result<Value, &'static str> {
    execute(prepare_refresh(id, secret, token)?)
}

fn execute(request: Request) -> Result<Value, &'static str> {
    // No curl config: the Authorization header or URL-encoded POST body goes
    // directly through stdin. Neither credentials nor sender data become code.
    let bytes = crate::process::run(
        "curl",
        &request.args,
        &request.input,
        Duration::from_secs(35),
        MAX_RESPONSE,
    )?;
    response(&bytes)
}

fn valid(value: &str) -> Result<(), &'static str> {
    if value.len() > MAX_INPUT || value.bytes().any(|b| b < 32 || b == 127) {
        return Err("gmail_invalid_input");
    }
    Ok(())
}

fn encode(value: &str) -> String {
    const HEX: &[u8] = b"0123456789ABCDEF";
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            result.push(byte as char);
        } else {
            result.push('%');
            result.push(HEX[(byte >> 4) as usize] as char);
            result.push(HEX[(byte & 15) as usize] as char);
        }
    }
    result
}

fn args() -> Vec<String> {
    [
        "-q",
        "--globoff",
        "--silent",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--noproxy",
        "*",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
        "--max-redirs",
        "0",
        "--write-out",
        "\n%{http_code}",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

fn prepare_get(
    path: &[&str],
    query: &[(String, String)],
    token: &str,
) -> Result<Request, &'static str> {
    valid(token)?;
    if token.is_empty() || path.is_empty() || path.len() > 16 || query.len() > 100 {
        return Err("gmail_invalid_input");
    }
    let mut url = String::from("https://gmail.googleapis.com/gmail/v1/users/me/");
    for (index, part) in path.iter().enumerate() {
        valid(part)?;
        if part.is_empty() || *part == "." || *part == ".." {
            return Err("gmail_invalid_input");
        }
        if index != 0 {
            url.push('/');
        }
        url.push_str(&encode(part));
    }
    for (index, (key, value)) in query.iter().enumerate() {
        valid(key)?;
        valid(value)?;
        url.push(if index == 0 { '?' } else { '&' });
        url.push_str(&encode(key));
        url.push('=');
        url.push_str(&encode(value));
        if url.len() > MAX_INPUT {
            return Err("gmail_invalid_input");
        }
    }
    if url.len() > MAX_INPUT {
        return Err("gmail_invalid_input");
    }
    let mut args = args();
    args.extend(["--header".into(), "@-".into(), "--url".into(), url]);
    Ok(Request {
        args,
        input: format!("Authorization: Bearer {token}\n").into_bytes(),
    })
}

fn prepare_refresh(id: &str, secret: &str, token: &str) -> Result<Request, &'static str> {
    for value in [id, secret, token] {
        valid(value)?;
        if value.is_empty() {
            return Err("gmail_invalid_input");
        }
    }
    let body = format!(
        "grant_type=refresh_token&client_id={}&client_secret={}&refresh_token={}",
        encode(id),
        encode(secret),
        encode(token)
    );
    if body.len() > MAX_INPUT {
        return Err("gmail_invalid_input");
    }
    let mut args = args();
    args.extend([
        "--header".into(),
        "Content-Type: application/x-www-form-urlencoded".into(),
        "--data-binary".into(),
        "@-".into(),
        "--url".into(),
        "https://oauth2.googleapis.com/token".into(),
    ]);
    Ok(Request {
        args,
        input: body.into_bytes(),
    })
}

fn response(bytes: &[u8]) -> Result<Value, &'static str> {
    let Some(index) = bytes.iter().rposition(|b| *b == b'\n') else {
        return Err("gmail_invalid_response");
    };
    let status = &bytes[index + 1..];
    if status.len() != 3 || !status.iter().all(u8::is_ascii_digit) {
        return Err("gmail_invalid_response");
    }
    if status == b"401" {
        return Err("gmail_unauthorized");
    }
    if status[0] != b'2' {
        return Err("gmail_http_failed");
    }
    let value: Value =
        serde_json::from_slice(&bytes[..index]).map_err(|_| "gmail_invalid_response")?;
    if !value.is_object() {
        return Err("gmail_invalid_response");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unauthorized_is_distinct_without_echoing_server_body() {
        assert_eq!(
            response(b"synthetic-secret\n401"),
            Err("gmail_unauthorized")
        );
        assert_eq!(response(b"synthetic-secret\n403"), Err("gmail_http_failed"));
    }
    #[test]
    fn get_encodes_untrusted_path_and_query_without_exposing_token() {
        let request = prepare_get(
            &["messages", "x/y?z#@"],
            &[("q".into(), "from:a+b@example.org &主题".into())],
            "synthetic-secret",
        )
        .unwrap();
        assert_eq!(request.args[0], "-q");
        assert!(request.args.contains(&"--globoff".into()));
        assert_eq!(
            request.args.last().unwrap(),
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/x%2Fy%3Fz%23%40?q=from%3Aa%2Bb%40example.org%20%26%E4%B8%BB%E9%A2%98"
        );
        assert!(!request.args.iter().any(|s| s.contains("synthetic-secret")));
        assert_eq!(request.input, b"Authorization: Bearer synthetic-secret\n");
    }
    #[test]
    fn controls_are_rejected_before_any_request_exists() {
        for bad in ["x\n", "x\r", "x\r\n", "x\0", "x\u{7f}", "x\t"] {
            assert_eq!(
                prepare_get(&["messages"], &[], bad).err(),
                Some("gmail_invalid_input")
            );
            assert_eq!(
                prepare_get(&[bad], &[], "valid").err(),
                Some("gmail_invalid_input")
            );
            assert_eq!(
                prepare_refresh("id", "secret", bad).err(),
                Some("gmail_invalid_input")
            );
            assert_eq!(
                prepare_refresh(bad, "secret", "token").err(),
                Some("gmail_invalid_input")
            );
            assert_eq!(
                prepare_refresh("id", bad, "token").err(),
                Some("gmail_invalid_input")
            );
            assert_eq!(
                prepare_get(&["messages"], &[(bad.into(), "value".into())], "token").err(),
                Some("gmail_invalid_input")
            );
            assert_eq!(
                prepare_get(&["messages"], &[("q".into(), bad.into())], "token").err(),
                Some("gmail_invalid_input")
            );
        }
        for path in [vec![".."], vec!["."], vec![""]] {
            assert!(prepare_get(&path, &[], "token").is_err());
        }
    }
    #[test]
    fn refresh_form_preserves_quotes_backslashes_unicode_without_argv_credentials() {
        let request = prepare_refresh("id", "quote\"\\", "é+&=").unwrap();
        assert_eq!(
            String::from_utf8(request.input).unwrap(),
            "grant_type=refresh_token&client_id=id&client_secret=quote%22%5C&refresh_token=%C3%A9%2B%26%3D"
        );
        assert!(
            !request
                .args
                .iter()
                .any(|s| s.contains("quote") || s.contains("é"))
        );
        assert_eq!(
            request.args.last().unwrap(),
            "https://oauth2.googleapis.com/token"
        );
    }
    #[test]
    fn status_trailer_rejects_redirects_and_never_echoes_errors() {
        assert_eq!(response(b"{\"ok\":true}\n200").unwrap()["ok"], true);
        for input in [
            b"synthetic-secret\n302".as_slice(),
            b"synthetic-secret\n401",
            b"{}\n000",
            b"{}\n200\n",
            b"[]\n200",
        ] {
            assert!(response(input).is_err());
            assert!(!response(input).unwrap_err().contains("synthetic-secret"));
        }
    }
}
