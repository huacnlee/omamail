//! In-memory benchmark seam. Input/output serialization is outside timed work.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::{hint::black_box, io::Read, time::Instant};
fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap();
    let input: Value = serde_json::from_str(&input).unwrap();
    let mut rows = Vec::new();
    for item in input["cases"].as_array().unwrap() {
        let raw = URL_SAFE_NO_PAD
            .decode(item["raw"].as_str().unwrap())
            .unwrap();
        for phase in input["phases"].as_array().unwrap() {
            let operation = || -> Result<Value, &'static str> {
                match phase.as_str().unwrap() {
                    "mime" => omamail::message::parse(black_box(&raw)),
                    "html" => omamail::message::html::sanitize(
                        black_box(item["html"].as_str().unwrap()),
                        &json!({}),
                    ),
                    "readprep" => omamail::message::html::sanitize(
                        black_box(item["html"].as_str().unwrap()),
                        &json!({"withPlainText":true,"withReader":true}),
                    ),
                    _ => Err("unsupported_benchmark_phase"),
                }
            };
            let start = Instant::now();
            let mut result = operation().expect("benchmark operation failed");
            let cold = start.elapsed().as_secs_f64() * 1e6;
            for _ in 0..5 {
                result = black_box(operation().expect("benchmark operation failed"));
            }
            let mut samples = Vec::new();
            let batch = input["batch"].as_u64().unwrap();
            for _ in 0..input["samples"].as_u64().unwrap() {
                let start = Instant::now();
                for _ in 0..batch {
                    result = black_box(operation().expect("benchmark operation failed"));
                }
                samples.push(start.elapsed().as_secs_f64() * 1e6 / batch as f64);
            }
            rows.push(json!({"name":item["name"],"phase":phase,"coldUs":cold,"samplesUs":samples,"result":result}));
        }
    }
    println!("{}", json!({"engine":"Rust release","cases":rows}));
}
