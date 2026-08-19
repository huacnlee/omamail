#!/usr/bin/env bash
# The shell constructs a service plugin itself and injects only four
# properties. A `required property` the shell does not know about makes the
# whole plugin fail to instantiate, with the reason buried in a console warning.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() { printf 'test_service_source.sh: %s\n' "$1" >&2; exit 1; }

grep -q 'property var shell' Service.qml || fail "Service.qml must accept an injected shell"
grep -q 'property var manifest' Service.qml || fail "Service.qml must accept an injected manifest"
grep -q '__sourceDir' Service.qml || fail "pluginDir must come from manifest.__sourceDir"
grep -q 'function applySettings' Service.qml || fail "the bar widget pushes settings in via applySettings"

if grep -qE '^\s*required property' Service.qml; then
  fail "Service.qml must not declare required properties: the shell cannot satisfy them"
fi

# The window drives this; the unread poll keeps running while it is false.
grep -q 'property bool windowOpen' Service.qml || fail "Service.qml must expose windowOpen"
if grep -q 'panelOpen' Service.qml; then
  fail "panelOpen is the old name; the window entry point sets windowOpen"
fi

printf 'test_service_source.sh ok\n'
