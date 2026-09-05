"""No malformed config field may start curl, even late in an IMAP batch."""
import base64
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def encoded(value):
    return base64.b64encode(value).decode()


with tempfile.TemporaryDirectory(prefix="omamail-config-test-") as directory:
    work = Path(directory)
    marker = work / "called"
    arguments = work / "arguments"
    stub = work / "curl"
    stub.write_text('#!/bin/sh\nprintf called > "$CURL_MARKER"\nprintf "%s\\n" "$@" > "$CURL_ARGUMENTS"\ncat >/dev/null\n')
    stub.chmod(0o700)
    env = dict(os.environ, PATH=str(work) + os.pathsep + os.environ["PATH"],
               CURL_MARKER=str(marker), CURL_ARGUMENTS=str(arguments))
    cases = [
        ("calendar-transport.sh", [], [b"https://example.com/dav", b"user:secret", b"<query/>"], [0, 1, 2]),
        ("calendar-write.sh", [], [b"https://example.com/dav", b"user:secret", b"BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"], [0, 1]),
        ("calendar-delete.sh", [], [b"https://example.com/dav", b"user:secret"], [0, 1]),
        ("mail-transport.sh", ["imap"], [b"imaps://example.com/INBOX", b"user:secret", b"NOOP", b"UID SEARCH ALL"], [0, 1, 2, 3]),
        ("mail-transport.sh", ["imap-id"], [b"imaps://example.com/", b"imaps://example.com/INBOX", b"user:secret", b"ID NIL", b"NOOP"], [0, 1, 2, 3, 4]),
        ("mail-transport.sh", ["smtp"], [b"smtps://example.com/", b"user:secret", b"sender@example.com", b"Subject: Hello\r\n\r\nBody\r\n", b"to@example.com", b"next@example.com"], [0, 1, 2, 4, 5]),
        ("mail-transport.sh", ["imap-append"], [b"imaps://example.com/Drafts", b"user:secret", b"Subject: Draft\r\n\r\nBody\r\n"], [0, 1]),
    ]
    count = 0
    for script, prefix, fields, protected in cases:
        # Valid multiline upload bodies are deliberately exempt from config
        # validation. Quotes, backslashes and Unicode remain valid field data.
        valid = list(fields)
        if b"user:secret" in valid:
            valid[valid.index(b"user:secret")] = 'user:p"a\\ss中文'.encode()
        marker.unlink(missing_ok=True)
        subprocess.run(["sh", str(ROOT / "scripts" / script)],
                       input=" ".join(prefix + [encoded(value) for value in valid]) + "\n",
                       text=True, capture_output=True, env=env, timeout=5)
        assert marker.exists(), (script, prefix, "valid input rejected")
        assert arguments.read_text().splitlines()[:2] == ["-q", "--globoff"]
        for index in protected:
            # Tail newlines must be checked before command substitution loses them.
            for suffix in [b"\nurl = https://127.0.0.1/\n#", b"\rnext\r#", b"\r\nnext\r\n#", b"\n", b"\r", b"\x00hidden", b"\t", b"\x7f", None]:
                request = [encoded(value) for value in fields]
                request[index] = encoded(fields[index] + suffix) if suffix is not None else "%%%"
                marker.unlink(missing_ok=True)
                result = subprocess.run(["sh", str(ROOT / "scripts" / script)],
                                        input=" ".join(prefix + request) + "\n",
                                        text=True, capture_output=True, env=env, timeout=5)
                assert result.returncode != 0, (script, index, suffix, "accepted")
                assert not marker.exists(), (script, index, suffix, "started curl")
                assert "user:secret" not in result.stdout + result.stderr
                count += 1
    print(f"curl config: {count} hostile fields rejected before curl starts")
