#!/usr/bin/env python3
"""Every component file must be reachable and consistently named.

A component that nothing instantiates is dead weight; a component named in the
Makefile that does not exist makes `make qml-check` fail with a path error
rather than a useful message.
"""
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent.parent
failures = []

components = sorted(p.name for p in (root / "components").glob("*.qml"))

# Every directory holding QML, so "is this type instantiated anywhere" has the
# whole tree to answer from rather than the two directories that existed first.
QML_DIRS = ("", "account", "cache", "message", "providers", "components")
qml_files = [p for d in QML_DIRS for p in sorted((root / d).glob("*.qml"))]
sources = "\n".join(p.read_text(encoding="utf-8") for p in qml_files)

for name in components:
    stem = name[:-4]
    if not re.search(rf"\b{stem}\s*{{", sources):
        failures.append(f"components/{name} is never instantiated")

makefile = (root / "Makefile").read_text(encoding="utf-8")
for name in components:
    if f"components/{name}" not in makefile:
        failures.append(f"components/{name} is missing from QML_FILES in the Makefile")

for listed in re.findall(r"components/(\w+\.qml)", makefile):
    if listed not in components:
        failures.append(f"Makefile lists components/{listed}, which does not exist")

# The manifest names these three by path, and the shell loads them by it. They
# are the reason the root is not empty.
for entry in ("Service.qml", "BarWidget.qml", "App.qml"):
    if not (root / entry).is_file():
        failures.append(f"{entry} is declared in the manifest but missing")

# Everything else belongs in a directory. A stray .qml at the root is either a
# fourth entry point nobody declared, or a file that was meant to be filed.
for stray in sorted(root.glob("*.qml")):
    if stray.name not in ("Service.qml", "BarWidget.qml", "App.qml"):
        failures.append(f"{stray.name} sits at the root; it belongs in a module directory")

# The Makefile drives qmllint, so a file it does not list is a file nobody
# checks. Components have their own check above; these are the rest.
for path in qml_files:
    listed = path.name if path.parent == root else f"{path.parent.name}/{path.name}"
    if listed.startswith("components/"):
        continue
    if listed not in makefile:
        failures.append(f"{listed} is missing from QML_FILES in the Makefile")

if failures:
    for line in failures:
        print(f"test_qml_names.py: {line}", file=sys.stderr)
    sys.exit(1)

print("test_qml_names.py ok")
