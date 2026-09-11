# Cached reader concurrency: completed QML callbacks

Measured 2026-09-11T18:43:42Z: 7 timed rounds × 16 operations, after one untimed warmup round per level.

| Case | In flight | Operations/s | Throughput / serial | Callback median / p95 ms | Full display checks |
|---|---:|---:|---:|---:|---:|
| small_plain | 1 | 2947.4 | 1.00× | 0.000 / 1.000 | 112 |
| small_plain | 2 | 3862.1 | 1.31× | 0.000 / 1.000 | 112 |
| small_plain | 4 | 7466.7 | 2.53× | 0.000 / 1.000 | 112 |
| small_plain | 8 | 8000.0 | 2.71× | 1.000 / 1.000 | 112 |
| newsletter_html | 1 | 21.7 | 1.00× | 45.000 / 59.000 | 112 |
| newsletter_html | 2 | 27.5 | 1.27× | 69.500 / 90.000 | 112 |
| newsletter_html | 4 | 27.1 | 1.25× | 130.000 / 163.000 | 112 |
| newsletter_html | 8 | 27.3 | 1.26× | 168.500 / 303.000 | 112 |
| nested_mime | 1 | 2947.4 | 1.00× | 0.000 / 1.000 | 112 |
| nested_mime | 2 | 4307.7 | 1.46× | 0.000 / 1.000 | 112 |
| nested_mime | 4 | 5894.7 | 2.00× | 1.000 / 1.000 | 112 |
| nested_mime | 8 | 5600.0 | 1.90× | 1.000 / 2.000 | 112 |
| large_attachment | 1 | 457.1 | 1.00× | 2.000 / 3.000 | 112 |
| large_attachment | 2 | 643.7 | 1.41× | 3.000 / 4.000 | 112 |
| large_attachment | 4 | 674.7 | 1.48× | 5.000 / 8.000 | 112 |
| large_attachment | 8 | 736.8 | 1.61× | 10.000 / 13.000 | 112 |
| unicode | 1 | 2604.7 | 1.00× | 0.000 / 1.000 | 112 |
| unicode | 2 | 3612.9 | 1.39× | 1.000 / 1.000 | 112 |
| unicode | 4 | 4480.0 | 1.72× | 1.000 / 1.000 | 112 |
| unicode | 8 | 3294.1 | 1.26× | 1.500 / 3.000 | 112 |

All measurements use `reader.open(cacheOnly=true)` through unchanged production Backend.qml/Upload.js/Chunks.js/Wire.js and one frozen release backend. Eight distinct message IDs per case are parsed, written to the isolated resource cache, then opened once before measurement to warm the renderer and establish full display references. Each operation still follows the real native cached-reader path. This measures cached resources and a warm renderer; it does not measure cold rendering, live mail networking, image fetching, follow-on model.apply, QML layout, or painting.

Every level completes the same ID sequence and number of operations. IDs are used in groups of eight, with a group finishing before reuse, so simultaneously outstanding calls address different messages. The concurrency limit changes; input size, account, fixed clock, image policy and binary do not. Levels run in fixed 1/2/4/8 order on a shared desktop. Throughput is total operations divided by total round time; ratios use the same case at concurrency 1. Per-callback latency starts immediately before reader.open and ends at its completed QML callback, including queueing, disk/cache work, native preparation, serialization and transport/QML decoding. p95 is across individual callbacks, not batch-average latencies.

Every timed reply is checked for the requested ID immediately, then its complete display projection is compared with its per-ID reference after all calls in the round finish. Only opaque readerKey is excluded; summary, body, attachments, rendered documents, render policy/revision and calendar payload are compared exactly. No result is sampled or skipped. Untimed parity checks hold at most one bounded round of reply references, which can influence allocation/GC; that retention is identical at each concurrency level. Reference JSON strings remain in memory. Resource seeding, reference construction and parity serialization are excluded from the timers.

Date.now has 1 ms resolution, limiting sub-millisecond comparisons; a reported 0 ms means below that resolution, not zero latency. The small number of rounds characterizes this run, not a confidence interval or a guarantee under another workload. Throughput flattening and increased callback latency can expose a shared processing/serialization bottleneck; these numbers alone do not identify a particular mutex or prove mail-network concurrency.

CPU: 13th Gen Intel(R) Core(TM) i7-13700KF; load before/after: (3.17578125, 2.11572265625, 1.970703125) / (2.69384765625, 2.14404296875, 1.98828125). Versions: {'qt': 'Qml Runtime 6.11.2', 'quickshell': 'Quickshell 0.3.1 (revision , distributed by Arch Linux)'}.

The executable and QML modules are copied and hashed before running. Source hashes describe the checkout snapshot, not attestation that an externally supplied binary was built from it. Raw round durations, every callback latency, peak concurrency and parity counts are in the adjacent JSON.

Reproduce: `python3 benchmarks/mail/reader_concurrency.py --binary target/release/omamail`. Smoke: add `--rounds 3 --cases small_plain newsletter_html --output /tmp/reader-concurrency-smoke.json`.
