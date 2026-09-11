# Omamail

**Your mail as a native Omarchy window — not a browser tab.**

Omamail is an Omarchy desktop email client: a Quickshell plugin
that reads, triages, and answers your mail over the official Gmail API, through
Microsoft OAuth for Outlook, over the HEY CLI client 37signals publish, over
JMAP, or over IMAP and SMTP for every other mailbox. It follows your active
theme and uses one private, exactly versioned Rust backend inside the plugin.


<img width="800" alt="Omamail - Reading mail with AI assistance for selected messages" src="docs/images/full-mail.webp" />

The calendar, a new message, and the question every new mailbox starts with:

<img width="265" alt="Omamail - The calendar in month view" src="docs/images/full-calendar.webp" /> <img width="265" alt="Omamail - Writing a new message" src="docs/images/full-compose.webp" /> <img width="265" alt="Omamail - Adding a mailbox: Gmail, HEY or IMAP" src="docs/images/full-add-mailbox.webp" />

And with mini size mode:

<img width="265" alt="Omamail - Mini size: the message list" src="docs/images/mini-list.webp" /> <img width="265" alt="Omamail - Mini size: one message open" src="docs/images/mini-message.webp" /> <img width="265" alt="Omamail - Mini size: writing a new message" src="docs/images/mini-compose.webp" />

Works with **Gmail**, **HEY**, **Fastmail**, **iCloud Mail**, **Outlook**, **Yahoo**, **Zoho**, **GMX**, **Proton Mail** (through its Bridge), and any server that speaks **JMAP** or **IMAP** — including one you run yourself.

## Features

- **Designed, not assembled.** Monospace, square-cornered, and built to sit
  inside Omarchy rather than to look like a web app in a window. Three columns
  when there is room, one when there is not, and nothing on screen that is not
  your mail.
- **Gmail, Outlook, HEY, JMAP and IMAP.** Sign in to Gmail with Google, to Outlook with Microsoft, to HEY through the HEY CLI that 37signals publish, or add a mailbox on any JMAP or IMAP server with an address and an app password. Several accounts at once, each with its own inbox, cache and unread count.
- **Keyboard-first.** `j`/`k` to move, `Shift+J`/`Shift+K` to scroll the reader,
  `e` to archive, `v` to file, `s` to star, `r` to
  reply, `c` to compose, `Alt+1`…`0` for the mailboxes — hold Alt and the rail says
  which is which — `Alt+A` to switch account, `/` to search, `?` for the rest.
  A key the mailbox has no verb for says so instead of pretending: HEY has
  neither an archive nor a star, so `e` and `s` name what is missing.
- **Always counting.** The unread badge keeps working while the window is shut,
  for every account, with a desktop notification when new mail lands.
- **One window.** Read, archive, star, trash, search, and answer without a
  second window taking a region of its own.
- **Invitations you can answer.** A meeting invitation is read out of the
  message's own calendar part and drawn as a meeting: when it runs, in your
  clock rather than the organiser's, how long for, where, whether it repeats,
  and who else has said yes. **Yes**, **Maybe** and **No** answer the
  organiser, and a Google Meet link joins in one click. It works on Gmail and
  on IMAP alike — the answer is an ordinary reply, which is what every calendar
  server is already listening for. Not on HEY: `hey` serves a message's text,
  not the calendar file beside it, so there is nothing to read the meeting out
  of.
- **Off a list in one click.** A newsletter that supports one-click
  unsubscribing is unsubscribed from without leaving the window. One that only
  offers an address gets a message; one that only offers a page says so before
  it opens your browser. Nothing is ever fetched from a sender's address until
  you ask.
- **Attachments open or keep.** The filename opens one in whatever handles its
  type; the arrow beside it saves the file to your download folder and says
  where it went. Two messages carrying one name are two files: the second is
  numbered rather than landing on top of the first.
- **Images stay blocked.** Loading a sender's pictures tells them the mail was
  read, from which address and when. They load when you ask, for that one
  message.
- **Right-to-left mail reads right to left.** An Arabic, Hebrew or Persian
  message lays out from the right — subject, list row, bar preview and body —
  and an English one alongside it does not. A reply keeps its direction where
  most clients lose it: `Re:` is Latin whatever the thread is written in, and
  the prefix is set aside before the question is asked rather than answering it.
  A sender who states direction only in CSS is understood too, which Qt's own
  renderer does not do. Set **Message direction** to a fixed direction to have
  every message read that way instead. The interface itself is unaffected.
- **Your theme.** Every colour comes from the active Omarchy theme, so the
  mailbox changes the moment the desktop does.
- **Keyring-backed.** Gmail and Outlook refresh tokens and every JMAP and IMAP password live in GNOME Keyring — never in a config file, never on a command line. A HEY mailbox has no credential here at all: the HEY CLI holds its own token, and Omamail only ever asks it whether it is signed in.

## What it is

One installed application with three cooperating parts:

- a **background service**, which keeps counting whether or not the window is
  open
- an **application window** — a real Hyprland window, tiled like any other,
  with your mailboxes, the message list, and the reader side by side
- **compose and reply inside that same window**, because a second window would
  take a region of its own. A `mailto:` link from elsewhere on the desktop
  opens that same compose form.

## Install the plugin

```bash
omarchy plugin add https://github.com/huacnlee/omamail.git --enable
```

Open Omamail and explicitly install its backend when prompted. Loading the
plugin never downloads a binary. The installer uses the exact `backend-version`
release for Linux x86_64 or aarch64 and keeps it at `runtime/bin/omamail` inside
the plugin. No system package or second Quickshell process is installed.
See [backend installation and releases](docs/BACKEND-RUNTIME.md) for updates,
optional CLI access and recovery. Each plugin revision keeps its own exact backend
pin; an old plugin never automatically switches to the backend used by main.

Then click the envelope in the bar. To open it from the keyboard, add this to
`~/.config/hypr/bindings.lua`:

```lua
  o.bind("SUPER + SHIFT + G", "Omamail", "omarchy shell shell toggle omamail '{}'")
```

The target is `shell`, not the plugin id: the window is summoned by the shell,
which is what loads it in the first place. A plugin-scoped target would have to
be registered by code that is only running once the window is already open.

Once the plugin is enabled, Omamail handles `mailto:` links. Clicking an
address in a browser, a PDF, or a notification opens compose here.
`xdg-open mailto:you@example.com` is the check.

Requires Omarchy 4, the Rust backend, `secret-tool`, `xdg-open` and `python3`
for keyring and desktop integration. Rust owns mail networking, remote image
fetching and one-click unsubscribe. A HEY mailbox additionally needs the official
`hey` client; see below. Building locally also requires the Rust toolchain.

## Mailboxes it can open

Adding a mailbox asks which kind first, because the four setups have nothing in common.

**Gmail** signs in with Google directly. Google issues Gmail API access per
project, so this route needs an OAuth client you create once — the setup page
walks through it. In exchange it gets labels, conversations, Gmail's own search
syntax, and a "report spam" that Google actually learns from.

**Outlook** signs in on Microsoft's own page and uses [Microsoft's supported OAuth route for IMAP and SMTP][microsoft-mail-oauth]. It works with Outlook.com, Hotmail, Live and MSN accounts; Omamail never asks for the Microsoft account password. Until Omamail ships a maintainer-owned public client, the setup page asks for an Application (client) ID from a one-time Microsoft Entra app registration. Make it a public client for personal Microsoft accounts; the sign-in asks for `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access` and `openid` and shows the device code to enter in the Microsoft page it opens. Microsoft Graph — sending where the tenant has SMTP off, the calendar — is a second code for `Mail.Send` and `Calendars.ReadWrite`, asked for once, when Microsoft refuses the Graph exchange for want of consent: straight after the sign-in where the mailbox sends through Graph, else from the mailbox's settings (*Allow Microsoft Graph...*).

A **work or school** mailbox (Microsoft 365) is the same sign-in addressed to its own tenant: turn on *Work or school account* on the setup page, and register the client in that tenant, or as multi-tenant. Where the tenant has switched authenticated SMTP off — the common Microsoft 365 default, which fails a send with "SmtpClientAuthentication is disabled" — turn on *Send through Microsoft Graph*: the same message goes to Graph's `sendMail` with a token of Graph's own audience, obtained with the same refresh token, and Graph files the sent copy itself. That needs the `Mail.Send` permission on the registration.

Before signing in, enable IMAP in Outlook.com: **Settings > Mail > Forwarding and IMAP > Let devices and apps use IMAP**, then save. Microsoft disables IMAP by default; OAuth consent alone does not enable mailbox access. See [Microsoft's IMAP setup instructions](https://support.microsoft.com/en-us/outlook/pop-imap-and-smtp-settings-for-outlook-com).

**HEY** needs no address and no password. HEY publishes no IMAP, no POP and no
public API, so Omamail reads it through the [HEY CLI][hey-cli] client 37signals
ship for exactly this — which means the sign-in, the token and the keyring entry
it lives in are all `hey`'s, and Omamail never asks for your HEY password.

Install it once:

```bash
omarchy-mise-install github:basecamp/hey-cli hey
```

Recent versions of Omarchy install it for you as a lazy mise tool, so that line
is only for doing it by hand; [37signals' own installer][hey-cli] is the other
route. Either way it lands in `~/.local/bin`, which is where Omamail looks when
it is not already on `PATH`. Then choose **HEY** on the setup page and press
**Sign in to HEY** — that opens HEY in your browser, and nothing else is asked
of you.

The rail is HEY's own: Imbox, New for you, Reply Later, Set Aside, The Feed and
Paper Trail. **No Sent** — HEY's API has one, but `hey` does not serve it yet:
there is no `hey box sent`, and search only scopes to the Imbox, the Feed, Paper
Trail and Trash. When the client gains it, it is one more line in the rail.

What HEY does not have, the panel does not offer: **no star** and **no
archive**, because HEY moves a thread to one of those boxes instead, and a key
that quietly meant "file this in Paper Trail" would be a promise this could not
keep — `e` and `s` say so rather than pretending. Reading, marking read,
replying, searching, labels, trashing and a "report spam" HEY trains its filter
on all work.

Three more differences worth knowing. A HEY row is a *conversation*, not a
single message. Message bodies read as `hey` serves them — as the sender's own
HTML where your `hey` is new enough to hand it over, and as text elsewhere;
Omamail asks for the richer one every time and takes whichever comes back, so
upgrading `hey` improves it with nothing to change here. And the meeting card,
the one-click unsubscribe, attachments and the Screener are all read out of
parts of a message that `hey` does not serve, or out of an endpoint it does not
expose — so they stay in HEY's own app, which the setup page links to.

**JMAP** is an address and an app password or an API token — Fastmail, a Stalwart server of your own, or anything else that speaks the protocol. Discovery starts at `https://<your-address-domain>/.well-known/jmap`. If your domain does not serve that endpoint, enter the server URL under **Server settings**. Discovery uses HTTPS and may follow its authenticated redirect; an unsigned DNS SRV record cannot choose where your credential goes. The credential goes to that server and to the addresses inside its session object.

Where a server offers JMAP and IMAP alike, this is the better of the two. A JMAP row is a *conversation* rather than a single message, and the reader draws a rail of that conversation's other messages down its side — `n` and `p` walk it. Mail also arrives when the server sends it rather than when the next check comes round: every signed-in JMAP mailbox holds one event stream open whether or not the window is, so a message that lands on the server is in the list about a second later.

What your particular server does not have, the panel does not offer — and here that is a fact about your account rather than about the protocol. A server with no Archive mailbox has no Archive row and no `e`; one whose Junk folder trains nothing has no "report spam"; a credential that cannot submit mail makes the mailbox read-only. Each of them says which it is instead of failing after you have pressed it.


**IMAP** is an address and a password. Fastmail, iCloud, Zoho, GMX, Proton via its Bridge, or a server of your own: the servers are filled in from the address for the ones this knows, and shown behind a disclosure so they can be corrected for the ones it does not. Most providers want an *app password* rather than the one you sign in to their website with, and the form says so before you find out the hard way.

What IMAP does not have, the panel does not offer: no labels, no server-side
conversations, no "report spam" — moving a message to a Junk folder teaches a
server nothing, and a button that quietly meant that would be a promise this
could not keep. Archive appears only when the server has an archive folder to
move to. Sending goes out over SMTP, or the mailbox is read-only if no SMTP
server is set.

The sent copy is filed by Omamail rather than left to the server: a message handed to SMTP submission lands nowhere on its own. It goes to the server's own Sent folder, named by the server rather than guessed, and arrives already marked read; a server that reports no Sent folder holds no copy, and the status row says so. One thing worth knowing: a Gmail account read over IMAP has Google file its own copy of anything sent through Gmail's SMTP, so those accounts hold two.

If you enabled the optional CLI link, first run
`python3 scripts/backend-runtime.py disable-cli` from the plugin directory.
Omarchy has no verified uninstall hook to remove that external link for you.
Then remove the plugin:

```bash
omarchy plugin remove omamail
```

That removes the plugin and its private runtime. Account data, caches, drafts
and keyring entries stay in place. Removing those is separate and up to you:

```bash
secret-tool clear service omamail    # refresh tokens and JMAP and IMAP passwords
hey auth logout                      # the HEY session, if you added one
rm -rf ~/.config/omamail             # the OAuth client and account list
rm -rf ~/.cache/omamail              # cached mail
rm ~/.local/share/applications/omamail.desktop
```

Signing out from inside the app clears the keyring entry on its own. The plugin
never edits your shell, Hyprland or theme configuration. The keybinding above
and the mailto desktop file are yours to add and yours to remove.

## Connecting your mailbox

Gmail has no shared application to sign in through. Google issues API access
per Cloud project, so Omamail signs in with an OAuth client **you own**.
The window walks you through it in five steps, each with the console page one
click away. It takes about two minutes, once.

The step people skip, and the one that decides whether the sign-in lasts:
**press "Publish app"** on your own project. A project left in Testing is
issued refresh tokens that expire after seven days, so the app would sign you
out every week. Publishing shows an "unverified app" warning once — expected
for a client you made yourself, since you are the developer and the only user.

If you have the `gcloud` CLI, `scripts/google-cloud-project.sh` does the two
steps that have an API — creating the project and enabling Gmail — and opens
the console on the rest with the project already selected. The consent screen
and the client itself are console-only; there is no CLI for them.

> **Why isn't a client built in?** `gmail.modify` and `gmail.send` are
> *restricted* scopes. Shipping a client would mean this project completing
> Google's OAuth verification first; until then it would be stuck in Testing,
> handing every user a seven-day session. The code is ready for one —
> `Credentials.BUILTIN` is a single constant — and your own client always wins
> over it.

## Using it

Right-click does the rest. On a label in the rail: rename it, make a label beside or beneath it, move it under another, delete it, or watch it for new mail — a watched label counts its unread on every refresh and shows an eye. On the reader's From or To line: copy the address, or search the mailbox for mail from it or to it.

| Key | What it does |
| --- | --- |
| `j` / `k`; `Shift+J` / `Shift+K` | Move down / up; scroll the open message down / up |
| `Right` / `Left` | Open the selected message / return to the list |
| `Enter` or `o` | Open the selected message |
| `n` / `p` | Next / previous message in the conversation |
| `Esc` | Back to the list; close the window from the list |
| `e` | Archive |
| `d` | Move to trash |
| `s` | Star or unstar |
| `v` | Move to a label or folder |
| `Shift+I` / `Shift+U` | Mark read / unread |
| `r` / `a` / `f` | Reply, reply all, forward |
| `c` | Compose |
| `Ctrl+Enter` | Send |
| `/` | Search |
| `Alt+1` … `Alt+0` | The mailbox with that number on the rail |
| `Alt+A` | Switch account |
| `Space` / `x` | Select the message; `e`, `d`, `s`, `v`, `Shift+I`, `Shift+U` then act on every selected one |
| `Ctrl+A` | Select every message loaded, or none |
| `Alt+G` | Open AI assistance for the message, selection, or draft in the right dock |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom the message body, or reset it |
| `F5` / `Ctrl+R` | Check for mail |
| `?` | Every shortcut |

To act on several messages, hold Ctrl to replace the row actions with checkboxes, or Ctrl+click a row to select or deselect it without opening it. Checkboxes stay visible while any message is selected; releasing Ctrl with no selection restores the usual actions. `Space` or `x` toggles the keyboard cursor's row. Shift+click selects the range from the cursor to an unchecked row, or clears that range when the clicked row is already checked; other selections stay as they are. In the list, `Ctrl+A` selects every loaded message or clears the selection, and `Esc` clears an active selection before going back. The status bar shows how many messages are selected; archive, trash, star, move and read/unread actions apply to that selection while the list is visible.

Search paints matching cached rows first and adds server results as they arrive. It takes Gmail's own operator syntax straight through — `from:jane`, `has:attachment`, `older_than:7d`. The Unread mailbox leaves Promotions, Social and Forums out rather than asking for Primary: Gmail's categories do not remove the `INBOX` label, so an unread filter without that exclusion comes back as the whole promotional backlog rather than the mail you have not read — while one that asks for Primary comes back empty on any account where Gmail is not applying the category labels, which is unread mail with nothing left to say so. Updates stays in, because receipts, deliveries and notifications land there. Right-click any row in the list for archive, trash, spam, star and read/unread without leaving the keyboard cursor behind.

AI assistance uses the default AI selected in Omarchy, with no separate Omamail AI settings. Use the outline **AI icon** button beside Compose, the message menu, or `Alt+G`. Type a multiline question or use `/` for common commands, then Enter to send or Shift+Enter for a new line. The **…** menu opens new chats and conversation history. Results return to the right dock; draft suggestions can be inserted or replace the body after review. The panel streams the conversation and supports follow-up questions without opening a terminal. The background adapter currently supports Claude. See [AI assistance](docs/AGENT.md).

A signature is set per mailbox on the settings page, under Writing. It is placed under a new message and above the quoted text in a reply, so a sign-off stays next to the words it signs rather than stranded below a screen of somebody else's message. It is sent exactly as typed — no `-- ` line is added in front of it, because a client that adds one turns a signature into two decisions, and the line is one keystroke away for anybody who wants it. Each mailbox keeps its own: two addresses are two identities, and one sign-off under both is wrong for whichever it was not written for. A saved draft is reopened as it was written, so resuming one never signs it twice.

## What it does not do

- **No embedded browser.** A message opens in a reading view Omamail builds
  itself: headings, paragraphs, lists and links in your own type at a readable
  measure, with none of the sender's presentation in it. The sender's own
  layout is one click away, and that one renders through Qt's own rich text
  engine, which handles the HTML-4-and-inline-styles subset that real mail is
  written in. A browser engine cannot be embedded in a plugin at all:
  `QtWebEngineQuick::initialize()` has to run before the host process builds
  its `QGuiApplication`, and a plugin loads long after that.

Remote images in a message body are blocked until you ask for them, and asking
covers that one message. Rust fetches approved images and gives Qt raster data
URIs. Loading a message's pictures can fire tracking pixels and tell
the sender when the mail was read — which is why it is a decision rather than a
default. Images pointed at this machine or at the network around it (loopback,
private addresses, `.local` names, `file:`) are never fetched at all, however
often you ask: a message must not be able to make the client knock on the door
of something listening on your own network.

Several mailboxes can be added and switched between; each keeps its own cache,
its own refresh token, and its own unread count, and the bar badge counts all of
them. They share one OAuth client, since a client belongs to a Cloud project
rather than to an address — so adding a second mailbox is a sign-in, not another
trip through the console. Mailboxes are added and removed on the settings page,
and switched from the menu, the user bar at the foot of the rail, or `Alt+A` —
which opens the same switcher with the keyboard on the mailbox you are in:
`j`/`k` move, `Enter` or `o` takes one.

The message list, labels and profile are cached per account so cached views
can appear while a refresh runs. Parsed bodies and preloaded message resources
share a 256 MiB disk budget across all accounts, with least-recently-used eviction.
The Rust backend warms the first Inbox page and downloads newly discovered mail
in the background. Opening a cached message displays it before network
revalidation completes; a cache miss follows the normal loading path.
`j` and `k` immediately open the selected row in the reader.

The persistent Rust backend checks signed-in accounts automatically, including
while the mail window is closed. Each account uses the configured refresh
interval (120 seconds by default); checks run asynchronously across accounts,
and repeated checks for the same account are coalesced. The backend sends updated
counts and previews to the UI. Signing out cancels that account's checks;
stopping the shell also stops its backend. This does not install a separate
system service.

## Where your credentials live

- **A HEY mailbox has no credential here at all.** `hey` performs the OAuth
  flow, keeps the token in your keyring and refreshes it; Omamail only ever
  asks it whether it is signed in. Signing out from the setup page runs
  `hey auth logout`, which signs that client out for everything on the machine
  that uses it.
- The Gmail refresh token goes to **GNOME Keyring**, keyed by client *and* account,
  written over stdin so it never appears in the process table. Two mailboxes
  share one client, so keying by client alone would have let the second sign-in
  overwrite the first.
- The Outlook refresh token goes to **GNOME Keyring** under its own provider, client and account keys. The Microsoft Application (client) ID is public configuration and stays with the account entry.
- A JMAP or IMAP password goes to the same keyring, keyed by the account, and over stdin for the same reason. A JMAP credential is only ever sent to the server that answered the session request and to the addresses inside that session object.
- The OAuth client goes to `~/.config/omamail/credentials.json`, mode
  `0600`. Not to plugin settings — `shell.json` is world-readable.
- The access token exists only in memory.
- Signing out clears the keyring entry.

The app asks for `gmail.modify`, `gmail.send` and `calendar.events`.
`gmail.modify` covers reading, labelling, archiving and trashing, and
deliberately **cannot** delete anything permanently. `calendar.events` reads
calendars and writes events.

## Development

Rust sources live in `src/`: `cli/` handles commands, `backend/` handles the
persistent stdio protocol, and business modules are shared by both. Qt/QML,
JavaScript and runtime artwork live in `ui/`. UI unit tests are in `ui/tests/`,
Rust unit tests live with their modules, and `tests/` holds integration tests.
Rust owns mail transport and shared content processing, query/render caches,
action reconciliation, the durable outbox and compose recovery. QML keeps editor,
selection and presentation state. See [backend architecture](docs/BACKEND.md)
for the method inventory, security boundaries and remaining validation.

```bash
make install          # build/install the local backend, link the plugin, restart shell
./dev backend         # build the development Rust executable
./dev run             # build and print shell environment/start instructions
make validate         # tests, source regressions, qmllint, manifest check
```

`make install` installs the compiled release binary at `runtime/bin/omamail`
inside this checkout, then links the checkout into the Omarchy plugins directory.
Use `make install-backend-local` to build and replace only that binary without
restarting the shell. Unset `OMAMAIL_BIN` when using the installed runtime.

`OMAMAIL_BIN` is an explicit development override; a running shell must receive
that environment before constructing the plugin. See
[the runtime guide](docs/BACKEND-RUNTIME.md) for the restart limitation and the
publish-before-pin release workflow.

For reproducible synthetic MIME and reader CPU measurements, run
`python3 benchmarks/mail/run.py --samples 31 --batch 3 --qml` after other builds
and tests finish. The [benchmark guide](benchmarks/mail/README.md) explains the
frozen JS baseline, required output parity and measurement limits; these timings
do not measure mail-server latency or end-to-end inbox loading.

How to send a change — there is no issue tracker — is in
[CONTRIBUTING.md](CONTRIBUTING.md). Working agreements are in
[AGENTS.md](AGENTS.md) and the specification is in [docs/SPEC.md](docs/SPEC.md).

Omamail is an independent project and is not affiliated with Google, Microsoft or 37signals. Gmail is a trademark of Google LLC; Outlook is a trademark of Microsoft Corporation; HEY is a trademark of 37signals, LLC.

Licensed under the [MIT License](LICENSE).

[hey-cli]: https://github.com/basecamp/hey-cli
[microsoft-mail-oauth]: https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
