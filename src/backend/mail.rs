use super::Session;
use crate::mail::{ListRequest, Provider};
use serde_json::{Value, json};
use std::{future::Future, pin::Pin};

struct ProviderList<'a> {
    session: &'a Session,
}

fn summaries(messages: &[Value]) -> Result<Vec<Value>, &'static str> {
    let now = chrono::Utc::now().timestamp_millis();
    messages
        .iter()
        .map(|message| crate::message::content::summarize(message, now))
        .collect()
}

async fn imap_call(method: &str, params: &Value) -> Result<Value, &'static str> {
    let method = method.to_owned();
    let params = params.clone();
    tokio::spawn(async move { crate::providers::imap::call(&method, &params).await })
        .await
        .map_err(|_| "worker_failed")?
}

impl Session {
    pub(super) async fn mail_call(
        &self,
        method: &str,
        params: &Value,
    ) -> Result<Value, &'static str> {
        if method != "mail.list" {
            return Err("unknown_method");
        }
        let request = ListRequest::try_from(params)?;
        crate::mail::list::list_with(request, &ProviderList { session: self }).await
    }

    async fn provider_list(
        &self,
        request: &ListRequest,
        query: String,
    ) -> Result<Value, &'static str> {
        let params = json!({
            "accountId":request.account.id,
            "query":query,
            "pageSize":request.limit,
            "pageToken":request.page_token,
        });
        match request.account.provider {
            Provider::Gmail => Box::pin(self.gmail_list(&params)).await,
            Provider::Hey => Box::pin(self.hey_list(&params)).await,
            Provider::Jmap => Box::pin(self.jmap_list(&params)).await,
            Provider::Outlook | Provider::Imap => {
                Box::pin(self.imap_list(&params, request.limit)).await
            }
        }
    }

    async fn gmail_list(&self, params: &Value) -> Result<Value, &'static str> {
        let page = self.gmail.call("gmail.list", params).await?;
        let ids = page["ids"]
            .as_array()
            .ok_or("gmail_invalid_response")?
            .iter()
            .map(|id| {
                id.as_str()
                    .map(str::to_owned)
                    .ok_or("gmail_invalid_response")
            })
            .collect::<Result<Vec<_>, _>>()?;
        let messages = futures_util::future::try_join_all(ids.iter().map(|id| {
            let id = id.clone();
            async move {
                self.gmail
                    .call(
                        "gmail.read",
                        &json!({"accountId":params["accountId"],"id":id,"full":false}),
                    )
                    .await
            }
        }))
        .await?;
        Ok(json!({
            "ids":ids,
            "messages":summaries(&messages)?,
            "nextPageToken":page["nextPageToken"].as_str().unwrap_or(""),
            "estimate":page["estimate"].as_u64().unwrap_or(0),
        }))
    }

    async fn hey_list(&self, params: &Value) -> Result<Value, &'static str> {
        let program = crate::providers::hey_access::program()?;
        let checked = crate::providers::hey_access::checked_params(&json!({
            "accountId":params["accountId"],
            "program":program,
            "query":params["query"],
            "pageSize":params["pageSize"],
            "pageToken":params["pageToken"],
        }))
        .await?;
        let page = crate::providers::hey::call("hey.list", &checked).await?;
        let messages = page["messages"].as_array().ok_or("hey_invalid_response")?;
        Ok(json!({
            "ids":page["ids"],
            "messages":summaries(messages)?,
            "nextPageToken":page["nextPageToken"].as_str().unwrap_or(""),
            "estimate":page["estimate"].as_u64().unwrap_or(0),
        }))
    }

    async fn jmap_list(&self, params: &Value) -> Result<Value, &'static str> {
        let page = self
            .jmap
            .call(
                "jmap.list",
                &json!({
                    "accountId":params["accountId"],"query":params["query"],
                    "maxResults":params["pageSize"],"pageToken":params["pageToken"],
                }),
            )
            .await?;
        let data = &page["data"];
        let messages = self
            .jmap
            .call(
                "jmap.messages",
                &json!({"accountId":params["accountId"],"ids":data["ids"],"withBlocks":true}),
            )
            .await?;
        let messages = messages["data"].as_array().ok_or("jmap_invalid_response")?;
        Ok(json!({
            "ids":data["ids"],
            "messages":summaries(messages)?,
            "nextPageToken":data["nextPageToken"].as_str().unwrap_or(""),
            "estimate":data["estimate"].as_u64().unwrap_or(0),
        }))
    }

    async fn imap_list(&self, params: &Value, limit: u16) -> Result<Value, &'static str> {
        let mut request = json!({
            "accountId":params["accountId"],"query":params["query"],"limit":limit,
            "pageToken":params["pageToken"],"progressive":true,"readOnly":true,
        });
        let mut page = Box::pin(imap_call("imap.list", &request)).await?;
        if page["warning"]
            .as_str()
            .is_some_and(|warning| !warning.is_empty())
        {
            return Err("imap_list_incomplete");
        }
        if let Some(continuation) = page["continuation"]
            .as_str()
            .filter(|token| !token.is_empty())
        {
            request["continuation"] = json!(continuation);
            page = Box::pin(imap_call("imap.listContinue", &request)).await?;
            if page["warning"]
                .as_str()
                .is_some_and(|warning| !warning.is_empty())
            {
                return Err("imap_list_incomplete");
            }
            if page["continuation"]
                .as_str()
                .is_some_and(|token| !token.is_empty())
            {
                return Err("imap_list_incomplete");
            }
        }
        let provider_page = &page["page"];
        let messages = Box::pin(imap_call(
            "imap.messages",
            &json!({
                "accountId":params["accountId"],"ids":provider_page["ids"],
                "full":false,"progressive":false,"readOnly":true,
            }),
        ))
        .await?;
        if messages["warning"]
            .as_str()
            .is_some_and(|warning| !warning.is_empty())
        {
            return Err("imap_list_incomplete");
        }
        let messages = messages["messages"]
            .as_array()
            .ok_or("imap_invalid_response")?;
        Ok(json!({
            "ids":provider_page["ids"],
            "messages":summaries(messages)?,
            "nextPageToken":provider_page["nextPageToken"].as_str().unwrap_or(""),
            "estimate":provider_page["estimate"].as_u64().unwrap_or(0),
        }))
    }
}

impl crate::mail::list::ListAdapter for ProviderList<'_> {
    fn list<'a>(
        &'a self,
        request: &'a ListRequest,
        provider_query: String,
    ) -> Pin<Box<dyn Future<Output = Result<Value, &'static str>> + Send + 'a>> {
        Box::pin(self.session.provider_list(request, provider_query))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::{Account, Mailbox};
    use std::{
        env,
        ffi::OsString,
        fs,
        io::{BufRead, BufReader},
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::PathBuf,
        process::{Command, Stdio},
        sync::{Mutex, MutexGuard},
    };
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};

    static ENVIRONMENT: Mutex<()> = Mutex::new(());

    struct Fixture {
        _environment: MutexGuard<'static, ()>,
        previous_config: Option<OsString>,
        previous_home: Option<OsString>,
        previous_path: Option<OsString>,
        root: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            unsafe {
                if let Some(value) = &self.previous_config {
                    env::set_var("XDG_CONFIG_HOME", value);
                } else {
                    env::remove_var("XDG_CONFIG_HOME");
                }
                if let Some(value) = &self.previous_home {
                    env::set_var("HOME", value);
                } else {
                    env::remove_var("HOME");
                }
                if let Some(value) = &self.previous_path {
                    env::set_var("PATH", value);
                } else {
                    env::remove_var("PATH");
                }
            }
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    fn fixture(imap_port: u16, with_keyring: bool) -> Fixture {
        let environment = ENVIRONMENT
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let root = env::temp_dir().join(format!("omamail-backend-mail-{}", std::process::id()));
        let config = root.join("config");
        fs::create_dir_all(config.join("omamail")).unwrap();
        fs::write(
            config.join("omamail/accounts.json"),
            json!({
                "version":1,
                "activeId":"gmail@example.org",
                "accounts":[
                    {"provider":"gmail","email":"gmail@example.org"},
                    {"provider":"imap","email":"imap@example.org","imap":{"username":"imap@example.org","imapHost":"127.0.0.1","imapPort":imap_port,"insecure":true}},
                    {"provider":"jmap","email":"jmap@example.org","jmap":{"sessionUrl":"https://localhost:9/session","username":"jmap@example.org"}}
                ]
            })
            .to_string(),
        )
        .unwrap();
        fs::set_permissions(config.join("omamail"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(
            config.join("omamail/accounts.json"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let previous_config = env::var_os("XDG_CONFIG_HOME");
        let previous_home = env::var_os("HOME");
        let previous_path = env::var_os("PATH");
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        let secret_tool = bin.join("secret-tool");
        fs::write(
            &secret_tool,
            if with_keyring {
                "#!/bin/sh\nprintf 'synthetic\\n'\n"
            } else {
                "#!/bin/sh\nexit 1\n"
            },
        )
        .unwrap();
        fs::set_permissions(&secret_tool, fs::Permissions::from_mode(0o700)).unwrap();
        unsafe { env::set_var("PATH", bin) };
        unsafe {
            env::set_var("XDG_CONFIG_HOME", &config);
            env::set_var("HOME", root.join("home"));
        }
        Fixture {
            _environment: environment,
            previous_config,
            previous_home,
            previous_path,
            root,
        }
    }

    fn metadata(path: &std::path::Path) -> (u32, (i64, i64), (i64, i64)) {
        let metadata = fs::metadata(path).unwrap();
        (
            metadata.mode(),
            (metadata.mtime(), metadata.mtime_nsec()),
            (metadata.ctime(), metadata.ctime_nsec()),
        )
    }

    #[tokio::test]
    async fn configured_list_failures_do_not_repair_the_registry() {
        let fixture = fixture(9, false);
        let directory = fixture.root.join("config/omamail");
        let registry = directory.join("accounts.json");
        let before = (
            metadata(&directory),
            metadata(&registry),
            fs::read(&registry).unwrap(),
        );
        let session = Session::default();
        for account in [
            "gmail@example.org",
            "imap:imap@example.org",
            "jmap:jmap@example.org",
        ] {
            assert!(
                session
                    .dispatch("mail.list", &json!({"account":account}))
                    .await
                    .is_err()
            );
            assert_eq!(
                (
                    metadata(&directory),
                    metadata(&registry),
                    fs::read(&registry).unwrap()
                ),
                before
            );
        }
    }

    #[tokio::test]
    async fn imap_adapter_lists_its_first_page_without_a_request_token() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let fixture = fixture(listener.local_addr().unwrap().port(), true);
        let peer = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (reader, mut writer) = stream.into_split();
            let mut reader = AsyncBufReader::new(reader);
            writer.write_all(b"* OK ready\r\n").await.unwrap();
            loop {
                let mut line = Vec::new();
                reader.read_until(b'\n', &mut line).await.unwrap();
                let response = if line.starts_with(b"O1 LOGIN") {
                    b"O1 OK login\r\n".as_slice()
                } else if line == b"O1 CAPABILITY\r\n" {
                    b"* CAPABILITY IMAP4rev1\r\nO1 OK caps\r\n".as_slice()
                } else if line == b"O1 LIST \"\" \"*\"\r\n" {
                    b"* LIST () \"/\" INBOX\r\nO1 OK folders\r\n".as_slice()
                } else if line == b"O1 SELECT \"INBOX\"\r\n" {
                    b"O1 OK selected\r\n".as_slice()
                } else if line == b"O1 UID FETCH 1:* (UID)\r\n" {
                    b"* 1 FETCH (UID 7)\r\nO1 OK snapshot\r\n".as_slice()
                } else if line.starts_with(b"O1 UID FETCH 7 (UID FLAGS ") {
                    b"* 7 FETCH (UID 7 FLAGS () INTERNALDATE \"11-Sep-2026 12:00:00 +0000\" RFC822.SIZE 54 BODY[HEADER.FIELDS (FROM SUBJECT)] {54}\r\nFrom: Test <test@example.org>\r\nSubject: First page\r\n\r\n)\r\nO1 OK fetched\r\n".as_slice()
                } else {
                    panic!(
                        "unexpected IMAP command: {:?}",
                        String::from_utf8_lossy(&line)
                    );
                };
                writer.write_all(response).await.unwrap();
                if line.starts_with(b"O1 UID FETCH 7 (UID FLAGS ") {
                    return;
                }
            }
        });
        let result = Session::default()
            .dispatch("mail.list", &json!({"account":"imap:imap@example.org"}))
            .await
            .unwrap();
        assert_eq!(result["messages"][0]["id"], "7:INBOX");
        peer.await.unwrap();
        drop(fixture);
    }

    #[tokio::test]
    async fn jmap_adapter_keeps_thread_state_from_nonrepresentative_members() {
        let mut peer = Command::new("python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/src/providers/jmap/mailbox_tls_test.py"
            ))
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(peer.stdout.take().unwrap());
        let mut port = String::new();
        output.read_line(&mut port).unwrap();
        let mut certificate = String::new();
        output.read_line(&mut certificate).unwrap();
        let jmap = std::sync::Arc::new(
            crate::providers::jmap::Session::with_test_certificate(
                &fs::read(certificate.trim()).unwrap(),
            )
            .unwrap(),
        );
        let port: u16 = port.trim().parse().unwrap();
        let boxes = vec![
            json!({"id":"I","role":"inbox"}),
            json!({"id":"S","role":"sent"}),
            json!({"id":"T","role":"trash"}),
            json!({"id":"A","role":"archive"}),
            json!({"id":"D","role":"drafts"}),
        ];
        jmap.install_snapshot_for_test(
            "jmap:user@example.test",
            json!({
                "apiUrl":format!("https://localhost:{port}/api"),
                "downloadUrl":format!("https://localhost:{port}/blob/{{blobId}}"),
                "uploadUrl":format!("https://localhost:{port}/upload"),
                "eventSourceUrl":format!("https://localhost:{port}/events"),
                "state":"s1",
                "capabilities":{
                    "urn:ietf:params:jmap:core":{"maxObjectsInGet":2,"maxObjectsInSet":2},
                    "urn:ietf:params:jmap:mail":{},
                },
                "accounts":{"account":{"accountCapabilities":{"urn:ietf:params:jmap:mail":{"emailQuerySortOptions":["receivedAt"]}}}},
                "primaryAccounts":{"urn:ietf:params:jmap:mail":"account"},
            }),
            boxes,
            json!({"scheme":"basic","username":"user","secret":"synthetic"}),
            "user@example.test",
        )
        .await
        .unwrap();
        let session = Session {
            jmap,
            ..Default::default()
        };
        let result = session
            .provider_list(
                &ListRequest {
                    account: Account {
                        id: "jmap:user@example.test".into(),
                        provider: Provider::Jmap,
                    },
                    mailbox: Mailbox::Inbox,
                    query: String::new(),
                    limit: 25,
                    page_token: String::new(),
                },
                "role:inbox".into(),
            )
            .await
            .unwrap();
        assert_eq!(
            result["messages"][0]["thread"]["memberIds"],
            json!(["e1", "e2"])
        );
        assert_eq!(result["messages"][0]["thread"]["count"], 2);
        assert_eq!(result["messages"][0]["unread"], true);
        assert_eq!(result["messages"][0]["starred"], true);
        let _ = peer.kill();
        let _ = peer.wait();
    }
}
