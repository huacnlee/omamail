use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use omamail::backend::Session;
use serde_json::json;

#[tokio::test]
async fn upload_preserves_large_message_and_is_consumed_only_when_complete() {
    let session = Session::default();
    let raw = format!("Subject: large\r\n\r\n{}", "x".repeat(2 * 1024 * 1024));
    let reference = session
        .dispatch("upload.begin", &json!({"size":raw.len()}))
        .await
        .unwrap();
    let id = reference["upload"].as_str().unwrap();
    assert_eq!(
        session
            .dispatch("message.parseUpload", &json!({"upload":id}))
            .await,
        Err("upload_incomplete")
    );
    for (index, chunk) in raw.as_bytes().chunks(256 * 1024).enumerate() {
        let offset = index * 256 * 1024;
        let result = session
            .dispatch(
                "upload.append",
                &json!({"upload":id,"offset":offset,"data":URL_SAFE_NO_PAD.encode(chunk)}),
            )
            .await
            .unwrap();
        assert_eq!(result["offset"], offset + chunk.len());
    }
    let parsed = session
        .dispatch("message.parseUpload", &json!({"upload":id}))
        .await
        .unwrap();
    assert_eq!(parsed["body"]["size"], 2 * 1024 * 1024);
    assert_eq!(
        session
            .dispatch("message.parseUpload", &json!({"upload":id}))
            .await,
        Err("upload_not_found")
    );
}

#[tokio::test]
async fn invalid_chunks_never_mutate_upload_and_sessions_are_isolated() {
    let session = Session::default();
    let other = Session::default();
    let reference = session
        .dispatch("upload.begin", &json!({"size":1}))
        .await
        .unwrap();
    let id = reference["upload"].as_str().unwrap();
    for (offset, data, error) in [
        (1, "YQ", "upload_offset_mismatch"),
        (0, "%%%", "invalid_upload_encoding"),
        (0, "YWI", "upload_size_exceeded"),
    ] {
        assert_eq!(
            session
                .dispatch(
                    "upload.append",
                    &json!({"upload":id,"offset":offset,"data":data})
                )
                .await,
            Err(error)
        );
    }
    assert_eq!(
        other
            .dispatch("upload.discard", &json!({"upload":id}))
            .await,
        Err("upload_not_found")
    );
    assert_eq!(
        session
            .dispatch(
                "upload.append",
                &json!({"upload":id,"offset":0,"data":"YQ"})
            )
            .await
            .unwrap()["offset"],
        1
    );
    session
        .dispatch("upload.discard", &json!({"upload":id}))
        .await
        .unwrap();
    assert_eq!(
        session
            .dispatch("upload.discard", &json!({"upload":id}))
            .await,
        Err("upload_not_found")
    );
}

#[tokio::test]
async fn declared_sizes_reserve_capacity_before_receiving_bytes() {
    let session = Session::default();
    let size = omamail::backend::upload::MAX_UPLOAD;
    let first = session
        .dispatch("upload.begin", &json!({"size":size}))
        .await
        .unwrap();
    session
        .dispatch("upload.begin", &json!({"size":size}))
        .await
        .unwrap();
    assert_eq!(
        session.dispatch("upload.begin", &json!({"size":1})).await,
        Err("upload_capacity_exceeded")
    );
    session
        .dispatch("upload.discard", &json!({"upload":first["upload"]}))
        .await
        .unwrap();
    session
        .dispatch("upload.begin", &json!({"size":size}))
        .await
        .unwrap();
}

#[tokio::test]
async fn uploaded_requests_cannot_bypass_shutdown_or_nest_uploads() {
    let session = Session::default();
    let upload = session
        .dispatch("upload.begin", &json!({"size":2}))
        .await
        .unwrap()["upload"]
        .clone();
    session
        .dispatch(
            "upload.append",
            &json!({"upload":upload,"offset":0,"data":"e30"}),
        )
        .await
        .unwrap();
    for method in ["system.quit", "request.upload", "upload.begin"] {
        assert_eq!(
            session
                .dispatch("request.upload", &json!({"method":method,"upload":upload}))
                .await,
            Err("invalid_params")
        );
    }
    let answer = session
        .dispatch(
            "request.upload",
            &json!({"method":"system.info","upload":upload}),
        )
        .await
        .unwrap();
    assert_eq!(answer["name"], "omamail");
    assert_eq!(
        session
            .dispatch("upload.discard", &json!({"upload":upload}))
            .await,
        Err("upload_not_found")
    );
}
