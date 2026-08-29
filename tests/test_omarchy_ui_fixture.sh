#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
shell_bin="${GPUI_SHELL_BIN:-$project_dir/../gpui-component/target/debug/gpui-shell}"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT

cp -R "$project_dir/app/." "$fixture_dir/"
sed -i 's/"entry": "main.js"/"entry": "omarchy-ui.fixture.js"/' "$fixture_dir/gpui-shell.json"
"$shell_bin" check "$fixture_dir"
