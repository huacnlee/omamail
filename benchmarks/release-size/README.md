# Release size experiment

Measured locally on Linux x86_64 with Rust 1.98.1. All binaries are v0.9.0,
with full LTO, one codegen unit, stripped symbols, and panic unwinding retained.
The binaries use the local GNU target; these are not the published static musl sizes.

| Profile | Executable bytes | gzip bytes | Newsletter reader median / p95 (ms) |
| --- | ---: | ---: | ---: |
| Speed: opt-level 3 | 12,372,520 | 5,803,376 | 31 / 37 |
| Size: opt-level s (selected) | 8,706,696 | 4,202,922 | 33 / 40 |
| Mixed: dependencies s, omamail 3 | 12,178,280 | 5,153,019 | 33 / 37 |

The selected profile reduces executable size by 29.6% and gzip size by 27.6%.
It trades 2 ms in the observed newsletter median for smaller downloads; this
small sequential local experiment does not establish a general performance bound.
Gzip sizes use Python gzip level 9 on the executable, not the release tar archive.

Reader measurements use the unchanged production QML bridge, including transport,
with 15 samples after five warmups. Both newsletter HTML and nested MIME display
projections passed parity checks. See the adjacent raw reports for samples,
first-call timings, machine details and binary hashes. Network and UI painting
are excluded. Build jobs were idle during measurements.

Reproduce each profile with `cargo build --release --locked --bin omamail`, freeze
the resulting executable, then run:

```sh
python3 benchmarks/mail/reader_pipeline.py --binary /path/to/frozen/omamail \
  --samples 15 --cases newsletter_html nested_mime --output /tmp/profile.json
```

Use `--before /tmp/speed.json` for subsequent profiles to verify output parity.
Do not use panic=abort: outbox delivery catches panics to preserve failure recovery.
