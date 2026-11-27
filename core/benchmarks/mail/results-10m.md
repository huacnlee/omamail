# Mail CPU benchmark results

CPU-only diagnostic. For measured processing including QML ↔ Rust transport, see [roundtrip-results.md](roundtrip-results.md). These ratios are not application speedups.

Measured 2026-09-11T17:04:49Z on 13th Gen Intel(R) Core(TM) i7-13700KF.
rustc 1.98.1 (48a229cea 2026-09-01); Node v26.8.1; Qml Runtime 6.11.2.
31 warm batch samples per case; five warmups; optimized Rust release.

Shared desktop machine; no exclusive CPU affinity or machine isolation.
Load averages (1/5/15 min): before (0.328125, 1.3291015625, 2.20166015625); after (1.39599609375, 1.48095703125, 2.046875).
Command wall time: 274.221s; build: 9.079s.

All times below are microseconds per operation. Ratios above 1 mean Rust was faster.

| Case / stage | Qt median / p95 | Rust median / p95 | Node median / p95 | Qt ÷ Rust | Equal output |
|---|---:|---:|---:|---:|---|
| large_attachment / mime | 4307000.00 / 7198000.00 | 11241.18 / 12662.14 | 1687169.45 / 1744703.22 | 383.14× | yes |

First invocation per case (microseconds; Qt 0 means below its 1 ms timer resolution):

| Case / stage | Node cold | Qt cold | Rust cold |
|---|---:|---:|---:|
| large_attachment / mime | 1826359.83 | 5668000.00 | 14033.36 |

Corpus sizes:

| Case | RFC 822 bytes | HTML UTF-8 bytes |
|---|---:|---:|
| large_attachment | 14349510 | 32 |

Whole-process peak RSS and wall time:

| Engine | Peak RSS MiB | Process wall seconds |
|---|---:|---:|
| node | 1045.21 | 62.97 |
| qml | 15953.99 | 201.08 |
| rust | 133.83 | 0.52 |

RSS includes the runtime, benchmark harness, all inputs/results, intermediate allocations and GC; it is not incremental parser memory. Core stage timings exclude network, disk, IPC and serialization. Cold calls share a process; they are not independently cold process starts. Qt warm samples use calibrated batches to limit timer quantization.

These synthetic CPU measurements do not establish end-to-end inbox latency. See [methodology](README.md) and the accompanying JSON for raw samples, corpus hashes, source/binary hashes and load averages.
