#!/usr/bin/env python3
"""Decode one mail attachment and keep it, rather than opening it once.

Same two lines on stdin as open-attachment.py — the filename and the data,
both base64 — because they come from the same place and the QML side should
not have to know which of the two it is talking to.

Where it lands is the desktop's own answer, read from the environment and then
from user-dirs.dirs rather than by running xdg-user-dir: the binary belongs to
a package that is not everywhere, and the file it reads is a shell fragment
with two lines worth parsing.

The final path goes to stdout so the panel can say where the file went. A
message that names no location is a message that sends the reader to look.
"""

import base64
import os
from pathlib import Path
import re
import sys


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
    while len(os.fsencode(name)) > 240:
        name = name[:-1]
    return name or "attachment"


def download_directory() -> Path:
    """Where the desktop keeps downloads, or the home directory.

    XDG_DOWNLOAD_DIR wins because a caller that set it meant it. The
    user-dirs.dirs line is quoted and may start with $HOME, which is the whole
    of the parsing this needs.
    """
    from_env = os.environ.get("XDG_DOWNLOAD_DIR", "").strip()
    if from_env:
        return Path(os.path.expandvars(os.path.expanduser(from_env)))

    home = Path(os.environ.get("HOME", "")).expanduser()
    config = os.environ.get("XDG_CONFIG_HOME", "").strip()
    dirs_file = (Path(config) if config else home / ".config") / "user-dirs.dirs"
    try:
        for line in dirs_file.read_text(encoding="utf-8", errors="replace").splitlines():
            match = re.match(r'\s*XDG_DOWNLOAD_DIR\s*=\s*"(.*)"\s*$', line)
            if not match:
                continue
            value = match.group(1).replace("$HOME", str(home))
            if value:
                return Path(value)
    except OSError:
        pass

    # Named rather than tested for, and created by the caller if it is not
    # there yet. Falling back to the home directory when `~/Downloads` happens
    # not to exist put saved mail loose among the dotfiles on a fresh machine,
    # which is worse than making the folder every desktop already expects.
    return home / "Downloads"


def unique_path(directory: Path, filename: str) -> Path:
    """A path nothing is using, without overwriting what is already there.

    Two messages carrying "invoice.pdf" are two invoices, and the second one
    replacing the first is the kind of loss nobody notices until they need the
    file. Numbered the way a browser numbers them, so the suffix stays on the
    end of the stem rather than after the extension.
    """
    target = directory / filename
    if not target.exists():
        return target
    stem = target.stem or "attachment"
    suffix = target.suffix
    for index in range(2, 1000):
        candidate = directory / ("%s (%d)%s" % (stem, index, suffix))
        if not candidate.exists():
            return candidate
    raise OSError("too many files by that name")


def main() -> int:
    filename_line = sys.stdin.buffer.readline()
    data_line = sys.stdin.buffer.readline()
    if not filename_line or not data_line:
        print("The attachment request is incomplete", file=sys.stderr)
        return 2

    try:
        filename = safe_filename(decode(filename_line))
        data = decode(data_line)
    except (ValueError, base64.binascii.Error):
        print("The attachment data is not valid base64", file=sys.stderr)
        return 2

    directory = download_directory()
    try:
        directory.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        print("Could not use %s: %s" % (directory, error), file=sys.stderr)
        return 1

    try:
        target = unique_path(directory, filename)
        # O_EXCL rather than a plain write: `unique_path` asked whether the
        # name was free and something could have taken it since, and a saved
        # attachment must never land on top of a file that was already there.
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as error:
        print("Could not save to %s: %s" % (directory, error), file=sys.stderr)
        return 1

    try:
        with os.fdopen(descriptor, "wb") as attachment:
            attachment.write(data)
    except OSError as error:
        # A half-written file is worse than none: it looks like the attachment
        # and opens as nothing.
        try:
            os.unlink(target)
        except OSError:
            pass
        print("Could not write %s: %s" % (target.name, error), file=sys.stderr)
        return 1

    sys.stdout.write(str(target) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
