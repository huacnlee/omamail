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
                {"name":"Content-Disposition", "value":"inline"},
                {"name":"Content-ID", "value":"<logo@example.invalid>"}
            ])),
            part("image/gif", "pixel.gif", serde_json::json!([
                {"name":"Content-ID", "value":"<pixel@example.invalid>"}
            ])),
            part("image/png", "attachment-logo.png", serde_json::json!([
                {"name":"Content-Disposition", "value":"inline; filename=attachment-logo.png"},
                {"name":"Content-ID", "value":"<attachment-logo@example.invalid>"}
            ])),
            part("image/jpeg", "photo.jpg", serde_json::json!([
                {"name":"Content-Disposition", "value":"attachment; filename=photo.jpg"},
                {"name":"Content-ID", "value":"<photo@example.invalid>"}
            ])),
            part("application/pdf", "document.pdf", serde_json::json!([
                {"name":"Content-Disposition", "value":"inline"}
            ])),
            serde_json::json!({"mimeType":"text/html", "headers":[], "body":{"data":
                URL_SAFE_NO_PAD.encode(r#"<img src="cid:LOGO@example.invalid"><img src="cid:pixel@example.invalid"><img src='cid:attachment-logo@example.invalid'>"#)}})
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

/// The attachment rows a raw message shows, as `(filename, mimeType)`, after the
/// same parse and prepare the reader runs; each row must be fetchable.
fn listed(raw: &str) -> Vec<(String, String)> {
    let payload = super::parse(raw.replace('\n', "\r\n").as_bytes()).unwrap();
    let message = serde_json::json!({"id":"x", "payload": payload});
    let prepared = super::content::prepare(&message, 0).unwrap();
    prepared["attachments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            let id = file["attachmentId"].as_str().unwrap();
            assert!(
                super::content::attachment_bytes(&message, id).is_some(),
                "{id} cannot be fetched"
            );
            (
                file["filename"].as_str().unwrap().to_owned(),
                file["mimeType"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

// iPhone and Apple Mail send photos as inline parts under a plain-text body:
// nothing draws them, so they are the attachments.
#[test]
fn inline_photos_under_a_plain_body_are_listed() {
    let raw = "Subject: photo
Content-Type: multipart/mixed; boundary=b

--b
Content-Type: text/plain

Here it is
--b
Content-Type: image/jpeg; name=IMG_0001.jpeg
Content-Disposition: inline; filename=IMG_0001.jpeg
Content-Transfer-Encoding: base64

/9j/4AAQ
--b--
";
    assert_eq!(
        listed(raw),
        [("IMG_0001.jpeg".to_owned(), "image/jpeg".to_owned())]
    );
}

// Outlook gives attached pictures a Content-ID the HTML never names; a picture
// the HTML does draw (compared case-blind) stays out of the list.
#[test]
fn images_the_html_does_not_reference_are_listed() {
    let raw = "Subject: scan
Content-Type: multipart/related; boundary=b

--b
Content-Type: text/html

<p>See attached</p><img src=\"cid:LOGO@x\">
--b
Content-Type: image/png; name=\"logo.png\"
Content-ID: <logo@x>
Content-Transfer-Encoding: base64

iVBORw0K
--b
Content-Type: image/png; name=\"scan.png\"
Content-ID: <abc@x>
Content-Transfer-Encoding: base64

iVBORw0K
--b--
";
    assert_eq!(
        listed(raw),
        [("scan.png".to_owned(), "image/png".to_owned())]
    );
}

#[test]
fn forwarded_messages_are_listed_as_eml_files() {
    let raw = "Subject: Fwd: hello
Content-Type: multipart/mixed; boundary=b

--b
Content-Type: text/plain

Forwarding this
--b
Content-Type: message/rfc822

From: someone@example.invalid
Subject: hello

original body
--b--
";
    assert_eq!(
        listed(raw),
        [(
            "forwarded message.eml".to_owned(),
            "message/rfc822".to_owned()
        )]
    );
}

// Scanners and copiers send files with no name at all.
#[test]
fn unnamed_files_are_listed_under_a_name_from_their_type() {
    let raw = "Subject: scan
Content-Type: multipart/mixed; boundary=b

--b
Content-Type: text/plain

Scanned document
--b
Content-Type: application/pdf
Content-Transfer-Encoding: base64

JVBERi0x
--b
Content-Type: application/x-unknown
Content-Transfer-Encoding: base64

AAEC
--b--
";
    assert_eq!(
        listed(raw),
        [
            ("attachment.pdf".to_owned(), "application/pdf".to_owned()),
            ("attachment".to_owned(), "application/x-unknown".to_owned()),
        ]
    );
}

// Bodies never become attachments, and a lone body is not a file either.
#[test]
fn text_bodies_are_not_listed() {
    let raw = "Subject: hi
Content-Type: multipart/alternative; boundary=b

--b
Content-Type: text/plain

hi
--b
Content-Type: text/html

<p>hi</p>
--b--
";
    assert!(listed(raw).is_empty());
    assert!(listed("Subject: hi\n\nhello\n").is_empty());
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
        "<head><style>p { color: red; }</style></head><body><p>Send money easily</p></body>",
        "<body><p>Send money easily</p></body>",
        "<style>p { color: red; }</style><div><p>Send money easily</p></div>",
    ] {
        let body = &super::content::prepare(&message(markup, Some(html)), 0).unwrap()["body"];
        assert_eq!(body["source"], "html", "{markup}");
        assert_eq!(body["text"], "Send money easily", "{markup}");
    }
    for text in [
        "<paul@example.com> wrote:\n> see </p> in the docs",
        "<div> is a block element, <span> is not.\nRegards",
        "Send money easily",
        "<div> is a block element; close it with </div>",
        "<p>See the docs for </p>",
        "<html> is the root element; close it with </html>",
        "<head> contains metadata; close it with </head>",
        "<body> contains visible content; close it with </body>",
        "<style> declares CSS </style><body> contains content </body>",
        "<!-- example --> <div> is closed with </div>",
        "<div><span>code</span></div> is an example ending with </p>",
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
