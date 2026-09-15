#!/usr/bin/env python3
"""Keep the published standalone commands aligned with repository entry points."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PAGE = (ROOT / "docs/index.html").read_text(encoding="utf-8")
README = (ROOT / "README.md").read_text(encoding="utf-8")
PAGES_WORKFLOW = (ROOT / ".github/workflows/pages.yml").read_text(encoding="utf-8")

# The installers are served from the site, so the commands stay short and the
# repository's branch layout is not part of the public contract.
UNIX_INSTALL = "curl -fsSL https://huacnlee.github.io/omamail/install.sh | sh"
WINDOWS_INSTALL = "irm https://huacnlee.github.io/omamail/install.ps1 | iex"
TABS = (
    'role="tab" id="install-tab-macos" aria-controls="install-macos" aria-selected="true"',
    'role="tab" id="install-tab-linux" aria-controls="install-linux" aria-selected="false"',
    'role="tab" id="install-tab-windows" aria-controls="install-windows" aria-selected="false"',
)
PANELS = (
    'role="tabpanel" id="install-macos" aria-labelledby="install-tab-macos"',
    'role="tabpanel" id="install-linux" aria-labelledby="install-tab-linux" hidden',
    'role="tabpanel" id="install-windows" aria-labelledby="install-tab-windows" hidden',
)

for installer in ("install.sh", "install.ps1"):
    assert (ROOT / installer).is_file(), f"website links to a missing installer: {installer}"
    assert f"cp {installer} _site/{installer}" in PAGES_WORKFLOW, f"the site does not publish {installer}"
    assert f"      - {installer}\n" in PAGES_WORKFLOW, f"a change to {installer} does not redeploy the site"
assert PAGE.count(UNIX_INSTALL) == 2, "macOS and Linux must each show the canonical curl command"
assert PAGE.count(WINDOWS_INSTALL) == 1, "Windows must show the canonical PowerShell command"
assert "raw.githubusercontent.com" not in PAGE, "website still points at the raw repository"
for tab in TABS:
    assert tab in PAGE, f"website is missing the install tab: {tab}"
for panel in PANELS:
    assert panel in PAGE, f"website is missing the install panel: {panel}"
assert 'selectTab(document.getElementById("install-tab-windows"))' in PAGE, "the Windows tab does not open for Windows visitors"
assert "TAR.GZ ONLY" in PAGE, "Linux package format is not explicit"
assert "make app-run" in PAGE, "standalone development entry point is missing"
assert "mailto:</code> registration" in PAGE, "standalone capability boundary is missing"

assert README.count(UNIX_INSTALL) == 1, "README must show the canonical curl command once"
assert README.count(WINDOWS_INSTALL) == 1, "README must show the canonical PowerShell command once"
assert "raw/refs/heads" not in README and "raw.githubusercontent.com" not in README, "README still points at the raw repository"

print("Website standalone installation instructions PASS")
