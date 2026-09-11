#!/usr/bin/env python3
"""Fail while production UI retains application network transports.

This source gate complements (never replaces) provider runtime/security tests.
Run directly for the repository gate; --self-test tests the detector itself.
Bootstrap release installation, external provisioning, browser links and official
HEY supervision are documented separately in docs/NETWORK-MIGRATION.md.
"""
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
LEGACY = re.compile(
    r"(?:mail-transport\.sh|jmap-transport\.sh|jmap-stream\.py|"
    r"calendar-(?:transport|write|delete)\.sh|image_fetch\.py|unsubscribe\.py)"
)
# Match construction, not explanatory comments mentioning the old API.
XHR = re.compile(r"\bnew\s+XMLHttpRequest\s*\(")
RAW_TOOL = re.compile(r'''["'](?:curl|wget|socat)["']''')
RUST_CURL = re.compile(r'''(?:Command::new|\.arg)\(\s*["'](?:curl|wget)["']''')


def code_lines(source):
    """Drop full-line comments without interpreting URLs as comment markers."""
    block = False
    for number, line in enumerate(source.splitlines(), 1):
        stripped = line.strip()
        if block:
            if "*/" in stripped:
                block = False
            continue
        if stripped.startswith("/*"):
            block = "*/" not in stripped
            continue
        if stripped.startswith("//"):
            continue
        yield number, line


def violations(path, source):
    rules = [(RUST_CURL, "external HTTP process")] if path.suffix == ".rs" else [
        (XHR, "QML XMLHttpRequest"),
        (LEGACY, "legacy application network helper"),
        (RAW_TOOL, "UI network tool"),
    ]
    for number, line in code_lines(source):
        for pattern, reason in rules:
            if pattern.search(line):
                yield f"{path}:{number}: {reason}"


def repository_violations(root):
    for directory, suffixes in (("ui", {".qml", ".js"}), ("src", {".rs"})):
        for path in sorted((root / directory).rglob("*")):
            if not path.is_file() or path.suffix not in suffixes:
                continue
            relative = path.relative_to(root)
            if "tests" in relative.parts or path.name.endswith("_tests.rs"):
                continue
            yield from violations(relative, path.read_text())


class DetectorTests(unittest.TestCase):
    def test_detects_network_constructor(self):
        self.assertEqual(len(list(violations(Path("x.qml"), "var r = new XMLHttpRequest()"))), 1)

    def test_detects_indirect_helper_assignment(self):
        self.assertEqual(len(list(violations(Path("x.qml"), 'property string transport: dir + "/scripts/mail-transport.sh"'))), 1)

    def test_ignores_documentation_and_browser_link(self):
        source = '// new XMLHttpRequest()\n/* curl */\nQt.openUrlExternally("https://example.org")'
        self.assertEqual(list(violations(Path("x.qml"), source)), [])

    def test_detects_native_curl_wrapper(self):
        self.assertEqual(len(list(violations(Path("x.rs"), 'Command::new("curl")'))), 1)


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        unittest.main(argv=[sys.argv[0]])
    else:
        found = list(repository_violations(ROOT))
        if found:
            print("Application network migration remains incomplete:")
            print("\n".join(found))
            sys.exit(1)
        print("No legacy UI application network transports found. Runtime evidence is still required.")
