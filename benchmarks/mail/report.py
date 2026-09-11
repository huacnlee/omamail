#!/usr/bin/env python3
"""Render measured results without hiding regressions or unequal work."""
import json
from pathlib import Path
import sys


def render(report):
    lines=['# Mail CPU benchmark results','',
        'CPU-only diagnostic. For measured processing including QML ↔ Rust transport, see [roundtrip-results.md](roundtrip-results.md). These ratios are not application speedups.','',
        f"Measured {report['date']} on {report['machine']['cpu']}.",
        f"{report['versions']['rust']}; Node {report['versions']['node']}; {report['versions']['qml'] or 'Qt not measured'}.",
        f"{report['samples']} warm batch samples per case; five warmups; optimized Rust release.",'',
        report.get('conditions','Shared desktop machine; no exclusive CPU affinity.'),
        f"Load averages (1/5/15 min): before {report['machine']['loadAverageBefore']}; after {report['machine']['loadAverageAfter']}.",
        f"Command wall time: {report.get('commandWallSeconds',0):.3f}s; build: {report.get('buildWallSeconds',0):.3f}s.",'',
        'All times below are microseconds per operation. Ratios above 1 mean Rust was faster.', '',
        '| Case / stage | Qt median / p95 | Rust median / p95 | Node median / p95 | Qt ÷ Rust | Equal output |',
        '|---|---:|---:|---:|---:|---|']
    for row in report['results']:
        def timing(key):
            if key not in row:return '—'
            return f"{row[key]['medianUs']:.2f} / {row[key]['p95Us']:.2f}"
        valid=row['semanticMatch'] and row.get('qmlSemanticMatch',True)
        ratio=f"{row['qmlSpeedup']:.2f}×" if valid and 'qml' in row else '—'
        lines.append(f"| {row['name']} / {row['phase']} | {timing('qml')} | {timing('rust')} | {timing('node')} | {ratio} | {'yes' if valid else 'NO'} |")
    lines+=['','First invocation per case (microseconds; Qt 0 means below its 1 ms timer resolution):','',
        '| Case / stage | Node cold | Qt cold | Rust cold |','|---|---:|---:|---:|']
    for row in report['results']:
        lines.append(f"| {row['name']} / {row['phase']} | {row['node']['coldUs']:.2f} | {row.get('qml',{}).get('coldUs',0):.2f} | {row['rust']['coldUs']:.2f} |")
    lines+=['','Corpus sizes:','','| Case | RFC 822 bytes | HTML UTF-8 bytes |','|---|---:|---:|']
    for case in report['corpus']:lines.append(f"| {case['name']} | {case['bytes']} | {case['htmlBytes']} |")
    lines+=['','Whole-process peak RSS and wall time:','','| Engine | Peak RSS MiB | Process wall seconds |','|---|---:|---:|']
    for engine in ['node','qml','rust']:
        proc=report.get(engine+'Process')
        if proc:lines.append(f"| {engine} | {proc['peakRssKiB']/1024:.2f} | {proc['processWallSeconds']:.2f} |")
    lines+=['','RSS includes the runtime, benchmark harness, all inputs/results, intermediate allocations and GC; it is not incremental parser memory. Core stage timings exclude network, disk, IPC and serialization. Cold calls share a process; they are not independently cold process starts. Qt warm samples use calibrated batches to limit timer quantization.', '',
        'These synthetic CPU measurements do not establish end-to-end inbox latency. See [methodology](README.md) and the accompanying JSON for raw samples, corpus hashes, source/binary hashes and load averages.','']
    return '\n'.join(lines)


if __name__=='__main__':
    path=Path(sys.argv[1])
    path.with_suffix('.md').write_text(render(json.loads(path.read_text())))
