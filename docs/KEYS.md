# Omamail — Keybindings

How the keyboard works in this application, and why it is built this way.

## The model

**The keyboard belongs to the application, and the context says what a key
means where.** This is the model a TUI uses, and the one GPUI uses for actions:
a key is not owned by whichever widget happens to hold the focus — it is owned
by the app, and scoped to the contexts where it means something.

Everything follows from that:

- Every binding lives in one table, `BINDINGS` in `src/keys/keymap.ts`. Nothing else describes a key. The shortcut sheet (`src/shell/ShortcutHelp.tsx`) and the status-bar hints render from that table.
- `src/keys/router.ts` binds the keys that are live in the current context through NSH's `keymap.bind`, and runs what was pressed by id. Features answer an id with `registerCommand` from `src/keys/commands.ts`; the router itself answers the navigation ids no feature claims.
- `Escape` is a binding like any other, not a field's own key handler, so it does not depend on who holds the focus.

## The contexts

The window is in exactly one context at a time. `contextFor` in `src/keys/keymap.ts` derives it from what is on screen, by precedence — a page is a form before it is anything else, a draft beats reading, a query being typed beats the list underneath it. The router's `keyContext` feeds it from the app store and from what features report with `reportKeyState`:

```ts
if (value.assistantEditing) return value.assistantCommands ? "assistantCommands" : "assistant";
if (value.showPage) return "page";
if (value.eventComposing) {
  return value.guestSuggestions ? "eventGuests" : value.eventDescriptionFocused ? "eventDescription" : "eventCompose";
}
if (value.composing) return "compose";
if (value.searchFocused) return "search";
if (value.calendarVisible) return "calendar";
if (value.currentView === "reader") return "reader";
return "list";
```

A draft in its own window has the compose context while that window has the keyboard, whatever the mail window behind it shows.

| Context | What it is | What it binds |
|---|---|---|
| `list` | The message list | The mailbox keys |
| `reader` | A message open | The mailbox keys, plus reply/forward and zoom. `j`/`k` move the mailbox cursor and immediately open its message; `Shift+J`/`Shift+K` scroll the message body |
| `search` | A query being typed | `Escape`, and the modified keys |
| `compose` | A draft being written | `Escape`, `Ctrl+Return`, and the modified keys |
| `eventCompose` | Creating or editing an event | `Enter` saves and closes after success; `Escape` closes; modified keys remain available |
| `eventDescription` | Writing an event description | `Enter` inserts a line break; `Ctrl+Enter` saves; `Escape` closes |
| `assistant` | Typing or reading in the AI dock | `Return`/`Enter` sends, `Escape`, and the modified keys |
| `assistantCommands` | Slash-command suggestions | Up/Down selects, Return/Enter completes or executes, Escape dismisses |
| `page` | Setup or settings | `Escape`, and the modified keys |
| `calendar` | The calendar | Calendar navigation, hour zoom in the day and week views, and the modified keys |

`Ctrl+,` opens Settings from every context, including a focused draft field.
Back returns to the previous screen with the draft intact.

While an AI request is running, Escape interrupts it and keeps the dock open; otherwise Escape closes the dock before leaving the underlying mail or draft and restores the previous focus. An open command suggestion or history view is left first.

The AI input uses `assistant`: Return/Enter sends and Shift+Return/Enter inserts a newline. Ctrl+Return/Enter also sends for compatibility. Typing `/` offers `/clear` (new chat), `/history` (conversation history), and `/diagnose` (diagnostics). Up/Down selects a suggestion; Return/Enter completes a partial command or executes an exact command immediately; choosing `/history` always opens the history at once. Commands stay local. Outside suggestions, Up/Down retain normal text navigation.

Changing the AI agent or model starts fresh chats and clears queued follow-ups while preserving unsent input. Previous chats remain readable in History, but cannot continue across the selection change; the cutoff persists across restarts. New chats created afterward can still resume normally.

In a text-entry context the router binds that context's few keys with `when: "always"`, so they reach the app before the focused field; `Escape` is bound that way in every context. Every other key goes to the field, so normal typing and line breaks are untouched. While an input method is composing (pinyin, kana, hangul), the router binds nothing at all, not even `Escape`: Return picks a candidate and Escape cancels the composition. Every ui text field reports its focus and composition to `src/ui/ime.ts`; `src/ui/ime.test.tsx` and `src/features/assistant/cjk.test.tsx` cover it.

`mail` in the table below is shorthand for `list` and `reader`; `all` is every
context.

**A text-entry context binds no bare key but `Escape`, except AI send/command selection described above and Enter to save in single-line event fields.** The multiline event description keeps Return/Enter for line breaks, including pasted paragraphs; Ctrl+Return/Enter saves from either type of field. `src/keys/keymap.test.ts` checks the rule over the whole table.

If a bare letter is not bound in `compose`, it cannot fire there, and the field gets it the way any other character arrives. Outside the text-entry contexts the one typing question is asked once, in the router: while a ui text field has the focus (`textInputActive` in `src/ui/ime.ts`), the single-key shortcuts stand aside and the field gets its letters.

## One mechanism

Implementation constraints: never bind a key yourself; answer a binding id with `registerCommand` (the newest registration wins, and it goes when the component that made it unmounts). A key is bound only while something answers it, so an unclaimed key reaches the focused control. A popup that walks its own rows takes its keys with `pushKeyLayer`, which the router binds over the table in every context (`PickerKeys` in `src/features/mailbox/LabelMenu.tsx`). Something Escape should close before going back registers with `registerEscape`. Provider actions must be refused before optimistic updates even when their buttons are hidden; filter hints with `hintsFor` in `src/keys/keymap.ts` too.

**The context owns the keyboard, not the focused field.** The router binds again whenever the context, the focused text field, the open key layer or the shortcut sheet changes, and binds only what is live there.

This is the part that has to stay one thing. In the Qt client the context came from what was on screen while the focus stayed wherever the last click left it, and the two drifted: closing a reply left its invisible text field holding the keyboard, and `j` and `k` were gone for the rest of the session. Nothing warned — the keys stopped arriving. Here a field leaves the focused set when it loses the focus and when it unmounts (`trackTextField` in `src/ui/ime.ts`), so a closed draft cannot keep the letters; `src/ui/ime.test.tsx` checks that a field removed mid-composition leaves the app's keys on.

A draft places its own focus when it opens: the body for a reply or a saved draft, otherwise the first empty line, To and then Subject (`src/features/compose/ComposeView.tsx`).

## The bindings

Generated from `src/keys/keymap.ts`. `scripts/check-keys.ts`, run by `make check`, asserts this table matches it, so the two cannot drift — three hand-written copies of this list used to exist, and they had.

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
| `archive` | `e` | mail | Archive (in Archive: move to Inbox) |
| `trash` | `d` | mail | Move to trash (in the trash: restore) |
| `star` | `s` | mail | Star or unstar |
| `moveToLabel` | `v` | mail | Move to |
| `openInBrowser` | `b` | mail | Open in browser |
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
| `calendarDay` | `d` | calendar | Show day view |
| `calendarAgenda` | `a` | calendar | Show agenda view |
| `calendarUndo` | `u` | calendar | Undo the last event change |
| `calendarMonth` | `m` | calendar | Show month view |
| `calendarZoomIn` | `Ctrl++`, `Ctrl+=` | calendar | Make hours taller in the day and week views |
| `calendarZoomOut` | `Ctrl+-` | calendar | Make hours shorter in the day and week views |
| `calendarZoomReset` | `Ctrl+0` | calendar | Return to the automatic hour height |
| `send` | `Ctrl+Return`, `Ctrl+Enter` | compose | Send |
| `saveEvent` | `Return`, `Enter`, `Ctrl+Return`, `Ctrl+Enter` | eventCompose+eventDescription | Save and close the event |
| `guestNext` | `Down` | eventGuests | Next guest suggestion |
| `guestPrevious` | `Up` | eventGuests | Previous guest suggestion |
| `guestChoose` | `Return`, `Enter` | eventGuests | Choose guest suggestion |
| `undoSend` | `Alt+Z` | all | Undo send |
| `search` | `/` | mail | Search |
| `goMailbox` | `Ctrl+1`, `Ctrl+2`, `Ctrl+3`, `Ctrl+4`, `Ctrl+5`, `Ctrl+6`, `Ctrl+7`, `Ctrl+8`, `Ctrl+9` | mail | Go to that mailbox |
| `goAccount` | `Alt+1`, `Alt+2`, `Alt+3`, `Alt+4`, `Alt+5`, `Alt+6`, `Alt+7`, `Alt+8`, `Alt+9`, `Alt+0` | mail+calendar | Go to that email account |
| `switchAccount` | `Alt+A` | mail | Switch account |
| `askAgent` | `Alt+G` | mail+compose | Ask AI about the message or draft |
| `assistantSend` | `Return`, `Enter`, `Ctrl+Return`, `Ctrl+Enter` | assistant+assistantCommands | Send the AI message |
| `assistantCommandNext` | `Down` | assistantCommands | Next command |
| `assistantCommandPrevious` | `Up` | assistantCommands | Previous command |
| `assistantChooseCommand` | `Return`, `Enter` | assistantCommands | Complete or run the selected AI command |
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

`e` and `d` are the archive and trash buttons, and where a button's action is already done for every row it will reach, the button is its inverse, and so is the key: in the trash they restore, and in Archive they move an archived message to the Inbox. The rows are the ones the control acts on: the ticked rows when it is about one of them (a key, a ticked row's menu or middle-click, the reader on a ticked message), else the cursor's row (before there is one, the listing's rows, which is what the hint row and the empty reader's key list describe), the row itself, or the row the open message belongs to. A mixed selection gets the key's own verb, the way `s` stars a mixed one. Restore is the provider's untrash, which every client has, so it is also the way out of the trash on HEY, which has no archive and no move. It is not called Move to Inbox because where it lands is the provider's: Gmail takes the TRASH label off and leaves the rest, the others move the message to the Inbox. `e` turns back only in Archive: on IMAP every folder but the Inbox reads as archived, and `e` in one of them still files the message in Archive. `keyActionFor` in `src/mail/listModel.ts` is the rule. `keyAction` in `src/features/list/store.ts` applies it over the rows a control reaches (the ticked rows if there are any, else the cursor's row or the open message), and the list reports the result for the hint row through `reportKeyState`'s `actions`. A button's tooltip, on a row or in the reader, names `e` or `d` only when the key reaches the same rows and asks the same of them. Hovering does not move the cursor, so a row names its keys only when it is the cursor's row, or ticked while the selection is active. A message that is not one of the listing's rows, such as one a notification opened over the Trash, is judged by its own labels. Because `e` files a message into Archive from every folder but Archive, a message read in Junk has no one-key way back, so on a mailbox whose labels are folders `v` offers the Inbox as well.

`n` and `p` walk the conversation rail beside the message on a provider whose listing collapses to conversations, opening the next and previous member in the same reader and stopping at the ends. The rail runs newest at the top, so `n` opens the stop below the open message, which is the older one, and `p` the stop above it, the newer — the keys follow the rail as it is drawn, the way `j` and `k` follow the list. They move the reader and nothing else. `j` and `k` move the list cursor and immediately open the representative of that row, leaving the conversation member selected with `n` or `p`. A message whose conversation has one member draws no rail, and both keys then do nothing. A right-click on a stop opens the same menu a row has — reply, archive, trash, spam, read, star — for that one message: the action reaches the member alone, where the same verb on the row reaches every counted member, and if the open message is the one taken out of the view the reader moves to the stop beside it, the newer one above or else the older below.

The delayed-send toast does not create a keyboard context. The current screen keeps its normal keys while the toast is visible. A new draft, reply, or forward can open during the delay. The send button waits for the queued message, but every draft field remains editable. The toast button restores the queued message. `Alt+Z` does the same from every context. `Ctrl+Z` remains text undo while composing or searching. If another compose is open, Omamail saves it to the provider's Drafts storage before dropping its in-memory fallback. A failed save keeps that fallback.

Back and `Escape` close an untouched composition immediately without saving, including a prefilled reply, forward, or existing provider draft. After a user edit, they open a modal with Cancel, Discard, and Save draft. Save draft initially has focus; Tab and Shift+Tab cycle through the buttons, and Enter activates the focused choice. Escape inside the popup cancels and returns to composing. A failed save restores the changed draft. The composer's bottom Discard button exits immediately.

The event and label delete confirmation initially focuses Delete. Tab and Shift+Tab cycle between Delete and Cancel; Return or Enter activates the focused button. Escape cancels.

## Why the rail is numbered and not chorded

`g i`, `g s`, `g u` and `g t` used to open the mailboxes, and they were two
problems in one row.

They were a chord, and the Qt client this app replaced put a deadline on an unfinished one: `styleHints.keyboardInputInterval`, 400ms there. Press `g`, think for half a second, press `i`, and nothing happened — no mailbox, no error, no hint that a clock had been running. Measured then, not guessed: `0ms → fires · 300ms → fires · 500ms → dead · 800ms → dead`.

And they had to be memorised. Four bindings that look like nothing on screen,
for the four places you actually go.

`Ctrl+1`…`Ctrl+9` replaces both (Command on macOS, as the table's `Ctrl` is everywhere there). A modifier has no deadline, and **holding Ctrl puts the digit on every row of the rail**, so there is nothing to remember — the rail says which key opens it. The numbers run down the rail as it is drawn, mailboxes first and then the server's labels, from `sidebarSlots` in `src/mail/labels.ts`, which
is the same list the badges are drawn from: the number beside a row and the row
a number opens are one fact rather than two. Past the ninth row there is simply
no number: `Ctrl+0` is reset zoom, the way it is in every browser, and the
rail does not take it.

Held Ctrl is read in `src/shell/Shell.tsx` off the window's raw key-down and key-up events, and it is not a binding — a modifier alone binds nothing, so there is nothing to route. It accepts no event, so what follows Ctrl still goes where it always went. It clears when the window loses the focus rather than only on release, because the release can land in another window, and waiting for one that is not coming would paint the numbers on permanently. The numbers show only in the list and reader contexts.

`Escape` is the only bare key bound everywhere, because it is the way out of
everywhere. With rows ticked and the list on screen — alone, or beside the
reader in a wide window — it unticks them first and goes nowhere; the next
press goes back. Where it goes is not decided by the key: the window keeps a history of the places it has been — a stack ruled by `src/app/navigation.ts` and kept in `src/app/store.ts` — and `Escape` (`goBack` in `src/keys/router.ts`), like every Back bar, ends in `back()`, which pops one entry. A draft, the event form and the shortcut sheet are
entries too, so the sheet closes before the message under it, and a reply
raised from the list returns to the list, not to the message it opened on the
way. On the root, `back()` clears a search if there is one and otherwise closes
the window.

## What survives an overlay

The shortcut sheet sits on top of the mailbox, and `survivesOverlay` is the
whole guard: without it a row goes dead while the sheet is up, which is why `e`
cannot archive behind it.

A few rows carry it. `help` and `back` keep their own meaning — they are how the sheet goes away. The movement rows are handed to the sheet instead, in `src/shell/ShortcutHelp.tsx`: while it is up, `j`, `k`, `Shift+J` and `Shift+K` scroll it, the arrows, page keys and Home/End are the panel's own, and the list's cursor and scroll commands do nothing behind it. A sheet taller than the window that could only be read with a mouse would be the one screen here that contradicts the rest. `src/shell/Shell.test.tsx` covers it.

**The account switcher is not on that list.** It is a ui `Popover` (`src/features/mailbox/AccountSwitcher.tsx`), not the sheet. `Alt+A` opens it through the table like any other key, and from there the keys come from the search line at the top of the popup and from its key layer (`PickerKeys`) — the one place in this window where the rule at the top of this document runs backwards. Letters narrow the rows to the mailboxes they
name, by the name they were given or their address; `Down` and `Up`, or `Ctrl`
with `j`, `k`, `n` or `p`, walk what is left; `Enter` opens the row the cursor
is on. A bare `j` or `k` is a letter there now, as it has to be for "jack" to
find a mailbox.
`src/features/mailbox/Sidebar.test.tsx` exercises this on the production popup, and `wrappedIndex` in `src/mail/labels.ts` holds the only decision in it — the cursor wraps, where the message list clamps.

The image viewer is a popup too, a ui `Dialog` (`src/features/reader/ImageViewer.tsx`). While it is open its own key handler takes the plain keys: `Left` and `Right` page through the message's pictures (wrapping at either end), `+` and `-` zoom, `0` fits the picture to the window again, and `Escape` closes it.

## The cursor

Hover must not write `cursorId`: content scrolls beneath a stationary pointer, and the row that arrives under it reports hover. Reveal keyboard selection with `contentYToReveal` in `src/mail/listModel.ts`.

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

Three rules, all in `src/mail/listModel.ts` so its tests (`src/mail/listModel.test.ts`) reach them:

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

The list is an NSH `List` (`src/features/list/index.tsx`), and keyboard movement scrolls it from an effect on the cursor: **`contentYToReveal`** decides where the scroller goes, leaving it alone while the row is already visible so stepping one row does not drag the list under someone reading it. Hover never changes the cursor, so this scroll never fights the mouse.

## The mouse

In the month calendar, dragging an event previews its destination date. Escape cancels a held drag before navigating back; releasing outside the calendar also cancels. After a drop, the preview stays visible while saving and refreshing, or returns to the original date if saving fails. Events with guests still open the existing confirmation form before saving.

The mouse does not move the keyboard's cursor. A row draws its own hover (`hoveredId` in `src/features/list/Row.tsx`), clicking one opens it, and right-clicking one opens its menu for that row — but hovering does nothing to `cursorId`.

That is not a preference. Hover is reported when content moves under a pointer that has not moved, and the list scrolls to follow the keyboard. In the Qt client, with hover writing `cursorId`, pressing `j` moved the cursor, the scroll brought a different row under the still pointer, and the cursor snapped back to it — so `j` and `k` stuck on whichever rows the mouse was resting near.

A mouse with a back button takes the same step `Escape` takes — `goBack()`, so the two do not become separate implementations of going back — with one exception. It never closes the window. `Escape` on a root with nothing left to clear ends the window, which is right for a key somebody pressed on purpose and wrong for a button sitting under the hand with no affordance saying the next press shuts the mailbox, so the mouse stops there instead. `src/shell/Shell.tsx` reports the press and `mouseBack` in `src/keys/router.ts` decides what it means, the same way the router does for keys: it goes back while `canGoBack()` says there is a step that is not closing the window, and otherwise only offers the press to the Escape layers.

## Adding a key

1. Add a row to `BINDINGS` in `src/keys/keymap.ts`. Name the contexts it means something in — that is the guard, and there is no other. A `display` string is how the sheet shows a range instead of enumerating every key.
2. Answer its id with `registerCommand(id, ({ slot }) => ...)` from `src/keys/commands.ts`, in the feature that owns the action, or in `SHELL` in `src/keys/router.ts` when it is navigation. `slot` is which of the row's keys fired, which is how a row of several keys tells them apart — read it, never parse the sequence.
3. Add the row to the table above. `make check` (`scripts/check-keys.ts`) fails if you forget.

That is all. The shortcut sheet and the status hints pick it up on their own.

## Not here

**User-configurable bindings.** The table makes it possible — the rows are data
— but nothing has asked for it, and a config file for bindings needs a merge
story and a conflict story this does not need.
