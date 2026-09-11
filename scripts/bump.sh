#!/usr/bin/env bash
# Prepare release metadata locally. Publication and pin advancement belong to CI.
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
version="${1-}"
python3 - "$version" <<'PY'
from pathlib import Path
import importlib.util
import re
import sys
spec = importlib.util.spec_from_file_location("release", "scripts/package-backend.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
version = sys.argv[1]
if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
    raise SystemExit("bump: usage: scripts/bump.sh MAJOR.MINOR.PATCH")
current = release.check(Path("."))
if tuple(map(int, version.split("."))) <= tuple(map(int, current.split("."))):
    raise SystemExit("bump: the new version must be newer than " + current)
patterns = {
    "manifest.json": r'("version"\s*:\s*")[^"]+(")',
    "Cargo.toml": r'(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")',
    "Cargo.lock": r'(^\[\[package\]\]\nname = "omamail"\nversion = ")[^"]+(")',
}
prepared = {}
for name, pattern in patterns.items():
    text, count = re.subn(pattern, lambda m: m[1] + version + m[2], Path(name).read_text(), flags=re.MULTILINE)
    if count != 1:
        raise SystemExit("bump: expected one version record in " + name)
    prepared[name] = text
for name, text in prepared.items():
    Path(name).write_text(text)
print("Prepared " + version + "; backend-version remains on the published runtime.")
print("Review, test, commit and push this branch; dispatch Release on that branch.")
print("CI publishes and verifies both assets before making a pin-only commit.")
PY
