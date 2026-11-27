#!/bin/sh
# The Omarchy plugin entry that existing installs keep after the NSH cutover.
# Omarchy installs a third-party plugin as a git checkout and reads only the
# checkout's top-level manifest.json, so the repository root must hold the
# notice widget's manifest, and its entry must stay inside the checkout.
# No network; python3 runs isolated (-I).
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)

python3 -I - "$ROOT" <<'PY'
import json
import os
import stat
import sys

root = sys.argv[1]
path = os.path.join(root, "manifest.json")


def fail(message):
    sys.exit("test_manifest.sh: " + message)


def no_constants(name):
    fail("manifest.json is not strict JSON (" + name + ")")


with open(path, encoding="utf-8") as f:
    try:
        manifest = json.load(f, parse_constant=no_constants)
    except json.JSONDecodeError as error:
        fail("manifest.json does not parse: %s" % error)

if not isinstance(manifest, dict):
    fail("manifest.json is not an object")
if manifest.get("id") != "omamail":
    fail("id must be omamail, the id existing installs are registered under")
if manifest.get("schemaVersion") != 1:
    fail("schemaVersion must be 1")
if manifest.get("kinds") != ["bar-widget"]:
    fail("kinds must be exactly [\"bar-widget\"]")

entries = manifest.get("entryPoints")
if not isinstance(entries, dict) or list(entries) != ["barWidget"]:
    fail("entryPoints must hold barWidget only")
entry = entries["barWidget"]
if not isinstance(entry, str) or entry == "":
    fail("the barWidget entry must be a path")
if os.path.isabs(entry) or entry.startswith("~") or "\\" in entry:
    fail("the barWidget entry must be relative to the checkout: " + entry)
if ".." in entry.split("/"):
    fail("the barWidget entry must not climb out of the checkout: " + entry)

resolved = os.path.realpath(os.path.join(root, entry))
if os.path.commonpath([resolved, root]) != root:
    fail("the barWidget entry resolves outside the checkout: " + resolved)
if not os.path.exists(resolved) or not stat.S_ISREG(os.stat(resolved).st_mode):
    fail("the barWidget entry is not a regular file: " + resolved)
if os.path.relpath(resolved, root) != os.path.join("omarchy", "notice", "BarWidget.qml"):
    fail("the barWidget entry must be omarchy/notice/BarWidget.qml, not " + entry)

# The widget runs its helper from beside itself (Qt.resolvedUrl).
helper = os.path.join(os.path.dirname(resolved), "omamail-app.sh")
mode = os.stat(helper).st_mode if os.path.exists(helper) else 0
if not stat.S_ISREG(mode) or not mode & stat.S_IXUSR:
    fail("omamail-app.sh next to the entry must be an executable file")
if mode & stat.S_IWOTH:
    fail("omamail-app.sh must not be world-writable")

settings = manifest.get("barWidget", {})
if settings.get("schema") != [] or settings.get("defaults") != {}:
    fail("the notice widget keeps no settings of its own: empty schema and defaults")

print("ok: manifest.json is the notice widget's, at omarchy/notice/BarWidget.qml")
PY
