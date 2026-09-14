#!/usr/bin/env python3
"""Run a Windows Qt test while preserving its otherwise hidden diagnostics."""

from pathlib import Path
import subprocess
import sys
import tempfile


def emit(data: bytes) -> None:
    if data:
        sys.stdout.buffer.write(data)
        if not data.endswith(b"\n"):
            sys.stdout.buffer.write(b"\n")


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: run_native_test.py TEST_EXECUTABLE", file=sys.stderr)
        return 2
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix="omamail-qtest-") as directory:
        report = Path(directory) / "report.txt"
        try:
            completed = subprocess.run(
                [str(executable), "-o", f"{report},txt"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=False,
            )
        except OSError as error:
            print(f"could not start {executable}: {error}", file=sys.stderr)
            return 127
        emit(completed.stdout)
        if report.is_file():
            emit(report.read_bytes())
        print(f"native test exit code: {completed.returncode}")
        return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
