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

## Layout

Four places, and which one a file belongs in is decided by what it talks to:

| Where | What lives there |
|--------------|-------------------------------------------------------|
| root | `Service.qml`, `BarWidget.qml`, `App.qml` — and nothing else. These three are named in `manifest.json` and loaded by the shell at that path. |
| `lib/` | The `.js` libraries. No QML in any of them, which is why the node tests can reach them. |
| `providers/` | One pair per mail service: something that signs in, something that fetches. |
| `core/` | `MailAccount.qml` and the two caches it owns. |
| `components/` | Views. They draw what they are given and decide nothing. |

- `tests/test_qml_names.py` fails on a fourth `.qml` at the root, and on any
  QML file the Makefile does not list — a file `qmllint` never sees is a file
  nobody checks.
- QML resolves a type by name from its own directory, so a file that builds a
  type from another one imports that directory: `Service.qml` has
  `import "core"`, `core/MailAccount.qml` has `import "../providers"`.

## JavaScript libraries

- The files under `lib/` are read by the QML engine. They start with
  `.pragma library` and use `var` and `function` only — no `const`, `let`,
  arrow functions, or template literals.
- Everything that parses, formats, or decides lives in one of them, so the node
  tests can reach it without a compositor. QML holds no logic worth testing.
- `tests/load.js` resolves against `lib/`, so a test says `load("Cache.js")`.

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

## Providers

- A mailbox is a **provider**: `gmail`, `imap`, or `hey`. `Provider.js` is the
  only place that knows the differences — which mailboxes exist, what a query
  string means, what the service can be asked to do, and how it signs in.
  Nothing above it branches on a provider id.
- Two objects make a provider work: something that signs in (`AuthManager`,
  `ImapAuth`) and something that fetches (`GmailApiClient`, `ImapClient`).
  `MailAccount` builds one pair through a `Loader` and drives them through an
  identical interface — same method names, same arguments, same callback shape.
  Adding a provider is those two files and a registry entry.
- **Both clients hand back Gmail's message resource**: a headers array, a MIME
  tree, part bodies in base64url. That is what lets one list, one reader, one
  cache and one set of actions serve every provider. `Message.parseRfc822` is
  the adapter that rebuilds that shape from the wire format, and it is worth
  keeping even where IMAP's own structures would have been more natural.
- A capability the provider does not declare is a **button the panel does not
  draw**. Offering one that fails is worse than omitting it: it fails after the
  user has committed to it, with the row already moved. IMAP therefore has no
  "report spam" — moving a message to a Junk folder teaches a server nothing,
  and a button that quietly meant that is a promise the provider cannot keep.
- An account id is the address for Gmail and `imap:<address>` for IMAP. One
  address can legitimately be both, and a Gmail account keeping the bare address
  is what stops an upgrade from having to migrate cache directories, keyring
  entries and the active account.
- `hey` is a real entry with no client behind it *yet*, deliberately. 37signals
  publish no API, and no IMAP or POP either — their FAQ says so — so there is
  nothing to sign in to. The entry is the plan rather than an apology: it keeps
  the seam, states what is missing, and the setup page shows that reason instead
  of a form it cannot honour. Adding HEY when an interface appears is a
  `capabilities` block, a `Hey.js` and a `HeyClient.qml`.
- Do not fill that gap by driving the private endpoints app.hey.com uses. It
  would ask a user for their HEY password so it could be replayed against an
  interface carrying no compatibility promise, and it would break on a deploy
  nobody announced. Waiting for a supported interface is the difference between
  a provider that keeps working and one that fails silently on somebody else's
  release day.

## Imap.js and the transport

- `Imap.js` is the protocol and nothing else: every string sent to a server and
  every decision about what came back. No transport, and no message format —
  an RFC 822 message is `Message.js`'s subject.
- The transport is `scripts/mail-transport.sh`, which is curl. Fields cross to
  it base64-encoded on one line of stdin, so a password never reaches the
  process table and nothing needs escaping on the way; the config carrying it
  goes to curl's own stdin rather than to a file that would be on disk.
- **The response comes back base64 too, and that is load-bearing.** IMAP
  measures a literal in octets. Read as UTF-8 text, 2048 octets of a message
  with an accent in it is fewer than 2048 characters, and the parser walks off
  the end of one response into the middle of the next — which is also how a
  message body could forge a response of its own. Base64 keeps one character
  per octet, so counting characters is counting octets.
- `BODY.PEEK`, never `BODY`. Reading a list must not mark the mailbox seen, and
  that is the most common way a hand-rolled IMAP client ruins a mailbox.
- `UID EXPUNGE`, never bare `EXPUNGE`: the latter removes every `\Deleted`
  message in the folder, including ones another client marked — somebody else's
  mail disappearing because this one archived.
- A message id is `<uid>:<folder>`. A UID is unique only within its folder, so a
  bare one collides between folders in the list and in the body cache on disk.
- Folder names are never guessed. `LIST` reports them and SPECIAL-USE names
  them: "Sent" is "Sent Items" on Exchange and "[Gmail]/Sent Mail" on Gmail, and
  a client that guessed would create folders rather than find them.

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

## What the repository carries

- This plugin is installed by cloning it — `omarchy plugin add` runs a plain
  `git clone` with no `--depth` — so everything tracked, and everything ever
  tracked, is between a user and a working mailbox.
- Only what the plugin needs to run, plus the README, AGENTS.md and
  `docs/SPEC.md`. Design canvases and planning notes are working material and
  live outside the repository; `.gitignore` keeps them out.
- Screenshots go to GitHub's attachment host by dragging them into an issue or
  a release, never into the tree. A 320 KB PNG that nothing referenced was a
  quarter of what a clone cost.
- `tests/test_source.sh` fails on any tracked file over 128 KB. The things that
  get big are never the source, so the ceiling is the rule rather than a list of
  banned paths.

## Verification

- Run `make validate` after any QML or behavior change. It runs the node tests,
  the source regressions, `qmllint`, and `omarchy plugin validate`.
- `qmllint` cannot resolve `qs.Ui` / `qs.Commons` and reports unresolved-import
  warnings for every plugin, including the shell's own. The exit code is the
  gate, not the warning count.
