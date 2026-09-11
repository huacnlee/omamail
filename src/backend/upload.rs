use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

pub const MAX_UPLOAD: usize = 64 * 1024 * 1024;
const CAPACITY: usize = 2 * MAX_UPLOAD;
const CHUNK: usize = 256 * 1024;

struct Upload {
    size: usize,
    bytes: Vec<u8>,
    touched: Instant,
}

#[derive(Default)]
pub struct Uploads {
    entries: HashMap<String, Upload>,
    sequence: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Begin {
    size: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Append {
    upload: String,
    offset: usize,
    data: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Reference {
    upload: String,
}

impl Uploads {
    fn expire(&mut self) {
        self.entries
            .retain(|_, entry| entry.touched.elapsed() < Duration::from_secs(300));
    }

    pub fn call(&mut self, method: &str, params: &Value) -> Result<Value, &'static str> {
        self.expire();
        match method {
            "upload.begin" => {
                let request: Begin =
                    serde_json::from_value(params.clone()).map_err(|_| "invalid_params")?;
                let reserved: usize = self.entries.values().map(|e| e.size).sum();
                if request.size > MAX_UPLOAD
                    || request.size > CAPACITY - reserved
                    || self.entries.len() >= 8
                {
                    return Err("upload_capacity_exceeded");
                }
                self.sequence = self.sequence.checked_add(1).ok_or("upload_id_exhausted")?;
                let mut bytes = Vec::new();
                bytes
                    .try_reserve_exact(request.size)
                    .map_err(|_| "upload_capacity_exceeded")?;
                let id = format!("upload-{}", self.sequence);
                self.entries.insert(
                    id.clone(),
                    Upload {
                        size: request.size,
                        bytes,
                        touched: Instant::now(),
                    },
                );
                Ok(json!({"upload":id,"chunkSize":CHUNK}))
            }
            "upload.append" => {
                let request: Append =
                    serde_json::from_value(params.clone()).map_err(|_| "invalid_params")?;
                if request.data.len() > CHUNK * 4 / 3 + 4 {
                    return Err("upload_chunk_too_large");
                }
                let bytes = URL_SAFE_NO_PAD
                    .decode(&request.data)
                    .map_err(|_| "invalid_upload_encoding")?;
                if bytes.len() > CHUNK {
                    return Err("upload_chunk_too_large");
                }
                let entry = self
                    .entries
                    .get_mut(&request.upload)
                    .ok_or("upload_not_found")?;
                if request.offset != entry.bytes.len() {
                    return Err("upload_offset_mismatch");
                }
                if bytes.len() > entry.size - entry.bytes.len() {
                    return Err("upload_size_exceeded");
                }
                entry.bytes.extend(bytes);
                entry.touched = Instant::now();
                Ok(json!({"offset":entry.bytes.len()}))
            }
            "upload.discard" => {
                let request: Reference =
                    serde_json::from_value(params.clone()).map_err(|_| "invalid_params")?;
                self.entries
                    .remove(&request.upload)
                    .ok_or("upload_not_found")?;
                Ok(json!({"discarded":true}))
            }
            _ => Err("unknown_method"),
        }
    }

    pub fn take(&mut self, params: &Value) -> Result<Vec<u8>, &'static str> {
        self.expire();
        let request: Reference =
            serde_json::from_value(params.clone()).map_err(|_| "invalid_params")?;
        let entry = self
            .entries
            .get(&request.upload)
            .ok_or("upload_not_found")?;
        if entry.bytes.len() != entry.size {
            return Err("upload_incomplete");
        }
        Ok(self.entries.remove(&request.upload).unwrap().bytes)
    }
}
