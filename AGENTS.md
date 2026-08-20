# Repository working agreements

## Colors

- Use colors from the active Omarchy system theme. Do not hard-code UI colors.
- Pass semantic colors down from `App.qml` as required component properties so
  a theme change propagates through every view.
- Derive muted, hover, and selected variants from an inherited color with
  alpha, or from `Style.normalFillFor` / `hoverFillFor` / `selectedFillFor`.
  Do not introduce literal fallback grays.
- Secondary text mixes the foreground toward the **background**, not
  `Qt.darker`. On a light theme, darkening an almost-black foreground makes
  "secondary" text heavier than body text — the opposite of what it means.
- `tests/test_source.sh` enforces the no-literal-colors rule. Keep it updated
  rather than working around it.

## JavaScript libraries

- Files at the repository root ending in `.js` are read by the QML engine.
  They start with `.pragma library` and use `var` and `function` only — no
  `const`, `let`, arrow functions, or template literals.
- Everything that parses, formats, or decides lives in one of them, so the node
  tests can reach it without a compositor. QML holds no logic worth testing.

## Entry points

- `Service.qml` is constructed by the shell itself, which injects only `shell`,
  `manifest`, `pluginRegistry`, and `barWidgetRegistry`. It must declare **no**
  required properties: one the shell does not know about makes the whole plugin
  fail to instantiate, with the reason buried in a console warning.
- Plugin settings reach the service from the bar widget via `applySettings`,
  because the shell hands settings to the widget rather than to the service.

## UI labels

- Suffix button and menu labels with `...` when activating them opens a dialog,
  a page, a browser, or a terminal workflow instead of completing the action
  immediately.
- Never let colour alone carry state. Unread is a dot, a heavier weight, and a
  brighter subject, because some themes put the accent close to the foreground.
- Prefer the shorter label when both are honest, but never buy brevity with
  accuracy: "Mark these read" acts on the messages that are loaded, so it does
  not claim to mark all of them.

## Popups and their triggers

- A control that opens a popup holds a selected style for as long as that popup
  is on screen. A trigger that looks untouched while its own menu is up leaves
  the menu looking unattached to anything, and leaves the user without an answer
  to "which of these opened it".
- Anchor a popup to the trigger's own edge, not to the pointer. `mapToGlobal(0, 0)`
  on the control, never the click position: the menu should land in the same
  place however the control was pressed.
- Place a popup *after* it opens, and again whenever its height changes. A
  `QQC.Popup` does not build its contents until the first `open()`, so its
  height is still zero while any placement code is deciding whether it fits —
  the first open lands somewhere different from every one after it, which is the
  bug this rule exists to prevent.
- A popup that would overflow flips to the other side of its trigger, then
  clamps to the window edge, then clamps to zero. All three, in that order.

## Secrets

- Refresh tokens go to GNOME Keyring over stdin, never through a command line.
- The OAuth client goes to a 0600 file, never to plugin settings: `shell.json`
  is world-readable.
- Anything that could carry a credential passes through `OAuth.redact` before
  it can reach a label.
- Remote images in a message body are blocked until the reader asks for them,
  and asking covers one message. Qt's rich text engine really does fetch them,
  so rendering one fires every tracking pixel in the message.

## Html.js

- Qt is the renderer; this is the gate in front of it. `TextEdit` with
  `textFormat: RichText` is a real HTML engine and it is what draws every
  message — what Qt gives a QML plugin no say over is what that engine does
  while it works, and it fetches `<img src>`, lays a `<style>` block's CSS out
  as body text, and ignores `display:none`. C++ could hook
  `QTextDocument::loadResource`; QML cannot. The string handed over is the only
  control point there is.
- So it parses: **tokenize → tree → clean → serialise**. Not with patterns.
  Where a tag ends is the one thing the image policy cannot be wrong about, and
  `/<img\b[^>]*>/` is wrong about it the moment a sender puts a `>` in an alt
  text.
- The parse is deliberately **not** a conformant HTML5 tree builder and must not
  become one. A browser's parser inserts `<tbody>`, hoists content out of a
  `<table>` and reopens formatting across a block; every one of those is a change
  to mail nobody asked for. This one only closes what the sender left open.
- Everything downstream walks the tree by recursion, so `MAX_TREE_DEPTH` is
  load-bearing: without it a deeply nested message is a stack overflow inside
  the process that draws the whole desktop.
- The body cache holds the sender's HTML, not the sanitiser's output. A fix here
  then applies to every message already on disk instead of only to the ones
  fetched afterwards.
- This runs on the GUI thread of the shell that draws the user's whole desktop.
  Count the parses: opening a message is one `sanitize`, plus one
  `readPlainText` when the message had no text/plain part of its own. Anything
  that needs to know how heavy the result is asks the call that produced it.

## Anything a stranger wrote

- A message body, a subject, a sender name, a snippet, an attachment filename:
  all of it is written by whoever sent the mail, and none of it is markup.
- `Text` defaults to `Text.AutoText`, which promotes anything tag-shaped to rich
  text — and Qt's rich text engine fetches `<img src>`. Every `Text` showing
  message content therefore says `textFormat: Text.PlainText`, and
  `tests/test_qml_text_format.py` fails the build when one forgets.
- An image is only ever fetched from a host on the public internet. Loopback,
  private and link-local addresses, single-label and `.local` names, `file:`
  and relative sources are refused outright — `Html.imageSourceKind` is the one
  place that decides, and the reader, the popover and the sanitiser all ask it.
- Values that go back out to Google — a `To`, a `Subject`, an `In-Reply-To`
  copied off the message being answered — lose their line breaks first, or the
  reply carries headers nobody typed.

## Verification

- Run `make validate` after any QML or behavior change. It runs the node tests,
  the source regressions, `qmllint`, and `omarchy plugin validate`.
- `qmllint` cannot resolve `qs.Ui` / `qs.Commons` and reports unresolved-import
  warnings for every plugin, including the shell's own. The exit code is the
  gate, not the warning count.
