# Mail CPU benchmark results

CPU-only diagnostic. For measured processing including QML ↔ Rust transport, see [roundtrip-results.md](roundtrip-results.md). These ratios are not application speedups.

Measured 2026-09-11T16:43:14Z on 13th Gen Intel(R) Core(TM) i7-13700KF.
rustc 1.98.1 (48a229cea 2026-09-01); Node v26.8.1; Qml Runtime 6.11.2.
31 warm batch samples per case; five warmups; optimized Rust release.

Shared desktop machine, no exclusive CPU affinity. Builds and broad tests were paused; brief isolated shell tests overlapped part of the Qt run. This is not a strictly isolated-machine measurement.
Load averages (1/5/15 min): before [3.06103515625, 2.30712890625, 2.44873046875]; after [3.875, 2.7392578125, 2.5791015625].
Command wall time: 139.915s; build: 25.460s.

All times below are microseconds per operation. Ratios above 1 mean Rust was faster.

| Case / stage | Qt median / p95 | Rust median / p95 | Node median / p95 | Qt ÷ Rust | Equal output |
|---|---:|---:|---:|---:|---|
| small_plain / mime | 39.06 / 66.41 | 5.45 / 6.40 | 18.84 / 26.90 | 7.17× | yes |
| small_plain / html | 7.81 / 16.60 | 2.35 / 2.81 | 5.85 / 17.21 | 3.33× | yes |
| small_plain / readprep | 24.41 / 59.57 | 9.51 / 10.62 | 19.37 / 34.34 | 2.57× | yes |
| newsletter_html / mime | 110000.00 / 226000.00 | 301.52 / 512.64 | 36463.41 / 38212.03 | 364.82× | yes |
| newsletter_html / html | 58000.00 / 101000.00 | 6213.97 / 10220.98 | 29188.77 / 36638.90 | 9.33× | yes |
| newsletter_html / readprep | 141000.00 / 176000.00 | 16565.42 / 21351.81 | 63001.57 / 67865.38 | 8.51× | yes |
| nested_mime / mime | 187.50 / 281.25 | 67.66 / 68.93 | 90.10 / 104.24 | 2.77× | yes |
| nested_mime / html | 48.83 / 109.38 | 5.77 / 6.28 | 27.56 / 28.51 | 8.47× | yes |
| nested_mime / readprep | 78.12 / 218.75 | 15.42 / 15.63 | 44.43 / 48.73 | 5.07× | yes |
| large_attachment / mime | 1040000.00 / 1433000.00 | 1911.96 / 3626.78 | 340209.89 / 386051.10 | 543.94× | yes |
| large_attachment / html | 8.30 / 8.79 | 2.14 / 3.20 | 3.44 / 7.24 | 3.88× | yes |
| large_attachment / readprep | 24.41 / 29.30 | 5.38 / 5.56 | 11.60 / 15.13 | 4.54× | yes |
| unicode / mime | 4000.00 / 26000.00 | 12.33 / 12.70 | 1477.38 / 2119.56 | 324.37× | yes |
| unicode / html | 14.65 / 21.00 | 8.62 / 10.41 | 5.12 / 5.36 | 1.70× | yes |
| unicode / readprep | 500.00 / 593.75 | 95.49 / 97.23 | 212.54 / 220.79 | 5.24× | yes |

First invocation per case (microseconds; Qt 0 means below its 1 ms timer resolution):

| Case / stage | Node cold | Qt cold | Rust cold |
|---|---:|---:|---:|
| small_plain / mime | 473.95 | 0.00 | 42.04 |
| small_plain / html | 555.00 | 1000.00 | 415.98 |
| small_plain / readprep | 774.83 | 0.00 | 317.68 |
| newsletter_html / mime | 44247.24 | 110000.00 | 714.31 |
| newsletter_html / html | 32679.20 | 60000.00 | 7930.60 |
| newsletter_html / readprep | 62629.31 | 115000.00 | 16404.23 |
| nested_mime / mime | 408.96 | 0.00 | 105.81 |
| nested_mime / html | 51.95 | 0.00 | 12.95 |
| nested_mime / readprep | 135.93 | 0.00 | 28.19 |
| large_attachment / mime | 328623.02 | 1411000.00 | 2014.26 |
| large_attachment / html | 30.14 | 0.00 | 12.16 |
| large_attachment / readprep | 44.11 | 0.00 | 15.31 |
| unicode / mime | 1525.02 | 16000.00 | 17.35 |
| unicode / html | 23.84 | 0.00 | 10.09 |
| unicode / readprep | 582.64 | 1000.00 | 108.63 |

Corpus sizes:

| Case | RFC 822 bytes | HTML UTF-8 bytes |
|---|---:|---:|
| small_plain | 346 | 60 |
| newsletter_html | 380279 | 277696 |
| nested_mime | 1949 | 231 |
| large_attachment | 2870362 | 32 |
| unicode | 16694 | 12007 |

Whole-process peak RSS and wall time:

| Engine | Peak RSS MiB | Process wall seconds |
|---|---:|---:|
| node | 650.12 | 47.14 |
| qml | 2921.87 | 64.34 |
| rust | 64.86 | 2.75 |

RSS includes the runtime, benchmark harness, all inputs/results, intermediate allocations and GC; it is not incremental parser memory. Core stage timings exclude network, disk, IPC and serialization. Cold calls share a process; they are not independently cold process starts. Qt warm samples use calibrated batches to limit timer quantization.

These synthetic CPU measurements do not establish end-to-end inbox latency. See [methodology](README.md) and the accompanying JSON for raw samples, corpus hashes, source/binary hashes and load averages.
