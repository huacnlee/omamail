#!/usr/bin/env python3
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "attachment_common", ROOT / "scripts" / "attachment_common.py")
attachment = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(attachment)


def refused(name, data, label):
    assert not attachment.openable_attachment(name, data), label


refused("invoice.pdf", b"<!doctype html><script>alert(1)</script>",
        "HTML bytes cannot hide behind a PDF name")
refused("chart.png", b"\xef\xbb\xbf  <SVG xmlns='http://www.w3.org/2000/svg'/>",
        "SVG bytes cannot hide behind a PNG name")
refused("notes.txt", "  <html>hello</html>".encode("utf-16"),
        "UTF-16 HTML must be judged as text")
refused("readme.txt", b"#!/bin/sh\ntouch /tmp/pwned\n",
        "a script cannot hide behind a text name")
refused("manual.pdf", b"MZ\x90\x00program", "a PE program cannot hide behind a PDF name")
refused("manual.pdf", b"\x7fELFprogram", "an ELF program cannot hide behind a PDF name")

assert attachment.openable_attachment("report.pdf", b"%PDF-1.7\ncontent")
assert attachment.openable_attachment("photo.png", b"\x89PNG\r\n\x1a\ncontent")
assert attachment.openable_attachment("notes.txt", b"ordinary text\n")

print("test_attachment_common.py ok")
