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


# --------------------------------------------------------------- the readers
#
# These read files this program did not write, so each one is checked against
# the shape somebody would plausibly produce rather than only the shape the
# happy path above builds.

import importlib.util

spec = importlib.util.spec_from_file_location("contact_suggestions", SCRIPT)
harvester = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harvester)

with tempfile.TemporaryDirectory() as temporary:
    scratch = Path(temporary)

    # A wrapped address book. Asking whether str(value) contains an "@" is true
    # of a stringified list, and what came out was a contact named "contacts"
    # whose address was the whole serialised array.
    wrapped = scratch / "wrapped.json"
    wrapped.write_text(
        json.dumps({"contacts": [{"name": "A", "email": "a@example.com"}]}),
        encoding="utf-8",
    )
    assert harvester.json_contacts(wrapped) == [], harvester.json_contacts(wrapped)

    # The two shapes that are an address book.
    listed = scratch / "listed.json"
    listed.write_text(
        json.dumps([{"name": "Ada", "email": "ada@example.com"},
                    {"name": "Bad", "email": "not an address"}]),
        encoding="utf-8",
    )
    assert harvester.json_contacts(listed) == [{"name": "Ada", "email": "ada@example.com"}]

    mapped = scratch / "mapped.json"
    mapped.write_text(
        json.dumps({"grace@example.com": "Grace", "Alan": "alan@example.com"}),
        encoding="utf-8",
    )
    assert sorted(harvester.json_contacts(mapped), key=lambda row: row["email"]) == [
        {"name": "Alan", "email": "alan@example.com"},
        {"name": "Grace", "email": "grace@example.com"},
    ]

    # A folded vCard, and a malformed property after it. The fold has to be
    # rejoined before the value is read, and the bad line must not take the
    # cards that follow it with it.
    folded = scratch / "book.vcf"
    folded.write_text(
        "BEGIN:VCARD\r\n"
        "FN:Wilhelmina Fitzgerald-Montmorency the Th\r\n ird\r\n"
        "EMAIL:wilhelmina@example.com\r\n"
        "END:VCARD\r\n"
        "BEGIN:VCARD\r\n"
        "MALFORMED-LINE-WITHOUT-A-COLON\r\n"
        "FN:Second Card\r\n"
        "EMAIL:second@example.com\r\n"
        "END:VCARD\r\n",
        encoding="utf-8",
    )
    assert harvester.parse_vcf(folded) == [
        {"name": "Wilhelmina Fitzgerald-Montmorency the Third",
         "email": "wilhelmina@example.com"},
        {"name": "Second Card", "email": "second@example.com"},
    ], harvester.parse_vcf(folded)

    # A bulk send is not a room full of the user's contacts, and a display name
    # the parser filled in from the local part is not a name anybody wrote.
    cache = scratch / "cache"
    cache.mkdir()
    bulk = [{"name": "P%d" % i, "email": "p%d@example.com" % i} for i in range(20)]
    (cache / "account-x.json").write_text(
        json.dumps({"queries": {"q": {"summaries": [
            {"from": {"name": "noreply", "email": "noreply@example.com"},
             "to": bulk, "cc": [], "bcc": [{"name": "B", "email": "b@example.com"}]},
            {"from": {"name": "Jane Doe", "email": "jane@example.com"},
             "to": [{"name": "Me", "email": "me@example.com"}]},
        ]}}}),
        encoding="utf-8",
    )
    harvested = harvester.omamail_cache_records(cache)
    addresses = sorted(row["email"] for row in harvested)
    assert addresses == ["jane@example.com", "me@example.com", "noreply@example.com"], addresses
    by_email = {row["email"]: row["name"] for row in harvested}
    assert by_email["noreply@example.com"] == ""
    assert by_email["jane@example.com"] == "Jane Doe"

print("contact discovery tests passed")
