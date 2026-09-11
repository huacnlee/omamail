"""What both attachment scripts do to a name and to a payload before trusting it.

One copy rather than two. `open-attachment.py` and `save-attachment.py` read
the same two base64 lines from the same caller, and the filename on the first
of them is written by whoever sent the mail. That makes `safe_filename` a
security boundary, and a security boundary that exists twice is one that will
be fixed once.
"""

import base64
import os
import unicodedata

# A name longer than this is refused by ext4 and by every filesystem the app is
# likely to land on, which measures bytes rather than characters.
NAME_LIMIT = 240

# Past this, what follows the last dot is not an extension — it is the rest of
# the name, and there is nothing to preserve by keeping it.
SUFFIX_LIMIT = 32


def decode(value: bytes) -> bytes:
    compact = b"".join(value.split())
    compact += b"=" * (-len(compact) % 4)
    return base64.b64decode(compact, altchars=b"-_", validate=True)


# Opening these hands the desktop a document that can run code or fetch
# further resources. Saving them is still allowed; opening them is not.
OPEN_REFUSED_SUFFIXES = (
    ".html", ".htm", ".xhtml", ".shtml",
    ".svg", ".svgz",
    ".xml",
    ".desktop", ".url", ".lnk",
    ".js", ".mjs", ".cjs",
    ".hta",
    ".exe", ".bat", ".cmd", ".com", ".msi", ".scr",
    ".sh", ".bash", ".zsh",
    ".ps1", ".vbs", ".vbe", ".wsf", ".wsh",
)


def openable_filename(name: str) -> bool:
    normalized = unicodedata.normalize("NFKC", str(name)).replace("\u2024", ".")
    cleaned = "".join(
        character for character in normalized
        if unicodedata.category(character) not in ("Cf", "Cc", "Zl", "Zp")
    )
    lowered = cleaned.rstrip("._ \t").lower()
    return not any(lowered.endswith(suffix) for suffix in OPEN_REFUSED_SUFFIXES)


ACTIVE_BINARY_PREFIXES = (
    b"MZ", b"\x7fELF",
    b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf",
    b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
    b"L\x00\x00\x00\x01\x14\x02\x00",
)

ACTIVE_TEXT_MARKERS = (
    b"<!doctype", b"<html", b"<head", b"<body", b"<script",
    b"<iframe", b"<meta", b"<svg", b"<?xml", b"[desktop entry]",
)


def openable_attachment(name: str, data: bytes) -> bool:
    """Whether neither the sender's name nor the bytes describe active content."""
    if not openable_filename(name):
        return False
    content = bytes(data)
    if content.startswith(ACTIVE_BINARY_PREFIXES):
        return False

    sample = content[:65536]
    if sample.startswith(b"\xef\xbb\xbf"):
        sample = sample[3:]
    elif sample.startswith((b"\xff\xfe", b"\xfe\xff")):
        try:
            sample = sample.decode("utf-16").encode("utf-8")
        except UnicodeError:
            return False
    folded = sample.replace(b"\x00", b"").lstrip().lower()
    if folded.startswith(b"#!"):
        return False
    return not any(marker in folded for marker in ACTIVE_TEXT_MARKERS)


def safe_filename(value: bytes) -> str:
    """The sender's name, with everything that could leave the folder removed.

    Both separators, because a name written on Windows carries backslashes and
    a path is not what a filename may be. Control characters go too: a newline
    in a filename is unreadable in every listing that shows it.
    """
    name = value.decode("utf-8", errors="replace").replace("\\", "/").split("/")[-1]
    name = "".join("_" if ord(character) < 32 or ord(character) == 127 else character
                   for character in name).strip()
    if name in ("", ".", ".."):
        name = "attachment"
    return _within_limit(name) or "attachment"


def _within_limit(name: str) -> str:
    """Short enough for the filesystem, with the extension still on the end.

    Trimming the tail is the obvious way to shorten a name and the wrong one: it
    takes the extension with it, and a saved file that no longer says it is a
    PDF does not open in what opens a PDF. The stem gives up the characters
    instead.
    """
    if len(os.fsencode(name)) <= NAME_LIMIT:
        return name

    stem, dot, extension = name.rpartition(".")
    suffix = dot + extension
    if not stem or len(os.fsencode(suffix)) > SUFFIX_LIMIT:
        stem, suffix = name, ""

    room = NAME_LIMIT - len(os.fsencode(suffix))
    while stem and len(os.fsencode(stem)) > room:
        stem = stem[:-1]
    return stem + suffix
