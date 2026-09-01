#!/usr/bin/env bash
# Two rules that are easy to break by accident and invisible until someone
# switches to a light theme or the QML engine chokes on modern syntax.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

fail() { printf 'test_source.sh: %s\n' "$1" >&2; exit 1; }

# Enumerated rather than globbed: the layout groups by module, and a module
# with no QML in it (message/, today) turns a literal glob into a grep error
# that hides whatever the check was meant to say.
#
# git does the enumerating rather than `find`. `--cached --others
# --exclude-standard` is the tracked files plus the ones not committed yet —
# this checkout's source, so a file you are still writing is checked — and
# nothing that is ignored. `find` walks ignored paths too, and a linked
# worktree under .claude/ is a second checkout of this same repository whose
# copies of these files would be reported here as if they were ours.
#
# A read loop rather than `mapfile`, which is bash 4 and absent from the bash
# 3.2 that macOS still ships — a check that only runs on the deployment target
# is a check nobody runs while writing the code. NUL-separated either way, so a
# path with a space in it stays one path.
QML_FILES=()
while IFS= read -r -d '' found; do QML_FILES+=("$found"); done \
  < <(git ls-files -z --cached --others --exclude-standard -- '*.qml')

JS_FILES=()
while IFS= read -r -d '' found; do JS_FILES+=("$found"); done \
  < <(git ls-files -z --cached --others --exclude-standard -- '*.js' ':!tests/*')

# A developer machine may point /bin/sh at bash while the release runner points
# it at dash. Bash's global parameter replacement then passes locally and dies
# only in CI with "Bad substitution". Scripts declaring /bin/sh stay within
# POSIX parameter expansion regardless of which shell happens to own that path.
if grep -rnE '\$\{[A-Za-z_][A-Za-z0-9_]*//' --include='*.sh' scripts; then
  fail "a /bin/sh script uses bash-only global parameter replacement"
fi

# 1. No hard-coded colours in QML. Every colour comes from the active Omarchy
#    theme, or a light theme renders unreadable text.
if grep -nE '(color|Color)\s*:\s*"#[0-9A-Fa-f]{3,8}"' -- "${QML_FILES[@]}"; then
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

# 3b. Reading mode is a rebuild, and the rebuild lives with the parse.
#
# `background` is an address in HTML, not a colour, and Qt fetches it. It sat in
# the colour list because senders write it next to `bgcolor`, and with
# `keepColors` on it survived — a real message reached its sender's host with
# remote images off. An appearance option may never buy a network request, so
# the resource attributes are refused before the colour question is asked.
if grep -nE '^var COLOUR_ATTRIBUTES = .*\bbackground\b' message/Html.js; then
  fail "message/Html.js treats the HTML background attribute as a colour; it is an address"
fi
grep -q '^var RESOURCE_ATTRIBUTES = {' message/Html.js \
  || fail "message/Html.js must refuse resource-bearing attributes as their own class"
awk '
  /^function cleanAttributes/ { in_function = 1 }
  in_function && /RESOURCE_ATTRIBUTES\[name\] === true/ { resource = NR }
  in_function && /COLOUR_ATTRIBUTES\[name\] === true/ { colour = NR }
  in_function && /^}/ { exit !(resource && colour && resource < colour) }
  END { exit !(resource && colour && resource < colour) }
' message/Html.js \
  || fail "a resource attribute must be dropped before keepColors is consulted"

# A text node goes back out escaped. What the tokenizer read as text is not what
# a second reader reads once something between two pieces of it is unwrapped, and
# a "<" that was not a tag on the way in can be one on the way out — past every
# check here, because by then it is a string rather than an element.
grep -q 'out.push(escapeMarkup(node.text))' message/Html.js \
  || fail "message/Html.js must escape a text node on the way out, not write it back raw"

# Deciding what may be fetched and rebuilding a message for reading are one
# file's work, and a view that called the sanitiser would be a second place
# those decisions were made. What it may still do is fit a document it has
# already been given to the width it has.
if grep -nE 'Html\.(sanitize|readerTree)\(' components/MessageReader.qml; then
  fail "the reader view must not sanitise a body; the account renders it once"
fi
grep -q 'withReader: true' account/MailAccount.qml \
  || fail "the reading document must come off the same parse as the formatted one"
grep -q 'remoteImageData: remoteImagesAllowed ? remoteImageData : null' account/MailAccount.qml \
  || fail "Qt must receive prepared image bytes rather than a pending remote source"
grep -q 'max-redirs = 0' scripts/image-fetch.sh \
  || fail "the image fetcher must not follow an unchecked redirect"
grep -q 'property string bodyMode: "reader"' Service.qml \
  || fail "a message opens in reading mode"
# Choosing between three readings that were all built when the body arrived is a
# preference and nothing else. A mode switch that re-rendered would re-run the
# image policy, and one that re-fetched would tell the sender the mail was
# opened again.
if awk '
  /function setBodyMode\(value\)/ { in_function = 1 }
  in_function && /(renderSource|select\(|getMessage|showRemoteImages)/ { found = 1 }
  in_function && /^  }/ { exit found ? 0 : 1 }
  END { exit found ? 0 : 1 }
' Service.qml; then
  fail "changing how a message is read must not re-render or re-fetch it"
fi

# 3c. Which way a message runs is decided in one place, and the two questions it
#     answers stay separate.
#
# Qt resolves a paragraph's direction from its own first strong character and is
# good at it. Two things it cannot do are what Direction.js is for, and both are
# easy to undo by "simplifying" the code that uses it.
grep -q 'promoteDirection' message/Html.js \
  || fail "a CSS direction must be promoted to the dir attribute Qt actually reads"
# The sheet's physical sides and the body's `dir` are one statement. Qt places a
# list marker on the side the block runs from, so a sheet that indents a list
# from the right while the block is still left-to-right does not move the bullet
# — it drops it. Splitting these was tried; the bullets went missing.
grep -q 'function baseDirectionAttribute' message/Html.js \
  || fail "the body direction and the stylesheet's sides must be written together"
if grep -n 'palette.pinned' message/Html.js; then
  fail "a document has one direction, not a direction and a flag saying whether to mean it"
fi

# A reply prefix is Latin whatever the thread is written in, so a subject asked
# with `resolve` rather than `resolveSubject` puts every message in a thread
# after the first against the wrong edge — which is the bug the module exists
# for, and the one a refactor is most likely to reintroduce.
for file in components/MessageRow.qml components/MessageReader.qml bar/BarPreview.qml; do
  grep -q 'Direction.resolveSubject' "$file" \
    || fail "$file must strip the reply prefix before asking which way a subject runs"
done

# The same mistake on the body side. The plain reading of an HTML message
# carries this client's own `[image N]` markers in front of the sender's first
# word, so `resolve` on it answers about a Latin "i" that omamail wrote.
grep -q 'Direction.resolveBody' components/MessageReader.qml \
  || fail "the reader must look past its own image markers before asking which way a body runs"

# The interface is not mirrored: this setting is a fact about the mail, not
# about the window around it. A LayoutMirroring here would be a different
# feature wearing this one's name.
if grep -rn 'LayoutMirroring' -- "${QML_FILES[@]}"; then
  fail "message direction must not mirror the interface; it applies to content only"
fi

# 4. The bar switches `barForeground` when transparent mode needs contrast.
#    `foreground` is the fixed theme value and does not follow that switch.
grep -q 'bar ? bar\.barForeground' BarWidget.qml \
  || fail "the bar icon must follow bar.barForeground in transparent mode"
grep -q 'markColor: root.accent' App.qml \
  || fail "the Omamail header M must use the active theme accent"
grep -q 'markColor: Color.accent' BarWidget.qml \
  || fail "the bar M must use the active theme accent"

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
for file in components/MessageList.qml components/ReaderBlankSlate.qml; do
  if grep -n 'resultSummary' "$file"; then
    fail "$file must not expose result-count estimates in the interface"
  fi
done
if grep -n 'modelData\.unread' components/AccountSwitcher.qml; then
  fail "the account switcher must identify mailboxes without count badges"
fi
grep -q 'mapToGlobal(0, 0)' components/UserBar.qml \
  || fail "the account switcher must anchor to the user bar, not the click position"
awk '
  /id: footer$/ { in_footer = 1 }
  in_footer && /anchors.leftMargin: Style.space\(8\)/ { left = 1 }
  in_footer && /anchors.rightMargin: Style.space\(8\)/ { right = 1 }
  in_footer && /spacing: Style.space\(4\)/ { exit !(left && right) }
  END { exit !(left && right) }
' components/MessageReader.qml \
  || fail "the reader toolbar control frames must share the status-bar inset"

# A trigger holds a selected style while what it opened is on screen. The bar
# icon is the only trigger the window has, so without this there is nothing on
# screen saying which icon put it there.
grep -q 'windowOpen' BarWidget.qml \
  || fail "the bar icon must show an active style while the window is open"
grep -q 'KeyboardPanel {' BarWidget.qml \
  || fail "the bar icon must open a mail and calendar preview"
[ -f bar/BarPreview.qml ] || fail "the bar preview view is missing"
python3 - <<'PY'
from pathlib import Path

widget = Path("BarWidget.qml").read_text()
open_window = widget[widget.index("function openWindow()"):widget.index("function openMessage(")]
if "shell.toggle" not in open_window or open_window.index("shell.toggle") > open_window.index("shell.summon"):
    raise SystemExit("test_source.sh: the bar's main-window action must toggle an open window closed")
pressed = widget[widget.index("onPressed: function(buttonCode)"):]
pressed = pressed[:pressed.index("\n    }")]
if "buttonCode === Qt.LeftButton" not in pressed or "root.openWindow()" not in pressed:
    raise SystemExit("test_source.sh: left-clicking the bar icon must open Omamail")
PY
# The shell marks an open bar panel with a short accent line on the bar's inner
# edge. Omamail's main window is not a bar popout, so its widget draws the same
# indicator itself instead of substituting an unrelated grey square.
grep -q 'id: openIndicator' BarWidget.qml \
  || fail "the open Omamail window must use the bar's accent-line indicator"
if grep -q 'id: openFill' BarWidget.qml; then
  fail "the bar icon must not replace the native-style indicator with a selected fill"
fi
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

grep -q 'Qt.rgba(popupBackgroundColor.r, popupBackgroundColor.g, popupBackgroundColor.b, 1)' \
  components/RecipientSuggestions.qml \
  || fail "recipient suggestions must obscure the compose form behind them"
grep -q 'z: root.toSuggestions.length > 0 ? 100 : 0' components/ComposeView.qml \
  || fail "recipient suggestions must stack above later compose rows"
grep -q 'id: bccToggle' components/ComposeView.qml \
  || fail "a draft must offer Bcc the same way it offers Cc, not only when a mailto names one"
grep -q 'NumberField {' components/SettingsPage.qml \
  || fail "the in-app settings page must expose numeric settings"
grep -q 'setUndoSendSeconds' components/SettingsPage.qml \
  || fail "the in-app settings page must save the undo window"

# The IMAP server disclosure always reserves an icon slot. Both names selected
# by its state must have a drawing, or the slot is blank in one or both states.
for icon in chevronLeft chevronRight chevronDown mail; do
  if ! grep -q "root.name === \"$icon\"" components/ActionIcon.qml; then
    fail "ActionIcon does not draw the $icon icon"
  fi
done
grep -q 'text: "Week"' components/CalendarView.qml \
  || fail "the calendar needs a week-view control"
python3 - <<'PY'
from pathlib import Path
text = Path("components/CalendarView.qml").read_text()
if text.index('text: "Week"') > text.index('text: "Month"'):
    raise SystemExit("test_source.sh: Week must appear before Month in the view switcher")
if 'text: "Go to today"' not in text:
    raise SystemExit("test_source.sh: Today must read as a navigation action")
today = text.index('text: "Go to today"')
right = text.index('anchors.right: parent.right')
if today > right:
    raise SystemExit("test_source.sh: Go to today must sit with the date on the left")
today_block = text[today:text.index('}', today)]
if 'bordered: false' not in today_block:
    raise SystemExit("test_source.sh: Go to today must be a text-only action")
if 'iconName: "refresh"' in text:
    raise SystemExit("test_source.sh: calendar refresh belongs in the window header")
if "id: calendarLoading" not in text or "root.controller.loading" not in text:
    raise SystemExit("test_source.sh: calendar network refresh must show an inline loading animation")
if "RotationAnimator on rotation" not in text:
    raise SystemExit("test_source.sh: the calendar loading indicator must animate")
error = text.index("id: calendarError")
body = text.index("id: calendarBody")
if error > body:
    raise SystemExit("test_source.sh: calendar errors must reserve space above the calendar body")
error_block = text[error:body]
if "height:" not in error_block or "lastError" not in error_block:
    raise SystemExit("test_source.sh: calendar errors must occupy their own visible row")
if 'objectName: "calendarErrorCopy"' not in error_block or "copyRequested" not in error_block:
    raise SystemExit("test_source.sh: a disabled Calendar API error must offer Copy")
if 'objectName: "calendarApiEnable"' not in error_block or "openRequested" not in error_block:
    raise SystemExit("test_source.sh: a disabled Calendar API error must link to Google Cloud")
if 'lastErrorKind === "googleApiDisabled"' not in error_block:
    raise SystemExit("test_source.sh: Calendar API actions must use the typed Google error")
PY
python3 - <<'PY'
from pathlib import Path
text = Path("App.qml").read_text()
if "function switchAccount(index)" not in text:
    raise SystemExit("test_source.sh: account entry points must share view-preserving switching")
switch = text[text.index("function switchAccount(index)"):text.index("function editAccount", text.index("function switchAccount(index)"))]
if "calendarVisible" not in switch or "mailboxAfterAccountSwitch" not in switch:
    raise SystemExit("test_source.sh: account switching must retain Calendar or the current mailbox tab")
if "onAccountChosen" not in text or "root.switchAccount(index)" not in text:
    raise SystemExit("test_source.sh: the account picker must use view-preserving switching")
service = Path("Service.qml").read_text()
if "accountId: root.calendarAccountId" not in service:
    raise SystemExit("test_source.sh: the visible Calendar must be told which account is displayed")
# What the calendar depends on is what its cache is keyed by, and under the
# unified view that is not the mailbox: the same calendars are shown whichever
# one is open. Keying by the account there stored a copy of the same events per
# account and turned every mailbox switch into a cache miss and a full refetch.
controller = Path("calendar/CalendarController.qml").read_text()
if "eventCache.get(refreshScope" not in controller or "eventCache.put(refreshScope" not in controller:
    raise SystemExit("test_source.sh: the event cache must be keyed by the calendar scope, not the mailbox")
# The reload watches the scope rather than the two things that go into it. A
# mailbox switch under the unified view changes nothing on screen, and neither
# does the setting for a controller that had no mailbox to follow — watching the
# inputs separately got those two wrong in opposite directions.
if "onCalendarScopeChanged: reloadVisibleRange()" not in controller:
    raise SystemExit("test_source.sh: the visible range must reload on a change of scope, not of mailbox")
if "onAccountIdChanged" in controller or "onUnifiedCalendarViewChanged" in controller:
    raise SystemExit("test_source.sh: reloading on either input separately is what the scope replaced")
composer_default = Path("components/CalendarEventComposer.qml").read_text()
if "preferredCalendarId()" not in composer_default:
    raise SystemExit("test_source.sh: a new event must open on the mailbox being read, not the first account")
composer = Path("components/CalendarEventComposer.qml").read_text()
if "controller.writableSourceGroups" not in composer:
    raise SystemExit("test_source.sh: event creation must offer writable calendars from the selected calendar view")
PY
grep -q 'text: "Create event\.\.\."' App.qml \
  || fail "calendar mode needs a Create event... header action"
python3 - <<'PY'
from pathlib import Path

sidebar = Path("components/MailboxSidebar.qml").read_text()
footer = sidebar[sidebar.index("id: footer"):sidebar.index("component Entry:")]
if 'label: "Calendar"' not in footer or "calendarRequested" not in footer:
    raise SystemExit("test_source.sh: Calendar must be fixed above the sidebar account row")
calendar = footer.index('label: "Calendar"')
separator = footer.index("PanelSeparator", calendar)
if "Style.space(6)" not in footer[calendar:separator]:
    raise SystemExit("test_source.sh: Calendar must keep a gap above the account separator")

app = Path("App.qml").read_text()
sidebar_use = app[app.index("id: sidebar"):app.index("MailboxTabs {")]
if "!root.calendarVisible" in sidebar_use or "calendarSelected: root.calendarVisible" not in sidebar_use:
    raise SystemExit("test_source.sh: the mailbox sidebar must remain visible and select Calendar")
header = app[app.index("id: headerRight"):app.index("// mailbox as a whole")]
if 'iconName: root.calendarVisible ? "mail" : "calendar"' in header:
    raise SystemExit("test_source.sh: Calendar navigation belongs in the sidebar, not the header")

calendar = Path("components/CalendarView.qml").read_text()
if "CalendarSidebar {" in calendar:
    raise SystemExit("test_source.sh: Calendar must not open a second sidebar")
week = Path("components/WeekCalendarView.qml").read_text()
for source, name in ((calendar, "month"), (week, "week")):
    if "required property color calendarBorderColor" not in source:
        raise SystemExit("test_source.sh: %s calendar must inherit the themed border token" % name)
    if "required property color calendarTodayBackgroundColor" not in source:
        raise SystemExit("test_source.sh: %s calendar must inherit the themed Today background" % name)
    if "required property int calendarBorderWidth" not in source:
        raise SystemExit("test_source.sh: %s calendar must inherit the themed border width" % name)
if "calendarBorderColor: root.calendarBorder" not in app:
    raise SystemExit("test_source.sh: App must pass the system calendar border token")
if "calendarTodayBackgroundColor: root.calendarTodayBackground" not in app:
    raise SystemExit("test_source.sh: App must pass the system Today background token")
if "readonly property color calendarBorder: Style.normalBorderColor" not in app:
    raise SystemExit("test_source.sh: calendar borders must originate from the system border token")
if "readonly property color calendarTodayBackground: Style.selectedAccentFill" not in app:
    raise SystemExit("test_source.sh: Today must use the quieter system accent fill token")
if "calendarBorderWidth: root.calendarBorderWidth" not in app:
    raise SystemExit("test_source.sh: App must pass the system calendar border width")
if "border.color: root.calendarBorderColor" not in calendar or "border.width: root.calendarBorderWidth" not in calendar:
    raise SystemExit("test_source.sh: month cells must consume the themed calendar border")
if "? root.calendarTodayBackgroundColor" not in calendar:
    raise SystemExit("test_source.sh: the Month Today cell must consume the themed background")
if ("calendarBorderColor: root.calendarBorderColor" not in calendar
        or "calendarTodayBackgroundColor: root.calendarTodayBackgroundColor" not in calendar
        or "calendarBorderWidth: root.calendarBorderWidth" not in calendar):
    raise SystemExit("test_source.sh: CalendarView must propagate themed calendar tokens to Week")
if week.count("root.calendarTodayBackgroundColor") < 2:
    raise SystemExit("test_source.sh: Week Today must span the all-day lane and timeline")
PY
grep -q 'function setSourceEnabled' calendar/CalendarController.qml \
  || fail "calendar visibility must persist through the controller"
grep -q 'function setSourceColor' calendar/CalendarController.qml \
  || fail "calendar colors must persist through the controller"
grep -q 'property bool sourcesLoaded' calendar/CalendarController.qml \
  || fail "calendar refresh must wait for the saved source list"
grep -q 'if (firstLoad && root.rangeStart && root.rangeEnd)' calendar/CalendarController.qml \
  || fail "calendar events must load automatically after startup source discovery"
grep -q 'function onSourcesLoadedChanged' components/CalendarView.qml \
  || fail "the calendar view must refresh when its saved sources become ready"
grep -q 'property double pendingRangeStart' calendar/CalendarController.qml \
  || fail "a calendar range change during loading must be queued"
grep -q 'CalendarCache {' calendar/CalendarController.qml \
  || fail "CalendarController must restore events before refreshing the network"
if grep -q '^    events = \[\]$' calendar/CalendarController.qml; then
  fail "Calendar refresh must not blank cached events before the network answers"
fi
grep -q 'root.refresh(nextStart, nextEnd)' calendar/CalendarController.qml \
  || fail "the queued calendar range must run after the active refresh"
grep -q 'eventDeadline.restart()' calendar/CalendarController.qml \
  || fail "Google event creation must start its deadline"
python3 - <<'PY'
from pathlib import Path

controller = Path("calendar/CalendarController.qml").read_text()
google_timeout = controller[controller.index("id: googleDeadline"):]
google_timeout = google_timeout[:google_timeout.index("}\n  }")]
if "failSource(" in google_timeout:
    raise SystemExit("test_source.sh: abort must be the only Google refresh timeout completion path")
if "id: eventDeadline" not in controller or "root.eventRequest.abort()" not in controller:
    raise SystemExit("test_source.sh: Google event creation must abort after a deadline")

service = Path("Service.qml").read_text()
if "readonly property var pendingSendHost" not in service:
    raise SystemExit("test_source.sh: an undoable send must remain reachable across accounts")
PY
grep -q 'allDayEventsOnDay' components/WeekCalendarView.qml \
  || fail "all-day events must have a pinned week-view lane"
grep -q 'signal createAt' components/WeekCalendarView.qml \
  || fail "empty week slots must start event creation"
grep -q 'function beginAt' components/CalendarEventComposer.qml \
  || fail "event creation must accept a preselected time"
python3 - <<'PY'
from pathlib import Path

app = Path("App.qml").read_text()
for component_id in ("listColumn", "reader"):
    marker = f"id: {component_id}"
    start = app.index(marker)
    end = app.find("\n        }", start)
    block = app[start:end]
    if "!root.calendarVisible" not in block:
        raise SystemExit(
            f"test_source.sh: {component_id} must be inactive behind the calendar view"
        )
PY
[ -f components/CalendarEventDetail.qml ] \
  || fail "calendar events need an in-app overview page"
grep -q 'CalendarEventDetail {' components/CalendarView.qml \
  || fail "calendar event activation must open the native overview"

if grep -q 'Open Omamail' bar/BarPreview.qml; then
  fail "the bar preview must not contain a redundant Open Omamail button"
fi
grep -q 'messages: host ? host.previewMessages : \[\]' Service.qml \
  || fail "the bar preview must use each account's unread preview feed"
grep -q 'id: barCalendar' Service.qml \
  || fail "the bar preview needs an independent upcoming-event range"
grep -q 'root.gmail.refreshCalendarPreview()' BarWidget.qml \
  || fail "opening the bar preview must refresh its upcoming events"
grep -q 'width: parent ? parent.width : 0' BarWidget.qml \
  || fail "bar preview rows must stay inside the panel's padded content area"
grep -q '"MMM d · ddd HH:mm"' bar/BarPreview.qml \
  || fail "upcoming events must show a calendar date as well as a weekday"
if awk '
  /function activateEvent\(event\)/ { in_function = 1 }
  in_function && /Qt\.openUrlExternally/ { found = 1 }
  in_function && /^  }/ { exit found ? 0 : 1 }
  END { exit found ? 0 : 1 }
' components/CalendarView.qml; then
  fail "activating a calendar event must not jump to its provider"
fi
grep -q 'calendarView.detailOpen' App.qml \
  || fail "Escape must close the native calendar event overview first"
if grep -q 'Shortcut { sequence: "Escape"' components/CalendarEventComposer.qml; then
  fail "event creation must use the central Escape route, not an ambiguous duplicate"
fi
grep -q 'text: "Make recurring"' components/CalendarEventComposer.qml \
  || fail "event creation needs an optional recurrence section"
grep -q 'text: "Add a calendar"' components/CalendarSettings.qml \
  || fail "settings must let a user add a calendar"
grep -q 'placeholderText: "Calendar name"' components/CalendarSettings.qml \
  || fail "calendar setup needs a name field"
grep -q 'placeholderText: "CalDAV URL"' components/CalendarSettings.qml \
  || fail "calendar setup needs a CalDAV URL field"
grep -q 'placeholderText: "Username"' components/CalendarSettings.qml \
  || fail "calendar setup needs a username field"
grep -q 'placeholderText: "Password or app password"' components/CalendarSettings.qml \
  || fail "calendar setup needs its own password field"
grep -q 'text: "Set password"' components/CalendarSettings.qml \
  || fail "existing CalDAV calendars need a password action"
grep -q 'credentials.json|accounts.json|window.json|calendars.json|compose.json' scripts/config-store.sh \
  || fail "the config writer must accept calendar source records"
if grep -q 'Five Nextcloud calendars\|imported from Thunderbird\|Nextcloud password' components/CalendarSettings.qml; then
  fail "calendar settings must not describe one user's imported setup"
fi
[ -f components/WeekCalendarView.qml ] \
  || fail "the calendar week view is missing"
grep -q 'id: dayHeaders' components/WeekCalendarView.qml \
  || fail "the week view must label each day"

# Row fills reach the list/reader divider; content padding belongs inside a
# row, not in a gutter that cuts every selected background short.
grep -q 'width: listFlick\.width$' App.qml \
  || fail "message rows must reach the list column edge"
grep -q 'leadingBoundaryOverlap: listSplitter.visible ? listSplitter.width : 0' App.qml \
  || fail "the reader toolbar boundary must cross the splitter hit area to meet its visible rule"
grep -q 'anchors.leftMargin: -root.leadingBoundaryOverlap' components/MessageReader.qml \
  || fail "the reader toolbar boundary must meet the list/reader divider"
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

# A first-time search paints what every cached mailbox page already knows, then
# accepts provider results without waiting for the last metadata request. The
# progress argument is part of the shared client interface, not a Gmail branch
# in MailAccount.
grep -q 'Cache\.searchSummaries(cacheStore\.store, searchQuery,' account/MailAccount.qml \
  || fail "typed searches must inspect eligible cached message summaries first"
grep -q 'Provider\.cachedSummaryInSearch' account/MailAccount.qml \
  || fail "cached search previews must stay inside the provider's live scope"
grep -q 'function loadSearchMessages' account/MailAccount.qml \
  || fail "typed searches need a progressive list pipeline"
grep -q 'Model\.settledSearchResults' account/MailAccount.qml \
  || fail "the final server ids must replace the cached search preview"
grep -q 'Model\.missingSearchSummaryIds' account/MailAccount.qml \
  || fail "a partial metadata page must close paging before a missing row"
grep -q '}, idsArrived)' account/MailAccount.qml \
  || fail "server ids must be consumed before the final list callback"
grep -q 'readonly property bool serverSearchLoading:' account/MailAccount.qml \
  || fail "typed searches must expose that the server answer is still loading"
grep -q 'serverSearching: !!root\.service && root\.service\.serverSearchLoading' App.qml \
  || fail "the search field must receive the live server-search state"
grep -q 'text: "Searching server"' components/SearchBar.qml \
  || fail "the search field must name what is still running"
grep -q 'RotationAnimator on rotation' components/SearchBar.qml \
  || fail "the server-search state must remain visible when its label no longer fits"
for client in providers/GmailApiClient.qml providers/HeyClient.qml providers/ImapClient.qml; do
  grep -q 'function listMessages(query, maxResults, pageToken, callback, progress)' "$client" \
    || fail "$client must expose the shared progressive search interface"
  grep -q 'function getMessages(ids, full, callback, existingHandle, progress)' "$client" \
    || fail "$client must expose the shared progressive list interface"
done
grep -q 'if (ids.length > 0) progress({' providers/ImapClient.qml \
  || fail "IMAP search windows must report ids before the final page"
grep -q 'Imap\.uidCeilingCommand()' providers/ImapClient.qml \
  || fail "interactive IMAP search must not wait for the complete UID snapshot"
grep -q 'Imap\.searchCommands(criteria, snapshot, nextUid)' providers/ImapClient.qml \
  || fail "a sparse interactive search must reuse a UID snapshot after its first window"
grep -q 'streamedSummaryBatch' providers/ImapClient.qml \
  || fail "streamed IMAP results must fetch headers in visible batches"
grep -q 'fetchQueue\.push(wanted)' account/MailAccount.qml \
  || fail "streamed metadata reads need one shared queue"
grep -q 'if (index >= 0 && listLoading)' account/MailAccount.qml \
  || fail "an action must stop a live list before stale snapshots can settle"
grep -q 'pendingAction !== "" && cacheKey === pendingActionQuery' account/MailAccount.qml \
  || fail "an action may only suppress refreshes for its own query"
grep -q 'deferredListLoad = ({' account/MailAccount.qml \
  || fail "navigation back to an action query must defer rather than lose its load"
grep -q 'resumeDeferredListLoad(actionQuery' account/MailAccount.qml \
  || fail "an action callback must resume a deferred navigation load"
awk '
  /function act\(/ { in_act = 1 }
  in_act && /if \(pendingAction !== ""\)/ { guarded = 1 }
  in_act && /pendingAction = action/ { exit !guarded }
  END { exit !guarded }
' account/MailAccount.qml \
  || fail "a second row action must not overwrite the pending action slot"
awk '
  /function markAllRead\(\)/ { in_mark_all = 1 }
  in_mark_all && /if \(pendingAction !== ""\)/ { guarded = 1 }
  in_mark_all && /pendingAction = "markRead"/ { exit !guarded }
  END { exit !guarded }
' account/MailAccount.qml \
  || fail "mark-all must not overwrite the pending action slot"
awk '
  /function loadMessages\(/ { in_load = 1 }
  in_load && /if \(error \|\| !page\)/ { in_page_error = 1 }
  in_page_error && /if \(!append\) root\.nextPageToken = ""/ { cleared = 1 }
  in_page_error && /return/ { exit !cleared }
  END { exit !cleared }
' account/MailAccount.qml \
  || fail "a failed page-one refresh must clear its stale continuation token"
grep -q 'if (invalidatesPage) nextPageToken = ""' account/MailAccount.qml \
  || fail "a membership-changing action must invalidate its offset token"
grep -q 'var invalidatesPage = !survives || opaqueQuery' account/MailAccount.qml \
  || fail "mark-all must invalidate opaque search offsets too"
grep -q 'var invalidatesPage = !survives || opaqueQuery' account/MailAccount.qml \
  || fail "paging membership must not follow the reader's keep-open decision"
grep -q 'if (!service.act(acted, action)) return false' App.qml \
  || fail "a refused action must not move the keyboard cursor"
grep -q 'queueQuietAction(messageId, action, cacheKey)' account/MailAccount.qml \
  || fail "automatic mark-read must wait rather than disappear behind another action"
awk '
  /function runQueuedQuietAction\(\)/ { in_quiet = 1 }
  in_quiet && /listSerial\+\+/ { interrupts = 1 }
  in_quiet && /root\.loadMessages\(false, true/ { reloads = 1 }
  /function act\(/ { exit !(interrupts && reloads) }
  END { exit !(interrupts && reloads) }
' account/MailAccount.qml \
  || fail "a detached quiet action must stop and revalidate its query stream"
test "$(grep -c 'root.active && root.cacheKey !== actionQuery' account/MailAccount.qml)" -ge 2 \
  || fail "successful actions must revalidate a mailbox opened while they were pending"
awk '
  /function markAllRead\(\)/ { in_mark_all = 1 }
  in_mark_all && /if \(interrupted\)/ { saw_interrupt = 1 }
  in_mark_all && /root\.loadMessages\(false, true, error\)/ { saw_retry = 1 }
  in_mark_all && /^  }/ { exit !(saw_interrupt && saw_retry) }
  END { exit !(saw_interrupt && saw_retry) }
' account/MailAccount.qml \
  || fail "mark-all must stop and revalidate a live list too"
grep -q 'root\.loadMessages(false, true, error)' account/MailAccount.qml \
  || fail "a failed action must resume the list without losing its error"
grep -q 'root\.loadMessages(false, true, "")' account/MailAccount.qml \
  || fail "a successful action must revalidate without repainting stale cache"
awk '
  /if \(!finalPage\)/ { in_null_page = 1 }
  in_null_page && /root\.nextPageToken = ""/ { cleared = 1 }
  in_null_page && /return/ { exit !cleared }
  END { exit !cleared }
' account/MailAccount.qml \
  || fail "a failed page-one search must clear cached pagination"
awk '
  /function fetchSummaries/ { in_fetch = 1 }
  in_fetch && /Model\.missingSearchSummaryIds\(summaries, ids\)/ { checks_ids = 1 }
  in_fetch && /root\.nextPageToken = ""/ { clears_page = 1 }
  /function applySummaries/ { exit !(checks_ids && clears_page) }
  END { exit !(checks_ids && clears_page) }
' account/MailAccount.qml \
  || fail "ordinary metadata reads must detect holes and close paging"
grep -q 'if (error && prefixSettled !== true)' providers/ImapClient.qml \
  || fail "an IMAP failure before SEARCH answers must keep the cached preview"
for client in providers/GmailApiClient.qml providers/ImapClient.qml; do
  grep -q 'callback(ordered, firstError)' "$client" \
    || fail "$client must report partial metadata failures"
done
grep -q 'progressTimerComponent' providers/GmailApiClient.qml \
  || fail "parallel Gmail metadata replies must be coalesced before repainting"
grep -q 'MAX_SUMMARIES_PER_QUERY' cache/Cache.js \
  || fail "each cached query needs a row cap"

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

# The tested protocol helper owns the setup decision; the form must not grow a
# second, untested copy that can drop Proton Bridge's local transport again.
grep -q 'return Imap\.setupSettings({' components/ImapSetupPage.qml \
  || fail "the IMAP setup form must use the tested settings builder"
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

# Removing a mailbox is destructive. The edit pages may request it, but only a
# confirmation owned by App may call the service after naming the target.
grep -q 'AccountRemovalDialog {' App.qml \
  || fail "account removal needs a confirmation dialog"
if awk '
  /function removeCurrentAccountFromEditor\(/ { in_remove = 1 }
  in_remove && /service\.removeAccountAt/ { exit 0 }
  in_remove && /^  }/ { exit 1 }
  END { exit 1 }
' App.qml; then
  fail "requesting account removal must not remove it immediately"
fi

# The fix for a hanging request that looks right and does nothing.
#
# Qt's QML XMLHttpRequest has no `timeout` and no `ontimeout`: the properties do
# not exist, and assigning one reads back exactly what was written — so this
# line passes review, passes a read-through, and leaves the request hanging
# exactly as before. Measured, not read from a specification: `"timeout" in
# xhr` is false, and a request against a socket that accepts and never answers
# was still going after eight seconds. A Timer calling abort() is what there is.
#
# Only the trap is checked here. "This request has a deadline" is not something
# grep can ask — a file may hold several Timers and only one of them may be the
# one that matters — so that invariant lives in AGENTS.md and in the offscreen
# harness that measured it, not in a test that would pass whatever happened.
if grep -rnE '\.timeout[[:space:]]*=' --include=*.qml . | grep -v '^./tests/'; then
  fail "XMLHttpRequest.timeout does not exist in Qt's QML engine; use a Timer that aborts"
fi

# A mailbox names itself the way the account list names it.
#
# An id is the bare address only for the default provider; every other one
# carries its provider in front. Assigning the address alone is also an
# assignment rather than a binding, so it replaced the id the list had given —
# and `Service.findAccount` compares the two. A HEY mailbox called itself
# `you@hey.com` while the list called it `hey:you@hey.com`, nothing matched, and
# switching to it silently fell back to whichever mailbox was first.
if grep -nE 'accountId = accountEmail' account/MailAccount.qml; then
  fail "a mailbox's id must come from Accounts.accountId, not from the address alone"
fi
grep -q 'accountId = Accounts.accountId(accountEmail, providerId)' account/MailAccount.qml \
  || fail "MailAccount must name itself through Accounts.accountId"

# Native desktop controls retain the arrow cursor. A pointing hand is reserved
# for actual links such as URLs inside the message reader.
for file in components/IconButton.qml components/IconTextButton.qml components/AppMenu.qml \
  components/MessageMenu.qml components/AccountSwitcher.qml components/ProviderPicker.qml \
  components/MailboxSidebar.qml components/UserBar.qml; do
  if grep -n 'PointingHandCursor' "$file"; then
    fail "$file uses a web-link cursor for a native control"
  fi
done

# Labels say when an action leaves the app and use three periods for the
# established workflow suffix. Busy state is status, not decorative prose.
if grep -rnE 'Checking…|Fetching the mailbox…|Not signed in yet|Open in Gmail|text: "(Shortcuts|GitHub|Twitter)"' \
  App.qml components; then
  fail "UI copy does not follow the project action and status vocabulary"
fi
if grep -rnE '^[[:space:]]*(text|tooltipText):.*…' App.qml components; then
  fail "UI labels use the project ellipsis convention (...), while progress uses state"
fi
grep -q 'text: "Add a mailbox\.\.\."' components/SettingsPage.qml \
  || fail "Add a mailbox opens a workflow and needs an ellipsis"
grep -q 'tooltipText: "Add another mail account"' components/SettingsPage.qml \
  || fail "the add-account tooltip must be provider-neutral"
if awk '
  /id: accountLine/ { in_status = 1 }
  in_status && /resultSummary/ { exit 0 }
  in_status && /^        }/ { exit 1 }
  END { exit 1 }
' App.qml; then
  fail "the window status line must not repeat the list result count"
fi

# Both action menus own navigation locally because Qt popups intercept window
# shortcuts. Placement happens after opening and whenever content is measured.
for file in components/AppMenu.qml components/MessageMenu.qml; do
  grep -q 'Keys.onPressed' "$file" \
    || fail "$file needs popup-local keyboard navigation"
  grep -q 'onOpened:' "$file" \
    || fail "$file must place itself after its contents exist"
  grep -q 'onHeightChanged: root.place()' "$file" \
    || fail "$file must re-place itself when its measured height changes"
  grep -q 'MenuActionRow {' "$file" \
    || fail "$file must use the shared menu-row contract"
  if grep -q 'component MenuRow: Rectangle' "$file"; then
    fail "$file duplicates the shared menu-row presentation"
  fi
done

# Feature views receive semantic colours from App. Reading theme roles locally
# makes the same concept drift between pages and prevents App from naming it.
for file in components/AppMenu.qml components/MessageMenu.qml components/AccountSwitcher.qml \
  components/ProviderPicker.qml components/MailboxTabs.qml components/SetupPage.qml \
  components/ImapSetupPage.qml components/KeyHints.qml components/ImagePopover.qml \
  components/ComposeView.qml; do
  if grep -nE '(^|[^A-Za-z])Color\.' "$file"; then
    fail "$file reads theme colours instead of receiving semantic roles"
  fi
done

# Row actions must meet the compact desktop hit-target floor.
if grep -n 'size: Style\.space(20)' components/MessageRow.qml; then
  fail "message row actions need at least a 24px hit target"
fi
grep -q 'anchors.margins: root.visualInset' components/IconButton.qml \
  || fail "IconButton hover fill must sit inside its hit target"
grep -q 'verticalPadding: Style.space(2)' components/ReaderNotice.qml \
  || fail "ReaderNotice actions must keep their visual surface inside the notice"
grep -q 'width: implicitWidth' components/ReaderNotice.qml \
  || fail "ReaderNotice actions need a trailing intrinsic-width lane"
if grep -q 'Ctrl+Enter sends' components/ComposeView.qml; then
  fail "Compose must render shortcut hints from Keymap instead of hand-writing a second copy"
fi
grep -q 'visible: !root.showPage && !root.composing' App.qml \
  || fail "mailbox header commands must stand down while Compose owns the task"
awk '
  /id: header$/ { in_header = 1 }
  in_header && /visible: !root.composing/ { found = 1 }
  in_header && /id: body$/ { exit !found }
  END { exit !found }
' App.qml || fail "Compose must replace the mailbox header instead of stacking another one below it"
grep -q 'anchors.top: header.visible ? header.bottom : parent.top' App.qml \
  || fail "Compose must reclaim the space of the hidden mailbox header"
if grep -q 'text: subjectField.text' components/ComposeView.qml; then
  fail "the Compose header must not repeat the Subject field"
fi
awk '
  /id: titleRow/ { in_title = 1 }
  in_title && /anchors.horizontalCenter: parent.horizontalCenter/ { centered = 1 }
  in_title && /anchors.left: backBar.right/ { follows_back = 1 }
  in_title && /^    }/ { exit !(centered && !follows_back) }
  END { exit !(centered && !follows_back) }
' components/ComposeView.qml \
  || fail "the Compose title must stay centered independently of the Back control"
awk '
  /id: fromButton/ { in_from = 1 }
  in_from && /bordered: true/ { found = 1 }
  in_from && /^      }/ { exit !found }
  END { exit !found }
' components/ComposeView.qml \
  || fail "the From dropdown must use an outline treatment"
awk '
  /id: fromButton/ { in_from = 1 }
  in_from && /background: Style.normalFillFor\(root.textColor, root.accentColor\)/ { fill = 1 }
  in_from && /verticalPadding: Style.spacing.inputPaddingY/ { padding = 1 }
  in_from && /^      }/ { exit !(fill && padding) }
  END { exit !(fill && padding) }
' components/ComposeView.qml \
  || fail "the From dropdown must share the TextField fill and vertical sizing"

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

# A mailbox row is the selected one only when no search is standing on top of
# it, and that guard is a continuation line. Inserting a binding between the two
# lines silently reparented the guard onto the new property — every row on the
# rail then numbered itself 1, and nothing failed.
awk '
  /selected: !!root.service && root.service.mailboxKey/ {
    getline
    if ($0 !~ /searchQuery/) exit 1
  }
' components/MailboxSidebar.qml \
  || fail "the mailbox row's selected guard lost its search continuation line"

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
#
#    preview.png is the one exception, and it is named rather than waved
#    through by raising the ceiling. The marketplace catalog rebuilds from
#    branch HEAD and takes a plugin's card image from a root file, so this one
#    has to be in the tree or the card falls back to a placeholder. It gets a
#    ceiling of its own instead of none: a card image that grew to a megabyte
#    would still be a megabyte every user clones.
limit=$((128 * 1024))
preview_limit=$((384 * 1024))
oversized=$(git ls-files -z \
  | xargs -0 -I{} sh -c '
      case "{}" in
        preview.png) ceiling='"$preview_limit"' ;;
        *) ceiling='"$limit"' ;;
      esac
      size=$(wc -c < "{}" 2>/dev/null || echo 0)
      [ "$size" -gt "$ceiling" ] && printf "%s\t%s\n" "$size" "{}"' \
  || true)
if [ -n "$oversized" ]; then
  printf '%s\n' "$oversized" >&2
  fail "the files above are over their size ceiling; keep large assets out of the clone"
fi

# The compose form, account boundary and raw-message builder must keep the
# selected send-as address all the way to the provider. A missing link silently
# falls back to a default address and makes the selector lie.
# A mailto: link is a draft, not a page. The desktop handler summons the
# window with the URL; open() turns that into compose fields. Toggle would
# close a mailbox that is already on screen.
grep -q 'import "message/Mailto.js" as Mailto' App.qml \
  || fail "App.qml must parse mailto payloads through Mailto.js"
grep -q 'Mailto.draftFromPayload(payload)' App.qml \
  || fail "open() must seed compose from a mailto payload"
grep -q 'function beginDraft' components/ComposeView.qml \
  || fail "ComposeView must fill a new draft from a mailto"
grep -q 'omarchy-shell shell summon' scripts/mailto.sh \
  || fail "the mailto handler must summon Omamail, not toggle it"
grep -q 'install-mailto.sh' install.sh \
  || fail "install.sh must register the mailto desktop handler"
grep -q 'registerMailtoHandler' Service.qml \
  || fail "the service must register the mailto handler when the plugin loads"
grep -q 'bcc: Mail.headerFrom(parsed.headers, "Bcc")' providers/HeyClient.qml \
  || fail "HEY must pass a mailto Bcc through to hey compose"
grep -q 'signal mailtoRequested(string url)' components/MessageReader.qml \
  || fail "a mailto in a message body must compose here, not leave through xdg-open"
if awk '
  /onLinkActivated:/ { in_link = 1 }
  in_link && /Qt.openUrlExternally\(link\)/ { found = 1 }
  in_link && /^[[:space:]]*\}/ { exit found ? 0 : 1 }
  END { exit found ? 0 : 1 }
' components/MessageReader.qml; then
  fail "MessageReader must not send mailto links out through Qt.openUrlExternally"
fi

grep -q 'sendIdentities' components/ComposeView.qml \
  || fail "compose From must list every connected mailbox that can send"
grep -q 'function identities' compose/Senders.js \
  || fail "which addresses a new message may be sent as lives in compose/Senders.js"
grep -q 'root.service.switchTo' components/ComposeView.qml \
  || fail "choosing another mailbox as From must switch the sending account"
python3 - <<'PY'
from pathlib import Path

service = Path("Service.qml").read_text()
start = service.index("readonly property var sendIdentities:")
end = service.index("readonly property string accountAddress:", start)
block = service[start:end]
if "hostsEpoch" not in block:
    raise SystemExit(
        "test_source.sh: sendIdentities must re-read after a mailbox host signs in"
    )
recount = service[service.index("function recount("):]
recount = recount[:recount.index("\n  }") + 4]
if "hostsEpoch" not in recount:
    raise SystemExit(
        "test_source.sh: recount() must bump hostsEpoch so From can see signed-in mailboxes"
    )
PY

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

# Qt FileDialog under QT_QPA_PLATFORMTHEME=gtk3 aborts the whole shell inside
# GLib/DBus. The window is owned by Quickshell (`quickshell,Attach files`).
# Attach has to pick files in a child process; opening Omafiles and hoping
# the user pastes is not a picker.
if grep -nE 'FileDialog|QtQuick\.Dialogs' -- "${QML_FILES[@]}"; then
  fail "QML must not open FileDialog: it crashes Quickshell under the gtk3 platform theme"
fi
python3 - <<'PY'
from pathlib import Path

compose = Path("components/ComposeView.qml").read_text()
start = compose.index("function chooseFiles()")
end = compose.index("\n  function ", start + 1)
block = compose[start:end]
if 'enqueueAttach("pick")' not in block:
    raise SystemExit("test_source.sh: Attach must pick files out of process through attachment.sh")
if "FileDialog" in block or "execDetached" in block:
    raise SystemExit(
        "test_source.sh: Attach must not open an in-process dialog or a detached file manager"
    )
PY

printf 'test_source.sh ok\n'
