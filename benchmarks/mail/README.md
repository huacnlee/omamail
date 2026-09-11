# Synthetic mail performance benchmarks

## Processing including QML ↔ Rust transport

The primary comparison is [roundtrip-results.md](roundtrip-results.md): the
previous Qt JavaScript implementation versus the release backend, timed from
QML request to completed callback. It includes parameter encoding, uploads,
Rust processing, response serialization, pipe transfer and QML decoding.

```sh
python3 benchmarks/mail/roundtrip.py
```

The same five synthetic cases and three independent stages are checked for
output equivalence. Each uses five warmups and 31 samples. Inputs start in QML;
network, disk, startup and drawing are excluded. This measures QML-requested
processing, not the provider/cache pipeline that keeps source data in Rust.
Small operations use batches because QML has a millisecond clock. Raw samples,
source/binary hashes and runtime details are in `roundtrip-results.json`.
The archived September 11 run predates recording the current `ui/message`
encoding dependency and independent HTML input hashes. Its raw samples remain
unchanged; subsequent runs record those hashes and the harness as well.
Regressions remain in the table: native CPU improvements do not necessarily
outweigh encoding and transport costs. Do not add synthetic response timings to
CPU measurements to estimate a full operation.

## CPU-only diagnostic

Run from the repository root after builds/tests have stopped:

```sh
python3 benchmarks/mail/run.py --samples 31 --batch 3 --qml
```

The runner builds an optimized, locked Rust example and compares it with an
immutable copy of the former production JavaScript in both Node and Qt's QML
JavaScript engine. `baseline/manifest.json` hashes are verified before each run.
The generated corpus uses only synthetic addresses, bodies and attachments.
It covers a small plain message, a large newsletter, eight nested MIME levels,
a 2 MiB binary attachment and multilingual Unicode. The report records exact
input sizes/hashes, runtime versions, CPU, native source/binary hashes and load.

Stages are independent: `mime` parses RFC 822 into a MIME resource; `html`
sanitizes markup; `readprep` sanitizes and also constructs plain text and the
reader document, including the same body-direction inference used by the reader.
The JS wrapper calls the frozen Direction module for this new metadata field;
the native implementation includes it in preparation. HTML is pre-extracted, so its time excludes MIME parsing.
`--phases mime` or `--phases html readprep` selects specific stages.

Input decoding, process startup, reading the corpus, report serialization and
network/disk access are outside core timing. Each stage records its first call
(`coldUs`), five warmups, then 31 batch samples, with median and nearest-rank p95
per operation. “Cold” means the first invocation for that case, not a fresh
engine/library for each case. Node uses `hrtime.bigint`, Rust uses `Instant`.
Qt uses millisecond `Date.now` and calibrates its batch to at least 20 ms (with
a 2048-operation cap); a zero cold value means below timer resolution. Large
cases are processed sequentially. GC remains part of JS measurements.

Every measured operation must succeed. MIME equivalence compares decoded body
bytes by SHA-256, header names/values, MIME types, names and recursive structure;
attachment locator IDs and unused part IDs are implementation details. HTML
checks all output fields, markup, resource counts, reader/plain output, and
normalized trees retaining text, attributes and child order. Tree caches and
absent default fields are excluded. A mismatch makes the runner fail: timing a
different output is not evidence of a speed improvement.

Peak RSS is measured separately for each complete child process with Linux
`getrusage(RUSAGE_CHILDREN)` in a fresh wrapper. It includes runtime, harness,
inputs, outputs, intermediate allocations and GC. It is neither incremental
parser memory nor a live application memory measurement. Process wall time
includes startup and serialization; it is not the CPU-stage latency.

These measurements describe local CPU work on this corpus. They do not measure
mail-server latency, account synchronization, rendering, IPC or perceived inbox
loading, and do not establish production end-to-end speedups.

The checked-in run was made on a shared active desktop, without exclusive CPU
pinning. Broad builds and tests were paused, but brief unrelated shell tests
overlapped part of the Qt run. It was not a dedicated idle host. The JSON and
rendered report retain the observed before/after load averages; p95 variation
can include scheduling and garbage collection. Use `--conditions` to describe
the environment for subsequent runs rather than claiming stricter isolation.

## 10 MiB attachment case

The existing application limits are unchanged. A 10 MiB decoded attachment
produces about 13.69 MiB of RFC 822 input after base64 transfer encoding, within
the current 16 MiB parser limit. Run this case separately so its process RSS
is not conflated with the original five-case report:

```sh
python3 benchmarks/mail/run.py --attachment-mib 10 --cases large_attachment --phases mime --samples 31 --batch 1 --qml --output benchmarks/mail/results-10m.json
```

The default corpus still uses a 2 MiB attachment. The larger case can use
substantial memory in the frozen JavaScript implementations.
