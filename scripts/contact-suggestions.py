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


def parse_vcf(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    contacts: list[dict[str, str]] = []
    current_name = ""
    current_emails: list[str] = []
    try:
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if line.startswith("BEGIN:VCARD"):
                current_name = ""
                current_emails = []
            elif line.startswith("FN:") or line.startswith("FN;"):
                current_name = line.split(":", 1)[1].strip()
            elif line.startswith("EMAIL:") or line.startswith("EMAIL;"):
                current_emails.append(line.split(":", 1)[1].strip())
            elif line.startswith("END:VCARD"):
                for em in current_emails:
                    if "@" in em:
                        contacts.append({"name": current_name, "email": em})
    except Exception:
        pass
    return contacts


def omamail_cache_records(cache_dir: Path) -> list[dict[str, str]]:
    if not cache_dir.is_dir():
        return []
    contacts: list[dict[str, str]] = []
    for acc_file in sorted(cache_dir.glob("account-*.json")):
        try:
            data = json.loads(acc_file.read_text(encoding="utf-8", errors="ignore"))
            queries = data.get("queries", {})
            if isinstance(queries, dict):
                for qdata in queries.values():
                    if not isinstance(qdata, dict):
                        continue
                    entries = qdata.get("summaries", []) or qdata.get("messages", [])
                    if isinstance(entries, list):
                        for msg in entries:
                            if not isinstance(msg, dict):
                                continue
                            for f in ("from", "replyTo"):
                                val = msg.get(f)
                                if isinstance(val, dict):
                                    name = val.get("name") or val.get("display") or ""
                                    email = val.get("email") or ""
                                    if "@" in email:
                                        contacts.append({"name": str(name).strip(), "email": str(email).strip()})
                            for f in ("to", "cc", "bcc"):
                                val = msg.get(f)
                                if isinstance(val, list):
                                    for item in val:
                                        if isinstance(item, dict):
                                            name = item.get("name") or item.get("display") or ""
                                            email = item.get("email") or ""
                                            if "@" in email:
                                                contacts.append({"name": str(name).strip(), "email": str(email).strip()})
        except Exception:
            pass
    return contacts


def json_contacts(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    contacts: list[dict[str, str]] = []
    try:
        raw = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, dict) and "email" in item:
                    contacts.append({"name": str(item.get("name") or "").strip(), "email": str(item["email"]).strip()})
        elif isinstance(raw, dict):
            for k, v in raw.items():
                if "@" in k:
                    contacts.append({"name": str(v or "").strip(), "email": k.strip()})
                elif "@" in str(v):
                    contacts.append({"name": k.strip(), "email": str(v).strip()})
    except Exception:
        pass
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
            if "@" not in email or email.startswith("@") or email.endswith("@"):
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
