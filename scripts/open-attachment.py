#!/usr/bin/env python3
"""Decode one mail attachment into a private runtime file and open it."""

import base64
import os
from pathlib import Path
import subprocess
import sys
import tempfile

# Beside this file, and shared with save-attachment.py so the name the
# sender chose is made safe by one implementation rather than two.
from attachment_common import decode, safe_filename


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
