# Design

What the app looks like and why. `AGENTS.md` holds the working agreements about
the code, `docs/SPEC.md` what this is and which product questions are settled,
`docs/KEYS.md` the keyboard. This holds the surface.

Where a rule has a reason, the reason is the rule — it is what tells you whether
a case nobody wrote down is covered.

## Icons

**One set, one grid, one weight.** `components/ActionIcon.qml` is the whole set:
Canvas paths on a 16-unit grid, `strokeScale: 1.4`, drawn by name. A new glyph
is a branch in it, never a new component. Two drawn-icon components are two
grids, and two grids in one row is something a reader notices without being able
to say why.

- **Drawn, not rasterised.** These render at 13–16px, where Qt's SVG renderer
  smears strokes. The shell's own bar icons are Canvas paths for the same
  reason, and so is omarchy-mihoro's `ActionIcon`, which shares these
  coordinates.
- **Drawn, not a text glyph.** A character covers whatever fraction of its em
  box the family chose, so it will not match a drawn neighbour at any size — `×`
  is a multiplication sign and draws about half the height it was set at. `✏`
  and 🗑 take a colour emoji presentation on most font stacks.
- **One size within a row.** The grid makes two glyphs at the same `iconSize`
  optically equal; nothing makes them equal across sizes. The size belongs to
  the context, not to the glyph.
- `components/IconButton.qml` is that icon on the kit's hover/cursor surface.
  It exists because `qs.Ui.PanelActionButton` takes a font glyph and these are
  paths — otherwise it is the same control, and it must keep behaving like one.
- `GmailIcon` is outside the set: a logo with its own proportions. `gmailRed` is
  the single hard-coded colour in the project and covers exactly the M inside
  that mark.

## Colour

- Every colour comes from the active Omarchy theme, or a light theme renders
  unreadable text. `tests/test_source.sh` fails on a literal in QML, and on one
  named inside a JS library — colours are passed in from QML, which is the only
  place that can read the theme.
- Pass **semantic** colours down from `App.qml` as required properties: a
  destructive account action consumes the danger role it was given. Calling it
  dim or urgent at the button loses what the action means.
- Derive muted, hover and selected variants from an inherited colour with alpha,
  or from `Style.normalFillFor` / `hoverFillFor` / `selectedFillFor`. No literal
  fallback greys.
- **Secondary text mixes the foreground toward the background, not
  `Qt.darker`.** On a light theme, darkening an almost-black foreground makes
  "secondary" heavier than body text — the opposite of what it means.
- **Colour alone never carries state.** Unread is a dot, a heavier weight and a
  brighter subject, because some themes put the accent close to the foreground.
- `Html.js`'s `PAPER` and `INK` are the one other carve-out, and a narrow one:
  they are the sheet a sender's HTML is printed on. Content colours, not chrome
  — a message that sets `#24292e` text needs a light ground under it or it
  vanishes.

## Labels

- Suffix a button or menu label with `...` when activating it opens a dialog, a
  page, a browser, or a terminal workflow instead of completing the action
  immediately.
- Prefer the shorter label when both are honest, and never buy brevity with
  accuracy: "Mark these read" acts on the messages that are loaded, so it does
  not claim to mark all of them.
- An icon-only action carries its label in a tooltip, and that label follows the
  same `...` rule. The reader's six actions are icons because six labels would
  not fit, with the destructive one set apart by a rule and the urgent colour.

## The window's shape

One `FloatingWindow`, 980×720 default and 760×520 minimum, holding list and
reader. Hyprland treats it as an ordinary window.

- **Everything happens in that one content area.** Compose, reply and setup are
  views inside it, never a second window: Omarchy's panel mechanism gives every
  extra window its own region, and several mailboxes are not several windows.
- The sidebar is an open but narrow icon rail — 148px, 44px collapsed — named by
  tooltips either way, and collapsing is one click.
- **Loading is rows shaped like the content that will arrive**, not a lone
  Loading label that makes the column jump when the real thing lands.
- Cache first: a query paints immediately from disk and revalidates behind
  itself. Switching mailboxes must not go blank.
- Row fills reach the list/reader divider. Content padding belongs inside a row,
  not in a gutter that cuts every selected background short.
- **A capability the provider does not declare is a button the app does not
  draw.** Offering one that fails is worse than omitting it: it fails after the
  user has committed, with the row already moved.

## Triggers and popups

- A control that opens a popup **holds a selected style for as long as that
  popup is on screen.** A trigger that looks untouched while its own menu is up
  leaves the menu unattached to anything, and the user without an answer to
  "which of these opened it". The bar icon is the window's only trigger, so it
  carries `windowOpen` as a selected fill — not the bar's own `active`, which
  recolours from `bar.active` and falls back to `urgent`, a warning colour for a
  window merely being open.
- Anchor a popup to the trigger's own edge, never to the pointer:
  `mapToGlobal(0, 0)` on the control, so the menu lands in the same place
  however the control was pressed.
- **Place a popup after it opens**, and again whenever its height changes. A
  `QQC.Popup` does not build its contents until the first `open()`, so its
  height is zero while placement code is deciding whether it fits, and the first
  open lands somewhere different from every one after it.
- A popup that would overflow flips to the other side of its trigger, then
  clamps to the window edge, then clamps to zero. All three, in that order.

## Rows, the cursor, and focus

The full model is `docs/KEYS.md`. What shows on the surface:

- **The mouse does not move the keyboard's cursor.** Qt re-reports hover when
  content moves under a still pointer, and the list scrolls to follow the
  keyboard — so a hover that wrote `cursorId` pulled it back to whatever the
  pointer was resting on, and `j` went nowhere. A row draws its own hover; that
  is all hover is for here.
- **The cursor and the open message are two different things.** `cursorId` is
  where the keyboard is, `selectedId` is what the reader shows.
- The context owns the keyboard. Changing it moves the focus, and a context that
  types into nothing parks the keyboard on a plain `Item` — never hand focus
  back with `forceActiveFocus()` on the focus scope, which re-elects the field
  being left and leaves it swallowing every bare key.
- `focus: true` may not sit on a component that can be invisible while holding
  it. Focus follows "in use".
- Every action the mouse can reach has a key, and every key is in `keys/Keymap.js`.

## Anything a stranger wrote

A message body, a subject, a sender name, a snippet, an attachment filename: all
of it is written by whoever sent the mail, and none of it is markup.

- Every `Text` showing message content sets `textFormat: Text.PlainText`.
  `Text.AutoText` promotes anything tag-shaped to rich text, and Qt's rich text
  engine fetches `<img src>`. `tests/test_qml_text_format.py` fails the build
  when one is forgotten.
- **Remote images are blocked until the reader asks**, and asking covers one
  message. Rendering one fires every tracking pixel in it and reports the read.
- An image is only ever fetched from a host on the public internet.
  `Html.imageSourceKind` is the one place that decides, and the reader, the
  popover and the sanitiser all ask it.

## Secrets on the surface

- Anything that could carry a credential passes through `OAuth.redact` before it
  can reach a label.
- The OAuth client goes to a 0600 file and the refresh token to the keyring over
  stdin — never plugin settings, because `shell.json` is world-readable, and
  never a command line, because arguments are in the process list.
- An IMAP address is account identity. Its login username may legitimately
  differ and must never replace it in a label or while editing.

## What the repository carries

- The plugin is installed by cloning it, so every megabyte in the tree is a
  megabyte between a user and a working mailbox — and the things that get big
  are never the source. `tests/test_source.sh` fails on any tracked file over
  128 KB.
- `preview.png` is the one named exception, with a ceiling of its own rather
  than a raised one: the marketplace card rebuilds from a root file, and a card
  image that grew to a megabyte would still be a megabyte every user clones.
- Screenshots go to GitHub's attachment host by dragging them into an issue or a
  release. Design canvases and planning notes are working material and live
  outside the repository.

## Verification

`make test` runs the node tests, the source regressions and the QML tests;
`make validate` adds `qmllint` and `omarchy plugin validate`. Run it after any
QML or behaviour change.

`tests/test_source.sh` pins the decisions above at the source level, because
Quickshell's `Process`, the `qs.Ui` kit and a real theme only exist inside a
running shell. When a decision here changes, change the test in the same commit
— a rule with nothing holding it is a rule that has already drifted.
