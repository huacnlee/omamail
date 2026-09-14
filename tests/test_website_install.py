#!/usr/bin/env python3
"""Keep the published standalone commands aligned with repository entry points."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PAGE = (ROOT / "docs/index.html").read_text(encoding="utf-8")

UNIX_INSTALL = (
    "curl -fsSL https://raw.githubusercontent.com/huacnlee/omamail/main/install.sh | sh"
)
WINDOWS_LINES = (
    "$installer = Join-Path $env:TEMP 'omamail-install.ps1'",
    "Invoke-WebRequest https://raw.githubusercontent.com/huacnlee/omamail/main/install.ps1 -OutFile $installer",
    "&amp; $installer",
)

assert (ROOT / "install.sh").is_file(), "website links to a missing Unix installer"
assert (ROOT / "install.ps1").is_file(), "website links to a missing Windows installer"
assert PAGE.count(UNIX_INSTALL) == 2, "macOS and Linux must each show the canonical curl command"
for line in WINDOWS_LINES:
    assert line in PAGE, f"website is missing the Windows installer line: {line}"
assert "TAR.GZ ONLY" in PAGE, "Linux package format is not explicit"
assert "make app-run" in PAGE, "standalone development entry point is missing"
assert "mailto:</code> registration" in PAGE, "standalone capability boundary is missing"

print("Website standalone installation instructions PASS")
