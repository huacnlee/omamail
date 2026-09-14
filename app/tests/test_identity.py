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
# The bare logo is the Linux and Windows window icon. On macOS the plated
# bundle icon is the application icon, and setting a window icon there would
# swap the Dock image for the bare logo while Finder keeps the plate. A run
# outside a bundle takes the same plated icon from the resource.
require(main, '#ifdef Q_OS_MACOS\n    if (!QCoreApplication::applicationDirPath().endsWith(',
        "macOS bundle icon guard")
require(main, 'iconFromIcnsFile(QStringLiteral(\n            ":/omamail/app/resources/macos/omamail.icns"',
        "macOS development icon")
cmake = (APP / "CMakeLists.txt").read_text(encoding="utf-8")
require(cmake, 'resources/macos/omamail.icns"', "macOS icon resource")

# Closing the window is not quitting: Qt must not end the process on its own
# when the last window is hidden, or Cmd+W behaves as Cmd+Q.
require(main, 'application.setQuitOnLastWindowClosed(false);', "host-owned process lifetime")

qml = (APP / "qml/Main.qml").read_text(encoding="utf-8")
require(qml, 'title: "Omamail"', "window title")

with (APP / "resources/macos/Info.plist").open("rb") as stream:
    plist = plistlib.load(stream)
for key in ("CFBundleDisplayName", "CFBundleName"):
    if plist.get(key) != "Omamail":
        raise SystemExit(f"macOS {key} is not Omamail")
if plist.get("CFBundleIconFile") != "omamail.icns":
    raise SystemExit("macOS bundle icon is not omamail.icns")

mac_svg = (APP / "resources/macos/omamail-macos.svg").read_text(encoding="utf-8")
require(mac_svg, 'viewBox="0 0 1024 1024"', "macOS 1024px icon canvas")
# Apple's app-icon grid: an 824pt plate on the 1024pt canvas. A plate that
# fills the canvas sits in the Dock visibly larger than every neighbour.
require(mac_svg, 'x="100" y="100" width="824" height="824" rx="185"',
        "macOS rounded icon plate")
require(mac_svg, 'fill="#1a1b26"', "Omarchy background on the macOS icon")
if '<path' in mac_svg:
    raise SystemExit("macOS icon redraws part of the Omamail logo")
generator = (APP / "resources/icons/generate-native-icons.sh").read_text(encoding="utf-8")
require(generator, 'source_logo="$root/resources/icons/omamail.svg"',
        "canonical native icon logo source")
require(generator, '-density 768 "$source_logo" -resize 596x596 "$work/logo.png"',
        "native icon logo scale")
require(generator, '"$work/plate.png" "$work/logo.png" -gravity center -composite',
        "complete native icon composition")

icns = (APP / "resources/macos/omamail.icns").read_bytes()
if icns[:4] != b"icns" or int.from_bytes(icns[4:8], "big") != len(icns):
    raise SystemExit("macOS Omamail icon is not a complete ICNS file")
chunks = set()
png_dimensions = set()
offset = 8
while offset < len(icns):
    size = int.from_bytes(icns[offset + 4:offset + 8], "big")
    if size < 8 or offset + size > len(icns):
        raise SystemExit("macOS Omamail ICNS has a malformed image chunk")
    chunks.add(icns[offset:offset + 4])
    payload = icns[offset + 8:offset + size]
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        png_dimensions.add((
            int.from_bytes(payload[16:20], "big"),
            int.from_bytes(payload[20:24], "big"),
            payload[25],
        ))
    offset += size
if offset != len(icns) or not {b"ic04", b"ic05", b"ic07", b"ic08", b"ic09", b"ic10"}.issubset(chunks):
    raise SystemExit("macOS Omamail ICNS does not cover 16px through 1024px")
for dimension in (32, 64, 128, 256, 512, 1024):
    if (dimension, dimension, 6) not in png_dimensions:
        raise SystemExit(f"macOS Omamail ICNS lacks a {dimension}px RGBA image")

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
