#!/usr/bin/env python3
"""Keep the standalone application's visible identity consistent on every OS."""

from pathlib import Path
import plistlib


ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "app"


def require(source: str, text: str, description: str) -> None:
    if text not in source:
        raise SystemExit(f"{description} is missing")


main = (APP / "src/main.cpp").read_text(encoding="utf-8")
require(main, 'setApplicationName(QStringLiteral("Omamail"))', "Qt application name")
require(main, 'setWindowIcon(QIcon(QStringLiteral(', "Qt window icon")
require(main, ':/omamail/app/resources/icons/omamail.svg', "Qt Omamail icon resource")

qml = (APP / "qml/Main.qml").read_text(encoding="utf-8")
require(qml, 'title: "Omamail"', "window title")

with (APP / "resources/macos/Info.plist").open("rb") as stream:
    plist = plistlib.load(stream)
for key in ("CFBundleDisplayName", "CFBundleName"):
    if plist.get(key) != "Omamail":
        raise SystemExit(f"macOS {key} is not Omamail")
if plist.get("CFBundleIconFile") != "omamail.icns":
    raise SystemExit("macOS bundle icon is not omamail.icns")

desktop = (APP / "resources/linux/omamail.desktop").read_text(encoding="utf-8")
require("\n" + desktop, "\nName=Omamail\n", "Linux application name")
require("\n" + desktop, "\nIcon=omamail\n", "Linux application icon")

rc = (APP / "resources/windows/omamail.rc.in").read_text(encoding="utf-8")
require(rc, 'ICON "@CMAKE_CURRENT_SOURCE_DIR@/resources/windows/omamail.ico"',
        "Windows executable icon")
for field in ("CompanyName", "FileDescription", "ProductName"):
    require(rc, f'VALUE "{field}", "Omamail\\0"', f"Windows {field}")
icon = (APP / "resources/windows/omamail.ico").read_bytes()
if len(icon) < 4 or icon[:4] != b"\x00\x00\x01\x00":
    raise SystemExit("Windows Omamail icon is not an ICO file")

canonical = (ROOT / "ui/assets/omamail.svg").read_bytes()
standalone = (APP / "resources/icons/omamail.svg").read_bytes()
if standalone != canonical:
    raise SystemExit("standalone icon differs from the Omamail UI logo")
