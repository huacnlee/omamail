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
| `calendar/` | The calendars an account serves and their events: the sources in `Sources.js`, the rules in `Calendar.js`, the controller that reads and writes them, and the range cache. |
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

## Direction

Which way a message runs is a fact about the mail, not about the window. The
interface is not mirrored and there is no `LayoutMirroring` anywhere;
`tests/test_source.sh` enforces that, because "RTL support" is the name of two
different features and only one of them is here.

- Qt already resolves each paragraph and each `Text` from its own first strong
  character, and it is good at it. Leave it alone wherever it is right. It
  elides the *logical* end of a right-to-left string under `Text.ElideRight`,
  resolves each `<br>`-separated line of a plain body separately, and needs no
  help with an Arabic subject or an Arabic paragraph.
- `message/Direction.js` exists for the three places it is wrong or absent, and
  for nothing else. Adding a fourth caller is a decision, not a formality.
- **A subject is asked with `resolveSubject`, never `resolve`.** A reply prefix
  is Latin whatever the thread is written in, so `Re: مرحبا` reads left-to-right
  to anything taking the first strong character at face value — which is every
  message in a thread after the first, and most of a mailbox.
- **Qt honours the `dir` attribute and ignores the CSS `direction` property.**
  `promoteDirection` translates one into the other next to
  `promoteImageDimensions`, which is there for the same reason on `width`. A
  template written for a browser states direction only in CSS.
- **The body's `dir` and the stylesheet's physical sides are one statement.**
  Qt reads `margin-left` and has never heard of `margin-inline-start`, so a side
  is chosen when the sheet is built; and Qt places a list marker on the side the
  block runs from, so a sheet that indents a list from the right while the block
  is still left-to-right does not move the bullet, it **drops** it. Writing one
  without the other was tried and looked exactly like that.
  `baseDirectionAttribute` keeps them together and `tests/test_source.sh` keeps
  them that way.
- A base direction is a **default, not an override**: a sender's own `dir` — or
  a `direction` in their CSS, which `promoteDirection` turns into the same thing
  — still wins element by element inside it. That is what makes supplying one
  safe on a message nobody has inspected.
- A `Text` with no answer to give is left alone rather than assigned Qt's own
  default back. `undefined` on `horizontalAlignment` restores natural alignment;
  it does not warn.
- **A message being sent states its direction or loses it.** This is the fourth
  caller, and it was a decision. Qt resolves a compose field from the text in
  it, so a writer sees their own paragraph against the right edge as they type
  — but none of that travels with the message. A `text/plain` part states no
  direction at all, and a client with nothing to read falls back to
  left-to-right, which is what a Persian mail written here looked like in
  someone else's inbox. `buildRawMessage` asks `outgoingDirection`, which reads
  the body by the same rule the reader uses, so a message arrives looking the
  way it looked while it was written.
- **A right-to-left body grows a `text/html` twin; a left-to-right one grows
  nothing.** The plain part stays exactly as it was and stays listed first, and
  the twin is the least markup that can carry a direction — the text escaped,
  its line breaks kept, `dir` on the `<body>`, and no styling of any kind. It is
  not a rendering of the message, it is a statement about it. Left-to-right is
  already what a bare `text/plain` means to every client, so stating it would
  make every message ever sent `multipart` in order to repeat the default —
  the same reason `Html.js` gives a document no `dir` when nothing chose one.
- **A nested MIME boundary is a prefix, never a suffix.** `splitMultipart` finds
  a delimiter by searching for `--` and the boundary anywhere in the body, so an
  inner boundary that began with the outer one would be found by the outer scan
  as well and the message would come apart at the wrong line. `nestedBoundary`
  puts its tag in front for that reason, and `tests/test_message.js` asserts the
  inner delimiter cannot be read as the outer one.
- The calendar reply keeps its two parts and gains no twin. An RSVP's sentence
  is generated rather than composed, so there is no writer's direction to carry,
  and `multipart/alternative` holding exactly `text/plain` and `text/calendar`
  is the shape every calendar server recognises a reply in.
- Qt ignores `dir` on a `<td>` — on a wrapping `<div>` inside one, too. Nothing
  is done about it: text inside a cell still resolves from its own first strong
  character, which covers the case that actually arrives.

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
- **A response line has curl's 64 KiB ceiling.** SEARCH returns every matching
  UID on one line, so an unbounded `UID SEARCH ALL` fails around ten thousand
  messages. Counts and non-interactive listings first take a UID snapshot with
  `UID FETCH 1:* (UID)`, whose response is one short line per message, then
  split those stable UIDs into batches of at most 4096. An interactive search
  cannot wait for that whole snapshot: it reads the highest UID with
  `UID FETCH *:* (UID)` and searches one numeric UID range at most 4096 wide.
  If that range does not fill the page, it takes the snapshot in the background
  and sends every older message-bounded search on one reused connection. Never
  replace UID windows with message sequence-number windows, which move when
  another client expunges mail.
- **An interactive search reports its settled newest prefix.** That ordering is
  what makes a row safe to draw before the older windows answer: nothing still
  in flight can belong in front of it. The numeric first window is what makes
  that prefix early; the snapshot fallback is what stops a sparse, long-lived
  mailbox from paying one TLS handshake and LOGIN for thousands of empty UID
  numbers. It stops once the requested page is full and keeps a next-page
  offset only while every preceding match is known. Counts and other
  non-interactive reads supply no progress callback and still scan every
  window, because their total has to be exact.
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
- **CalDAV credentials go only to the configured source's own origin.** A
  server-written event `href` is resolved against the collection and refused
  when its scheme, host or port differs — `Calendar.caldavEventUrl` is the
  one place that decides, and the controller judges it before the keyring is
  touched.
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
- **Qt never fetches a remote message image itself.** Its loader takes no policy
  from QML, follows redirects, and draws a broken placeholder while a resource
  is pending. Once the reader has allowed images, `scripts/image-fetch.sh`
  fetches each approved public HTTP(S) source with curl, no redirects, a size
  ceiling and deadlines. Only a successful supported image comes back as a
  `data:` URI; until then the source is absent from both rich documents. Do not
  hand the original remote URL back to Qt or replace this with a QML request,
  because that reopens both redirect SSRF and the loading-placeholder defect.
- Remote images in a message body are blocked until the reader asks for them.
  Fetching one still tells its host that this address opened this message at
  this moment, so tracking pixels and hidden images never enter the fetch list.
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
  document, and — when the message shipped no `text/plain` part of its own —
  the plain text. Anything that needs to know how heavy a result
  is asks the call that produced it, and a view never parses a body itself.
- **Reading mode is a rebuild, not a filter, and that is the whole of its
  security argument.** The sanitiser walks the sender's tree and removes; the
  reader builds a new tree and copies across text, a checked `href`, a checked
  `src`, and numeric image dimensions capped to the small-inline-image limit.
  Every element starts with an empty attribute list and only those checked
  values are added, so there is no path by which a `class`, a `bgcolor`, an
  `align`, a `style` or a `background` reaches the output *at all*. Do not keep
  another sender attribute: the argument is structural, and every exception has
  to be bounded where it is added.
- **A text node is not safe just because the tokenizer called it text.** It goes
  back out with its `<` and `>` escaped, because this file joins text the sender
  had kept apart — `collapse` unwraps a span and welds its neighbours together,
  reading mode rebuilds a paragraph out of pieces and drops the characters that
  draw as nothing. A `<` that started no tag on the way in can start one on the
  way out, and the element it makes was never seen by the image policy, the link
  rule or anything else here: by then it is a string. For the same reason a style
  attribute has its character references decoded before it is split into
  declarations — `&#117;rl(` carries the `;` that separates one from the next.
- **An HTML `background` is an address, not a colour.** It sat in the colour list
  because senders write it beside `bgcolor`, and `keepColors` therefore let it
  through — a real message reached its sender's host with remote images off.
  Resource-bearing attributes are their own class now and are refused before
  the colour question is asked, because no appearance option may ever buy a
  network request. `tests/test_source.sh` asserts that order.
- **Not everything small is hidden.** A preheader is written `display:none`,
  `visibility:hidden`, a one-pixel type size, `opacity:0`, or no height with
  the overflow clipped. Three near-misses are not: `font-size:0` on a container
  closes the gaps between the boxes it holds and every box re-declares a size —
  read as hiding, it emptied whole messages; `max-height:0` hides nothing unless
  what overflows is clipped; and `mso-hide:all` hides from *Outlook*, which
  makes it the version meant for everybody else, so treating it as hidden throws
  away the call to action and keeps nothing, because the Outlook branch is in a
  conditional comment the parser drops. When a reading comes out empty, suspect
  this before suspecting the walk.
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
- A user-visible pull request carries a `## Release Notes` section in its
  description. Write the shipped results there as concise user-facing bullets;
  implementation details and verification belong in their own sections.
- The release workflow finds pull requests from the commit range between the
  previous and current tags, then `scripts/release-notes.sh` combines every
  `## Release Notes` section and builds the complete change list. Do not replace
  this with GitHub's generated notes: those do not read the PR descriptions and
  can omit a pull request that is present in the tagged history.
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
