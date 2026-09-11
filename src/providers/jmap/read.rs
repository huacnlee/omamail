use super::mailbox::{Context, MEMBER_PROPERTIES, Snapshot, argument, fill, ids};
use super::query::string;
use super::*;
impl Session {
    pub(super) async fn list(
        &self,
        context: &Context,
        snapshot: &Snapshot,
        params: &Value,
    ) -> Result<Value, &'static str> {
        let query = params["query"].as_str().unwrap_or("");
        let filter = query::filter(query, &snapshot.roles)?;
        let limit = params["maxResults"].as_u64().unwrap_or(25).clamp(1, 1000) as usize;
        let token = params["pageToken"].as_str().unwrap_or("");
        let mut answer = Value::Null;
        for by_position in [false, true] {
            let calls = json!([
                ["Email/query",query::query(&snapshot.account,filter.clone(),limit,token,by_position),"0"],
                ["Email/get",{"accountId":snapshot.account,"#ids":{"resultOf":"0","name":"Email/query","path":"/ids"},"properties":super::resource::LIST_PROPERTIES},"1"],
                ["Thread/get",{"accountId":snapshot.account,"#ids":{"resultOf":"1","name":"Email/get","path":"/list/*/threadId"}},"2"],
                ["Email/get",{"accountId":snapshot.account,"#ids":{"resultOf":"2","name":"Thread/get","path":"/list/*/emailIds"},"properties":MEMBER_PROPERTIES},"3"]]);
            let calls = if snapshot.limit("maxCallsInRequest", 16) < 4 {
                json!([calls[0]])
            } else {
                calls
            };
            answer = self.api(context, snapshot, calls, false).await?;
            if argument(&answer, "0", "Email/query") == Err("jmap_anchor_not_found") && !by_position
            {
                continue;
            }
            break;
        }
        let query_args = argument(&answer, "0", "Email/query")?;
        let mut page = query::page(query_args, limit);
        page["state"] = query_args
            .get("queryState")
            .cloned()
            .unwrap_or_else(|| json!(""));
        let page_ids = ids(&page["ids"])?;
        let reps = match argument(&answer, "1", "Email/get") {
            Ok(args) => args["list"]
                .as_array()
                .ok_or("jmap_invalid_response")?
                .clone(),
            Err(_) => {
                self.get_emails(context, snapshot, &page_ids, false, false)
                    .await?
            }
        };
        let threads = match argument(&answer, "2", "Thread/get") {
            Ok(args) => args["list"]
                .as_array()
                .ok_or("jmap_invalid_response")?
                .clone(),
            Err(_) => {
                let wanted = ids(&json!(
                    reps.iter()
                        .map(|v| v["threadId"].clone())
                        .collect::<Vec<_>>()
                ))?;
                let mut all = Vec::new();
                for chunk in wanted.chunks(snapshot.limit("maxObjectsInGet", 256)) {
                    let result = self
                        .api(
                            context,
                            snapshot,
                            json!([["Thread/get",{"accountId":snapshot.account,"ids":chunk},"0"]]),
                            false,
                        )
                        .await?;
                    all.extend(
                        argument(&result, "0", "Thread/get")?["list"]
                            .as_array()
                            .ok_or("jmap_invalid_response")?
                            .clone(),
                    );
                }
                all
            }
        };
        let mut thread_map = serde_json::Map::new();
        let mut member_ids = Vec::new();
        for thread in threads {
            let members = ids(&thread["emailIds"])?;
            for id in &members {
                if !member_ids.contains(id) {
                    if member_ids.len() >= 65536 {
                        return Err("jmap_response_too_large");
                    }
                    member_ids.push(id.clone());
                }
            }
            thread_map.insert(string(&thread["id"]).into(), json!(members));
        }
        let members = match argument(&answer, "3", "Email/get") {
            Ok(args) => args["list"]
                .as_array()
                .ok_or("jmap_invalid_response")?
                .clone(),
            Err(_) => {
                self.get_emails(context, snapshot, &member_ids, false, true)
                    .await?
            }
        };
        let mut index = serde_json::Map::new();
        for member in &members {
            index.insert(string(&member["id"]).into(), member.clone());
        }
        let blocks = super::resource::thread_blocks(
            &json!(reps),
            &Value::Object(thread_map),
            &Value::Object(index),
            &snapshot.roles,
            string(&filter["inMailbox"]),
        );
        {
            let mut held = context.blocks.lock().map_err(|_| "session_failed")?;
            if held.len() + page_ids.len() > 4096 {
                held.clear();
            }
            for (id, block) in blocks.as_object().ok_or("jmap_invalid_response")? {
                held.insert(id.clone(), block.clone());
            }
        }
        {
            let mut held = context.summaries.lock().map_err(|_| "session_failed")?;
            if held.len() + reps.len() > 4096 {
                held.clear();
            }
            for row in reps {
                held.insert(string(&row["id"]).into(), row);
            }
        }
        {
            let mut held = context.memberships.lock().map_err(|_| "session_failed")?;
            if held.len() + members.len() > 4096 {
                held.clear();
            }
            for row in members {
                held.insert(string(&row["id"]).into(), row["mailboxIds"].clone());
            }
        }
        Ok(page)
    }
    pub(super) async fn messages(
        &self,
        context: &Context,
        snapshot: &Snapshot,
        params: &Value,
    ) -> Result<Value, &'static str> {
        let ids = ids(&params["ids"])?;
        let mut emails = Vec::new();
        let mut missing = Vec::new();
        {
            let summaries = context.summaries.lock().map_err(|_| "session_failed")?;
            for id in &ids {
                if let Some(email) = summaries.get(id) {
                    emails.push(email.clone());
                } else {
                    missing.push(id.clone());
                }
            }
        }
        if !missing.is_empty() {
            emails.extend(
                self.get_emails(context, snapshot, &missing, false, false)
                    .await?,
            );
        }
        let with_blocks = params["withBlocks"] != false;
        let blocks = context.blocks.lock().map_err(|_| "session_failed")?;
        let mut result = Vec::new();
        let mut result_bytes = 0usize;
        for id in ids {
            if let Some(email) = emails.iter().find(|email| email["id"] == id) {
                super::resource::validate_budget(email, false)?;
                let mut message = super::resource::to_message(email, &snapshot.roles, false);
                if with_blocks && let Some(block) = blocks.get(&id) {
                    message["thread"] = block.clone();
                }
                result_bytes = result_bytes.saturating_add(
                    serde_json::to_vec(&message)
                        .map_err(|_| "jmap_invalid_response")?
                        .len(),
                );
                if result_bytes > MAX_BODY {
                    return Err("jmap_response_too_large");
                }
                result.push(message);
            }
        }
        Ok(json!(result))
    }
    pub(super) async fn read(
        &self,
        context: &Context,
        snapshot: &Snapshot,
        params: &Value,
    ) -> Result<Value, &'static str> {
        let id = text(params, "id")?;
        let emails = self
            .get_emails(
                context,
                snapshot,
                &[id.to_owned()],
                params["full"] != false,
                false,
            )
            .await?;
        let email = emails.first().ok_or("jmap_message_not_found")?;
        super::resource::validate_budget(email, params["full"] != false)?;
        let mut message =
            super::resource::to_message(email, &snapshot.roles, params["full"] != false);
        if let Some(block) = context.blocks.lock().map_err(|_| "session_failed")?.get(id) {
            message["thread"] = block.clone();
        }
        let parts = super::resource::truncated_parts(email);
        // A message can advertise arbitrarily many truncated text parts. Repair
        // incrementally under one byte budget rather than retaining every blob.
        // Failed/oversized repairs retain the text already delivered, matching
        // the prior reader's best-effort behavior.
        let used = serde_json::to_vec(&message)
            .map_err(|_| "jmap_invalid_response")?
            .len();
        let mut budget = MAX_BODY.saturating_sub(used);
        for part in parts.iter().take(64) {
            mailbox::active(context)?;
            let overhead = serde_json::to_vec(part)
                .map_err(|_| "jmap_invalid_response")?
                .len()
                .saturating_mul(6)
                .saturating_add(256);
            budget = budget.saturating_sub(overhead);
            let cap = budget / 4 * 3;
            if cap == 0 {
                break;
            }
            if part["size"].as_u64().is_some_and(|size| size > cap as u64) {
                continue;
            }
            if let Ok(blob) = self
                .attachment_limited(snapshot, string(&part["blobId"]), cap)
                .await
            {
                let data = string(&blob["data"]);
                budget = budget.saturating_sub(data.len());
                super::resource::substitute_part(&mut message["payload"], part, data);
            }
        }
        Ok(message)
    }
    pub(super) async fn attachment(
        &self,
        snapshot: &Snapshot,
        blob: &str,
    ) -> Result<Value, &'static str> {
        self.attachment_limited(snapshot, blob, MAX_BODY).await
    }
    async fn attachment_limited(
        &self,
        snapshot: &Snapshot,
        blob: &str,
        limit: usize,
    ) -> Result<Value, &'static str> {
        if blob.is_empty() || blob.len() > 4096 {
            return Err("invalid_params");
        }
        let endpoint = fill(
            string(&snapshot.document["downloadUrl"]),
            &[
                ("accountId", &snapshot.account),
                ("blobId", blob),
                ("name", "attachment"),
                ("type", "application/octet-stream"),
            ],
        );
        let request =
            prepare(&json!({"verb":"download","url":endpoint,"credential":snapshot.credential}))?;
        let _slot = snapshot
            .slots
            .acquire()
            .await
            .map_err(|_| "session_failed")?;
        let reply = execute_bounded(self.client.as_ref().map_err(|e| *e)?, request, limit).await?;
        if reply["status"] == 401 {
            return Err("jmap_unauthorized");
        }
        if reply["status"] != 200 {
            return Err("jmap_network_failed");
        }
        let bytes = STANDARD
            .decode(string(&reply["body"]))
            .map_err(|_| "jmap_invalid_response")?;
        Ok(
            json!({"data":base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes),"size":bytes.len()}),
        )
    }
}
