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
