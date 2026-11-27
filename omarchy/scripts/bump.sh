#!/usr/bin/env bash
# Set a new version in every versioned file (nsh.json, manifest.json,
# core/Cargo.toml and the Cargo.lock files) without committing. `make publish`
# runs it on a fresh release branch; CI builds and publishes from there.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ "$#" -eq 1 ] || { echo "bump: usage: omarchy/scripts/bump.sh MAJOR.MINOR.PATCH" >&2; exit 2; }
python3 "$root/omarchy/scripts/release.py" --root "$root" bump "$1"
