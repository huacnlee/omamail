#!/usr/bin/env python3

import configparser
import json
import os
import re
import sqlite3
from pathlib import Path
from urllib.parse import quote

# The one gate every harvested address passes, because the harvesters below
# read files this program did not write and shapes it did not choose. "@ is
# somewhere in the string" is not that gate: a JSON value stringified by
# accident contains one, and what reached the picker was a whole serialised
# object offered as an address to send mail to.
ADDRESS = re.compile(r"^[^\s@<>,;\"\\]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$")

# A recipient list longer than this is a bulk send rather than a conversation.
# Harvesting one puts fifty strangers who happened to share a mailing with the
# user into the address completion, ahead of the addresses they curated.
MAX_HARVESTED_RECIPIENTS = 5

# The cache holds every query the panel has ever run. This is the ceiling on
# what any one of them may contribute, so a single large mailbox cannot fill
# the picker on its own.
MAX_CACHE_CONTACTS = 2000


def is_address(value: str) -> bool:
    return bool(ADDRESS.match(value))


# `Message.parseAddress` fills a missing display name from the local part
# verbatim, so a sender with no name of its own arrives here calling itself
# "noreply". That is not a name anybody wrote, and offering it as one puts
# `noreply <noreply@example.com>` into a To: field.
#
# Compared exactly rather than case-insensitively, because the fabricated value
# is the local part character for character. "Jane" against jane@example.com is
# a name the sender typed and is kept; "jane" against it is the fallback.
def real_name(name: str, email: str) -> str:
    return "" if name == email.split("@", 1)[0] else name


def profiles(root: Path) -> list[Path]:
    found: list[Path] = []
    registry = root / "profiles.ini"
    if registry.is_file():
        parser = configparser.ConfigParser(interpolation=None)
        try:
            parser.read(registry, encoding="utf-8")
            for section in parser.sections():
                if not section.lower().startswith("profile"):
                    continue
                raw = parser.get(section, "Path", fallback="").strip()
                if not raw:
                    continue
                path = Path(os.path.expandvars(os.path.expanduser(raw)))
                if parser.get(section, "IsRelative", fallback="1") != "0":
                    path = root / path
                found.append(path)
        except (configparser.Error, OSError):
            pass
    if root.is_dir():
        found.extend(path for path in root.iterdir() if path.is_dir())
        profiles_dir = root / "Profiles"
        if profiles_dir.is_dir():
            found.extend(path for path in profiles_dir.iterdir() if path.is_dir())
    return list(dict.fromkeys(path.resolve() for path in found if path.is_dir()))


def databases(profile: Path) -> list[Path]:
    history = sorted(profile.glob("history*.sqlite"))
    address_books = sorted(profile.glob("abook*.sqlite"))
    return [path for path in history + address_books if path.is_file()]


def records(database: Path) -> list[dict[str, str]]:
    uri = "file:" + quote(str(database), safe="/") + "?mode=ro"
    try:
        connection = sqlite3.connect(uri, uri=True, timeout=0.2)
        rows = connection.execute(
            """
            SELECT card,
                   MAX(CASE WHEN name = 'DisplayName' THEN value ELSE '' END),
                   MAX(CASE WHEN name = 'PrimaryEmail' THEN value ELSE '' END),
                   MAX(CASE WHEN name = 'SecondEmail' THEN value ELSE '' END)
              FROM properties
             GROUP BY card
            """
        ).fetchall()
        connection.close()
    except (OSError, sqlite3.Error):
        return []

    contacts: list[dict[str, str]] = []
    for _, name, primary, secondary in rows:
        for email in (primary, secondary):
            email = str(email or "").strip()
            if "@" not in email:
                continue
            contacts.append({"name": str(name or "").strip(), "email": email})
    return contacts


def parse_vcf(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []

    # vCard folds a value past ~75 characters onto a continuation line marked
    # by a leading space or tab. Stripping every line first turns those into
    # unrecognised properties, which truncates long names and long addresses at
    # the fold — and exports from Google Contacts and iOS fold routinely.
    unfolded = re.sub(r"\r?\n[ \t]", "", text)

    contacts: list[dict[str, str]] = []
    current_name = ""
    current_emails: list[str] = []
    for line in unfolded.splitlines():
        line = line.strip()
        # Per line, not per file. One property without a colon used to raise
        # out of the whole loop and silently discard every remaining card.
        try:
            if line.startswith("BEGIN:VCARD"):
                current_name = ""
                current_emails = []
            elif line.startswith("FN:") or line.startswith("FN;"):
                current_name = line.split(":", 1)[1].strip()
            elif line.startswith("EMAIL:") or line.startswith("EMAIL;"):
                current_emails.append(line.split(":", 1)[1].strip())
            elif line.startswith("END:VCARD"):
                for address in current_emails:
                    contacts.append({"name": current_name, "email": address})
                current_name = ""
                current_emails = []
        except IndexError:
            continue
    return contacts


# Everybody the panel has already shown the user, out of the pages it cached.
#
# Bounded on both sides. A recipient list longer than MAX_HARVESTED_RECIPIENTS
# is a bulk send, and every stranger who shared that mailing is not a contact —
# harvesting them buries the addresses the user actually corresponds with under
# a list they never chose. Bcc is left out entirely: in a received message it
# is either empty or the reader's own address.
def omamail_cache_records(cache_dir: Path) -> list[dict[str, str]]:
    if not cache_dir.is_dir():
        return []
    contacts: list[dict[str, str]] = []

    def take(value: object) -> None:
        if not isinstance(value, dict):
            return
        email = str(value.get("email") or "").strip()
        if not is_address(email):
            return
        name = str(value.get("name") or value.get("display") or "").strip()
        contacts.append({"name": real_name(name, email), "email": email})

    for account in sorted(cache_dir.glob("account-*.json")):
        try:
            data = json.loads(account.read_text(encoding="utf-8", errors="ignore"))
        except (OSError, ValueError):
            continue
        queries = data.get("queries", {})
        if not isinstance(queries, dict):
            continue
        for entry in queries.values():
            if not isinstance(entry, dict):
                continue
            rows = entry.get("summaries", []) or entry.get("messages", [])
            if not isinstance(rows, list):
                continue
            for message in rows:
                if not isinstance(message, dict):
                    continue
                if len(contacts) >= MAX_CACHE_CONTACTS:
                    return contacts
                for field in ("from", "replyTo"):
                    take(message.get(field))
                for field in ("to", "cc"):
                    people = message.get(field)
                    if not isinstance(people, list):
                        continue
                    if len(people) > MAX_HARVESTED_RECIPIENTS:
                        continue
                    for person in people:
                        take(person)
    return contacts


# A hand-written address book, in either of the two shapes somebody would
# reasonably write one in: a list of objects, or a mapping.
#
# The mapping branch used to ask whether `str(value)` contained an "@", which
# is true of a stringified list — so the natural wrapper `{"contacts": [...]}`
# produced a contact named "contacts" whose address was the whole serialised
# array, offered in the picker as something to send mail to. Both sides are
# checked as addresses now, and a value that is not a string is not one.
def json_contacts(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except (OSError, ValueError):
        return []

    contacts: list[dict[str, str]] = []
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            email = str(item.get("email") or "").strip()
            if is_address(email):
                contacts.append({"name": str(item.get("name") or "").strip(), "email": email})
    elif isinstance(raw, dict):
        for key, value in raw.items():
            name = value if isinstance(value, str) else ""
            if is_address(str(key).strip()):
                contacts.append({"name": name.strip(), "email": str(key).strip()})
            elif isinstance(value, str) and is_address(value.strip()):
                contacts.append({"name": str(key).strip(), "email": value.strip()})
    return contacts


def main() -> None:
    home = Path(os.environ.get("HOME", "")).expanduser()
    cache_env = os.environ.get("XDG_CACHE_HOME")
    cache_dir = (Path(cache_env) if cache_env else (home / ".cache")) / "omamail"
    config_env = os.environ.get("XDG_CONFIG_HOME")
    config_dir = (Path(config_env) if config_env else (home / ".config")) / "omamail"
    roots = [home / ".thunderbird", home / ".betterbird"]
    contacts: dict[str, dict[str, str]] = {}

    def collect(entries: list[dict[str, str]]) -> None:
        for contact in entries:
            email = str(contact.get("email") or "").strip()
            name = str(contact.get("name") or "").strip()
            if not is_address(email):
                continue
            key = email.lower()
            if key not in contacts or (not contacts[key]["name"] and name):
                contacts[key] = {"name": name, "email": email}

    for root in roots:
        for profile in profiles(root):
            for database in databases(profile):
                collect(records(database))

    collect(omamail_cache_records(cache_dir))
    collect(json_contacts(config_dir / "contacts.json"))
    collect(parse_vcf(config_dir / "contacts.vcf"))

    result = sorted(
        contacts.values(),
        key=lambda contact: (contact["name"] or contact["email"]).casefold(),
    )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
