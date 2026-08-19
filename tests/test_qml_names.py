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
sources = "\n".join(
    p.read_text(encoding="utf-8")
    for p in list(root.glob("*.qml")) + list((root / "components").glob("*.qml"))
)

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

for entry in ("Service.qml", "BarWidget.qml", "App.qml"):
    if not (root / entry).is_file():
        failures.append(f"{entry} is declared in the manifest but missing")

if failures:
    for line in failures:
        print(f"test_qml_names.py: {line}", file=sys.stderr)
    sys.exit(1)

print("test_qml_names.py ok")
