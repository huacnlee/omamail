# Rust → QML response benchmark

Measured 2026-09-11T17:10:57Z; 31 warm samples per size, five warmups.

| ASCII payload | Request round trip median / p95 (ms) | Response path median / p95 (ms) |
|---|---:|---:|
| 1024 bytes | 0.04 / 0.04 | below timer resolution; use round trip |
| 32768 bytes | 0.32 / 0.38 | below timer resolution; use round trip |
| 262144 bytes | 2.00 / 3.00 | 2.27 / 3.35 |
| 1048576 bytes | 9.00 / 10.00 | 9.27 / 10.03 |
| 10485760 bytes | 103.00 / 108.00 | 103.16 / 108.34 |

Uses the current production Rust JSON writer/chunker extracted at build time, unchanged production Backend.qml and real Quickshell pipes. The synthetic Rust fixture replaces mail/network/storage work; the application and its limits are unchanged. Payload allocation occurs before handshake, but the response path includes cloning the fixture into a response, Rust JSON serialization, pipe writes, QML chunk reassembly, JSON decoding, and callback dispatch. Expected payloads are allocated once in QML and every returned byte is compared after taking the callback timestamp. No UI drawing is measured. Request round trip additionally includes the small outgoing request and fixture dispatch; small batched averages also include validation between operations.

Response-path timing uses same-host SystemTime and QML Date.now, with 1 ms Qt clock resolution; sub-ms one-way results are approximate and clamped at zero. Small payloads use 50 sequential operations per batch for more stable round-trip averages. Payloads are flat ASCII strings, not object-heavy message lists or Unicode-rich documents. Shared desktop scheduling can affect the measurements.

Reproduce: `python3 benchmarks/ipc/run.py`. Raw samples, CPU/runtime versions, lockfile and binary hashes are in results.json. serde_json is pinned to the project lockfile version, with the project lockfile copied before the offline fixture build.
