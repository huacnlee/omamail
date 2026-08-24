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
  `Hey.js` and `Imap.js` — and those out of `GmailApi.js` and `HeyCli.js` in
  turn, because where a message lives on the web is a fact about the service
  rather than about the registry. `tests/load.js` resolves the chain the same
  way the engine does, so the tests exercise the real files.
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
- **A key is not a button.** A capability the provider does not declare loses
  its button, but `e` and `s` are bound in every mail context whatever mailbox
  is open — so the same action has to be refused in `MailAccount.act` *before*
  the optimistic update, and the status row's hints are filtered by
  `Keymap.hintsFor`'s second argument. Without both, HEY — which has neither an
  archive nor a star — moved the row out of the Imbox and said "Archived" for a
  request no server ever saw.
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

- A mailbox is a **provider**: `gmail`, `hey`, or `imap`, listed in that order
  because IMAP is the answer for a server the other two do not name and a
  chooser that opened with it would ask the question backwards. `Provider.js` is
  the only place that knows the differences — which mailboxes exist, what a query
  string means, what the service can be asked to do, and how it signs in.
  Nothing above it branches on a provider id.
- Two objects make a provider work: something that signs in (`AuthManager`,
  `HeyAuth`, `ImapAuth`) and something that fetches (`GmailApiClient`,
  `HeyClient`, `ImapClient`).
  `MailAccount` builds one pair through a `Loader` and drives them through an
  identical interface — same method names, same arguments, same callback shape.
  Adding a provider is those two files and a registry entry.
- **Every client hands back Gmail's message resource**: a headers array, a MIME
  tree, part bodies in base64url. That is what lets one list, one reader, one
  cache and one set of actions serve every provider. `Message.parseRfc822` is
  the adapter that rebuilds that shape from the wire format, and it is worth
  keeping even where IMAP's own structures would have been more natural.
  HEY never serves an RFC 822 message at all, so `HeyClient.toMessage`
  *composes* the resource from a posting and a thread read rather than parsing
  one — same shape, no parse.
- A detail read is authoritative about what it carries and silent about the
  rest, which is `Model.detailSummary`. HEY reads a conversation rather than a
  message and so answers with no subject line of its own; replacing the row
  wholesale blanked the subject the list had drawn.
- A capability the provider does not declare is a **button the panel does not
  draw**. Offering one that fails is worse than omitting it: it fails after the
  user has committed to it, with the row already moved. IMAP therefore has no
  "report spam" — moving a message to a Junk folder teaches a server nothing,
  and a button that quietly meant that is a promise the provider cannot keep.
- An account id is the address for Gmail and `<provider>:<address>` for the
  others. One address can legitimately be more than one mailbox, and a Gmail
  account keeping the bare address is what stops an upgrade from having to
  migrate cache directories, keyring entries and the active account.
- Where a message and a mailbox live on the web is a provider question, not
  `MailAccount`'s. `Registry.webMessageUrl` and `webBoxUrl` are that seam; the
  Gmail call that used to sit in `MailAccount` would have opened Gmail for the
  second provider that declared a web UI.

## HEY and the `hey` client

- HEY publishes no API, no IMAP and no POP, so the interface is `hey`, the
  command line client 37signals ship. **Do not fill that gap by driving the
  private endpoints app.hey.com uses**, which is what this provider waited for
  `hey` rather than doing: it would ask a user for their HEY password so it
  could be replayed against an interface carrying no compatibility promise, and
  it would break on a deploy nobody announced.
- `hey` owns the whole credential. It performs the OAuth flow, keeps the token
  in the keyring and refreshes it; `HeyAuth` holds a yes or a no and the path to
  the program, and has nothing worth redacting. Signing out is `hey auth
  logout`, which signs the machine's HEY client out of everything that uses it —
  the setup page says so next to the button, because a sign-out that only forgot
  locally would be undone by the next status read.
- `HeyCli.js` is the argument vectors and the answers, the way `Imap.js` is the
  protocol: no process, no message format. Every command asks for `--json`, so
  nothing ever parses a rendered table, and the envelope's `ok` is the check
  rather than the exit status — the CLI reports some refusals in JSON and still
  exits 0.
- **A thread answers to two numbers.** The posting id is its place in a box and
  is what `seen`, `move`, `trash` and `spam` take; the topic id is the
  conversation and is what `threads` and `reply` take. A message id here is
  `<posting>:<topic>` for that reason, the way an IMAP one carries its folder.
- **Unseen is the absence of a seen.** HEY's JSON omits an empty field, so a
  posting nobody has read carries no `seen` key at all. There is no unseen count
  and no unseen box either, so the badge is a listing and a tally — which is why
  the unread query is the one that names a `--limit`.
- **`--limit` and paging cannot both be had.** The CLI reads pages until it has
  the number asked for, then truncates *and drops the cursor*, so a limited
  listing can never be continued. Ordinary listings therefore ask for no limit
  and take HEY's own page, and the page size the user configured is applied in
  `HeyCli.pageOf` — its token is an offset into that page plus HEY's cursor for
  it.
- An optional flag the installed `hey` has never heard of fails the whole
  command, and the release most people have is older than `--allow-partial`.
  `HeyClient` drops the flag the usage error names and asks again, then
  remembers — which is also how `--html` upgrades a HEY mailbox from text
  bodies to the sender's own markup with nothing here to change. Every flag
  dropped this way must be boolean; dropping one that took a value would leave
  its value behind as a positional argument.
- HEY has no star and no archive, and neither is faked. A star that quietly
  moved a thread to Set Aside, or an archive that filed it in Paper Trail, is
  exactly the promise `Registry.capabilities` exists to stop being made.

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
- **Every request that crosses the network is given up on eventually, and in
  QML that costs a `Timer`.** Qt's QML `XMLHttpRequest` has no `timeout` and no
  `ontimeout`: the properties do not exist, and assigning one reads back
  exactly what was written — so the obvious fix looks like it works and does
  nothing at all. A `Timer` calling `abort()` is the whole of what is
  available, and `abort()` drives `readyState` to `DONE` with status 0, which
  is why the deadline needs no callback of its own: it lands in the failure
  path the request already had, decrementing `inFlight` once. Both facts were
  measured against a socket that accepts and never answers, not read from a
  specification. `tests/test_source.sh` fails an assignment to `.timeout`,
  because that is the mistake that looks correct; "this request has a deadline"
  is not something grep can ask, so it is stated here and proved by the
  offscreen harness rather than by a test that would pass whatever happened.
- **A gate that judges only the first address is not a gate.** `isPostableUrl`
  and `imageSourceKind` refuse loopback, private, link-local and single-label
  hosts — but they judge the address *the sender wrote*, and Qt's
  `XMLHttpRequest` follows a 3xx by itself and re-sends the request, body
  intact, wherever that answer points. Measured, not assumed: a loopback target
  answering `302 Location: /landed` recorded the POST arriving there. So the
  one-click unsubscribe goes out through `scripts/unsubscribe.sh`, which is
  curl, which follows nothing unless told to — and a 3xx is reported as a list
  that did not unsubscribe rather than as an address to chase.
- **Remote images are the part of that which is not closed.** Qt's own image
  loader performs those fetches and takes no policy from QML, so a sender who
  redirects an image can still reach an address the gate would have refused.
  What holds the line meanwhile is that nothing is fetched until the reader
  asks. Closing it properly means fetching the bytes here — curl, no redirects
  — and handing the renderer a `data:` URI, which is a day's work and a change
  to the rule that the string handed over is the only control point. Do not
  paper over it with a second check on the same first address.
- Remote images in a message body are blocked until the reader asks for them.
  Qt's rich text engine really does fetch them, so rendering one fires every
  tracking pixel in the message, and the fetch tells the host that this address
  opened this message at this moment.
- The answer is a standing one, off until it is given. Asking per message meant
  answering the same question on every newsletter and remembering none of it,
  so the cost of asking fell on somebody who had already decided. The notice's
  button says "Always show", because that is what it does, and Settings is the
  one place that turns it back off.

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
  **Count the parses.** Opening a message is one `sanitize`, and every reading of
  that message comes out of it: the sanitised document, the rebuilt reading
  document, and the plain text. Anything that needs to know how heavy a result
  is asks the call that produced it, and a view never parses a body itself.
- **Reading mode is a rebuild, not a filter, and that is the whole of its
  security argument.** The sanitiser walks the sender's tree and removes; the
  reader builds a new tree and copies across exactly three things — text, a
  checked `href`, a checked `src`. Every element it emits is constructed with an
  empty attribute list, so there is no path by which a `class`, a `width`, a
  `bgcolor`, an `align`, a `style` or a `background` reaches the output *at all*.
  Do not add a fourth thing that is carried over, and do not "keep just this one
  attribute": the argument is structural, and one exception ends it.
- **An HTML `background` is an address, not a colour.** It sat in the colour list
  because senders write it beside `bgcolor`, and `keepColors` therefore let it
  through — a real message reached its sender's host with remote images off.
  Resource-bearing attributes are their own class now and are refused before
  the colour question is asked, because no appearance option may ever buy a
  network request. `tests/test_source.sh` asserts that order.
- Reading mode's link rule is stricter than the formatted view's on purpose:
  `mailto:` or http(s) at a public host, nothing else. A message must not be
  able to put the machine this runs on, or the network behind the user's front
  door, under the pointer. Where the address is refused the label still shows —
  the words are the message, the address was not.

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
- `assets/` holds what the running plugin draws, which includes the provider
  artwork — a few kilobytes each, at 128px, reached through `Registry.mark` and
  `Registry.logo`. Those are two different questions: `mark` is the square icon
  a list row wants, `logo` is the lockup a page about the service opens with,
  and a provider with one file uses it for both. They are the services' own
  artwork and the one thing here that does **not** take a colour from the theme:
  a recoloured logo is not the logo. A provider with no artwork draws the
  themed envelope instead — that is what IMAP is, a mailbox somewhere and no
  brand to name.
- **HEY is a brand word.** It is upper case in every sentence; `hey` in lower
  case is the command, and only ever appears where a command is what is meant.
  The program in prose is "the HEY CLI".
- `tests/test_source.sh` fails on any tracked file over 128 KB. The things that
  get big are never the source, so the ceiling is the rule rather than a list of
  banned paths.

## Commits and pull requests

- **No scope prefix, and this is where the project departs from GPUI Component on purpose.** A title is the imperative outcome and nothing in front of it: `Read a message at a readable size`, not `reader: Read a message at a readable size`.

  gpui-component prefixes everything — `markdown: Share the parsed block list instead of cloning it every frame`, `dock: Keep a split filled when its last slot is hidden`, `input: Stop copying the value into InputPresentation` — and it is right to. That repository is a kit of separable components and crates, so the first question a reader has is *which one*, and the prefix answers it before the sentence starts.

  This repository is one application that does one thing: mail. There is no kit, no second component, and nothing a reader has to be told apart from anything else — so the question the prefix answers never arises, and a prefix put there anyway has to be invented. That is what `app:` is: a word that names nothing, on the changes that were worth doing. Do not restore the prefix by reading gpui-component and concluding the style should match. The style follows from the shape of the repository, and the shapes are different. This has been re-litigated once already.
- **A title names machinery and what happened to it, in the words the code uses.** It is read by somebody deciding whether this is the change they are looking for. `Use the body and the read state already on disk` says which machinery moved; `Open a message on what the list already knows` describes the mechanism that produced the result and names nothing, and reads as a title only to somebody who has already seen the diff. Prose that could sit in a release note is not a title.
- Derive the pull request title from the final `base...HEAD` diff. Do not copy the first commit subject when later commits have broadened or changed the outcome.
- **Re-derive it every time a commit is added, not only when the pull request is opened.** The rule above is easy to satisfy at creation and easy to lose afterwards — one pull request here was opened for a single fix, grew three more, and kept the first commit's subject until somebody read it and said it was wrong. The description carries the same rule for the same reason; the title needs it said out loud because a title is short enough to go on looking true.
- Rewrite the pull request description whenever its scope changes. It states the user-visible results, the architectural reason and invariants, and the verification actually performed; it does not preserve a chronological list of implementation attempts.
- Commit subjects follow the same rule: imperative, outcome-oriented, unprefixed. A conventional prefix never substitutes for a precise result.
- Markdown prose uses one source line per paragraph. Do not hard-wrap prose to a column width.

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
