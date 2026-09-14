#!/usr/bin/env python3
"""Keep the published standalone commands aligned with repository entry points."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PAGE = (ROOT / "docs/index.html").read_text(encoding="utf-8")

UNIX_INSTALL = (
    "curl -fsSL https://raw.githubusercontent.com/huacnlee/omamail/main/install.sh | sh"
)
TABS = (
    'role="tab" id="install-tab-macos" aria-controls="install-macos" aria-selected="true"',
    'role="tab" id="install-tab-linux" aria-controls="install-linux" aria-selected="false"',
)
PANELS = (
    'role="tabpanel" id="install-macos" aria-labelledby="install-tab-macos"',
    'role="tabpanel" id="install-linux" aria-labelledby="install-tab-linux" hidden',
)

assert (ROOT / "install.sh").is_file(), "website links to a missing Unix installer"
assert PAGE.count(UNIX_INSTALL) == 2, "macOS and Linux must each show the canonical curl command"
# The site shows macOS and Linux, one at a time behind tabs. Windows has an
# installer in the repository but no published instructions yet.
for tab in TABS:
    assert tab in PAGE, f"website is missing the install tab: {tab}"
for panel in PANELS:
    assert panel in PAGE, f"website is missing the install panel: {panel}"
assert "install.ps1" not in PAGE, "website still shows the Windows installer"
assert "TAR.GZ ONLY" in PAGE, "Linux package format is not explicit"
assert "make app-run" in PAGE, "standalone development entry point is missing"
assert "mailto:</code> registration" in PAGE, "standalone capability boundary is missing"

print("Website standalone installation instructions PASS")
