# Mail processing including QML ↔ Rust transport

Measured 2026-09-11T17:28:25Z on 13th Gen Intel(R) Core(TM) i7-13700KF; 31 samples, five warmups.

All times below are milliseconds per operation. Ratios above 1 mean the Rust path was faster.

| Case / stage | Previous Qt JS median / p95 | Rust + full RPC median / p95 | Qt / full RPC | Equal output |
|---|---:|---:|---:|---|
| small_plain / mime | 0.033 / 0.059 | 0.188 / 0.281 | 0.18× | yes |
| small_plain / html | 0.008 / 0.008 | 0.094 / 0.125 | 0.08× | yes |
| small_plain / readprep | 0.023 / 0.053 | 0.125 / 0.156 | 0.19× | yes |
| newsletter_html / mime | 107.000 / 173.000 | 99.000 / 107.000 | 1.08× | yes |
| newsletter_html / html | 59.000 / 117.000 | 139.000 / 150.000 | 0.42× | yes |
| newsletter_html / readprep | 128.000 / 166.000 | 154.000 / 164.000 | 0.83× | yes |
| nested_mime / mime | 0.188 / 0.320 | 0.812 / 1.281 | 0.23× | yes |
| nested_mime / html | 0.051 / 0.057 | 0.094 / 0.125 | 0.54× | yes |
| nested_mime / readprep | 0.074 / 0.094 | 0.156 / 0.406 | 0.47× | yes |
| large_attachment / mime | 983.000 / 1021.000 | 724.000 / 822.000 | 1.36× | yes |
| large_attachment / html | 0.008 / 0.009 | 0.094 / 0.094 | 0.08× | yes |
| large_attachment / readprep | 0.021 / 0.023 | 0.156 / 0.250 | 0.14× | yes |
| unicode / mime | 4.625 / 4.750 | 4.125 / 4.625 | 1.12× | yes |
| unicode / html | 0.015 / 0.017 | 0.250 / 0.375 | 0.06× | yes |
| unicode / readprep | 0.469 / 0.484 | 0.625 / 0.750 | 0.75× | yes |

The Rust column is measured directly from the QML call to its completed callback, using the release application backend and unchanged production Backend.qml/Upload.js/Chunks.js/Wire.js. It includes outgoing parameter serialization, JavaScript base64/UTF-8 upload encoding, upload.begin/append round trips where used, Rust dispatch and processing, response serialization/chunking, pipe transfer, QML reassembly/JSON parsing and callback dispatch. It is not the old CPU time plus an estimated transfer constant.

Both paths start with the same input already held in QML. MIME uses Backend.parseMessage; HTML stages use message.render with no cache identity, so a render cache hit cannot replace processing. Each stage is independent: HTML is pre-extracted, and readprep includes sanitization, plain-text extraction and reader-document preparation. Network access, disk reads, application startup, initial corpus decoding, report serialization and UI drawing are excluded. This represents processing requested from QML, not the native-provider/preloaded-cache path that keeps input in Rust.

The same frozen Qt JavaScript baseline is rerun in this process. Cold calls and five warmups precede each engine’s timed samples; Qt JS batches calibrate to at least 20 ms, capped at 2048 operations. Native small requests use fixed batches (32 or 8), large requests use one operation per sample. QML Date.now has 1 ms resolution; small native results are batch averages and include callback bookkeeping between operations. Final outputs are compared by decoded MIME bytes/tree semantics or complete normalized HTML outputs outside timing. The shared desktop and GC can affect results.

Load before: (0.69921875, 1.05810546875, 1.52880859375); after: (1.3193359375, 1.15576171875, 1.513671875). Versions: {'rust': 'rustc 1.98.1 (48a229cea 2026-09-01)', 'qt': 'Qml Runtime 6.11.2', 'quickshell': 'Quickshell 0.3.1 (revision , distributed by Arch Linux)'}.

Reproduce: `python3 benchmarks/mail/roundtrip.py`. Raw samples, corpus/source/binary hashes and versions are in roundtrip-results.json. The separate results.md remains a CPU-only diagnostic, not the headline performance comparison.
