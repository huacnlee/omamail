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

**Grouped by module, not by file type.** A module holds whatever doing its job
takes — the rules in `.js`, the object in `.qml`, side by side. There is no
directory of "all the JavaScript": that arrangement puts a provider's parsing
three directories away from the client that calls it.

| Module | What it is |
|-----------------|--------------------------------------------------------|
| root | `Service.qml`, `BarWidget.qml`, `App.qml`, and nothing else. `manifest.json` names these three and the shell loads them at that path. |
| `providers/` | Everything that differs between mail services: a description per provider, the registry over them, the protocol each speaks, and the pair of objects — signs in, fetches — that each needs. |
| `account/` | One mailbox and the list of them. `MailAccount.qml`, `Accounts.js`, and the rules in `Model.js` about what a list does after an action. |
| `cache/` | What a query result and a message body are kept in, and the two objects that keep them. |
| `message/` | A message's own content: parsing it (`Message.js`) and making it safe to draw (`Html.js`). |
| `components/` | Views. They draw what they are given and decide nothing. |

- `tests/test_qml_names.py` fails on a fourth `.qml` at the root, and on any QML
  file the Makefile does not list — a file `qmllint` never sees is a file nobody
  checks.
- QML resolves a type by name from its own directory, so a file that builds a
  type from another module imports that directory: `Service.qml` has
  `import "account"`, `account/MailAccount.qml` has `import "../providers"` and
  `import "../cache"`.

## JavaScript libraries

- The `.js` files are read by the QML engine. They start with `.pragma library`
  and use `var` and `function` only — no `const`, `let`, arrow functions, or
  template literals. `tests/test_source.sh` finds them wherever they are, so a
  new module is covered without being added to a list.
- Everything that parses, formats, or decides lives in one of them, so the node
  tests can reach it without a compositor. QML holds no logic worth testing.
- One JS resource may build on others with QML's `.import "Other.js" as Other`,
  which is how `providers/Registry.js` is assembled out of `Gmail.js`,
  `Imap.js` and `Hey.js`. `tests/load.js` resolves those the same way the engine
  does, so the tests exercise the real file.
- Tests name the module path: `load("cache/Cache.js")`. A bare filename would no
  longer say where the thing lives.

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

## Keys and focus

The design and the full table are in `docs/KEYS.md`; read it before touching a
key. What matters while working:

- Every binding lives in `keys/Keymap.js` and nothing else describes one. The
  shortcut sheet and the status hints render from it, and a test asserts
  `docs/KEYS.md` matches it. Three hand-written copies used to exist and had
  already drifted apart.
- The context is the only guard. Name the contexts a key means something in;
  there is no second question to answer. A text-entry context binds no bare key
  but `Escape`.
- The context owns the keyboard: changing it moves the focus, and a context that
  types into nothing parks the keyboard on a plain `Item`. Never hand focus back
  by calling `forceActiveFocus()` on the focus scope — that re-elects the field
  being left, so it does nothing and the dismissed field keeps eating keys.
- `focus: true` may not sit on a component that can be invisible while holding
  it, and a component in a context does not place its own focus — the context
  does. Two mechanisms for one thing is the bug this design replaces.
- Route keys through `KeyRouter`, never a `Keys.on...Pressed` handler: a window
  `Shortcut` beats a focused item's `Keys` handler, so a local one looks live and
  never runs. Anything `Escape` should do belongs in `goBack()`.
- **No chords.** Qt puts a deadline on an unfinished key sequence —
  `styleHints.keyboardInputInterval`, 400ms — so `g` then `i` half a second
  later does nothing at all and says nothing about why. The mailboxes were
  reached that way and are numbered now. A modifier has no deadline.
- A held modifier is the one thing `KeyRouter` cannot own, because a modifier
  alone cannot be a `Shortcut`. `App.qml` watches `Key_Alt` with a `Keys`
  handler to name the rail's rows, accepts nothing, and clears on `activeFocus`
  rather than on the release — Alt+Tab takes the release to another window.
- `KeyRouter` builds its shortcuts with an `Instantiator`. A `Repeater` builds
  only `Item`s, so it creates no `Shortcut`s at all and every key goes dead.
- A `QQC.Popup` with `CloseOnEscape` consumes `Escape` itself. Do not add a
  branch for an open popup; do add one for a plain overlay like the sheet.
- **An open `QQC.Popup` consumes every other key too**, and that is the one
  place the rule above inverts. It takes the key before the shortcut map sees
  it — `focus` true or false, bare or modified — so inside a popup a `KeyRouter`
  binding is what looks live and never runs, and a `Keys` handler on the
  popup's `contentItem` is the only thing that works. The account switcher is
  the one component that answers keys itself, for this reason.
  `tests/qml/tst_popup_keys.qml` asserts both halves, so the exception cannot
  be tidied back into the rule by someone who only read the rule.
- The mouse does not move the keyboard's cursor. Qt re-reports hover when
  content moves under a still pointer and the list scrolls to follow the
  keyboard, so a hover that wrote `cursorId` pulled it back to whatever the
  mouse was resting on and `j` went nowhere. A row draws its own hover.
- The list cursor and the open message are two different things. `cursorId` is
  where the keyboard is; `selectedId` is what the reader shows. Move the cursor
  with `Model.cursorAfterOffset`, and bring the row on screen with
  `Model.contentYToReveal` — the list is a `Column`, so there is no
  `positionViewAtIndex`.

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

## Releasing

- `scripts/bump.sh 0.2.0` is the whole of it: it sets the manifest version,
  commits, tags and pushes both. The release workflow refuses a tag that
  disagrees with the manifest, and by then the tag is on the remote and has to
  be deleted from it — deriving both from one argument is what stops that.
- It refuses before it writes: a `v` prefix, a version that is not
  MAJOR.MINOR.PATCH, one the manifest already carries, a branch that is not
  main, a dirty tree, a tag that already exists here or on the remote, and a
  main that is behind the remote. It runs `make test` before tagging.
- The tag is the only thing that publishes a release. Nothing else creates one.

## Verification

- `make test` runs the node tests, the source regressions, and the QML tests.
  The release workflow runs `make test-js test-shell` instead: the QML tests
  need the Qt the plugin actually runs on, and a runner ships an older one that
  disagrees about exactly the behaviour they exercise. They are a local gate,
  for the same reason `qmllint` is.
- Run `make validate` after any QML or behavior change. It runs the node tests,
  the source regressions, `qmllint`, and `omarchy plugin validate`.
- `qmllint` cannot resolve `qs.Ui` / `qs.Commons` and reports unresolved-import
  warnings for every plugin, including the shell's own. The exit code is the
  gate, not the warning count.
