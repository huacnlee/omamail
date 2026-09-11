use super::*;
#[test]
fn smoke() {
    let out = sanitize("<p>Hello <b>world</b></p>", &json!({"withReader":true})).unwrap();
    assert_eq!(out["html"], "<p>Hello <b>world</b></p>");
    assert_eq!(out["reader"]["html"], "<p>Hello <strong>world</strong></p>");
}

#[test]
fn actual_javascript_sanitizer_and_reader_corpus_matches() {
    let output = std::process::Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/message/html/golden.js"
        ))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    assert!(cases.len() > 200);
    let mut differences = vec![];
    for (index, case) in cases.into_iter().enumerate() {
        let actual = sanitize(case["source"].as_str().unwrap_or(""), &case["options"]).unwrap();
        for key in [
            "html",
            "blockedImages",
            "images",
            "remoteImages",
            "remoteImageSources",
            "complexity",
            "tooHeavy",
            "plainText",
        ] {
            if actual[key] != case["expected"][key] {
                differences.push(format!(
                    "case {index} {key}: actual={} expected={} source={}",
                    actual[key]
                        .to_string()
                        .chars()
                        .take(500)
                        .collect::<String>(),
                    case["expected"][key]
                        .to_string()
                        .chars()
                        .take(500)
                        .collect::<String>(),
                    case["source"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(200)
                        .collect::<String>()
                ));
            }
        }
        if case["expected"]["reader"].is_object() {
            for key in [
                "html",
                "images",
                "blockedImages",
                "complexity",
                "tooHeavy",
                "empty",
            ] {
                if actual["reader"][key] != case["expected"]["reader"][key] {
                    differences.push(format!(
                        "case {index} reader {key}: actual={} expected={} source={}",
                        actual["reader"][key]
                            .to_string()
                            .chars()
                            .take(500)
                            .collect::<String>(),
                        case["expected"]["reader"][key]
                            .to_string()
                            .chars()
                            .take(500)
                            .collect::<String>(),
                        case["source"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(200)
                            .collect::<String>()
                    ));
                }
            }
        }
    }
    assert!(differences.is_empty(), "{}", differences.join("\n"));
}

#[test]
fn malicious_resources_remain_inert_with_images_and_sender_colors_enabled() {
    let source = r#"<body background='https://tracker.example/a'><div style='background-image:&#117;rl(https://tracker.example/b);color:red'><img src='https://tracker.example/c'><input src='file:///tmp/secret'><span style='background:u\72l(https://tracker.example/d)'>safe</span></div></body>"#;
    for allow in [false, true] {
        let result = sanitize(
            source,
            &json!({"allowRemoteImages":allow,"keepColors":true,"withReader":true}),
        )
        .unwrap();
        for html in [
            result["html"].as_str().unwrap(),
            result["reader"]["html"].as_str().unwrap(),
        ] {
            assert!(!html.contains("tracker.example"), "{html}");
            assert!(!html.contains("file:"), "{html}");
            assert!(!html.contains("background="), "{html}");
        }
    }
    let result=sanitize("<img src='https://cdn.example.com/image'>",&json!({"allowRemoteImages":true,"remoteImageData":{"https://cdn.example.com/image":"data:image/png;base64,PHN2Zy8+"}})).unwrap();
    assert!(!result["html"].as_str().unwrap().contains("<img"));
}

#[test]
fn input_tree_and_expansion_have_explicit_bounds() {
    assert_eq!(
        parse(&"x".repeat(tree::MAX_INPUT + 1)).err(),
        Some("html_too_large")
    );
    assert_eq!(
        parse(&"<br>".repeat(tree::MAX_NODES + 1)).err(),
        Some("html_too_complex")
    );
    let deep = format!("{}kept{}", "<div>".repeat(5000), "</div>".repeat(5000));
    let result = sanitize(&deep, &json!({"withReader":true})).unwrap();
    assert!(result["html"].as_str().unwrap().contains("kept"));
    let links = format!(
        "{}{}{}",
        "<a href='https://example.org'>".repeat(100),
        "<p>line</p>".repeat(1000),
        "</a>".repeat(100)
    );
    let result = sanitize(&links, &json!({"withReader":true})).unwrap();
    assert!(result["reader"]["complexity"]["tags"].as_u64().unwrap() < 10000);
}

#[test]
#[ignore = "Run via make test-qml with Qt installed"]
fn native_output_cannot_trigger_qt_resource_requests() {
    use std::{
        io::{Read, Write},
        sync::{
            Arc,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
        time::Duration,
    };
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/image.png", listener.local_addr().unwrap());
    let count = Arc::new(AtomicUsize::new(0));
    let stopped = Arc::new(AtomicBool::new(false));
    let seen = count.clone();
    let stop = stopped.clone();
    let server = std::thread::spawn(move || {
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .unwrap();
                    let mut request = [0; 8192];
                    let _ = stream.read(&mut request);
                    seen.fetch_add(1, Ordering::SeqCst);
                    let _=stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n\x89PNG\r\n\x1a\n");
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2))
                }
                Err(_) => break,
            }
        }
    });
    let directory = std::env::temp_dir().join(format!(
        "omamail-native-html-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&directory).unwrap();
    let run = |documents: Vec<String>| {
        let qml = format!(
            "import QtQuick\nimport QtTest\nItem {{ width:400; height:200; property var documents: {}\nTextEdit {{ id: reader; width:400; height:200; textFormat: TextEdit.RichText }}\nTestCase {{ name: \"NativeHtmlResources\"; when: windowShown; function test_documents() {{ for (var i=0;i<documents.length;i++) {{ reader.text=documents[i]; wait(100); }} }} }}\n}}",
            serde_json::to_string(&documents).unwrap()
        );
        let path = directory.join("tst_native.qml");
        std::fs::write(&path, qml).unwrap();
        let output = std::process::Command::new(qml_runner())
            .arg("-input")
            .arg(path)
            .env("QT_QPA_PLATFORM", "offscreen")
            .env("QT_QUICK_BACKEND", "software")
            .env("QT_QPA_PLATFORMTHEME", "")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run(vec![format!("<img src='{url}'>")]);
    let positive = count.load(Ordering::SeqCst);
    assert!(
        positive > 0,
        "the Qt control must exercise actual network loading"
    );
    let attacks = [
        format!("<img src='{url}'>"),
        format!("<table background='{url}'><tr><td>body</td></tr></table>"),
        format!("<p style='background-image:&#117;rl({url})'>body</p>"),
        format!("<span><</span>img src='{url}'><p>body</p>"),
        format!("<span><\u{200b}img src='{url}'></span>"),
    ];
    let mut documents = vec![];
    for attack in attacks {
        let result = sanitize(
            &attack,
            &json!({"withReader":true,"keepColors":true,"allowRemoteImages":true}),
        )
        .unwrap();
        documents.push(result["html"].as_str().unwrap().into());
        documents.push(result["reader"]["html"].as_str().unwrap().into());
    }
    run(documents);
    let actual = count.load(Ordering::SeqCst);
    stopped.store(true, Ordering::SeqCst);
    server.join().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
    assert_eq!(
        actual, positive,
        "native sanitized output must send no resource requests"
    );
}

fn qml_runner() -> std::path::PathBuf {
    if let Some(path) = std::env::var_os("QMLTESTRUNNER") {
        return path.into();
    }
    for candidate in ["qmltestrunner6", "qmltestrunner"] {
        if let Some(paths) = std::env::var_os("PATH") {
            for directory in std::env::split_paths(&paths) {
                let path = directory.join(candidate);
                if path.is_file() {
                    return path;
                }
            }
        }
    }
    for candidate in [
        "/usr/lib/qt6/bin/qmltestrunner",
        "/usr/lib/x86_64-linux-gnu/qt6/bin/qmltestrunner",
    ] {
        let path = std::path::PathBuf::from(candidate);
        if path.is_file() {
            return path;
        }
    }
    panic!("Qt resource verification requires qmltestrunner; set QMLTESTRUNNER to its path");
}

#[test]
fn attribute_names_and_nonanchor_urls_cannot_create_resource_markup() {
    let html=sanitize("<svg><image xlink:href='https://tracker.example/a'></image></svg><div a\"src='https://tracker.example/b' href='https://tracker.example/c'>visible</div>",&json!({"keepColors":true})).unwrap();
    let output = html["html"].as_str().unwrap();
    assert!(!output.contains("tracker.example"));
    assert!(output.contains("visible"));
    let input = format!("<div {}>body</div>", "a='x' ".repeat(1025));
    assert_eq!(parse(&input).err(), Some("html_too_complex"));
    for limit in [json!(-1), json!(0), Value::Null] {
        let result = sanitize(
            "<img src='https://cdn.example.com/a'>",
            &json!({"maxImages":limit}),
        )
        .unwrap();
        assert_eq!(result["remoteImages"], 0);
        assert_eq!(result["remoteImageSources"], json!([]));
    }
}
