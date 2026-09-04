"""What both attachment scripts do to a name and to a payload before trusting it.

One copy rather than two. `open-attachment.py` and `save-attachment.py` read
the same two base64 lines from the same caller, and the filename on the first
of them is written by whoever sent the mail. That makes `safe_filename` a
security boundary, and a security boundary that exists twice is one that will
be fixed once.
"""

import base64
import os

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
