# Omamail — Keybindings

How the keyboard works in this application, and why it is built this way.

## The model

**The keyboard belongs to the application, and the context says what a key
means where.** This is the model a TUI uses, and the one GPUI uses for actions:
a key is not owned by whichever widget happens to hold the focus — it is owned
by the app, and scoped to the contexts where it means something.

Everything follows from that:

- Every binding lives in one table, `ui/keys/Keymap.js`. Nothing else describes a
  key. The shortcut sheet and the status-bar hints render from that table.
- `ui/components/KeyRouter.qml` turns the table into `Shortcut` objects and reports
  what was pressed by id. `App.qml` answers with one `runShortcut` function.
- `Escape` is a binding like any other, not a `Keys.onEscapePressed` handler, so
  it does not depend on who holds the focus.

## The contexts

The window is in exactly one context at a time. `App.qml` derives it from what
is on screen, by precedence — a page is a form before it is anything else, a
draft beats reading, a query being typed beats the list underneath it:

```qml
readonly property string keyContext:
    root.assistantEditing ? (root.activeAssistant.commandsOpen ? "assistantCommands" : "assistant")
  : root.showPage  ? "page"
  : root.composing ? "compose"
  : searchBar.fieldFocused ? "search"
  : root.calendarVisible ? "calendar"
  : root.currentView === "reader" ? "reader"
  : "list"
```

| Context | What it is | What it binds |
|---|---|---|
| `list` | The message list | The mailbox keys |
| `reader` | A message open | The mailbox keys, plus reply/forward and zoom. `j`/`k` move the mailbox cursor and immediately open its message; `Shift+J`/`Shift+K` scroll the message body |
| `search` | A query being typed | `Escape`, and the modified keys |
| `compose` | A draft being written | `Escape`, `Ctrl+Return`, and the modified keys |
| `assistant` | Typing or reading in the AI dock | `Return`/`Enter` sends, `Escape`, and the modified keys |
| `assistantCommands` | Choosing an AI slash command | `Up`, `Down`, `Return`, `Enter`, `Escape`, and the modified keys |
| `page` | Setup or settings | `Escape`, and the modified keys |
| `calendar` | The calendar month | Calendar navigation and the modified keys |

`Ctrl+,` opens Settings from every context, including a focused draft field.
Back returns to the previous screen with the draft intact.

While an AI request is running, Escape interrupts it and keeps the dock open;
otherwise Escape closes the dock. An open command menu or history view is left first.

The AI input uses `assistant`: Return/Enter sends and Shift+Return/Enter inserts
a newline. Ctrl+Return/Enter also sends for compatibility.
While `/` command candidates are visible, `assistantCommands` owns Up/Down and
Return/Enter; choosing a command inserts a highlighted slash token without sending it.
Tokens expand into their full instructions only when sent. Editing through a token
(including Backspace, Delete, or a selection replacement) removes the whole command;
ordinary text around it remains editable. This is text-edit normalization, not an
additional key binding. Escape
first dismisses those candidates, then closes the dock. Both contexts keep the
keyboard in the AI text area.
The `assistantSend` row's `sequenceContexts` restricts bare Return/Enter to
`assistant`, so those keys choose a candidate in `assistantCommands` instead.
Shift+Return/Enter remains ordinary text input in both contexts.

Qt 6.11's native `TextArea` accepts `ShortcutOverride` for editing keys even
after `Keys.onShortcutOverride` leaves the event unaccepted. This was measured
with a focused text area and a window Down shortcut: the shortcut never fired.
The AI text area therefore forwards its `Keys.onPressed` event unchanged to
`KeyRouter.routeKeyEvent`. The router decodes the key and applies the same
`Keymap.js` bindings and context as its window shortcuts. This is one router
with two event entry points, not a second set of local bindings. An unbound
event is left alone, preserving normal typing, IME input and line breaks.

`mail` in the table below is shorthand for `list` and `reader`; `all` is every
context.

**A text-entry context binds no bare key but `Escape`, except AI send and command
selection described above.**
There is no "is the user typing" question anywhere in the code, because there is
nothing left for it to answer: if a bare letter is not bound in `compose`, it
cannot fire there, and the field gets it the way any other character arrives.

## One mechanism

**The context owns the keyboard.** Changing context moves the focus — to
whatever that context types into, or to a parked home item when the context
types into nothing:

```qml
onKeyContextChanged: Qt.callLater(applyContextFocus)
function applyContextFocus() {
  if (keyContext === "compose") compose.takeFocus()
  else if (keyContext === "search") searchBar.focusField()
  else parkKeyboard()
}
```

This is the part that has to stay one thing. When the context came from what was
on screen and the focus stayed wherever the last click left it, the two drifted:
closing a reply left its text field holding the keyboard while invisible, Qt kept
handing that field every keystroke, and `j` and `k` were simply gone for the rest
of the session. Nothing warned — the keys stopped arriving.

`ComposeView` therefore does **not** place its own focus when it opens. Opening
it changes the context, and the context moves the keyboard. One mechanism, so
the two cannot disagree.

## The bindings

Generated from `ui/keys/Keymap.js`. `ui/tests/test_keymap.js` asserts this table
matches it, so the two cannot drift — three hand-written copies of this list
used to exist, and they had.

This table is the **defaults**. A user can move most of these keys from the
Keyboard section of Settings; see [The overrides](#the-overrides) below. The
override is a filter in front of one accessor, so the table stays the single
description of what a key means and only which key carries a meaning changes.

<!-- BEGIN BINDINGS -->
| id | keys | contexts | action |
|---|---|---|---|
| `cursorDown` | `j`, `Down` | mail | Move down |
| `cursorUp` | `k`, `Up` | mail | Move up |
| `scrollDown` | `Shift+J` | reader | Scroll down |
| `scrollUp` | `Shift+K` | reader | Scroll up |
| `open` | `Return`, `Enter`, `o` | mail | Open the selected message |
| `openReader` | `Right` | list | Open the selected message |
| `backToList` | `u`, `Left` | reader | Back to the list |
| `nextMember` | `n` | reader | Next message in the conversation |
| `previousMember` | `p` | reader | Previous message in the conversation |
| `archive` | `e` | mail | Archive |
| `trash` | `d` | mail | Move to trash |
| `star` | `s` | mail | Star or unstar |
| `moveToLabel` | `v` | mail | Move to |
| `markRead` | `Shift+I` | mail | Mark read |
| `markUnread` | `Shift+U` | mail | Mark unread |
| `toggleCheck` | `x`, `Space` | mail | Select or deselect the message |
| `checkAll` | `Ctrl+A` | list | Select every message loaded, or none |
| `reply` | `r` | mail | Reply |
| `replyAll` | `a` | mail | Reply to all |
| `forward` | `f` | mail | Forward |
| `compose` | `c` | mail | Compose or edit a draft |
| `createEvent` | `c` | calendar | Create an event |
| `calendarNext` | `j`, `Down` | calendar | Select the next event |
| `calendarPrevious` | `k`, `Up` | calendar | Select the previous event |
| `openCalendarEvent` | `Return`, `o` | calendar | Open the selected event |
| `calendarPreviousPeriod` | `h`, `Left` | calendar | Previous week or month |
| `calendarNextPeriod` | `l`, `Right` | calendar | Next week or month |
| `calendarToday` | `t` | calendar | Go to today |
| `calendarWeek` | `w` | calendar | Show week view |
| `calendarMonth` | `m` | calendar | Show month view |
| `send` | `Ctrl+Return`, `Ctrl+Enter` | compose | Send |
| `undoSend` | `Alt+Z` | all | Undo send |
| `search` | `/` | mail | Search |
| `goMailbox` | `Ctrl+1`, `Ctrl+2`, `Ctrl+3`, `Ctrl+4`, `Ctrl+5`, `Ctrl+6`, `Ctrl+7`, `Ctrl+8`, `Ctrl+9` | mail | Go to that mailbox |
| `goAccount` | `Alt+1`, `Alt+2`, `Alt+3`, `Alt+4`, `Alt+5`, `Alt+6`, `Alt+7`, `Alt+8`, `Alt+9`, `Alt+0` | mail+calendar | Go to that email account |
| `switchAccount` | `Alt+A` | mail | Switch account |
| `askAgent` | `Alt+G` | mail+compose | Ask AI about the message or draft |
| `assistantSend` | `Return`, `Enter`, `Ctrl+Return`, `Ctrl+Enter` | assistant+assistantCommands | Send the AI message |
| `assistantCommandUp` | `Up` | assistantCommands | Previous AI command |
| `assistantCommandDown` | `Down` | assistantCommands | Next AI command |
| `assistantChooseCommand` | `Return`, `Enter` | assistantCommands | Fill the selected AI command |
| `calendar` | `Alt+C` | mail+calendar | Switch between mail and calendar |
| `mailView` | `Ctrl+Shift+M` | mail+calendar | Go to mail |
| `calendarView` | `Ctrl+Shift+C` | mail+calendar | Go to calendar |
| `toggleSidebar` | `[` | mail+calendar | Show or hide the sidebar |
| `zoomIn` | `Ctrl++`, `Ctrl+=` | reader | Zoom the message body in |
| `zoomOut` | `Ctrl+-` | reader | Zoom the message body out |
| `zoomReset` | `Ctrl+0` | reader | Reset the zoom |
| `refresh` | `F5`, `Ctrl+R` | all | Check for mail |
| `settings` | `Ctrl+,` | all | Open settings |
| `help` | `?` | mail | Toggle all keybindings |
| `back` | `Escape` | all | Back, or close the window |
<!-- END BINDINGS -->

The bare `?` opens the complete key sheet from mail. In a text-entry context it
stays text, like every other bare character except `Escape`.

In Drafts, `Enter`, `o` and `c` open the selected draft in the composer, with what was written in it; `j`, `k` and a click open it in the reader. Leaving an unchanged draft closes it immediately. After edits, Back offers Save draft, Discard, or Cancel; saving updates the draft it came from, and sending takes that draft away. In every other mailbox, `c` starts a new message.

`Space` or `x` toggles the cursor row's selection in the list or reader context. Shift+click applies the clicked row's next checked state to the inclusive range from the cursor: an unchecked endpoint selects the range, and a checked endpoint clears it. Selections outside the range remain unchanged; the cursor then moves to the clicked row.

`n` and `p` walk the conversation rail beside the message on a provider whose listing collapses to conversations, opening the next and previous member in the same reader and stopping at the ends. The rail runs newest at the top, so `n` opens the stop below the open message, which is the older one, and `p` the stop above it, the newer — the keys follow the rail as it is drawn, the way `j` and `k` follow the list. They move the reader and nothing else. `j` and `k` move the list cursor and immediately open the representative of that row, leaving the conversation member selected with `n` or `p`. A message whose conversation has one member draws no rail, and both keys then do nothing. A right-click on a stop opens the same menu a row has — reply, archive, trash, spam, read, star — for that one message: the action reaches the member alone, where the same verb on the row reaches every counted member, and if the open message is the one taken out of the view the reader moves to the stop beside it, the newer one above or else the older below.

The delayed-send toast does not create a keyboard context. The current screen keeps its normal keys while the toast is visible. A new draft, reply, or forward can open during the delay. The send button waits for the queued message, but every draft field remains editable. The toast button restores the queued message. `Alt+Z` does the same from every context. `Ctrl+Z` remains text undo while composing or searching. If another compose is open, Omamail saves it to the provider's Drafts storage before dropping its in-memory fallback. A failed save keeps that fallback.

Back and `Escape` close an untouched composition immediately without saving, including a prefilled reply, forward, or existing provider draft. After a user edit, they open a modal with Cancel, Discard, and Save draft. Save draft initially has focus; Tab and Shift+Tab cycle through the buttons, and Enter activates the focused choice. Escape inside the popup cancels and returns to composing. A failed save restores the changed draft. The composer's bottom Discard button exits immediately.

## Why the rail is numbered and not chorded

`g i`, `g s`, `g u` and `g t` used to open the mailboxes, and they were two
problems in one row.

They were a chord, and Qt puts a deadline on an unfinished one:
`styleHints.keyboardInputInterval`, 400ms here. Press `g`, think for half a
second, press `i`, and nothing happens — no mailbox, no error, no hint that a
clock had been running. Measured, not guessed:
`0ms → fires · 300ms → fires · 500ms → dead · 800ms → dead`.

And they had to be memorised. Four bindings that look like nothing on screen,
for the four places you actually go.

`Ctrl+1`…`Ctrl+9` replaces both. A modifier has no deadline, and **holding Ctrl
puts the digit on every row of the rail**, so there is nothing to remember —
the rail says which key opens it. The numbers run down the rail as it is drawn,
mailboxes first and then the server's labels, from `Model.sidebarSlots`, which
is the same list the badges are drawn from: the number beside a row and the row
a number opens are one fact rather than two. Past the ninth row there is simply
no number: `Ctrl+0` is reset zoom, the way it is in every browser, and the
rail does not take it.

Held Ctrl is the one `Keys` handler in `App.qml`, and it is not a binding — a
modifier alone cannot be a `Shortcut`, so there is nothing to route. It accepts
no event, so what follows Ctrl still goes where it always went. It clears on
`activeFocus` rather than on release because Ctrl+Tab can take the release, and
waiting for one that is not coming would paint the numbers on permanently.

`Escape` is the only bare key bound everywhere, because it is the way out of
everywhere. With rows ticked and the list on screen — alone, or beside the
reader in a wide window — it unticks them first and goes nowhere; the next
press goes back. Where it goes is not decided by the key: the window keeps a history
of the places it has been — a stack in `App.qml`, ruled by
`ui/account/Navigation.js` — and `Escape`, like every Back bar, calls `back()`,
which pops one entry. A draft, the event form and the shortcut sheet are
entries too, so the sheet closes before the message under it, and a reply
raised from the list returns to the list, not to the message it opened on the
way. On the root, `back()` clears a search if there is one and otherwise closes
the window.

## What survives an overlay

The shortcut sheet sits on top of the mailbox, and `survivesOverlay` is the
whole guard: without it a row goes dead while the sheet is up, which is why `e`
cannot archive behind it.

Four rows carry it. `help` and `back` keep their own meaning — they are how the
sheet goes away. `cursorDown` and `cursorUp` are handed to the sheet instead, to
scroll it, in `runShortcut`. A sheet taller than the window that could only be
read with a mouse would be the one screen here that contradicts the rest.

**The account switcher is not on that list, and cannot be.** It is a
`QQC.Popup`, and an open popup takes every key before the shortcut map sees it —
`focus` true or false, bare key or modified. So `Alt+A` opens it through the
table like any other key, and from there the keys come from the search line at
the top of the popup — the one place in this window where the rule at the top
of this document runs backwards. Letters narrow the rows to the mailboxes they
name, by the name they were given or their address; `Down` and `Up`, or `Ctrl`
with `j`, `k`, `n` or `p`, walk what is left; `Enter` opens the row the cursor
is on. A bare `j` or `k` is a letter there now, as it has to be for "jack" to
find a mailbox.
`ui/tests/qml/tst_popup_keys.qml` holds the Qt behaviour that makes it so, and
`Model.wrappedIndex` holds the only decision in it — the cursor wraps, where the
message list clamps.

## The cursor

`cursorId` is where the keyboard is. `selectedId` is what the reader shows.
They are two different things, and conflating them was the first bug in this
area: movement was anchored on the opened message, so in the list — where
nothing is open — every step resolved to the first row, and `j` moved once and
then stopped.

`j`, `k`, `Down` and `Up` now move the cursor and immediately open the row in
the reader, in both wide and narrow windows. There is no preview settling delay
or read dwell: the same explicit-open path displays cached content or fetches
the message and marks it read when that path normally would. Prefetching stays
separate and never marks a message read. Moving at a list boundary does not
reopen the same message. The context continues to park focus outside text fields,
so successive navigation keys work while the reader is open.

`s` is the one acting key that follows the reader rather than the cursor. With a message open it stars the open message, on every provider, because that is the star the button beside it draws; `e` and `d` act on the cursor row, which is the row the open message belongs to. The difference only shows on a provider whose listing collapses to conversations, where `n` and `p` can walk the reader onto a member while the cursor stays on the row.

Three rules, all in `ui/account/Model.js` so the node tests reach them:

- **`cursorAfterOffset`** — moving. Anchored on the cursor itself, clamped at
  both ends, and starting from the end the move came from when there is no
  cursor yet, so `j` opens at the top and `k` at the bottom.
- **`cursorAfterRemoval`** — the row the cursor is on is about to leave, because
  it was archived or trashed. The cursor takes its place: the row below, or the
  row above at the end. Worked out *before* the action, while the row still has
  neighbours.
- **`cursorAfterReload`** — the whole list was replaced, by a mailbox switch, a
  search, or a refresh. A cursor whose message survived keeps its place; one
  whose message is gone starts at the top.

The last two exist because a cursor pointing at a message that is not listed
cannot be found, and `cursorAfterOffset` restarts at the top from there. Every
"the cursor jumped back to the first row" report is that.

The list is a `Column` of rows inside a `Flickable`, not a `ListView` — the
panel already owns a scroller, and nesting a second gives every wheel event two
plausible targets. So there is no `positionViewAtIndex`, and keyboard movement
has to scroll the list itself: **`Model.contentYToReveal`** decides where the
scroller goes, leaving it alone while the row is already visible so stepping one
row does not drag the list under someone reading it. It is called from
`moveCursor`, not from `cursorId` changing. Hover never changes the cursor, and
scrolling under the pointer would fight the mouse.

## The mouse

The mouse does not move the keyboard's cursor. A row draws its own hover
(`MessageRow.hot`), clicking one opens it, and right-clicking one sets the
cursor explicitly before opening its menu — but hovering does nothing to
`cursorId`.

That is not a preference. Qt re-reports hover when content moves under a
pointer that has not moved, and the list scrolls to follow the keyboard. With
hover writing `cursorId`, pressing `j` moved the cursor, the scroll brought a
different row under the still pointer, and the cursor snapped back to it — so
`j` and `k` stuck on whichever rows the mouse was resting near.
`ui/tests/qml/tst_hover_under_scroll.qml` pins the Qt behaviour that makes this so.

## Adding a key

1. Add a row to `BINDINGS` in `ui/keys/Keymap.js`. Name the contexts it means
   something in — that is the guard, and there is no other. A `display` string
   is how the sheet shows a range instead of enumerating every key.
2. Add a case to `runShortcut` in `App.qml`. The second argument is the
   sequence that fired, which is how a row of several keys tells them apart —
   read it with `slotFor`, never by parsing the string.
3. Add the row to the table above. The test will tell you if you forget.

That is all. The shortcut sheet and the status hints pick it up on their own.

## Why it looks like this

Four things were found by running the code rather than reading it. Each cost a
release-shaped bug, and each is now pinned by a test.

**A `Repeater` builds no `Shortcut`s.** A `Shortcut` is a `QtObject` and a
`Repeater` only builds `Item`s, so a `Repeater` creates nothing at all and every
key goes silently dead. `KeyRouter` uses an `Instantiator`.

**`FloatingWindow` does not forward `activeFocusItem`.** Quickshell's window is a
proxy; reading `window.activeFocusItem` gives `undefined`, which reads as falsy
and quietly passes every guard built on it. The attached `Window.activeFocusItem`
is the one that works.

**`forceActiveFocus()` on a `FocusScope` is a no-op.** It re-elects that scope's
current focus item — which is the field you are trying to leave. Parking the
keyboard has to land on a plain `Item`.

**A window `Shortcut` beats a focused item's `Keys` handler.** A local
`Keys.onEscapePressed` looks live and never runs. `SearchBar` had one; what it
did lives in `goBack()` now, which clears the field and then hands the key to
`back()`.

And one thing that is *not* a problem, recorded because it was assumed to be:
Qt already gives a focused `TextInput` the bare keys before any `Shortcut` sees
them. Typing a letter into a visible field never fired a shortcut. The old
hand-written "is the user typing" guard was not holding that line, and removing
it changed no behaviour.

## The overrides

The rows were always data, and nothing consumed a second copy of them — so a
user override is a filter in front of one accessor, `effectiveKeys`, not a
merge every reader has to learn. `keys/Keymap.js` holds a map of id → keys that
starts empty; everything that lists, draws, or fires a binding reads
`effectiveKeys(row)` rather than `row.keys`, so an override reaches the router,
the help sheet and the status hints together.

- **The table is still the defaults.** An override is dropped the moment it
  equals the row's own keys, so a reset is the absence of an entry rather than
  a copy of the default sitting on top of it. `keys/Keymap.js` is the only
  description of what a key *means*; the override map only changes which key
  carries it.
- **The file is `keybindings.json`**, beside the other non-secret preferences
  — `shell.json` is world-readable, so plugin settings were never the home for
  it. `{ "version": 1, "bindings": { "archive": ["z"] } }`. It is read and
  written by `keys/KeybindingsStore.qml` — beside the table rather than in
  `components/`, which draws what it is given and decides nothing. It goes
  through `Service.writeConfig` rather than running `scripts/config-store.sh`
  itself: the standalone app has no plugin directory and no shell scripts, and
  reaches the same file through its native host. A write that fails says so on
  `saveError`, because the rebind is live either way and would otherwise be
  gone at the next launch with nothing having said why. `Keymap.setOverrides`
  sanitises whatever it is handed — unknown ids, structural ids, empty lists,
  letter case and modifier order — so no hand-edited file can leave the
  keyboard unusable. It is not a validator: a string `QKeySequence` cannot
  parse costs that one row its key until it is reset, which is what the Reset
  in the Keyboard section is for.
- **What is the user's to move:** everything that is not structural and does
  not live in a text-entry context. `back` (Escape) and the two numbered rails
  are structural. A binding that lives in `search`, `compose`, or `page` is out
  because a text-entry context binds no bare key but Escape — a rebind there
  would have to carry a modifier and mean something Qt hands the field first
  anyway, which is the same reason the table never put a bare key in one.
  `assistant` and `assistantCommands` are out for the same reason and one
  more: the bare keys the table does put there are reachable only through
  `KeyRouter.routeKeyEvent`, which decodes `Up`, `Down`, `Return` and `Enter`
  and nothing else, so a row moved onto any other key in the dock would report
  success and then never fire. `Keymap.isRebindable` decides this from the
  contexts, not a second list, so a row that gains a text context stops being
  rebindable on its own.
- **A rebind replaces the row's whole key list.** `open` answers to `Return`,
  `Enter` and `o`; recording `p` for it leaves `p` and nothing else. The
  settings row shows the keys before and after, so it is visible, but there is
  no way to add a second key to a row — one capture, one key, and Reset to get
  the row's own list back.
- **`Ctrl+W` and `Ctrl+F4` are refused.** They are `StandardKey.Close`, which
  `app/qml/Main.qml` declares application-wide while `KeyRouter`'s delegates
  are deliberately window-scoped so a mailbox key can never tie with it. Qt
  answers a tie by firing neither, so an override landing there would take the
  standalone window's Close with it.
- **A recorded collision is refused before it reaches the file.**
  `Keymap.checkBinding` applies the candidate tentatively, runs the same
  `conflicts()` scan the table already trusts, reverts, and returns the sentence
  the settings row shows — rather than a second copy of the context-overlap
  logic.
- **A collision that gets in another way is shown, not silent.** A Reset does
  not pass through `checkBinding`, so resetting a binding back to a default that
  another binding has since been moved onto — or loading a hand-edited
  `keybindings.json` — can still put two actions on one key. `Keymap.conflictReport`
  reads `conflicts()` back and the Keyboard section lists each one: the key,
  where, the two actions, and a Reset for whichever side carries the override.
  A Reset is never itself refused — there always has to be a way back to the
  defaults.
- **Recording a key** is `keys/Capture.js`: a Qt key event becomes the sequence
  string the table and `QKeySequence` both speak. It is ASCII only, because a
  sequence Qt can bind and round-trip is Latin. The catcher that reads the
  press is `components/KeyCapture.qml` — that one *is* a view — held by the window rather than by the
  settings row — a window `Shortcut` beats a focused item's `Keys` handler, so
  `KeyRouter` stands its Shortcuts down (`suspended`) while a key is being
  recorded and the catcher takes what is left. It knows nothing about
  bindings: it reports a press and a cancel, and the window decides what
  either means.
- **Nudging the consumers.** `Keymap.js` is a shared library and its override
  map changing emits no QML signal, so `KeybindingsStore` bumps a revision,
  `App.qml` publishes it as `keymapRevision`, and `KeyRouter`, `ShortcutHelp`,
  the status hints, the empty reader's legend and the row's select tooltip read
  it to know they have to rebuild from the new keys. Anything that draws a key
  and does not read it will quietly go on naming the old one.

## Not here

**Chords, and rebinding onto one.** The capture field records a single
sequence, and the table has no chord in it — see *Why the rail is numbered and
not chorded* above.

**Per-context overrides.** One id, one key, everywhere that id already means
something. A row that is live in the mailbox and the calendar moves in both or
neither.

The AI dock occupies the right side and reduces the mail/composer area. Its own text-entry context prevents mailbox keys from firing while asking AI. Clicking back into the draft restores its normal editing context. Escape closes the dock before leaving the underlying mail or draft, and restores the previous focus.
