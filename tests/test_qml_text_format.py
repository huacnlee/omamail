#!/usr/bin/env python3
"""Every Text that shows something a stranger wrote must say it is plain.

Qt's default is Text.AutoText, which runs Qt.mightBeRichText() over the string
and switches to the rich text engine when it finds something tag-shaped. That
engine fetches <img src="https://..."> for real — so a subject line, a sender
name, or a snippet carrying one becomes exactly the tracking beacon the message
body is stripped of, without the body ever being opened.

The reader's own TextEdit is the one deliberate exception: it renders a
document that Html.sanitize has already been through.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# What a message, an account or Google can put words into.
UNTRUSTED = re.compile(
    r"\b(summary\s*\.|\.subject\b|\.snippet\b|\.from\b|\.display\b|\.email\b"
    r"|modelData\s*\.\s*filename\b|formatAddressList\b|lastError\b"
    r"|root\s*\.\s*requested\b|subjectField\s*\.\s*text\b)")

STRING = re.compile(r'"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'')
ELEMENT = re.compile(r"\b(Text|Label)\s*\{")


def blocks(source):
    """Every Text/Label element body, as (name, text) pairs."""
    masked = STRING.sub(lambda m: " " * len(m.group(0)), source)
    for opening in ELEMENT.finditer(masked):
        start = opening.end()
        depth = 1
        index = start
        while index < len(masked) and depth:
            if masked[index] == "{":
                depth += 1
            elif masked[index] == "}":
                depth -= 1
            index += 1
        yield opening.group(1), source[start:index - 1]


def main():
    failures = []
    files = [
        p
        for d in ("", "account", "cache", "message", "providers", "components")
        for p in sorted((ROOT / d).glob("*.qml"))
    ]
    for path in files:
        source = path.read_text(encoding="utf-8")
        for name, body in blocks(source):
            binding = re.search(r"^\s*text\s*:(.*?)(?=^\s*[\w.]+\s*:|\Z)",
                                body, re.S | re.M)
            if not binding or not UNTRUSTED.search(binding.group(1)):
                continue
            if "textFormat" not in body:
                excerpt = " ".join(binding.group(1).split())[:60]
                failures.append("%s: %s { text: %s } needs textFormat: Text.PlainText"
                                % (path.relative_to(ROOT), name, excerpt))
    if failures:
        for line in failures:
            print("test_qml_text_format.py: " + line, file=sys.stderr)
        return 1
    print("test_qml_text_format.py ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
