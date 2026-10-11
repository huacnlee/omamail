//! Synthetic attachments only: the tests classify or store bytes, never render
//! them or invoke the desktop opener.
use omamail::attachment::openable;

const INVOICE: &[u8] = include_bytes!("fixtures/attachments/embedded-invoice.pdf");

fn replace(bytes: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    let at = bytes.windows(from.len()).position(|s| s == from).unwrap();
    [
        bytes[..at].to_vec(),
        to.to_vec(),
        bytes[at + from.len()..].to_vec(),
    ]
    .concat()
}

// Keep startxref correct while changing an object, so a test really exercises
// the stream recognizer rather than failing solely on a shifted xref offset.
fn replace_object(from: &[u8], to: &[u8]) -> Vec<u8> {
    let bytes = replace(INVOICE, from, to);
    let xref = bytes.windows(5).position(|s| s == b"xref\n").unwrap();
    replace(
        &bytes,
        b"startxref\n837\n",
        format!("startxref\n{xref}\n").as_bytes(),
    )
}

fn before_xref(extra: &[u8]) -> Vec<u8> {
    let mut insertion = extra.to_vec();
    insertion.extend_from_slice(b"xref\n");
    replace_object(b"xref\n", &insertion)
}

#[test]
fn embedded_invoice_xml_can_open_as_pdf() {
    assert!(openable("invoice.pdf", INVOICE));
    assert!(openable("INVOICE.PDF", INVOICE));
}

#[test]
fn embedded_xml_does_not_authorize_other_file_types() {
    for name in [
        "invoice.xml",
        "invoice.svg",
        "invoice.html",
        "invoice.txt",
        "invoice.png",
    ] {
        assert!(!openable(name, INVOICE), "{name}");
    }
    for name in [
        "invoice.pdf ",
        "invoice.pdf.",
        "invoice.ｐｄｆ",
        "invoice.pdf\u{200b}",
    ] {
        assert!(!openable(name, INVOICE), "{name}");
    }
}

#[test]
fn pdf_prefix_does_not_authorize_active_content() {
    for content in [
        b"<?xml version='1.0'?><invoice/>".as_slice(),
        b"<html><body>not a PDF</body></html>",
        b"<svg xmlns='http://www.w3.org/2000/svg'/>",
        b"<script>throw 'must not run'</script>",
        b"[Desktop Entry]\nExec=false",
    ] {
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend_from_slice(content);
        bytes.extend_from_slice(b"\n%%EOF\n");
        assert!(!openable("invoice.pdf", &bytes));
    }
}

#[test]
fn truncated_invoice_does_not_get_an_xml_exception() {
    let xml = INVOICE.windows(5).position(|s| s == b"<?xml").unwrap();
    for length in [xml + 20, INVOICE.len() - 6] {
        assert!(!openable("invoice.pdf", &INVOICE[..length]));
    }
}

#[test]
fn malformed_or_ambiguous_streams_do_not_get_an_xml_exception() {
    for (from, to) in [
        (b"/Length 266".as_slice(), b"/Length 265".as_slice()),
        (b"/Length 266", b"/Length 268"),
        (b"/Length 266", b"/Length -1"),
        (b"/Length 266", b"/Length 999999999999999999999999999999"),
        (b"/Length 266", b"/Length 9 0 R"),
        (b"/Length 266", b"/Length 266 /Length 266"),
        (b"/Length 266", b"/Length 266 /#4cength 266"),
        (b"/Length 266", b"/Length 266 /#46ilter /FlateDecode"),
        (b"/Length 266", b"/Length 266 /F (some-file)"),
        (b"/Length 266", b"/Size 266"),
        (b"/Type /EmbeddedFile", b"/Params << /Type /EmbeddedFile >>"),
        (b"/Subtype /text#2Fxml", b"/Subtype /image#2Fsvg+xml"),
        (b"stream\n<?xml", b"stream <?xml"),
        (b"endstream", b"endstreamX"),
        (b"/Names [ (factur", b"/Names [ << (factur"),
    ] {
        assert!(
            !openable("invoice.pdf", &replace_object(from, to)),
            "{to:?}"
        );
    }
}

#[test]
fn embedded_xml_keeps_other_active_markers_visible() {
    for marker in [
        b"<!doctype".as_slice(),
        b"<html",
        b"<head",
        b"<body",
        b"<script",
        b"<iframe",
        b"<meta",
        b"<svg",
        b"[desktop entry]",
        b"<?xml-stylesheet",
        b"<\0s\0c\0r\0i\0p\0t",
    ] {
        // Fixed-width replacement leaves both stream length and xref intact.
        let mut bytes = INVOICE.to_vec();
        let at = bytes
            .windows(b"ExchangedDocumentContext".len())
            .position(|s| s == b"ExchangedDocumentContext")
            .unwrap();
        bytes[at..at + marker.len()].copy_from_slice(marker);
        assert!(!openable("invoice.pdf", &bytes), "{marker:?}");
    }
}

#[test]
fn pdf_names_and_comments_are_lexed_without_guessing() {
    assert!(openable(
        "invoice.pdf",
        &replace_object(b"/Subtype /text#2Fxml", b"/Subtype /application#2fxml")
    ));
    assert!(openable(
        "invoice.pdf",
        &replace_object(b"version=\"1.0\"", b"version='1.0'")
    ));
    assert!(openable(
        "invoice.pdf",
        &replace_object(b"/Type /EmbeddedFile", b"/#54ype /Embedded#46ile")
    ));
    assert!(openable(
        "invoice.pdf",
        &replace_object(b"/Length 266", b"% length of the invoice\n/Length 266")
    ));
    assert!(openable(
        "invoice.pdf",
        &replace_object(
            b"/Type /EmbeddedFile\n/Subtype /text#2Fxml",
            b"/Type /Metadata\n/Subtype /XML"
        )
    ));
}

#[test]
fn exception_checks_active_content_beyond_the_sniffing_window() {
    let mut comment = vec![b' '; 70_000];
    comment.extend_from_slice(b"% <script>throw 'must not run'</script>\n");
    assert!(!openable("invoice.pdf", &before_xref(&comment)));
}

#[test]
fn fake_streams_in_strings_comments_or_stream_payloads_cannot_qualify() {
    let fake = b"9 0 obj\n<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length 31 >>\nstream\n<?xml version='1.0'?><invoice/>\nendstream\nendobj";
    let mut literal = b"(".to_vec();
    literal.extend_from_slice(fake);
    literal.extend_from_slice(b")");
    assert!(!openable(
        "invoice.pdf",
        &replace_object(b"(pypdf)", &literal)
    ));

    let mut comment = Vec::new();
    for line in fake.split(|b| *b == b'\n') {
        comment.push(b'%');
        comment.extend_from_slice(line);
        comment.push(b'\n');
    }
    assert!(!openable("invoice.pdf", &before_xref(&comment)));

    let mut stream = format!("9 0 obj\n<< /Length {} >>\nstream\n", fake.len()).into_bytes();
    stream.extend_from_slice(fake);
    stream.extend_from_slice(b"\nendstream\nendobj\n");
    assert!(!openable("invoice.pdf", &before_xref(&stream)));
}

#[test]
fn invoice_xml_does_not_hide_appended_active_content() {
    for content in [
        b"<html>not a PDF</html>".as_slice(),
        b"<svg/>",
        b"<script>throw 'must not run'</script>",
        b"<?xml-stylesheet href='https://invalid.example/style.xsl'?>",
    ] {
        let mut bytes = INVOICE.to_vec();
        bytes.extend_from_slice(content);
        assert!(!openable("invoice.pdf", &bytes));
        let mut bytes = INVOICE.to_vec();
        bytes.resize(70_000, b' ');
        bytes.extend_from_slice(content);
        assert!(!openable("invoice.pdf", &bytes));
    }
}

#[cfg(target_os = "linux")]
#[test]
fn attachment_store_refusal_writes_nothing_and_returns_no_launch_path() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use std::{
        fs,
        io::Write,
        process::{Command, Stdio},
    };
    let root = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("omamail-pdf-boundary-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    for bytes in [
        b"%PDF-1.7\n<?xml version='1.0'?><svg/>\n%%EOF\n".to_vec(),
        replace_object(b"/Length 266", b"/Length 9 0 R"),
        replace_object(b"/Length 266", b"/Length 266 /Filter /FlateDecode"),
        INVOICE[..INVOICE.len() - 6].to_vec(),
    ] {
        let mut child = Command::new(env!("CARGO_BIN_EXE_omamail"))
            .args(["call", "attachment.store", "--json"])
            .env("HOME", &root)
            .env("XDG_RUNTIME_DIR", &root)
            .env("XDG_CONFIG_HOME", &root)
            .env("XDG_CACHE_HOME", &root)
            .env("XDG_STATE_HOME", &root)
            .env("XDG_DOWNLOAD_DIR", &root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let params = serde_json::json!({"filename":"invoice.pdf","data":STANDARD.encode(&bytes),"open":true});
        child
            .stdin
            .take()
            .unwrap()
            .write_all(params.to_string().as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        let reply: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(reply["error"]["code"], "attachment_open_refused", "{reply}");
        assert!(reply.get("path").is_none());
        assert!(reply.get("result").is_none());
        assert!(
            fs::read_dir(&root).unwrap().next().is_none(),
            "refusal wrote files"
        );
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn xml_exception_refuses_pdf_actions_and_opaque_object_streams() {
    for addition in [
        b"/OpenAction << /S /JavaScript /JS (app.alert\\(1\\)) >>".as_slice(),
        b"/#4fpenAction 9 0 R",
        b"/AA << /O 9 0 R >>",
        b"/Names << /JavaScript 9 0 R >>",
        b"/S /Launch /F (program)",
        b"/XFA 9 0 R",
        b"/Type /RichMedia",
        b"/#45ncrypt 9 0 R",
    ] {
        let mut replacement = b"/Producer (pypdf) ".to_vec();
        replacement.extend_from_slice(addition);
        assert!(
            !openable(
                "invoice.pdf",
                &replace_object(b"/Producer (pypdf)", &replacement)
            ),
            "{addition:?}"
        );
    }
    assert!(!openable(
        "invoice.pdf",
        &before_xref(b"9 0 obj\n<< /Type /ObjStm /Length 1 >>\nstream\nx\nendstream\nendobj\n")
    ));
}

#[test]
fn malformed_xml_declarations_are_not_exempted() {
    for encoding in [
        "encoding=UTF-8",
        "encoding=\"UTF-8",
        "xxxxxxxxxx",
        "version=\"1.0\"",
        "foo=\"bar\"",
        "encoding=\"?\"",
        "standalone=\"maybe\"",
    ] {
        let bytes = replace_object(b"encoding=\"UTF-8\"", encoding.as_bytes());
        let length = 266 + encoding.len() - b"encoding=\"UTF-8\"".len();
        let bytes = replace(
            &bytes,
            b"/Length 266",
            format!("/Length {length}").as_bytes(),
        );
        assert!(!openable("invoice.pdf", &bytes), "{encoding}");
    }
}

#[test]
fn cross_reference_into_another_stream_cannot_hide_native_actions() {
    let bytes = include_bytes!("fixtures/attachments/hidden-action.pdf");
    assert!(!openable("invoice.pdf", bytes));
    let escaped = replace(bytes, b"/OpenAction", b"/#4fpenAction");
    assert!(!openable("invoice.pdf", &escaped));
}

#[test]
fn xref_stream_cannot_enable_opaque_actions_even_without_object_stream_type() {
    assert!(!openable(
        "invoice.pdf",
        include_bytes!("fixtures/attachments/opaque-action.pdf")
    ));
    for field in [b"/XRefStm 12".as_slice(), b"/#50rev 12"] {
        let mut trailer = b"/Size 9 ".to_vec();
        trailer.extend_from_slice(field);
        assert!(!openable(
            "invoice.pdf",
            &replace(INVOICE, b"/Size 9", &trailer)
        ));
    }
}

#[test]
fn xml_stream_accepts_crlf_framing_and_a_utf8_bom() {
    assert!(openable(
        "invoice.pdf",
        include_bytes!("fixtures/attachments/embedded-invoice-crlf.pdf")
    ));
}
