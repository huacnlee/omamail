# Omamail — Keybindings

How the keyboard works in this application, and why it is built this way.

## The model

**The keyboard belongs to the application, and the context says what a key
means where.** This is the model a TUI uses, and the one GPUI uses for actions:
a key is not owned by whichever widget happens to hold the focus — it is owned
by the app, and scoped to the contexts where it means something.

Everything follows from that:

- Every binding lives in one table, `keys/Keymap.js`. Nothing else describes a
  key. The shortcut sheet and the status-bar hints render from that table.
- `components/KeyRouter.qml` turns the table into `Shortcut` objects and reports
  what was pressed by id. `App.qml` answers with one `runShortcut` function.
- `Escape` is a binding like any other, not a `Keys.onEscapePressed` handler, so
  it does not depend on who holds the focus.

## The contexts

The window is in exactly one context at a time. `App.qml` derives it from what
is on screen, by precedence — a page is a form before it is anything else, a
draft beats reading, a query being typed beats the list underneath it:

```qml
readonly property string keyContext:
    root.showPage  ? "page"
  : root.composing ? "compose"
  : searchBar.fieldFocused ? "search"
  : root.calendarVisible ? "calendar"
  : root.currentView === "reader" ? "reader"
  : "list"
```

| Context | What it is | What it binds |
|---|---|---|
| `list` | The message list | The mailbox keys |
| `reader` | A message open | The mailbox keys, plus reply/forward and zoom. `j`/`k` move the cursor without opening; `o` or `Enter` opens what they landed on |
| `search` | A query being typed | `Escape`, and the modified keys |
| `compose` | A draft being written | `Escape`, `Ctrl+Return`, and the modified keys |
| `page` | Setup or settings | `Escape`, and the modified keys |
| `calendar` | The calendar month | Calendar navigation and the modified keys |

`mail` in the table below is shorthand for `list` and `reader`; `all` is every
context.

**A text-entry context binds no bare key but `Escape`.** That is the whole rule.
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

Generated from `keys/Keymap.js`. `tests/test_keymap.js` asserts this table
matches it, so the two cannot drift — three hand-written copies of this list
used to exist, and they had.

<!-- BEGIN BINDINGS -->
| id | keys | contexts | action |
|---|---|---|---|
| `cursorDown` | `j`, `Down` | mail | Move down |
| `cursorUp` | `k`, `Up` | mail | Move up |
| `open` | `Return`, `o` | mail | Open the selected message |
| `backToList` | `u` | reader | Back to the list |
| `archive` | `e` | mail | Archive |
| `trash` | `d` | mail | Move to trash |
| `star` | `s` | mail | Star or unstar |
| `markRead` | `Shift+I` | mail | Mark read |
| `markUnread` | `Shift+U` | mail | Mark unread |
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
| `send` | `Ctrl+Return` | compose | Send |
| `undoSend` | `Alt+Z` | all | Undo send |
| `search` | `/` | mail | Search |
| `goMailbox` | `Ctrl+1`, `Ctrl+2`, `Ctrl+3`, `Ctrl+4`, `Ctrl+5`, `Ctrl+6`, `Ctrl+7`, `Ctrl+8`, `Ctrl+9`, `Ctrl+0` | mail | Go to that mailbox |
| `goAccount` | `Alt+1`, `Alt+2`, `Alt+3`, `Alt+4`, `Alt+5`, `Alt+6`, `Alt+7`, `Alt+8`, `Alt+9`, `Alt+0` | mail+calendar | Go to that email account |
| `switchAccount` | `Alt+A` | mail | Switch account |
| `calendar` | `Alt+C` | mail+calendar | Switch between mail and calendar |
| `mailView` | `Ctrl+Shift+M` | mail+calendar | Go to mail |
| `calendarView` | `Ctrl+Shift+C` | mail+calendar | Go to calendar |
| `toggleSidebar` | `[` | mail+calendar | Show or hide the sidebar |
| `zoomIn` | `Ctrl++`, `Ctrl+=` | reader | Zoom the message body in |
| `zoomOut` | `Ctrl+-` | reader | Zoom the message body out |
| `zoomReset` | `Ctrl+Shift+0` | reader | Reset the zoom |
| `refresh` | `F5` | all | Check for mail |
| `settings` | `Ctrl+,` | all | Open settings |
| `help` | `Ctrl+K`, `?`, `Ctrl+/`, `Ctrl+?` | mail | Toggle all keybindings |
| `back` | `Escape` | all | Back, or close the window |
<!-- END BINDINGS -->

The bare `/` stays in the mailbox because fields need it as text. `Ctrl+K`
opens the complete key sheet from every context.

In Drafts, `Enter` and `o` preview the selected draft. Press `c` to edit it. In every other mailbox, `c` starts a new message.

The delayed-send toast does not create a keyboard context. The current screen keeps its normal keys while the toast is visible. A new draft, reply, or forward can open during the delay. The send button waits for the queued message, but every draft field remains editable. The toast button restores the queued message. `Alt+Z` does the same from every context. `Ctrl+Z` remains text undo while composing or searching. If another compose is open, Omamail saves it to the provider's Drafts storage before dropping its in-memory fallback. A failed save keeps that fallback. Back and `Escape` save a non-empty composition before leaving it. The explicit Discard button remains the destructive exit.

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

`Ctrl+1`…`Ctrl+0` replaces both. A modifier has no deadline, and **holding Ctrl
puts the digit on every row of the rail**, so there is nothing to remember —
the rail says which key opens it. The numbers run down the rail as it is drawn,
mailboxes first and then the server's labels, from `Model.sidebarSlots`, which
is the same list the badges are drawn from: the number beside a row and the row
a number opens are one fact rather than two. Past the tenth row there is simply
no number, because there is no digit left to offer.

Held Ctrl is the one `Keys` handler in `App.qml`, and it is not a binding — a
modifier alone cannot be a `Shortcut`, so there is nothing to route. It accepts
no event, so what follows Ctrl still goes where it always went. It clears on
`activeFocus` rather than on release because Ctrl+Tab can take the release, and
waiting for one that is not coming would paint the numbers on permanently.

`Escape` is the only bare key bound everywhere, because it is the way out of
everywhere. What it means in each place is one list in `goBack()`, in the order
the window is stacked.

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
table like any other key, and from there `j`, `k`, `Enter` and `o` come from a
`Keys` handler on the popup's own `contentItem`: the one place in this window
where the rule at the top of this document runs backwards.
`tests/qml/tst_popup_keys.qml` holds the Qt behaviour that makes it so, and
`Model.wrappedIndex` holds the only decision in it — the cursor wraps, where the
message list clamps.

## The cursor

`cursorId` is where the keyboard is. `selectedId` is what the reader shows.
They are two different things, and conflating them was the first bug in this
area: movement was anchored on the opened message, so in the list — where
nothing is open — every step resolved to the first row, and `j` moved once and
then stopped.

Three rules, all in `account/Model.js` so the node tests reach them:

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
`moveCursor`, not from `cursorId` changing, because hovering a row moves the
cursor too and scrolling under the pointer fights the mouse.

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
`tests/qml/tst_hover_under_scroll.qml` pins the Qt behaviour that makes this so.

## Adding a key

1. Add a row to `BINDINGS` in `keys/Keymap.js`. Name the contexts it means
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
did lives in `goBack()` now.

And one thing that is *not* a problem, recorded because it was assumed to be:
Qt already gives a focused `TextInput` the bare keys before any `Shortcut` sees
them. Typing a letter into a visible field never fired a shortcut. The old
hand-written "is the user typing" guard was not holding that line, and removing
it changed no behaviour.

## Not here

**User-configurable bindings.** The table makes it possible — the rows are data
— but nothing has asked for it, and a config file for bindings needs a merge
story and a conflict story this does not need.
