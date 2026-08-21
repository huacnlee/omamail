#!/usr/bin/env bash
# Two rules that are easy to break by accident and invisible until someone
# switches to a light theme or the QML engine chokes on modern syntax.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() { printf 'test_source.sh: %s\n' "$1" >&2; exit 1; }

# Found rather than globbed: the layout groups by module, and a module with no
# QML in it (message/, today) turns a literal glob into a grep error that hides
# whatever the check was meant to say.
#
# A read loop rather than `mapfile`, which is bash 4 and absent from the bash
# 3.2 that macOS still ships — a check that only runs on the deployment target
# is a check nobody runs while writing the code. NUL-separated either way, so a
# path with a space in it stays one path.
QML_FILES=()
while IFS= read -r -d '' found; do QML_FILES+=("$found"); done \
  < <(find . -name '*.qml' -not -path './.git/*' -print0)

JS_FILES=()
while IFS= read -r -d '' found; do JS_FILES+=("$found"); done \
  < <(find . -name '*.js' -not -path './.git/*' -not -path './tests/*' -print0)

# 1. No hard-coded colours in QML. Every colour comes from the active Omarchy
#    theme, or a light theme renders unreadable text.
# gmailRed in ActionIcon is the single declared exception: the M inside the
# Gmail mark is a brand asset, the same carve-out this author's other plugins
# make for an official logo. Everything else takes the theme.
if grep -nE '(color|Color)\s*:\s*"#[0-9A-Fa-f]{3,8}"' -- "${QML_FILES[@]}" \
   | grep -v 'gmailRed'; then
  fail "hard-coded colour in QML: use Color.* or a colour passed in from App.qml"
fi
if grep -nE ':\s*"(red|blue|green|white|black|yellow|orange|purple|gray|grey)"' -- "${QML_FILES[@]}"; then
  fail "named display colour in QML: use Color.* instead"
fi

# 2. The JS libraries are read by the QML engine, which does not accept ES6.
#    tests/ is node-only and exempt.
for file in "${JS_FILES[@]}"; do
  head -1 "$file" | grep -q '^\.pragma library$' || fail "$file must start with .pragma library"
  # Comments quote code with backticks and say things like "a => b", so the
  # check runs on code lines only.
  if grep -vE '^\s*(//|\*|/\*)' "$file" | grep -nE '^\s*(const|let)\s|=>|`'; then
    fail "$file uses ES6 syntax the QML engine will not parse"
  fi
done

# 3. Nothing may name a colour inside a JS library either: colours are passed
#    in from QML, which is the only place that can read the theme.
# Html.js is the one exception, and a narrow one: PAPER and INK are the sheet a
# sender's HTML is printed on. They are content colours, not chrome — a
# message that sets #24292e text needs a light ground under it or it vanishes.
for file in account/Model.js providers/GmailApi.js message/Message.js; do
  if grep -vE '^\s*(//|\*|/\*)' "$file" | grep -nE '#[0-9A-Fa-f]{6}'; then
    fail "$file names a colour: pass it in from QML instead"
  fi
done
if grep -vE '^\s*(//|\*|/\*)' message/Html.js | grep -nE '#[0-9A-Fa-f]{6}' \
   | grep -vE 'PAPER|INK|paperPalette|#1155cc|#5f6368'; then
  fail "message/Html.js may only name the PAPER/INK sheet colours"
fi

# 4. barForeground is a qs.Ui.Panel property. A BarWidget that reads it gets
#    undefined, and an undefined colour paints nothing at all.
if grep -vE '^\s*//' BarWidget.qml | grep -n 'barForeground'; then
  fail "BarWidget has no barForeground; read bar.foreground instead"
fi

# IconTextButton has no separate hover glyph colour. Assigning one makes the
# whole component type unavailable at runtime, and App.qml then cannot be
# instantiated when the bar icon asks the shell to open it.
if awk '
  /^[[:space:]]*IconTextButton[[:space:]]*\{/ { in_button = 1; next }
  in_button && /^[[:space:]]*hoverColor:/ { print NR ":" $0; found = 1 }
  in_button && /^[[:space:]]*\}/ { in_button = 0 }
  END { exit !found }
' components/ImapSetupPage.qml; then
  fail "ImapSetupPage assigns the non-existent IconTextButton.hoverColor property"
fi

# A trigger holds a selected style while what it opened is on screen. The bar
# icon is the only trigger the window has, so without this there is nothing on
# screen saying which icon put it there.
grep -q 'windowOpen' BarWidget.qml \
  || fail "the bar icon must show an active style while the window is open"
# As a selected fill, the way every other selected control here is drawn. The
# bar's own `active` recolours the glyph from the theme's `bar.active`, which
# falls back to `urgent` — a warning colour for a window simply being open.
grep -q 'selectedFillFor' BarWidget.qml \
  || fail "the bar icon's open state must use the selected fill, not a glyph colour"
if grep -vE '^[[:space:]]*//' BarWidget.qml | grep -n 'activeColor'; then
  fail "BarWidget must not paint its glyph with the bar's urgent-derived activeColor"
fi

# The mouse must not move the keyboard's cursor. Qt re-reports hover when
# content moves under a still pointer, and the list scrolls to follow the
# keyboard — so a hover that wrote cursorId pulled it back to whatever the mouse
# was resting on, and j and k stuck on a few rows. A row shows its own hover
# (MessageRow.hot); that is the whole of what hover is for here.
if grep -n 'onRowHovered' App.qml; then
  fail "hovering a row must not move the keyboard cursor"
fi

# The context owns the keyboard. Every context that is not text entry parks the
# focus on a plain Item, because forceActiveFocus on the focus scope itself is a
# no-op — it re-elects the scope's current focus item, which is the field being
# left, so a dismissed compose field goes on swallowing every bare key. Nothing
# warns about this: the keys simply stop arriving.
grep -q 'onKeyContextChanged' App.qml \
  || fail "the key context must move the keyboard when it changes"
grep -q 'function parkKeyboard' App.qml \
  || fail "App.qml must park the keyboard on a plain Item, not on the focus scope"
if grep -vE '^[[:space:]]*//' App.qml | grep -n 'focusScope\.forceActiveFocus'; then
  fail "forceActiveFocus on the focus scope re-elects the field being left; park the keyboard instead"
fi

# A component that declares `focus: true` owns the window's focus even while it
# is invisible, and an owner that accepts keys is a sink for everything routed
# by focus rather than by Shortcut. ComposeView is instantiated whether or not
# anyone is writing, so an unconditional focus there swallowed every Escape in
# the window. Focus must follow "in use".
grep -q '^  focus: root.opened$' components/ComposeView.qml \
  || fail "ComposeView must own the focus only while it is open"
if grep -rn '^\s*focus: true\s*$' components/ComposeView.qml; then
  fail "ComposeView must not hold the focus unconditionally"
fi

# The IMAP server disclosure always reserves an icon slot. Both names selected
# by its state must have a drawing, or the slot is blank in one or both states.
for icon in chevronRight chevronDown; do
  if ! grep -q "root.name === \"$icon\"" components/ActionIcon.qml; then
    fail "ActionIcon does not draw ImapSetupPage's $icon icon"
  fi
done

# Row fills reach the list/reader divider; content padding belongs inside a
# row, not in a gutter that cuts every selected background short.
grep -q 'width: listFlick\.width$' App.qml \
  || fail "message rows must reach the list column edge"
awk '
  /id: listSplitter/ { in_splitter = 1 }
  in_splitter && /PanelSeparator[[:space:]]*\{/ { in_separator = 1 }
  in_separator && /anchors\.left: parent\.left/ { found = 1 }
  in_separator && /^[[:space:]]*\}/ { exit !found }
  END { exit !found }
' App.qml || fail "the list divider must sit on the splitter edge beside row fills"

# Initial loading is represented by rows shaped like the content that will
# arrive, rather than a lone Loading label that makes the column jump.
grep -q 'ListSkeleton {' components/MessageList.qml \
  || fail "an initially empty message list needs its skeleton"
grep -q 'Model\.showInitialListSkeleton' components/MessageList.qml \
  || fail "the list skeleton must only replace an empty initial fetch"
if grep -q 'implicitHeight: childrenRect\.height' components/ListSkeleton.qml; then
  fail "Column.implicitHeight is read-only and makes ListSkeleton unavailable"
fi

# New-mail notifications use the application's own mark, not the desktop's
# generic unread-mail glyph.
grep -q 'root\.pluginDir + "/assets/omamail\.svg"' account/MailAccount.qml \
  || fail "new-mail notifications need the Omamail app icon"
[ -f assets/omamail.svg ] || fail "the notification app icon is missing"

# Account actions live on the account's edit page. The switcher only changes
# accounts and leads to management; the management list only leads to editing.
grep -q 'text: "Manage accounts\.\.\."' components/AccountSwitcher.qml \
  || fail "the account switcher needs a Manage accounts... entry"
if grep -q 'removeAccountRequested' components/AccountSwitcher.qml; then
  fail "the account switcher must not remove accounts directly"
fi
grep -q 'signal editRequested(int index)' components/SettingsPage.qml \
  || fail "the account list needs an edit action"
if grep -qE 'signal (signIn|signOut|remove)Requested' components/SettingsPage.qml; then
  fail "sign-in, sign-out and removal belong on the account edit page"
fi
grep -q 'signal removeRequested()' components/ImapSetupPage.qml \
  || fail "the IMAP edit page needs to own account removal"
grep -q 'service\.discardCurrentDraft()' App.qml \
  || fail "leaving Add account must discard its unnamed draft"
if awk '
  /function addAccount\(/ { in_add = 1 }
  in_add && /saveAccounts\(\)/ { found = 1 }
  in_add && /^  \}/ { exit found ? 0 : 1 }
  END { exit found ? 0 : 1 }
' Service.qml; then
  fail "Add account must not persist its blank draft"
fi

# An IMAP address is account identity; its login username may legitimately be
# different and must never replace it while editing or loading the profile.
grep -q 'addressField\.text = service ? service\.accountAddress' components/ImapSetupPage.qml \
  || fail "IMAP Edit must read the saved account address separately from username"
grep -q 'email: root\.configuredEmail' account/MailAccount.qml \
  || fail "the IMAP profile must preserve the configured account address"

# Destructive account actions consume the semantic danger role passed from the
# app. Calling it dim or urgent at the button loses the action's meaning.
for page in components/SetupPage.qml components/ImapSetupPage.qml; do
  grep -q 'required property color dangerColor' "$page" \
    || fail "$page must receive the semantic danger colour"
  awk '
    /text: "Remove account"/ { in_remove = 1 }
    in_remove && /foreground: root\.dangerColor/ { found = 1 }
    in_remove && /^[[:space:]]*\}/ { exit !found }
    END { if (!in_remove) exit 1; exit !found }
  ' "$page" || fail "$page Remove account must be a danger button"
done

# Sign out and removal are peer account actions. Removal stays last in the
# action row instead of falling onto a detached row beneath it.
awk '
  /text: "Sign out"/ { saw_sign_out = 1 }
  saw_sign_out && /text: "Remove account"/ { saw_remove_after = 1 }
  saw_remove_after && /bordered: false/ { ghost = 1 }
  END { exit !(saw_sign_out && saw_remove_after && ghost) }
' components/ImapSetupPage.qml \
  || fail "IMAP Remove account must be the trailing danger ghost beside Sign out"
awk '
  /^  Button \{/ { top_button = 1; next }
  top_button && /text: "Remove account"/ { exit 1 }
  top_button && /^  \}/ { top_button = 0 }
' components/ImapSetupPage.qml \
  || fail "IMAP Remove account must not be detached from the account action row"

# 5. Nothing tracked may be large. This plugin is installed by cloning it, so
#    every megabyte in the tree is a megabyte between the user and a working
#    mailbox — and the things that get big are never the source. A published
#    design canvas with the editor bundled into it was 805 KB of the 1.4 MB a
#    clone cost, for content that was already in the repo beside it as six
#    small files, and an unreferenced screenshot was another 320 KB.
#
#    Anything genuinely large belongs somewhere a clone does not have to carry:
#    a release asset, or GitHub's own attachment host, which is where the
#    README's screenshots already live.
limit=$((128 * 1024))
oversized=$(git ls-files -z \
  | xargs -0 -I{} sh -c 'size=$(wc -c < "{}" 2>/dev/null || echo 0); [ "$size" -gt '"$limit"' ] && printf "%s\t%s\n" "$size" "{}"' \
  || true)
if [ -n "$oversized" ]; then
  printf '%s\n' "$oversized" >&2
  fail "the files above are over 128 KB; keep large assets out of the clone"
fi

# The compose form, account boundary and raw-message builder must keep the
# selected send-as address all the way to the provider. A missing link silently
# falls back to a default address and makes the selector lie.
grep -q 'from: root.fromEmail' components/ComposeView.qml \
  || fail "ComposeView must submit the selected From address"
grep -q 'from: from' account/MailAccount.qml \
  || fail "MailAccount must pass the selected From address to Message.js"
grep -q 'fromHeader(values.from, values.fromName)' message/Message.js \
  || fail "Message.js must write the selected From header, display name and all"
for client in providers/GmailApiClient.qml providers/ImapClient.qml; do
  grep -q 'function getSendAs' "$client" \
    || fail "$client must implement the provider-neutral sender-list operation"
done

printf 'test_source.sh ok\n'
