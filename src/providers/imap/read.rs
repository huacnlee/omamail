//! Mailbox discovery, UID search and MIME reads. No protocol is interpreted by QML.
use super::*;
use base64::engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD};
use std::collections::{BTreeMap, BTreeSet};
#[derive(Clone, Debug, PartialEq)]
enum Node {
    Text(Vec<u8>),
    List(Vec<Node>),
    End,
}
impl Node {
    fn text(&self) -> &[u8] {
        if let Self::Text(t) = self { t } else { b"" }
    }
    fn is(&self, value: &str) -> bool {
        self.text().eq_ignore_ascii_case(value.as_bytes())
    }
    fn number(&self) -> Option<u32> {
        std::str::from_utf8(self.text())
            .ok()?
            .parse::<u32>()
            .ok()
            .filter(|n| *n > 0)
    }
    fn list(&self) -> &[Node] {
        if let Self::List(v) = self { v } else { &[] }
    }
    fn string(&self) -> Result<String> {
        String::from_utf8(self.text().to_vec()).map_err(|_| "imap_invalid_response")
    }
}
fn nodes(data: &[u8]) -> Result<Vec<Vec<Node>>> {
    fn parse(
        data: &[u8],
        at: &mut usize,
        nested: bool,
        budget: &mut usize,
        depth: usize,
    ) -> Result<Vec<Node>> {
        if depth > 64 {
            return Err("imap_response_too_complex");
        }
        let mut out = Vec::new();
        while *at < data.len() {
            if *budget == 0 {
                return Err("imap_response_too_complex");
            }
            *budget -= 1;
            match data[*at] {
                b' ' | b'\t' | b'\r' => {
                    *at += 1;
                }
                b'\n' => {
                    *at += 1;
                    if !nested {
                        out.push(Node::End)
                    }
                }
                b'(' => {
                    *at += 1;
                    if nested && out.len() > 100000 {
                        return Err("imap_response_too_complex");
                    }
                    out.push(Node::List(parse(data, at, true, budget, depth + 1)?));
                }
                b')' => {
                    if !nested {
                        return Err("imap_invalid_response");
                    }
                    *at += 1;
                    return Ok(out);
                }
                b'"' => {
                    *at += 1;
                    let mut v = Vec::new();
                    let mut ended = false;
                    while *at < data.len() {
                        let c = data[*at];
                        *at += 1;
                        if c == b'"' {
                            ended = true;
                            break;
                        }
                        if c == b'\\' {
                            let c = *data.get(*at).ok_or("imap_invalid_response")?;
                            *at += 1;
                            v.push(c)
                        } else {
                            v.push(c)
                        }
                    }
                    if !ended {
                        return Err("imap_invalid_response");
                    }
                    out.push(Node::Text(v));
                }
                b'{' => {
                    let start = *at + 1;
                    let close = data[start..]
                        .iter()
                        .position(|b| *b == b'}')
                        .ok_or("imap_invalid_response")?
                        + start;
                    let n = std::str::from_utf8(&data[start..close])
                        .map_err(|_| "imap_invalid_response")?
                        .trim_end_matches('+')
                        .parse::<usize>()
                        .map_err(|_| "imap_invalid_response")?;
                    *at = close + 1;
                    if data.get(*at..*at + 2) != Some(b"\r\n") {
                        return Err("imap_invalid_response");
                    }
                    *at += 2;
                    if n > data.len() - *at {
                        return Err("imap_invalid_response");
                    }
                    out.push(Node::Text(data[*at..*at + n].to_vec()));
                    *at += n;
                }
                _ => {
                    let start = *at;
                    let mut brackets = 0usize;
                    while *at < data.len() {
                        let c = data[*at];
                        if brackets == 0 && (c.is_ascii_whitespace() || c == b'(' || c == b')') {
                            break;
                        }
                        if c == b'[' {
                            brackets += 1
                        } else if c == b']' {
                            brackets = brackets.saturating_sub(1)
                        }
                        *at += 1;
                    }
                    if *at == start {
                        return Err("imap_invalid_response");
                    }
                    out.push(Node::Text(data[start..*at].to_vec()));
                }
            }
        }
        if nested {
            return Err("imap_invalid_response");
        }
        Ok(out)
    }
    let flat = parse(data, &mut 0, false, &mut (LIMIT * 2), 0)?;
    Ok(flat
        .split(|n| *n == Node::End)
        .filter(|row| !row.is_empty())
        .map(|row| row.to_vec())
        .collect())
}
#[derive(Clone)]
struct Folder {
    name: String,
    delimiter: String,
    flags: Vec<String>,
}
#[derive(Clone)]
pub(super) struct Mailboxes {
    folders: Vec<Folder>,
    pub(super) special: BTreeMap<String, String>,
    pub(super) capabilities: Vec<String>,
}
struct Cached {
    key: String,
    boxes: Mailboxes,
    since: Instant,
}
static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub(super) async fn invalidate() {
    EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    BOXES.get_or_init(Default::default).lock().await.clear();
}
static BOXES: OnceLock<tokio::sync::Mutex<Vec<Cached>>> = OnceLock::new();
fn cache_key(p: &Value) -> String {
    json!([p["settings"], p["credential"], p["oauth"]]).to_string()
}
fn parse_folders(data: &[u8]) -> Result<Mailboxes> {
    let mut folders = Vec::new();
    let mut capabilities = Vec::new();
    for line in nodes(data)? {
        if line.len() >= 3 && line[0].is("*") && line[1].is("CAPABILITY") {
            capabilities = line[2..]
                .iter()
                .map(Node::string)
                .collect::<Result<Vec<_>>>()?;
        }
        if line.len() < 5 || !line[0].is("*") || !line[1].is("LIST") {
            continue;
        }
        let flags = line[2]
            .list()
            .iter()
            .map(Node::string)
            .collect::<Result<Vec<_>>>()?;
        let name = line[4].string()?;
        quote(&name)?;
        let delimiter = if line[3].is("NIL") {
            String::new()
        } else {
            line[3].string()?
        };
        folders.push(Folder {
            name,
            delimiter,
            flags,
        });
    }
    let mut special = BTreeMap::new();
    for folder in &folders {
        if folder
            .flags
            .iter()
            .any(|f| f.eq_ignore_ascii_case("\\Noselect"))
        {
            continue;
        }
        for flag in &folder.flags {
            let flag = flag.to_ascii_lowercase();
            if [
                "\\sent",
                "\\trash",
                "\\drafts",
                "\\archive",
                "\\junk",
                "\\all",
                "\\inbox",
            ]
            .contains(&flag.as_str())
            {
                special.entry(flag).or_insert_with(|| folder.name.clone());
            }
        }
        if folder.name.eq_ignore_ascii_case("INBOX") {
            special.insert("\\inbox".into(), folder.name.clone());
        }
    }
    // Fallbacks select only an existing LIST name, never invent a destination.
    for (flag, names) in [
        ("\\sent", &["sent", "sent items", "sent messages"][..]),
        ("\\trash", &["trash", "deleted items", "deleted messages"]),
        ("\\drafts", &["drafts"]),
        ("\\archive", &["archive", "archives"]),
        ("\\junk", &["junk", "junk email", "spam"]),
    ] {
        if special.contains_key(flag) {
            continue;
        }
        if let Some(folder) = folders.iter().find(|f| {
            !f.flags
                .iter()
                .any(|flag| flag.eq_ignore_ascii_case("\\Noselect"))
                && names.contains(&f.name.to_ascii_lowercase().as_str())
        }) {
            special.insert(flag.into(), folder.name.clone());
        }
    }
    Ok(Mailboxes {
        folders,
        special,
        capabilities,
    })
}
pub(super) async fn mailboxes(w: &mut Wire, p: &Value) -> Result<Mailboxes> {
    let key = cache_key(p);
    {
        let mut cache = BOXES.get_or_init(Default::default).lock().await;
        cache.retain(|c| c.since.elapsed() < Duration::from_secs(60));
        if let Some(c) = cache.iter().find(|c| c.key == key && p["refresh"] != true) {
            return Ok(c.boxes.clone());
        }
    }
    let epoch = EPOCH.load(std::sync::atomic::Ordering::SeqCst);
    let mut data = command(w, "CAPABILITY").await?;
    data.extend(command(w, "LIST \"\" \"*\"").await?);
    let boxes = parse_folders(&data)?;
    let mut cache = BOXES.get_or_init(Default::default).lock().await;
    if cache.len() >= 32 {
        cache.remove(0);
    }
    if epoch != EPOCH.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(boxes);
    }
    cache.push(Cached {
        key,
        boxes: boxes.clone(),
        since: Instant::now(),
    });
    Ok(boxes)
}
pub(super) fn resolve(boxes: &Mailboxes, name: &str) -> Result<String> {
    if name.starts_with('\\') {
        boxes
            .special
            .get(&name.to_ascii_lowercase())
            .cloned()
            .ok_or("imap_folder_unavailable")
    } else {
        quote(name)?;
        Ok(name.into())
    }
}
pub(super) fn mailbox_name(name: &str) -> String {
    let mut out = String::new();
    let mut rest = name;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        rest = &rest[start + 1..];
        let Some(end) = rest.find('-') else {
            out.push('&');
            out.push_str(rest);
            return out;
        };
        let chunk = &rest[..end];
        if chunk.is_empty() {
            out.push('&')
        } else {
            let decoded = STANDARD_NO_PAD
                .decode(chunk.replace(',', "/"))
                .ok()
                .filter(|b| b.len() % 2 == 0 && !b.is_empty())
                .and_then(|b| {
                    String::from_utf16(
                        &b.as_chunks::<2>()
                            .0
                            .iter()
                            .map(|s| u16::from_be_bytes([s[0], s[1]]))
                            .collect::<Vec<_>>(),
                    )
                    .ok()
                });
            if let Some(decoded) = decoded {
                out.push_str(&decoded)
            } else {
                out.push('&');
                out.push_str(chunk);
                out.push('-')
            }
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}
fn folders_value(boxes: &Mailboxes) -> Value {
    let labels:Vec<_>=boxes.folders.iter().filter(|f|!f.flags.iter().any(|flag|flag.eq_ignore_ascii_case("\\Noselect"))).map(|f|json!({"id":f.name,"name":mailbox_name(&f.name),"rawName":f.name,"delimiter":f.delimiter,"system":boxes.special.values().any(|name|name==&f.name),"unread":0,"total":0,"threadsUnread":0})).collect();
    let folders:Vec<_>=boxes.folders.iter().map(|f|json!({"name":f.name,"delimiter":f.delimiter,"flags":f.flags,"selectable":!f.flags.iter().any(|flag|flag.eq_ignore_ascii_case("\\Noselect"))})).collect();
    json!({"labels":labels,"folders":folders,"special":boxes.special,"capabilities":boxes.capabilities})
}
fn query(query: &str) -> Result<(String, String)> {
    if !safe(query) {
        return Err("invalid_params");
    }
    let text = query.trim();
    let (folder, criteria) = if let Some(rest) = text.strip_prefix("folder:") {
        if rest.starts_with('"') {
            let mut at = 1;
            let bytes = rest.as_bytes();
            let mut folder = Vec::new();
            let mut ended = false;
            while at < bytes.len() {
                let b = bytes[at];
                at += 1;
                if b == b'"' {
                    ended = true;
                    break;
                }
                if b == b'\\' {
                    folder.push(*bytes.get(at).ok_or("invalid_params")?);
                    at += 1;
                } else {
                    folder.push(b)
                }
            }
            if !ended {
                return Err("invalid_params");
            }
            (
                String::from_utf8(folder).map_err(|_| "invalid_params")?,
                rest[at..].trim().to_owned(),
            )
        } else {
            let (folder, criteria) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            (folder.into(), criteria.trim().into())
        }
    } else {
        ("INBOX".into(), text.into())
    };
    let folder = if folder.is_empty() {
        "INBOX".into()
    } else {
        folder
    };
    quote(&folder)?;
    let criteria = criteria
        .replace("\\n", " ")
        .replace("\\r", " ")
        .replace("\\t", " ");
    if !safe(&criteria) || criteria.len() > 32768 {
        return Err("invalid_params");
    }
    Ok((folder, criteria))
}
fn fetched_uids(data: &[u8]) -> Result<Vec<u32>> {
    let mut out = BTreeSet::new();
    for row in nodes(data)? {
        if row.len() < 4 || !row[0].is("*") || !row[2].is("FETCH") {
            continue;
        }
        for pair in row[3].list().windows(2) {
            if pair[0].is("UID")
                && let Some(uid) = pair[1].number()
            {
                out.insert(uid);
            }
        }
    }
    Ok(out.into_iter().collect())
}
fn search_uids(data: &[u8]) -> Result<Vec<u32>> {
    let mut out = BTreeSet::new();
    for row in nodes(data)? {
        if row.len() >= 2 && row[0].is("*") && row[1].is("SEARCH") {
            for n in &row[2..] {
                if let Some(uid) = n.number() {
                    out.insert(uid);
                }
            }
        }
    }
    Ok(out.into_iter().collect())
}
fn page(found: &[u32], folder: &str, offset: usize, limit: usize, more: bool) -> Value {
    let ordered: Vec<_> = found
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .rev()
        .collect();
    let ids: Vec<_> = ordered
        .iter()
        .skip(offset)
        .take(limit)
        .map(|uid| format!("{uid}:{folder}"))
        .collect();
    let next = offset + ids.len();
    let can_continue = next < ordered.len() || more;
    json!({"ids":ids,"threadIds":[],"nextPageToken":if can_continue{next.to_string()}else{String::new()},"estimate":if more{ordered.len().max(offset+limit+1)}else{ordered.len()}})
}
async fn list(w: &mut Wire, p: &Value, boxes: &Mailboxes) -> Result<Value> {
    let limit = p["limit"].as_u64().unwrap_or(25).clamp(1, 100) as usize;
    let offset = p["pageToken"]
        .as_str()
        .unwrap_or("")
        .parse::<usize>()
        .unwrap_or(0)
        .min(10_000_000);
    let (folder, criteria) = query(p["query"].as_str().unwrap_or(""))?;
    let folder = resolve(boxes, &folder)?;
    command(w, &format!("SELECT {}", quote(&folder)?)).await?;
    let mut found = Vec::new();
    let mut ceiling = None;
    if let Some(token) = p["continuation"].as_str() {
        if token.len() > 128 * 1024 {
            return Err("invalid_params");
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(token)
            .map_err(|_| "invalid_params")?;
        let state: Value = serde_json::from_slice(&bytes).map_err(|_| "invalid_params")?;
        if state["folder"] != folder
            || state["criteria"] != criteria
            || state["accountId"] != p["accountId"]
            || state["requestToken"] != p["requestToken"]
        {
            return Err("invalid_params");
        }
        found = state["found"]
            .as_array()
            .ok_or("invalid_params")?
            .iter()
            .map(|n| {
                n.as_u64()
                    .filter(|n| *n > 0 && *n <= u32::MAX as u64)
                    .map(|n| n as u32)
                    .ok_or("invalid_params")
            })
            .collect::<Result<Vec<_>>>()?;
        ceiling = Some(
            state["ceiling"]
                .as_u64()
                .filter(|n| *n <= u32::MAX as u64)
                .ok_or("invalid_params")? as u32,
        );
    } else if p["progressive"] == true && !criteria.is_empty() {
        // Native IMAP can read *:* directly. The old curl-specific STATUS/count workaround is gone.
        let top = match command(w, "UID FETCH *:* (UID)").await {
            Ok(data) => fetched_uids(&data)?.into_iter().max(),
            Err("imap_command_failed") => None,
            Err(error) => return Err(error),
        };
        if let Some(top) = top {
            let first = top.saturating_sub(4095).max(1);
            found = search_uids(
                &command(w, &format!("UID SEARCH UID {first}:{top} {criteria}")).await?,
            )?;
            let more = first > 1;
            let partial = page(&found, &folder, offset, limit, more);
            if partial["ids"]
                .as_array()
                .is_some_and(|ids| ids.len() >= limit)
                || !more
            {
                return Ok(json!({"page":partial}));
            }
            let token=URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"folder":folder,"criteria":criteria,"accountId":p["accountId"],"requestToken":p["requestToken"],"found":found,"ceiling":first-1})).map_err(|_|"invalid_params")?);
            return Ok(json!({"page":partial,"continuation":token}));
        }
    }
    let scan = async {
        let mut snapshot = fetched_uids(&command(w, "UID FETCH 1:* (UID)").await?)?;
        if let Some(ceiling) = ceiling {
            snapshot.retain(|uid| *uid <= ceiling)
        }
        if criteria.is_empty() {
            return Ok::<_, &'static str>(snapshot);
        }
        let mut matches = Vec::new();
        for window in snapshot.chunks(4096).rev() {
            let first = window[0];
            let last = *window.last().unwrap();
            matches.extend(search_uids(
                &command(w, &format!("UID SEARCH UID {first}:{last} {criteria}")).await?,
            )?);
        }
        Ok(matches)
    }
    .await;
    match scan {
        Ok(mut matches) => found.append(&mut matches),
        Err(error) if !found.is_empty() => {
            return Ok(json!({"page":page(&found,&folder,offset,limit,false),"warning":error}));
        }
        Err(error) => return Err(error),
    }
    Ok(json!({"page":page(&found,&folder,offset,limit,false)}))
}
pub(super) fn message_id(id: &str) -> Result<(u32, String)> {
    let (uid, folder) = id.split_once(':').ok_or("invalid_params")?;
    let uid = uid
        .parse::<u32>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or("invalid_params")?;
    quote(folder)?;
    if folder.is_empty() {
        return Err("invalid_params");
    }
    Ok((uid, folder.into()))
}
fn flags_labels(flags: &[String], folder: &str, boxes: &Mailboxes) -> Vec<String> {
    let has = |flag: &str| flags.iter().any(|f| f.eq_ignore_ascii_case(flag));
    let mut labels = Vec::new();
    if !has("\\Seen") {
        labels.push("UNREAD".into())
    }
    for (flag, label) in [
        ("\\Flagged", "STARRED"),
        ("\\Draft", "DRAFT"),
        ("\\Deleted", "TRASH"),
    ] {
        if has(flag) {
            labels.push(label.into())
        }
    }
    if folder.eq_ignore_ascii_case("INBOX") {
        labels.push("INBOX".into())
    }
    for (flag, label) in [
        ("\\sent", "SENT"),
        ("\\trash", "TRASH"),
        ("\\drafts", "DRAFT"),
        ("\\junk", "SPAM"),
    ] {
        if boxes
            .special
            .get(flag)
            .is_some_and(|name| name.eq_ignore_ascii_case(folder))
            && !labels.iter().any(|id| id == label)
        {
            labels.push(label.into())
        }
    }
    labels
}
fn snippet(payload: &Value) -> String {
    if payload["mimeType"] == "text/plain" {
        return payload["body"]["data"]
            .as_str()
            .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
            .map(|s| {
                String::from_utf8_lossy(&s)
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(200)
                    .collect()
            })
            .unwrap_or_default();
    }
    payload["parts"]
        .as_array()
        .and_then(|parts| parts.iter().map(snippet).find(|text| !text.is_empty()))
        .unwrap_or_default()
}
fn parse_messages(data: &[u8], folder: &str, full: bool, boxes: &Mailboxes) -> Result<Vec<Value>> {
    let mut result = Vec::new();
    for row in nodes(data)? {
        if row.len() < 4 || !row[0].is("*") || !row[2].is("FETCH") {
            continue;
        }
        let fields = row[3].list();
        let mut uid = None;
        let mut flags = Vec::new();
        let mut date = 0i64;
        let mut size = 0u64;
        let mut raw = None;
        let mut i = 0;
        while i + 1 < fields.len() {
            let key = &fields[i];
            let value = &fields[i + 1];
            if key.is("UID") {
                uid = value.number()
            } else if key.is("FLAGS") {
                flags = value
                    .list()
                    .iter()
                    .map(Node::string)
                    .collect::<Result<Vec<_>>>()?
            } else if key.is("INTERNALDATE") {
                date = chrono::DateTime::parse_from_str(&value.string()?, "%d-%b-%Y %H:%M:%S %z")
                    .map(|d| d.timestamp_millis())
                    .unwrap_or(0)
            } else if key.is("RFC822.SIZE") {
                size = std::str::from_utf8(value.text())
                    .ok()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0)
            } else if key.text().to_ascii_uppercase().starts_with(b"BODY[") {
                raw = Some(value.text())
            }
            i += 2;
        }
        let Some(uid) = uid else { continue };
        let Some(raw) = raw else { continue };
        let payload = crate::message::parse(raw)?;
        result.push(json!({"id":format!("{uid}:{folder}"),"threadId":format!("{uid}:{folder}"),"labelIds":flags_labels(&flags,folder,boxes),"internalDate":date,"sizeEstimate":size,"snippet":if full{snippet(&payload)}else{String::new()},"payload":payload}));
    }
    Ok(result)
}
async fn messages(p: &Value) -> Result<Value> {
    let ids = p["ids"].as_array().ok_or("invalid_params")?;
    if ids.len() > 500 {
        return Err("invalid_params");
    }
    let ids = ids
        .iter()
        .map(|id| id.as_str().ok_or("invalid_params"))
        .collect::<Result<Vec<_>>>()?;
    let original_ids = ids.clone();
    let offset = if let Some(token) = p["continuation"].as_str() {
        if token.len() > 65536 {
            return Err("invalid_params");
        }
        let cursor: Value = serde_json::from_slice(
            &URL_SAFE_NO_PAD
                .decode(token)
                .map_err(|_| "invalid_params")?,
        )
        .map_err(|_| "invalid_params")?;
        if cursor["accountId"] != p["accountId"]
            || cursor["requestToken"] != p["requestToken"]
            || cursor["ids"] != p["ids"]
        {
            return Err("invalid_params");
        }
        cursor["offset"]
            .as_u64()
            .filter(|n| *n <= ids.len() as u64)
            .ok_or("invalid_params")? as usize
    } else {
        0
    };
    let end = if p["progressive"] == true {
        (offset + 10).min(ids.len())
    } else {
        ids.len()
    };
    let ids = ids[offset..end].to_vec();
    let mut groups: BTreeMap<String, Vec<u32>> = BTreeMap::new();
    for id in &ids {
        let (uid, folder) = message_id(id)?;
        groups.entry(folder).or_default().push(uid);
    }
    let full = p["full"] == true;
    let futures = groups.into_iter().map(|(folder, uids)| async move {
        let (mut w, key) = acquire(p).await?;
        let boxes = mailboxes(&mut w, p).await?;
        command(&mut w, &format!("SELECT {}", quote(&folder)?)).await?;
        let set = uids
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let section = if full {
            ""
        } else {
            "HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID REPLY-TO LIST-UNSUBSCRIBE)"
        };
        let data = command(
            &mut w,
            &format!("UID FETCH {set} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[{section}])"),
        )
        .await?;
        release(w, key).await;
        tokio::task::spawn_blocking(move || parse_messages(&data, &folder, full, &boxes))
            .await
            .map_err(|_| "worker_failed")?
    });
    use futures_util::StreamExt;
    let mut results = futures_util::stream::iter(futures).buffer_unordered(4);
    let mut found = BTreeMap::new();
    let mut error = None;
    while let Some(result) = results.next().await {
        match result {
            Ok(messages) => {
                for message in messages {
                    found.insert(message["id"].as_str().unwrap_or("").to_owned(), message);
                }
            }
            Err(e) => {
                error.get_or_insert(e);
            }
        }
    }
    let ordered: Vec<_> = ids.iter().filter_map(|id| found.remove(*id)).collect();
    let continuation = if end < original_ids.len() && error.is_none() {
        Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"accountId":p["accountId"],"requestToken":p["requestToken"],"ids":p["ids"],"offset":end})).map_err(|_|"invalid_params")?))
    } else {
        None
    };
    Ok(json!({"messages":ordered,"warning":error,"continuation":continuation}))
}
fn status(data: &[u8]) -> Result<(u64, u64)> {
    for row in nodes(data)? {
        if row.len() >= 4 && row[0].is("*") && row[1].is("STATUS") {
            let fields = row[3].list();
            let mut count = None;
            let mut unseen = None;
            for pair in fields.as_chunks::<2>().0 {
                let n = std::str::from_utf8(pair[1].text())
                    .ok()
                    .and_then(|s| s.parse::<u64>().ok());
                if pair[0].is("MESSAGES") {
                    count = n
                } else if pair[0].is("UNSEEN") {
                    unseen = n
                }
            }
            return Ok((
                count.ok_or("imap_invalid_response")?,
                unseen.ok_or("imap_invalid_response")?,
            ));
        }
    }
    Err("imap_invalid_response")
}
pub(super) fn validate(method: &str, p: &Value) -> Result<()> {
    match method {
        "imap.list" | "imap.listContinue" => {
            query(p["query"].as_str().unwrap_or(""))?;
        }
        "imap.count" => {
            quote(string(p, "labelId")?)?;
        }
        "imap.messages" => {
            let ids = p["ids"].as_array().ok_or("invalid_params")?;
            if ids.len() > 500 {
                return Err("invalid_params");
            }
            for id in ids {
                message_id(id.as_str().ok_or("invalid_params")?)?;
            }
        }
        "imap.attachment" => {
            message_id(string(p, "messageId")?)?;
            string(p, "attachmentId")?;
        }
        _ => {}
    }
    Ok(())
}
pub(super) async fn call(method: &str, p: &Value) -> Result<Value> {
    if method == "imap.attachment" {
        let mut request = p.clone();
        request["ids"] = json!([string(p, "messageId")?]);
        request["full"] = json!(true);
        request["progressive"] = json!(false);
        let data = messages(&request).await?;
        let message = data["messages"]
            .as_array()
            .and_then(|v| v.first())
            .ok_or("imap_message_missing")?;
        fn part<'a>(payload: &'a Value, id: &str) -> Option<&'a str> {
            if payload["body"]["attachmentId"] == id {
                return payload["body"]["data"].as_str();
            }
            payload["parts"]
                .as_array()?
                .iter()
                .find_map(|p| part(p, id))
        }
        return Ok(
            json!({"data":part(&message["payload"],string(p,"attachmentId")?).ok_or("imap_attachment_missing")?}),
        );
    }
    if method == "imap.messages" {
        return messages(p).await;
    }
    // Refuse malformed query/folder input before any credential-bearing socket.
    if matches!(method, "imap.list" | "imap.listContinue") {
        query(p["query"].as_str().unwrap_or(""))?;
    }
    if method == "imap.count" {
        quote(string(p, "labelId")?)?;
    }
    let (mut w, key) = acquire(p).await?;
    let boxes = mailboxes(&mut w, p).await?;
    let result = match method {
        "imap.folders" => folders_value(&boxes),
        "imap.list" | "imap.listContinue" => list(&mut w, p, &boxes).await?,
        "imap.count" => {
            let id = string(p, "labelId")?;
            let folder = resolve(&boxes, id)?;
            let data = command(
                &mut w,
                &format!("STATUS {} (MESSAGES UNSEEN)", quote(&folder)?),
            )
            .await?;
            let (total, unread) = status(&data)?;
            json!({"id":id,"unread":unread,"total":total,"threadsUnread":unread})
        }
        _ => return Err("method_not_found"),
    };
    if result["warning"]
        .as_str()
        .is_some_and(|warning| !warning.is_empty())
    {
        return Ok(result);
    }
    release(w, key).await;
    Ok(result)
}
#[cfg(test)]
mod tests;
