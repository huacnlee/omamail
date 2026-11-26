# Cached reader ID → completed QML display callback

Measured 2026-09-11T18:27:02Z; 31 samples after five warmups. Milliseconds per operation.

| Case | Full-resource bridge median / p95 | Prepared-cache bridge median / p95 | Native reader median / p95 | Prepared / native | Equal display |
|---|---:|---:|---:|---:|---|
| small_plain | 0.375 / 0.438 | 0.312 / 0.562 | 0.250 / 0.312 | 1.25× | yes |
| newsletter_html | 336.000 / 376.000 | 176.000 / 185.000 | 53.000 / 57.000 | 3.32× | yes |
| nested_mime | 0.625 / 0.875 | 0.438 / 0.812 | 0.375 / 0.625 | 1.17× | yes |
| large_attachment | 1223.000 / 1302.000 | 2.000 / 2.000 | 2.000 / 3.000 | 1.00× | yes |
| unicode | 1.062 / 1.250 | 0.375 / 0.562 | 0.500 / 0.625 | 0.75× | yes |

First call per case (empty in-process render cache; filesystem cache warmed by seeding):

| Case | Full-resource bridge ms | Prepared-cache bridge ms | Native reader ms |
|---|---:|---:|---:|
| small_plain | 6.000 | 6.000 | 7.000 |
| newsletter_html | 397.000 | 205.000 | 87.000 |
| nested_mime | 1.000 | 0.000 | 1.000 |
| large_attachment | 1203.000 | 2.000 | 2.000 |
| unicode | 2.000 | 0.000 | 1.000 |

Logical JSON payload totals per operation, request + response, measured separately from timing:

| Case | Full-resource bridge bytes | Prepared-cache bridge bytes | Native reader bytes |
|---|---:|---:|---:|
| small_plain | 2949 | 2893 | 2803 |
| newsletter_html | 2859637 | 2119201 | 1546906 |
| nested_mime | 10231 | 6475 | 3042 |
| large_attachment | 5596469 | 3543 | 2893 |
| unicode | 46724 | 14803 | 14715 |

These are three arrangements of the **same Rust release executable** and production QML transport. Full-resource bridge: `cache.resourceRead → message.prepare → message.render`. Prepared-cache bridge (the previous optimized cache path): `message.prepareCached → message.render`. Native reader: `reader.open(cacheOnly=true)`. This is not a comparison against the original JavaScript application, a network benchmark, or UI painting latency.

All paths start with the same synthetic account ID and message ID, read the same persisted resource, and end when equivalent prepared display data reaches the completed QML callback. Timers include disk reads, JSON serialization, UTF-8/base64 uploads where needed, RPC dispatch, preparation/rendering, response chunking/reassembly and callback dispatch. Resource parsing/seeding, process startup, follow-on model.apply calls, QML layout/painting, remote-image fetching, output comparison and diagnostic byte counting are outside timing. This is callback completion, not click-to-photon latency. There are no real accounts, network reads, remote-image loads or AI requests.

Each engine starts in a fresh process, so its first call for each case has an empty in-process render cache. Resource seeding warms the OS filesystem cache: **coldUs is not cold-device I/O**. Five further calls warm the engine; the table measures repeated reads with a warm render cache and unchanged image policy. Render-cache bypass/forced-cold timings and image-policy-changing rerenders are not measured. Small cases use batches of 16 sequential operations with the same batch size for all engines; large cases use one. Date.now has 1 ms resolution; p95 is across per-batch averages, not individual-call tail latency. Engines run sequentially on a shared desktop; order, scheduling and GC can influence results.

Display parity compares summary, decoded body/direction, attachment descriptors and the complete normalized rendered document/reader tree and policy fields. Opaque reader keys, render revision identity metadata and duplicated serialized HTML are excluded; HTML tree nodes, attributes and text are compared. Logical JSON payload byte counts come from one extra untimed operation and exclude JSON-RPC envelopes, base64 expansion, chunk framing and protocol overhead; they are not physical pipe-byte measurements.

Build provenance: Built from fc8b41f plus the src/agent/jobs.rs and src/agent/storage.rs compatibility fixes, before reader optimizations; parent-recorded provenance, frozen binary SHA256 independently verified. Checkout source hashes were captured later.. CPU: 13th Gen Intel(R) Core(TM) i7-13700KF. Load before/after: (1.65380859375, 3.17578125, 2.517578125) / (1.6826171875, 2.84716796875, 2.4560546875). Versions: {'rust': 'rustc 1.98.1 (48a229cea 2026-09-01)', 'qt': 'Qml Runtime 6.11.2', 'quickshell': 'Quickshell 0.3.1 (revision , distributed by Arch Linux)'}.

The executable and QML modules are copied before the run and hashed; later builds cannot replace the executable being measured. With --binary, source hashes describe the checkout snapshot rather than proving that the supplied executable was built from it. Raw samples, cold calls, logical payload counts, corpus hashes, source hashes and parity digests are in the adjacent JSON file.

Reproduce: `python3 benchmarks/mail/reader_pipeline.py`. Use `--samples 3 --output /tmp/reader-smoke.json` for a smoke test.
