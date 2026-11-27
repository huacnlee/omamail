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

// Outgoing mail in Chinese, built and read back: an encoded subject and display
// names (RFC 2047), UTF-8 text and HTML parts, and a Chinese attachment name.
// The attachment name goes out as an RFC 2047 word in the parameter, as the
// Qt backend's builder writes it, and is checked here as readers decode it.
#[test]
fn chinese_outgoing_mail_reads_back_as_written() {
    use base64::engine::general_purpose::STANDARD;
    let body = "你好，世界\n第二行：Hello 世界 😀";
    let fields = serde_json::json!({
        "from": "jane@example.com",
        "fromName": "简 · 张三",
        "to": "王小明 <wang@example.cn>, \"李雷，测试\" <lilei@example.cn>",
        "subject": "季度回顾：预算与人员安排 😀",
        "body": body,
        "signatureHtml": "<b>签名</b>",
        "boundary": "b",
        "date": "Sat, 12 Sep 2026 10:00:00 +0000",
        "messageId": "<cjk@example.com>",
        "attachments": [{
            "filename": "季度报告（终稿）.pdf",
            "mimeType": "application/pdf",
            "data": STANDARD.encode(b"%PDF synthetic"),
        }],
    });
    let built = super::compose::build(&fields).unwrap();
    let raw = URL_SAFE_NO_PAD
        .decode(built["raw"].as_str().unwrap())
        .unwrap();
    // Headers are 7-bit on the wire.
    let head = &raw[..raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap()];
    assert!(head.is_ascii(), "{}", String::from_utf8_lossy(head));

    let mail = mailparse::parse_mail(&raw).unwrap();
    let get = |name: &str| mail.headers.iter().find(|h| h.get_key() == name).unwrap();
    assert_eq!(get("Subject").get_value(), "季度回顾：预算与人员安排 😀");
    let people = |name: &str| -> Vec<(String, String)> {
        mailparse::addrparse_header(get(name))
            .unwrap()
            .iter()
            .map(|a| match a {
                mailparse::MailAddr::Single(s) => {
                    (s.display_name.clone().unwrap_or_default(), s.addr.clone())
                }
                mailparse::MailAddr::Group(_) => panic!("group in {name}"),
            })
            .collect()
    };
    assert_eq!(
        people("From"),
        [("简 · 张三".to_owned(), "jane@example.com".to_owned())]
    );
    assert_eq!(
        people("To"),
        [
            ("王小明".to_owned(), "wang@example.cn".to_owned()),
            ("李雷，测试".to_owned(), "lilei@example.cn".to_owned()),
        ]
    );

    // multipart/mixed: [alternative(text, html), attachment]
    assert_eq!(mail.subparts.len(), 2);
    let alt = &mail.subparts[0];
    assert_eq!(alt.subparts.len(), 2);
    assert_eq!(alt.subparts[0].ctype.mimetype, "text/plain");
    assert_eq!(alt.subparts[0].ctype.charset.to_ascii_lowercase(), "utf-8");
    assert_eq!(alt.subparts[0].get_body().unwrap(), body);
    assert_eq!(alt.subparts[1].ctype.mimetype, "text/html");
    let html = alt.subparts[1].get_body().unwrap();
    assert!(html.contains("你好，世界"), "{html}");
    assert!(html.contains("Hello 世界 😀"), "{html}");
    assert!(html.contains("<b>签名</b>"), "{html}");

    let file = &mail.subparts[1];
    assert_eq!(file.get_body_raw().unwrap(), b"%PDF synthetic");
    // The app's reader (parse, then prepare) names it as written.
    let message = serde_json::json!({"id": "m", "payload": super::parse(&raw).unwrap()});
    let shown = super::content::prepare(&message, 0).unwrap();
    assert_eq!(shown["attachments"][0]["filename"], "季度报告（终稿）.pdf");
    assert_eq!(shown["body"]["text"], body);
}

// A Chinese attachment name sent the RFC 2231 way (`filename*=`) by another
// client reads back too.
#[test]
fn rfc2231_chinese_attachment_name_is_read() {
    let raw = "Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhi\r\n--x\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nAA==\r\n--x--\r\n";
    let message = serde_json::json!({"id": "m", "payload": super::parse(raw.as_bytes()).unwrap()});
    let shown = super::content::prepare(&message, 0).unwrap();
    assert_eq!(shown["attachments"][0]["filename"], "季度报告.pdf");
}
