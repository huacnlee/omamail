#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sources = "\n".join(
    path.read_text(encoding="utf-8")
    for path in sorted((ROOT / "src").glob("notifications*"))
)

for forbidden in (
    "QProcess",
    "system(",
    "popen(",
    "ShellExecute",
    "osascript",
    "notify-send",
):
    assert forbidden not in sources, f"notification adapter invokes a shell/process API: {forbidden}"

print("notification adapters contain no shell/process invocation")
