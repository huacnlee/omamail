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
grep -q 'function setUndoSendSeconds' Service.qml \
  || fail "the in-app settings page must be able to change the undo window"
grep -q 'shell.updateEntryInline(pluginId, entry)' Service.qml \
  || fail "the undo window must persist in shell settings"
python3 - <<'PY'
from pathlib import Path

text = Path("Service.qml").read_text()
start = text.index("function switchTo(id)")
end = text.index("function switchToIndex(index)", start)
block = text[start:end]
if "sendPending" in block:
    raise SystemExit(
        "test_service_source.sh: a pending send must not block account switching"
    )
if "pendingSendHost" not in text:
    raise SystemExit(
        "test_service_source.sh: undo must remain reachable after account switching"
    )
PY

# Only the ROOT object's required properties matter. The shell constructs that
# object and can satisfy nothing beyond the four it injects, so one it does not
# know about makes the whole plugin fail to instantiate. A delegate deeper in
# the file is a different thing entirely: its required properties are satisfied
# by the model it belongs to.
if grep -qE '^  required property' Service.qml; then
  fail "Service.qml root must not declare required properties: the shell cannot satisfy them"
fi

# MailAccount is constructed by Service, not by the shell, so it is allowed to
# require what it needs — and it needs the plugin directory to find its scripts.
grep -q 'required property string pluginDir' account/MailAccount.qml \
  || fail "MailAccount must require the plugin directory it runs scripts from"

# The window drives this; the unread poll keeps running while it is false.
grep -q 'property bool windowOpen' Service.qml || fail "Service.qml must expose windowOpen"
grep -q 'windowOpen: windowOpen || restoreWindow' Service.qml \
  || fail "a shell restart must persist whether the window was open"
grep -q 'readonly property bool readOnly: !!current && current.readOnly' Service.qml \
  || fail "Service.qml must forward provider-neutral read-only account state"
if grep -q 'panelOpen' Service.qml; then
  fail "panelOpen is the old name; the window entry point sets windowOpen"
fi

printf 'test_service_source.sh ok\n'
