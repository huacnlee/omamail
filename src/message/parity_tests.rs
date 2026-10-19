use super::*;
use serde_json::{Value, json};
use std::io::Write;
fn oracle(operation: &str, input: &Value) -> Value {
    let script = r#"const L=require('./benchmarks/mail/baseline/ui/tests/load.js'); const M=L.load('message/Message.js');const D=L.load('message/Direction.js'); const x=JSON.parse(require('fs').readFileSync(0,'utf8'));let r; if(process.argv[1]==='compose')r=M.buildSendPayload(x);else r={summary:M.summarize(x.message,new Date(x.now)),body:M.extractBody(x.message.payload),html:M.extractHtml(x.message.payload),attachments:M.attachments(x.message.payload)};if(process.argv[1]!=='compose'){r.summary.subjectDirection=D.resolveSubject(r.summary.subject,D.AUTO);r.body.bodyDirection=D.resolveBody(r.body.text,D.AUTO);}process.stdout.write(JSON.stringify(r));"#;
    let mut child = std::process::Command::new("node")
        .args(["-e", script, operation])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let result = child.wait_with_output().unwrap();
    assert!(result.status.success());
    serde_json::from_slice(&result.stdout).unwrap()
}
#[test]
fn outgoing_matches_javascript_oracle() {
    let base = json!({"from":"sender@example.org","to":"recipient@example.org","subject":"Hello","body":"hello\nworld","date":"Sat, 12 Sep 2026 10:00:00 +0000","messageId":"<test@example.org>","boundary":"boundary"});
    for patch in [
        json!({}),
        json!({"body":"مرحبا بالعالم"}),
        json!({"fromName":"张三","subject":"你好","cc":"a@example.org","bcc":"hidden@example.org"}),
        json!({"attachments":[{"filename":"binary.bin","mimeType":"application/octet-stream","data":"AP_-AQ"}]}),
        json!({"calendar":{"text":"BEGIN:VCALENDAR\r\nEND:VCALENDAR","method":"REPLY"}}),
        json!({"signatureHtml":"<b>Signature</b>"}),
    ] {
        let mut fields = base.clone();
        for (k, v) in patch.as_object().unwrap() {
            fields[k] = v.clone();
        }
        assert_eq!(
            compose::build(&fields).unwrap(),
            oracle("compose", &fields),
            "{fields}"
        );
    }
}
#[test]
fn prepared_resources_match_javascript_oracle() {
    for raw in [
        "From: Example <sender@example.org>\r\nTo: a@example.org\r\nSubject: =?UTF-8?B?5L2g5aW9?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHello\r\nWorld",
        "Content-Type: text/html; charset=utf-8\r\n\r\n<p>Hello &amp; world</p><img alt=\"picture\" src=\"https://example.org/a.png\">",
        "Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nbody\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"test.bin\"\r\nContent-Transfer-Encoding: base64\r\n\r\nAAEC\r\n--x--",
    ] {
        let mut message = json!({"payload":parse(raw.as_bytes()).unwrap()});
        message["id"] = json!("id");
        message["internalDate"] = json!("1789207200000");
        message["snippet"] = json!("hello &amp; world");
        let now = 1789207260000;
        assert_eq!(
            content::prepare(&message, now).unwrap(),
            oracle("prepare", &json!({"message":message,"now":now}))
        );
    }
}

#[test]
fn outgoing_refuses_header_controls_and_preserves_binary() {
    for control in ['\0', '\t', '\u{7f}'] {
        let fields = json!({"to":format!("a@example.org{control}Bcc: victim@example.org")});
        assert!(compose::build(&fields).is_err());
    }
    let fields = json!({"to":"a@example.org\r\nBcc: victim@example.org","body":"legitimate\r\nbody","attachments":[{"filename":"x\r\nInjected: bad","data":"AP_-AQ"}],"boundary":"x"});
    let output = compose::build(&fields).unwrap();
    let raw = URL_SAFE_NO_PAD
        .decode(output["raw"].as_str().unwrap())
        .unwrap();
    let wire = String::from_utf8(raw.clone()).unwrap();
    assert!(!wire.contains("\r\nBcc:"));
    assert!(!wire.contains("\r\nInjected:"));
    let parsed = mailparse::parse_mail(&raw).unwrap();
    assert_eq!(parsed.subparts[1].get_body_raw().unwrap(), [0, 255, 254, 1]);
}
#[test]
fn outgoing_nested_boundary_cannot_alias_outer() {
    let fields = json!({"body":"مرحبا","boundary":"alt_".repeat(15),"attachments":[{"filename":"x","data":"AA"}]});
    let output = compose::build(&fields).unwrap();
    let bytes = URL_SAFE_NO_PAD
        .decode(output["raw"].as_str().unwrap())
        .unwrap();
    let parsed = mailparse::parse_mail(&bytes).unwrap();
    assert_eq!(parsed.subparts.len(), 2);
    assert_eq!(parsed.subparts[0].subparts.len(), 2);
}
#[test]
fn prepare_bounds_untrusted_mime_and_restores_compose_text() {
    let mut part = json!({"mimeType":"text/plain","body":{"data":"aGVsbG8"}});
    for _ in 0..20 {
        part = json!({"parts":[part]});
    }
    assert_eq!(
        content::prepare(&json!({"payload":part}), 0).unwrap()["body"]["text"],
        ""
    );
    assert!(content::request("message.prepare", &json!({"message":{},"now":"wrong"})).is_err());
    assert_eq!(content::request("message.composeText",&json!({"signature":" signed ","body":"one\ntwo","summary":{"subject":"hello","from":{"display":"Jane"},"fullTime":"today"}})).unwrap(),json!({"body":"\n\nsigned\n\nOn today, Jane wrote:\n> one\n> two","quote":"On today, Jane wrote:\n> one\n> two","replySubject":"Re: hello"}));
}

#[test]
fn prepare_decodes_encoded_words_and_legacy_bodies_like_javascript() {
    for (subject, body, charset) in [
        (
            "=?utf-8?Q?hello_=E4=BD=A0?= =?utf-8?B?5aW9?=",
            "8J+YgCBoaQ",
            "utf-8",
        ),
        ("=?iso-8859-1?Q?caf=E9?=", "Y2Fm6Q", "iso-8859-1"),
        ("bad =?utf-8?B?%%%?= tail", "_wBB", "utf-8"),
    ] {
        let message = json!({"payload":{"mimeType":"text/plain","headers":[{"name":"Subject","value":subject},{"name":"From","value":"\"Jane, Example\" <jane@example.org>"},{"name":"Content-Type","value":format!("text/plain; charset={charset}")}],"body":{"data":body}},"thread":{"memberIds":[" a ",null,"",12],"unread":true},"labelIds":["INBOX"]});
        assert_eq!(
            content::prepare(&message, 0).unwrap(),
            oracle("prepare", &json!({"message":message,"now":0}))
        );
    }
}

#[test]
fn composition_has_explicit_output_and_attachment_limits() {
    assert_eq!(
        compose::build(&json!({"body":"x".repeat(compose::MAX_RAW)})).unwrap_err(),
        "message_too_large"
    );
    assert_eq!(
        compose::build(&json!({"attachments":vec![json!({});257]})).unwrap_err(),
        "too_many_attachments"
    );
    assert_eq!(
        compose::build(&json!({"attachments":[{"data":"%%%"}]})).unwrap_err(),
        "invalid_attachment_encoding"
    );
}

#[test]
fn outgoing_preserves_twenty_mebibyte_attachment_support() {
    use base64::engine::general_purpose::STANDARD;
    let data = STANDARD.encode(vec![0xab; 20 * 1024 * 1024]);
    let output=compose::build(&json!({"to":"test@example.org","body":"hello","attachments":[{"filename":"large.bin","data":data}]})).unwrap();
    assert!(output["raw"].as_str().unwrap().len() < 48 * 1024 * 1024);
}
#[test]
fn outgoing_address_words_never_hide_address_structure() {
    use mailparse::MailHeaderMap;
    for name in ["工 <victim@example.org>, Alias", "工, Lee"] {
        let quoted = format!("\"{name}\"");
        let fields = json!({"from":"alias@example.org","fromName":name,
            "to":format!("{quoted} <to@example.org>"),
            "cc":format!("{quoted} <cc@example.org>"),
            "bcc":format!("{quoted} <bcc@example.org>"),"body":"body"});
        let payload = crate::message::compose::build(&fields).unwrap();
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload["raw"].as_str().unwrap())
            .unwrap();
        let (headers, _) = mailparse::parse_headers(&bytes).unwrap();
        for (key, expected) in [
            ("From", "alias@example.org"),
            ("To", "to@example.org"),
            ("Cc", "cc@example.org"),
            ("Bcc", "bcc@example.org"),
        ] {
            let addresses =
                mailparse::addrparse_header(headers.get_first_header(key).unwrap()).unwrap();
            let one = addresses
                .extract_single_info()
                .expect("one structural address");
            assert_eq!(one.addr, expected);
            assert_eq!(one.display_name.as_deref(), Some(name));
        }
    }
}

fn composed_headers(fields: &Value) -> (Vec<u8>, Value) {
    let raw = URL_SAFE_NO_PAD
        .decode(compose::build(fields).unwrap()["raw"].as_str().unwrap())
        .unwrap();
    let summary = content::prepare(&json!({"payload":parse(&raw).unwrap()}), 0).unwrap();
    (raw, summary["summary"].clone())
}

#[test]
fn display_names_with_specials_stay_one_name_in_every_address_header() {
    use mailparse::MailHeaderMap;
    let mut names: Vec<(String, String)> = "()<>[]:;@\\,.\""
        .chars()
        .map(|c| format!("Ada {c} Lovelace"))
        .chain(
            [
                "Doe, Jane",
                "Say \"hi\" \\ bye",
                "ends with \\",
                "\"",
                "()<>[]:;@\\,.\"",
                "Team: eve@example.net;",
                "eve@example.net",
                "Müller, Jörg",
                "工, Lee <eve@example.net>",
                // Readers decode `=?` even inside quotes, so it leaves encoded.
                "=?UTF-8?B?PGV2ZUBleGFtcGxlLm5ldD4=?=",
            ]
            .map(String::from),
        )
        .map(|name| (name.clone(), name))
        .collect();
    for (typed, read) in [
        ("Ada\rBcc: eve@example.net", "Ada Bcc: eve@example.net"),
        ("Ada\nLovelace", "Ada Lovelace"),
        ("Ada\r\nLovelace", "Ada Lovelace"),
    ] {
        names.push((typed.into(), read.into()));
    }
    for (name, read) in &names {
        // The To text as the composer's field holds it.
        let typed = |email: &str| format!("{} <{email}>", compose::quoted_phrase(name, false));
        let fields = json!({"from":"me@example.org","fromName":name,
            "to":format!("{}, ada@example.org", typed("to@example.org")),
            "cc":typed("cc@example.org"),"bcc":typed("bcc@example.org"),
            "replyTo":typed("reply@example.org"),"body":"body"});
        let (raw, summary) = composed_headers(&fields);
        let (headers, _) = mailparse::parse_headers(&raw).unwrap();
        assert!(
            headers.iter().all(|h| h.get_value_raw().is_ascii()),
            "{name:?}"
        );
        assert!(headers.get_all_headers("Bcc").len() == 1, "{name:?}");
        for (key, expected) in [
            ("From", vec!["me@example.org"]),
            ("To", vec!["to@example.org", "ada@example.org"]),
            ("Cc", vec!["cc@example.org"]),
            ("Bcc", vec!["bcc@example.org"]),
            ("Reply-To", vec!["reply@example.org"]),
        ] {
            let list = mailparse::addrparse_header(headers.get_first_header(key).unwrap()).unwrap();
            let singles: Vec<_> = list
                .iter()
                .map(|a| match a {
                    mailparse::MailAddr::Single(s) => s.clone(),
                    _ => panic!("{name:?} made a group in {key}"),
                })
                .collect();
            assert_eq!(
                singles.iter().map(|s| s.addr.as_str()).collect::<Vec<_>>(),
                expected,
                "{name:?} {key}"
            );
            assert_eq!(
                singles[0].display_name.as_deref(),
                Some(read.as_str()),
                "{name:?} {key}"
            );
        }
        // And the reader this app draws a message with agrees.
        assert_eq!(summary["from"]["name"], read.as_str(), "{name:?}");
        assert_eq!(summary["to"].as_array().unwrap().len(), 2, "{name:?}");
        assert_eq!(summary["to"][0]["name"], read.as_str(), "{name:?}");
        assert_eq!(summary["cc"][0]["name"], read.as_str(), "{name:?}");
    }
    assert_eq!(
        compose::build(&json!({"from":"me@example.org","fromName":"Ada\0Lovelace"})).unwrap_err(),
        "invalid_message_header"
    );
}

fn to_line(to: &str) -> Result<String, &'static str> {
    use mailparse::MailHeaderMap;
    let raw = URL_SAFE_NO_PAD
        .decode(
            compose::build(&json!({"to":to,"body":"b"}))?["raw"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
    let (headers, _) = mailparse::parse_headers(&raw).unwrap();
    Ok(String::from_utf8(
        headers
            .get_first_header("To")
            .unwrap()
            .get_value_raw()
            .to_vec(),
    )
    .unwrap())
}

#[test]
fn typed_ascii_lists_go_out_as_typed_and_rewrites_refuse_what_they_could_change() {
    // A group in the middle, a nameless address with specials, a comment, an
    // unquoted comma, a half-typed draft: all as typed.
    for typed in [
        "ada@example.org, Team: eve@example.net; <dave@example.org>",
        "<a@example.org,eve@example.net>, <team:eve@example.net;>",
        "Smith (Sales) <s@example.org>, ann@example.org (Ann)",
        "Doe, Jane <x@example.org>",
        "bo",
    ] {
        assert_eq!(to_line(typed).unwrap(), typed);
    }
    // A list ASCII cannot carry, or with a name holding `=?`, is written again:
    // a nameless address keeps its brackets unless it is a plain addr-spec.
    assert_eq!(
        to_line("Jörg <j@example.org>, <a@example.org,eve@example.net>, <c@example.org>").unwrap(),
        "=?UTF-8?B?SsO2cmc=?= <j@example.org>, <a@example.org,eve@example.net>, c@example.org"
    );
    assert_eq!(
        to_line("=?utf-8?q?Team=3A_eve=40example=2Enet=3B?= <dave@example.org>").unwrap(),
        format!(
            "=?UTF-8?B?{}?= <dave@example.org>",
            base64::engine::general_purpose::STANDARD
                .encode("=?utf-8?q?Team=3A_eve=40example=2Enet=3B?=")
        )
    );
    // And refuses a group, an address that is not ASCII or printable, and what
    // it cannot read.
    for typed in [
        "Jörg <j@example.org>, Team: eve@example.net; <dave@example.org>",
        "Équipe: a@example.org, b@example.org;",
        "Jörg <j@example.org>, undisclosed-recipients:;",
        "=?x?=: a@example.org;",
        "x <jörg@example.org>",
        "jörg@example.org",
        "x <a\u{85}@example.org>",
        "x <a\0@example.org>",
        "Müller, Jörg <j@example.org>",
        // Rewritten, these would lose their first recipient: mailparse reads the
        // address's `=?utf-8?q?` as an encoded word that runs into the next
        // name, and the address turns into display text.
        "=?utf-8?q?a?=b@example.org, Jörg <c@example.org>",
        " =?utf-8?q?a?=b@example.org=?x?= ,=?utf-8?q?a?=Jörg <c@example.org,d@example.org>",
    ] {
        assert_eq!(
            to_line(typed).unwrap_err(),
            "invalid_message_header",
            "{typed:?}"
        );
    }
}

#[test]
fn composed_lists_name_the_recipients_that_were_typed() {
    // Random lists of specials, names that need rewriting and addresses:
    // whenever a message is built, its To names exactly the addresses mailparse
    // reads in the typed text, rewritten or not.
    let pieces = [
        "\"",
        "<",
        ">",
        "(",
        ")",
        "[",
        "]",
        ":",
        ";",
        "@",
        "\\",
        ",",
        ".",
        " ",
        "a",
        "é",
        "Jörg ",
        "=?x?= ",
        "\"Müller, Jörg\" ",
        "<a@example.org>",
        "b@example.org",
        "<c@example.org,d@example.org>",
        "Team: ",
        "(Sales) ",
    ];
    let mut seed: u64 = 0x9e3779b97f4a7c15;
    for _ in 0..200000 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let mut x = seed;
        let typed: String = (0..(seed % 10) as usize + 1)
            .map(|_| {
                x = x
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                pieces[((x >> 33) as usize) % pieces.len()]
            })
            .collect();
        let Ok(payload) = compose::build(&json!({"to":typed,"body":"b"})) else {
            continue;
        };
        let raw = URL_SAFE_NO_PAD
            .decode(payload["raw"].as_str().unwrap())
            .unwrap();
        let (headers, _) = mailparse::parse_headers(&raw).unwrap();
        let before = format!("To: {typed}\r\n\r\n");
        let (typed_headers, _) = mailparse::parse_headers(before.as_bytes()).unwrap();
        if let Ok(expected) = envelope::addresses(&typed_headers, "To") {
            assert_eq!(
                envelope::addresses(&headers, "To"),
                Ok(expected),
                "{typed:?}"
            );
        }
    }
}

#[test]
fn javascript_rewrites_name_the_typed_recipients() {
    // `Message.buildRawMessage` has no RFC 5322 parser of its own, so its
    // rewrites are judged by mailparse here: a line it writes is printable
    // ASCII, and a rewritten one names exactly the typed recipients.
    let pieces = [
        "\"",
        "<",
        ">",
        "(",
        ")",
        "[",
        "]",
        ":",
        ";",
        "@",
        "\\",
        ",",
        ".",
        " ",
        "a",
        "é",
        "Jörg ",
        "=?x?= ",
        "=?utf-8?q?a?=",
        "\"Müller, Jörg\" ",
        "<a@example.org>",
        "b@example.org",
        "<c@example.org,d@example.org>",
        "Team: ",
        "(Sales) ",
        "\u{85}",
        "\0",
    ];
    let mut seed: u64 = 0x1234_5678_9abc_def1;
    let inputs: Vec<String> = (0..100000)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let mut x = seed;
            (0..(seed % 10) as usize + 1)
                .map(|_| {
                    x = x
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    pieces[((x >> 33) as usize) % pieces.len()]
                })
                .collect()
        })
        .collect();
    let script = r#"const M=require('./ui/tests/load.js').load('message/Message.js');const xs=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(xs.map(t=>{const r=M.buildRawMessage({to:t,body:'x'});return r===null?null:r.split('\r\n').find(l=>l.startsWith('To:'))})))"#;
    let mut child = std::process::Command::new("node")
        .args(["-e", script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(json!(inputs).to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let lines: Vec<Option<String>> = serde_json::from_slice(&output.stdout).unwrap();
    for (typed, line) in inputs.iter().zip(&lines) {
        let Some(line) = line else { continue };
        assert!(line.bytes().all(|b| (0x20..0x7f).contains(&b)), "{typed:?}");
        if line == &format!("To: {typed}") {
            continue;
        }
        let written = format!("{line}\r\n\r\n");
        let (headers, _) = mailparse::parse_headers(written.as_bytes()).unwrap();
        let before = format!("To: {typed}\r\n\r\n");
        let (typed_headers, _) = mailparse::parse_headers(before.as_bytes()).unwrap();
        if let Ok(expected) = envelope::addresses(&typed_headers, "To") {
            assert_eq!(
                envelope::addresses(&headers, "To"),
                Ok(expected),
                "{typed:?} -> {line:?}"
            );
        }
    }
}

#[test]
fn picker_text_reads_as_one_address_in_mailparse() {
    // The To text `Recipients.address` writes for a contact, read by the parser
    // the backend writes the header with.
    let mut names: Vec<String> = "()<>[]:;@\\,.\""
        .chars()
        .map(|c| format!("Ada {c} Lovelace"))
        .collect();
    names.extend(
        [
            "Doe, Jane",
            "Say \"hi\" \\ bye",
            "ends with \\",
            "Team: eve@example.net;",
            "Müller, Jörg",
            "Jörg Müller",
            "Jane Doe",
        ]
        .map(String::from),
    );
    let script = r#"const R=require('./ui/tests/load.js').load('compose/Recipients.js');const names=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(names.map(n=>R.address({name:n,email:'dave@example.org'}))))"#;
    let mut child = std::process::Command::new("node")
        .args(["-e", script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(json!(names).to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let texts: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
    for (name, text) in names.iter().zip(&texts) {
        let list = mailparse::addrparse(text).unwrap();
        let one = list.extract_single_info().expect("one address");
        assert_eq!(one.addr, "dave@example.org", "{text}");
        assert_eq!(one.display_name.as_deref(), Some(name.as_str()), "{text}");
        let (raw, _) = composed_headers(&json!({"to":text}));
        let (headers, _) = mailparse::parse_headers(&raw).unwrap();
        assert_eq!(
            envelope::addresses(&headers, "To").unwrap(),
            ["dave@example.org"]
        );
    }
}

#[test]
fn address_lists_honour_escapes_inside_quoted_names() {
    let read = content::addresses("\"O\\\"Neil, Pat\" <pat@example.org>, ada@example.org");
    assert_eq!(read.len(), 2);
    assert_eq!(read[0]["name"], "O\"Neil, Pat");
    assert_eq!(read[1]["email"], "ada@example.org");
}
