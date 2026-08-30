#!/usr/bin/env python3

import configparser
import json
import os
import sqlite3
from pathlib import Path
from urllib.parse import quote


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


def main() -> None:
    home = Path(os.environ.get("HOME", "")).expanduser()
    # Both desktops' locations, unconditionally: one script serves the shell
    # plugin and the standalone client, and a directory the other platform uses
    # simply is not there. `contacts_host.rs` keeps the pair for the platform it
    # was built for, and a test holds the two lists together.
    roots = [
        home / ".thunderbird",
        home / ".betterbird",
        home / "Library/Thunderbird",
        home / "Library/Betterbird",
    ]
    contacts: dict[str, dict[str, str]] = {}
    for root in roots:
        for profile in profiles(root):
            for database in databases(profile):
                for contact in records(database):
                    contacts.setdefault(contact["email"].lower(), contact)
    result = sorted(
        contacts.values(),
        key=lambda contact: (contact["name"] or contact["email"]).casefold(),
    )
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
