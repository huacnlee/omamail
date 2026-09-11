use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use omamail::backend::Session;
use serde_json::json;

#[test]
fn upload_preserves_large_message_and_is_consumed_only_when_complete() {
    let session = Session::default();
    let raw = format!("Subject: large\r\n\r\n{}", "x".repeat(2 * 1024 * 1024));
    let reference = session
        .dispatch("upload.begin", &json!({"size":raw.len()}))
        .unwrap();
    let id = reference["upload"].as_str().unwrap();
    assert_eq!(
        session.dispatch("message.parseUpload", &json!({"upload":id})),
        Err("upload_incomplete")
    );
    for (index, chunk) in raw.as_bytes().chunks(256 * 1024).enumerate() {
        let offset = index * 256 * 1024;
        let result = session
            .dispatch(
                "upload.append",
                &json!({"upload":id,"offset":offset,"data":URL_SAFE_NO_PAD.encode(chunk)}),
            )
            .unwrap();
        assert_eq!(result["offset"], offset + chunk.len());
    }
    let parsed = session
        .dispatch("message.parseUpload", &json!({"upload":id}))
        .unwrap();
    assert_eq!(parsed["body"]["size"], 2 * 1024 * 1024);
    assert_eq!(
        session.dispatch("message.parseUpload", &json!({"upload":id})),
        Err("upload_not_found")
    );
}

#[test]
fn invalid_chunks_never_mutate_upload_and_sessions_are_isolated() {
    let session = Session::default();
    let other = Session::default();
    let reference = session
        .dispatch("upload.begin", &json!({"size":1}))
        .unwrap();
    let id = reference["upload"].as_str().unwrap();
    for (offset, data, error) in [
        (1, "YQ", "upload_offset_mismatch"),
        (0, "%%%", "invalid_upload_encoding"),
        (0, "YWI", "upload_size_exceeded"),
    ] {
        assert_eq!(
            session.dispatch(
                "upload.append",
                &json!({"upload":id,"offset":offset,"data":data})
            ),
            Err(error)
        );
    }
    assert_eq!(
        other.dispatch("upload.discard", &json!({"upload":id})),
        Err("upload_not_found")
    );
    assert_eq!(
        session
            .dispatch(
                "upload.append",
                &json!({"upload":id,"offset":0,"data":"YQ"})
            )
            .unwrap()["offset"],
        1
    );
    session
        .dispatch("upload.discard", &json!({"upload":id}))
        .unwrap();
    assert_eq!(
        session.dispatch("upload.discard", &json!({"upload":id})),
        Err("upload_not_found")
    );
}

#[test]
fn declared_sizes_reserve_capacity_before_receiving_bytes() {
    let session = Session::default();
    let size = omamail::message::MAX_MESSAGE;
    let first = session
        .dispatch("upload.begin", &json!({"size":size}))
        .unwrap();
    session
        .dispatch("upload.begin", &json!({"size":size}))
        .unwrap();
    assert_eq!(
        session.dispatch("upload.begin", &json!({"size":1})),
        Err("upload_capacity_exceeded")
    );
    session
        .dispatch("upload.discard", &json!({"upload":first["upload"]}))
        .unwrap();
    session
        .dispatch("upload.begin", &json!({"size":size}))
        .unwrap();
}
