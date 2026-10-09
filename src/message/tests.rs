use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

#[test]
fn encoded_headers_stay_encoded_until_the_shared_reader_decodes_them() {
    let raw = b"Subject: =?utf-8?B?5L2g5aW9?=\r\n\tworld\r\n\r\nbody";
    let payload = super::parse(raw).unwrap();
    assert_eq!(payload["headers"][0]["value"], "=?utf-8?B?5L2g5aW9?= world");
}

#[test]
fn malformed_multipart_remains_readable() {
    for (body, mime) in [
        ("the body anyway", "text/plain"),
        ("<html><body>hello</body></html>", "text/html"),
    ] {
        let raw = format!("Content-Type: multipart/alternative; boundary=NOPE\r\n\r\n{body}");
        let payload = super::parse(raw.as_bytes()).unwrap();
        assert_eq!(payload["mimeType"], mime);
        assert_eq!(payload["body"]["data"], URL_SAFE_NO_PAD.encode(body));
    }
}

#[test]
fn mime_normalizes_binary_attachments_without_text_conversion() {
    let raw=b"Subject: hello\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=E9\r\n--x\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=blob.bin\r\nContent-Transfer-Encoding: base64\r\n\r\nAP+A\r\n--x--\r\n";
    let parsed = super::parse(raw).unwrap();
    assert_eq!(
        parsed["parts"][0]["body"]["data"],
        URL_SAFE_NO_PAD.encode(b"caf\xe9")
    );
    assert_eq!(
        parsed["parts"][1]["body"]["data"],
        URL_SAFE_NO_PAD.encode([0, 255, 128])
    );
    assert_eq!(parsed["parts"][1]["body"]["attachmentId"], "part:2");
    assert_eq!(parsed["parts"][1]["filename"], "blob.bin");
}

#[test]
fn input_limits_are_enforced() {
    assert_eq!(
        super::parse(&vec![0; super::MAX_MESSAGE + 1]),
        Err("message_too_large")
    );
}

#[test]
fn inline_images_are_embedded_instead_of_listed_as_attachments() {
    fn part(mime: &str, filename: &str, headers: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "mimeType": mime,
            "filename": filename,
            "headers": headers,
            "body": {"attachmentId": format!("part:{filename}"), "size": 64, "data": ""}
        })
    }
    let message = serde_json::json!({"payload": {
        "mimeType": "multipart/related",
        "headers": [],
        "parts": [
            part("image/png", "logo.png", serde_json::json!([
                {"name":"Content-Disposition", "value":"inline"}
            ])),
            part("image/gif", "pixel.gif", serde_json::json!([
                {"name":"Content-ID", "value":"<pixel@example.invalid>"}
            ])),
            part("image/png", "attachment-logo.png", serde_json::json!([
                {"name":"Content-Disposition", "value":"inline; filename=attachment-logo.png"}
            ])),
            part("image/jpeg", "photo.jpg", serde_json::json!([
                {"name":"Content-Disposition", "value":"attachment; filename=photo.jpg"},
                {"name":"Content-ID", "value":"<photo@example.invalid>"}
            ])),
            part("application/pdf", "document.pdf", serde_json::json!([
                {"name":"Content-Disposition", "value":"inline"}
            ]))
        ]
    }});

    let prepared = super::content::prepare(&message, 0).unwrap();
    let listed: Vec<_> = prepared["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|attachment| attachment["filename"].as_str().unwrap())
        .collect();
    assert_eq!(listed, ["photo.jpg", "document.pdf"]);
}

// Some senders put the markup itself in the text/plain alternative. Shown as
// text that is a page of tags, so the HTML part is read instead; text that
// merely opens with an angle bracket stays the sender's text.
#[test]
fn markup_in_the_plain_alternative_is_read_from_the_html_part() {
    fn message(plain: &str, html: Option<&str>) -> serde_json::Value {
        let mut parts = vec![serde_json::json!({"mimeType":"text/plain",
            "body":{"data":URL_SAFE_NO_PAD.encode(plain)}})];
        if let Some(html) = html {
            parts.push(serde_json::json!({"mimeType":"text/html",
                "body":{"data":URL_SAFE_NO_PAD.encode(html)}}));
        }
        serde_json::json!({"payload":{"mimeType":"multipart/alternative","parts":parts}})
    }
    let html = "<!doctype html><html><body><p>Send money easily</p></body></html>";
    for markup in [
        "\n\n<!--[if gte mso 9]><style>.a { display: block; }</style><![endif]-->\n<div><p>Send money easily</p></div>\n",
        "<html><body><p>Send money easily</p></body></html>",
        "<DIV class=\"x\"><P>Send money easily</P></DIV>",
    ] {
        let body = &super::content::prepare(&message(markup, Some(html)), 0).unwrap()["body"];
        assert_eq!(body["source"], "html", "{markup}");
        assert_eq!(body["text"], "Send money easily", "{markup}");
    }
    for text in [
        "<paul@example.com> wrote:\n> see </p> in the docs",
        "<div> is a block element, <span> is not.\nRegards",
        "Send money easily",
    ] {
        let body = &super::content::prepare(&message(text, Some(html)), 0).unwrap()["body"];
        assert_eq!(body["source"], "plain", "{text}");
        assert_eq!(body["text"], text, "{text}");
    }
    // With no HTML part there is nothing better to read.
    let only = "<div><p>Send money easily</p></div>";
    let body = &super::content::prepare(&message(only, None), 0).unwrap()["body"];
    assert_eq!(body["source"], "plain");
    assert_eq!(body["text"], only);
}
