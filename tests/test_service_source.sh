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
grep -q 'function setAlwaysRenderHeavyMessages' Service.qml \
  || fail "the in-app settings page must be able to change large-message rendering"
grep -q 'alwaysRenderHeavyMessages' App.qml \
  || fail "the reader must receive the persistent large-message preference"
grep -q 'setAlwaysRenderHeavyMessages' components/SettingsPage.qml \
  || fail "the in-app settings page must expose large-message rendering"
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
if "Accounts.find(accountList, id)" not in block:
    raise SystemExit(
        "test_service_source.sh: a stale account switch must be refused before changing state"
    )
same_start = block.index("if (String(id) === activeAccountId)")
same_end = block.index("accountList = Accounts.setActive", same_start)
same_block = block[same_start:same_end]
if "activeIndex = -1" not in same_block or "refreshCurrent()" not in same_block:
    raise SystemExit(
        "test_service_source.sh: switching from a draft to the saved active account must refresh"
    )
if "pendingSendHost" not in text:
    raise SystemExit(
        "test_service_source.sh: undo must remain reachable after account switching"
    )

save_start = text.index("function saveAccounts()")
save_end = text.index("function applyAccounts(raw)", save_start)
save_block = text[save_start:save_end]
if "Accounts.hasSavedAccounts(accountList)" not in save_block:
    raise SystemExit(
        "test_service_source.sh: first-run state must never overwrite saved accounts"
    )

apply_start = save_end
apply_end = text.index("signal accountAdded()", apply_start)
apply_block = text[apply_start:apply_end]
if "accountsLoaded && !Accounts.isSerializedList(raw)" not in apply_block:
    raise SystemExit(
        "test_service_source.sh: a transient account read must not erase the loaded list"
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
if grep -q 'panelOpen' Service.qml; then
  fail "panelOpen is the old name; the window entry point sets windowOpen"
fi

printf 'test_service_source.sh ok\n'
