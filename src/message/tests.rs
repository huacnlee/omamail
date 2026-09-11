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
