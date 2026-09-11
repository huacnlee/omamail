//! Bounded in-process render results. Source and every sanitization option form the key.
//! Only trusted Rust renderer code inserts results; there is deliberately no RPC put.
use serde_json::Value;
use std::collections::VecDeque;
const MAX_BYTES: usize = 64 * 1024 * 1024;
const MAX_PER_ACCOUNT: usize = 12;
const MAX_ENTRIES: usize = 96;
#[derive(Default)]
pub struct RenderCache {
    entries: VecDeque<Entry>,
    bytes: usize,
}
struct Entry {
    account: String,
    id: String,
    source: String,
    options: Value,
    value: Value,
    bytes: usize,
}
impl RenderCache {
    pub fn get(&mut self, account: &str, id: &str, source: &str, options: &Value) -> Option<Value> {
        let at = self.entries.iter().position(|e| {
            e.account == account && e.id == id && e.source == source && e.options == *options
        })?;
        let entry = self.entries.remove(at)?;
        let value = entry.value.clone();
        self.entries.push_back(entry);
        Some(value)
    }
    pub fn put(
        &mut self,
        account: &str,
        id: &str,
        source: &str,
        options: &Value,
        value: Value,
    ) -> Result<(), &'static str> {
        if account.is_empty() || id.is_empty() {
            return Ok(());
        }
        let bytes = source.len()
            + serde_json::to_vec(options)
                .map_err(|_| "cache_invalid_input")?
                .len()
            + serde_json::to_vec(&value)
                .map_err(|_| "cache_invalid_input")?
                .len()
            + account.len()
            + id.len();
        if bytes > MAX_BYTES / 2 {
            return Ok(());
        }
        self.invalidate(account, Some(id));
        while self.entries.iter().filter(|e| e.account == account).count() >= MAX_PER_ACCOUNT {
            if let Some(at) = self.entries.iter().position(|e| e.account == account) {
                self.remove(at);
            }
        }
        while self.bytes + bytes > MAX_BYTES || self.entries.len() >= MAX_ENTRIES {
            self.remove(0);
        }
        self.entries.push_back(Entry {
            account: account.into(),
            id: id.into(),
            source: source.into(),
            options: options.clone(),
            value,
            bytes,
        });
        self.bytes += bytes;
        Ok(())
    }
    fn remove(&mut self, index: usize) {
        if let Some(entry) = self.entries.remove(index) {
            self.bytes = self.bytes.saturating_sub(entry.bytes)
        }
    }
    pub fn invalidate(&mut self, account: &str, id: Option<&str>) {
        for index in (0..self.entries.len()).rev() {
            let entry = &self.entries[index];
            if entry.account == account && id.is_none_or(|id| entry.id == id) {
                self.remove(index);
            }
        }
    }
    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn every_policy_source_and_account_change_is_a_miss() {
        let mut cache = RenderCache::default();
        let options = json!({"allowRemoteImages":false,"remoteImageData":{},"keepColors":false});
        cache
            .put("one", "id", "<img>", &options, json!({"html":"safe"}))
            .unwrap();
        assert!(cache.get("two", "id", "<img>", &options).is_none());
        assert!(cache.get("one", "id", "changed", &options).is_none());
        let changed =
            json!({"allowRemoteImages":true,"remoteImageData":{"x":"approved"},"keepColors":false});
        assert!(cache.get("one", "id", "<img>", &changed).is_none());
        assert_eq!(
            cache.get("one", "id", "<img>", &options).unwrap()["html"],
            "safe"
        );
    }
    #[test]
    fn lru_is_bounded_and_account_invalidation_is_scoped() {
        let mut cache = RenderCache::default();
        for id in 0..12 {
            cache
                .put(
                    "one",
                    &id.to_string(),
                    "source",
                    &json!({}),
                    json!({"html":id}),
                )
                .unwrap();
        }
        cache.get("one", "0", "source", &json!({}));
        cache
            .put("one", "12", "source", &json!({}), json!({}))
            .unwrap();
        assert!(cache.get("one", "1", "source", &json!({})).is_none());
        assert!(cache.get("one", "0", "source", &json!({})).is_some());
        cache
            .put("two", "0", "source", &json!({}), json!({}))
            .unwrap();
        cache.invalidate("one", None);
        assert!(cache.get("two", "0", "source", &json!({})).is_some());
        assert!(cache.bytes <= MAX_BYTES);
    }
    #[test]
    fn oversized_source_is_not_retained() {
        let mut cache = RenderCache::default();
        cache
            .put(
                "one",
                "id",
                &"x".repeat(MAX_BYTES / 2),
                &Value::Null,
                json!({}),
            )
            .unwrap();
        assert!(cache.entries.is_empty());
        assert_eq!(cache.bytes, 0);
    }
}
