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

    environment = dict(os.environ)
    environment["HOME"] = str(home)
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
        {"name": "Jane Doe", "email": "jane@example.com"},
        {"name": "", "email": "morgan@example.com"},
    ]

print("contact discovery tests passed")
