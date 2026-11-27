//! Autonomous unread checking uses saved settings and keyring credentials;
//! no open window, QML timer, or UI-owned token is required.
use super::*;

impl Session {
    pub async fn check(&self, account_id: &str) -> Result<Value, &'static str> {
        let page = self
            .native(
                "jmap.list",
                &json!({"accountId":account_id,"query":"role:inbox unseen","maxResults":3}),
            )
            .await?;
        let messages = self
            .native(
                "jmap.messages",
                &json!({"accountId":account_id,"ids":page["data"]["ids"],"withBlocks":true}),
            )
            .await?;
        Ok(
            json!({"estimate":page["data"]["estimate"],"messages":messages["data"],"fingerprint":page["data"]["state"]}),
        )
    }

    pub(super) async fn document(
        &self,
        verb: &str,
        endpoint: &str,
        credential: &Value,
        body: Option<String>,
    ) -> Result<Value, &'static str> {
        let params = json!({"verb":verb,"url":endpoint,"credential":credential,"body":body.unwrap_or_default()});
        let request = prepare(&params)?;
        let client = self.client.as_ref().map_err(|e| *e)?;
        let reply = tokio::time::timeout(REQUEST_TIME, async {
            let _slot = self
                .slots
                .acquire()
                .await
                .map_err(|_| "jmap_transport_unavailable")?;
            execute(client, request).await
        })
        .await
        .map_err(|_| "jmap_timeout")??;
        if reply["status"] == 401 {
            return Err("jmap_unauthorized");
        }
        if reply["status"] != 200 {
            return Err("jmap_network_failed");
        }
        serde_json::from_str(reply["body"].as_str().ok_or("jmap_invalid_response")?)
            .map_err(|_| "jmap_invalid_response")
    }
}
