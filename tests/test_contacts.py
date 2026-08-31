import json
import os
import sqlite3
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "contact-suggestions.py"


def make_book(path: Path, rows: list[tuple[str, str, str]]) -> None:
    database = sqlite3.connect(path)
    database.execute("CREATE TABLE properties (card TEXT, name TEXT, value TEXT)")
    for card, name, value in rows:
        database.execute("INSERT INTO properties VALUES (?, ?, ?)", (card, name, value))
    database.commit()
    database.close()


with tempfile.TemporaryDirectory() as temporary:
    home = Path(temporary)
    profile = home / ".thunderbird" / "Profiles" / "test.default"
    profile.mkdir(parents=True)
    (home / ".thunderbird" / "profiles.ini").write_text(
        "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/test.default\n",
        encoding="utf-8",
    )
    make_book(
        profile / "history.sqlite",
        [
            ("one", "DisplayName", "Jane Doe"),
            ("one", "PrimaryEmail", "jane@example.com"),
            ("two", "PrimaryEmail", "morgan@example.com"),
        ],
    )
    make_book(
        profile / "abook.sqlite",
        [
            ("duplicate", "DisplayName", "Jane Duplicate"),
            ("duplicate", "PrimaryEmail", "JANE@example.com"),
            ("extra", "DisplayName", "Ada Lovelace"),
            ("extra", "PrimaryEmail", "ada@example.com"),
        ],
    )

    # Also create omamail cache and contacts.json
    cache_dir = home / ".cache" / "omamail"
    cache_dir.mkdir(parents=True)
    (cache_dir / "account-test.json").write_text(
        json.dumps({
            "queries": {
                "folder:INBOX|25": {
                    "summaries": [
                        {
                            "from": {"name": "Cached Sender", "email": "sender@cached.org"},
                            "to": [{"name": "Cached Recipient", "email": "to@cached.org"}],
                            "cc": []
                        }
                    ]
                }
            }
        }),
        encoding="utf-8"
    )

    config_dir = home / ".config" / "omamail"
    config_dir.mkdir(parents=True)
    (config_dir / "contacts.json").write_text(
        json.dumps([{"name": "Local Friend", "email": "friend@local.net"}]),
        encoding="utf-8"
    )

    environment = dict(os.environ)
    environment["HOME"] = str(home)
    environment.pop("XDG_CACHE_HOME", None)
    environment.pop("XDG_CONFIG_HOME", None)
    result = subprocess.run(
        [str(SCRIPT)],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )
    contacts = json.loads(result.stdout)
    assert contacts == [
        {"name": "Ada Lovelace", "email": "ada@example.com"},
        {"name": "Cached Recipient", "email": "to@cached.org"},
        {"name": "Cached Sender", "email": "sender@cached.org"},
        {"name": "Jane Doe", "email": "jane@example.com"},
        {"name": "Local Friend", "email": "friend@local.net"},
        {"name": "", "email": "morgan@example.com"},
    ]

print("contact discovery tests passed")
