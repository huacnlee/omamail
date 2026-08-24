#!/usr/bin/env python3
"""Decode one mail attachment into a private runtime file and open it."""

import base64
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def decode(value: bytes) -> bytes:
    compact = b"".join(value.split())
    compact += b"=" * (-len(compact) % 4)
    return base64.b64decode(compact, altchars=b"-_", validate=True)


def safe_filename(value: bytes) -> str:
    name = value.decode("utf-8", errors="replace").replace("\\", "/").split("/")[-1]
    name = "".join("_" if ord(character) < 32 or ord(character) == 127 else character
                   for character in name).strip()
    if name in ("", ".", ".."):
        name = "attachment"
    while len(os.fsencode(name)) > 240:
        name = name[:-1]
    return name or "attachment"


def runtime_directory() -> str | None:
    candidate = os.environ.get("XDG_RUNTIME_DIR", "")
    if candidate and os.path.isdir(candidate) and os.access(candidate, os.W_OK):
        return candidate
    return None


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

    directory = tempfile.mkdtemp(prefix="omamail-attachment-", dir=runtime_directory())
    os.chmod(directory, 0o700)
    target = Path(directory, filename)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as attachment:
        attachment.write(data)

    try:
        subprocess.Popen(
            ["xdg-open", str(target)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
    except OSError as error:
        print("Could not start xdg-open: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
