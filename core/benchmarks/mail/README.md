# Synthetic mail performance benchmarks

These compare the native Rust message pipeline with a frozen copy of the
former production JavaScript under Node. The Qt-era runners that measured the
QML transport and Qt's JavaScript engine were removed with the Qt interface;
their archived reports went with them. `baseline/ui` stays: the Rust parity
tests in `src/message` load it as their oracle.

## CPU-only diagnostic

Run from `core/` after builds/tests have stopped (Linux: it reads
`/proc/cpuinfo`):

```sh
python3 benchmarks/mail/run.py --samples 31 --batch 3
```

The runner builds an optimized, locked Rust example and compares it with an
immutable copy of the former production JavaScript under Node. `baseline/manifest.json` hashes are verified before each run.
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
Large cases are processed sequentially. GC remains part of JS measurements.

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

The checked-in runs predate the Qt removal and still carry its Qt column. They
were made on a shared active desktop, without exclusive CPU pinning. Broad builds and tests were paused, but brief unrelated shell tests
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
python3 benchmarks/mail/run.py --attachment-mib 10 --cases large_attachment --phases mime --samples 31 --batch 1 --output benchmarks/mail/results-10m.json
```

The default corpus still uses a 2 MiB attachment. The larger case can use
substantial memory in the frozen JavaScript implementations.
