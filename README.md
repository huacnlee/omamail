# Omamail

**Your mail as a native Omarchy window — not a browser tab.**

Omamail is an Omarchy desktop email client: a Quickshell plugin that reads,
triages, and answers your mail over the official Gmail API, over the HEY CLI
client 37signals publish, or over IMAP and SMTP for every other mailbox. It
runs inside the `omarchy-shell` process you already have, follows your active
theme, and puts an unread count in the bar.


<img width="800" alt="Omamail - Reading a message in the three-column window" src="docs/images/full-mail.webp" />

The calendar, a new message, and the question every new mailbox starts with:

<img width="265" alt="Omamail - The calendar in month view" src="docs/images/full-calendar.webp" /> <img width="265" alt="Omamail - Writing a new message" src="docs/images/full-compose.webp" /> <img width="265" alt="Omamail - Adding a mailbox: Gmail, HEY or IMAP" src="docs/images/full-add-mailbox.webp" />

And with mini size mode:

<img width="265" alt="Omamail - Mini size: the message list" src="docs/images/mini-list.webp" /> <img width="265" alt="Omamail - Mini size: one message open" src="docs/images/mini-message.webp" /> <img width="265" alt="Omamail - Mini size: writing a new message" src="docs/images/mini-compose.webp" />

Works with **Gmail**, **HEY**, **Fastmail**, **iCloud Mail**, **Outlook**,
**Yahoo**, **Zoho**, **GMX**, **Proton Mail** (through its Bridge), and any
other IMAP server — including one you run yourself.

## Features

- **Designed, not assembled.** Monospace, square-cornered, and built to sit
  inside Omarchy rather than to look like a web app in a window. Three columns
  when there is room, one when there is not, and nothing on screen that is not
  your mail.
- **Gmail, HEY and IMAP.** Sign in to Gmail with Google directly, to HEY
  through the HEY CLI that 37signals publish, or add any IMAP mailbox with an
  address and an app password. Several accounts at once, each with its own
  inbox, cache and unread count.
- **Keyboard-first.** `j`/`k` to move, `e` to archive, `s` to star, `r` to
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
- **Keyring-backed.** The Gmail refresh token and every IMAP password live in
  GNOME Keyring — never in a config file, never on a command line. A HEY
  mailbox has no credential here at all: the HEY CLI holds its own token, and
  Omamail only ever asks it whether it is signed in.

## What it is

Three parts, one plugin:

- an **unread badge** in the bar, which keeps counting whether or not the
  window is open
- an **application window** — a real Hyprland window, tiled like any other,
  with your mailboxes, the message list, and the reader side by side
- **compose and reply inside that same window**, because a second window would
  take a region of its own under Omarchy's panel mechanism. A `mailto:` link
  from elsewhere on the desktop opens that same compose form.

## Add it to Omarchy

```bash
omarchy plugin add https://github.com/huacnlee/omamail.git --enable
```

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

Requires Omarchy 4, plus `socat`, `secret-tool`, `openssl`, `xdg-open` and
`curl` — all of which Omarchy already ships. A HEY mailbox additionally needs
`hey`; see below.

## Mailboxes it can open

Adding a mailbox asks which kind first, because the three setups have nothing in
common.

**Gmail** signs in with Google directly. Google issues Gmail API access per
project, so this route needs an OAuth client you create once — the setup page
walks through it. In exchange it gets labels, conversations, Gmail's own search
syntax, and a "report spam" that Google actually learns from.

**HEY** needs no address and no password. HEY publishes no IMAP, no POP and no
public API, so Omamail reads it through the [HEY CLI][hey-cli] client 37signals
ship for exactly this — which means the sign-in, the token and the keyring entry
it lives in are all `hey`'s, and Omamail never asks for your HEY password.

Install it once:

```bash
curl -fsSL https://hey.com/install-cli | bash
```

Recent versions of Omarchy install it for you as a lazy mise tool, and
`omarchy-mise-install github:basecamp/hey-cli hey` does the same thing by hand.
Either way it lands in `~/.local/bin`, which is where Omamail looks when it is
not already on `PATH`. Then choose **HEY** on the setup page and press **Sign in
to HEY** — that opens HEY in your browser, and nothing else is asked of you.

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


**IMAP** is an address and a password. Fastmail, iCloud, Zoho, Outlook, GMX,
Proton via its Bridge, or a server of your own: the servers are filled in from
the address for the ones this knows, and shown behind a disclosure so they can
be corrected for the ones it does not. Most providers want an *app password*
rather than the one you sign in to their website with, and the form says so
before you find out the hard way.

What IMAP does not have, the panel does not offer: no labels, no server-side
conversations, no "report spam" — moving a message to a Junk folder teaches a
server nothing, and a button that quietly meant that would be a promise this
could not keep. Archive appears only when the server has an archive folder to
move to. Sending goes out over SMTP, or the mailbox is read-only if no SMTP
server is set.

To remove it:

```bash
omarchy plugin remove omamail
```

That takes the plugin itself. Nothing it wrote lives inside your Omarchy
config, so removing those is separate and entirely up to you:

```bash
secret-tool clear service omamail    # the refresh token and IMAP passwords
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

If you have the `gcloud` CLI, `scripts/google-cloud-setup.sh` does the two
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

| Key | What it does |
| --- | --- |
| `j` / `k` | Move down / up |
| `Enter` or `o` | Open the selected message |
| `Esc` | Back to the list; close the window from the list |
| `e` | Archive |
| `d` | Move to trash |
| `s` | Star or unstar |
| `Shift+I` / `Shift+U` | Mark read / unread |
| `r` / `a` / `f` | Reply, reply all, forward |
| `c` | Compose |
| `Ctrl+Enter` | Send |
| `/` or `Ctrl+K` | Search |
| `Alt+1` … `Alt+0` | The mailbox with that number on the rail |
| `Alt+A` | Switch account |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom the message body, or reset it |
| `F5` | Check for mail |
| `Ctrl+?` | Every shortcut |

Search paints matching cached rows first and adds server results as they arrive. It takes Gmail's own operator syntax straight through — `from:jane`, `has:attachment`, `older_than:7d`. The Unread mailbox leaves Promotions, Social and Forums out rather than asking for Primary: Gmail's categories do not remove the `INBOX` label, so an unread filter without that exclusion comes back as the whole promotional backlog rather than the mail you have not read — while one that asks for Primary comes back empty on any account where Gmail is not applying the category labels, which is unread mail with nothing left to say so. Updates stays in, because receipts, deliveries and notifications land there. Right-click any row in the list for archive, trash, spam, star and read/unread without leaving the keyboard cursor behind.

## What it does not do

- **No embedded browser.** A message opens in a reading view Omamail builds
  itself: headings, paragraphs, lists and links in your own type at a readable
  measure, with none of the sender's presentation in it. The sender's own
  layout is one click away, and that one renders through Qt's own rich text
  engine, which handles the HTML-4-and-inline-styles subset that real mail is
  written in. A browser engine cannot be embedded in a plugin at all:
  `QtWebEngineQuick::initialize()` has to run before the host process builds
  its `QGuiApplication`, and a plugin loads long after that.
- **No attachment downloads.** Not yet.

Remote images in a message body are blocked until you ask for them, and asking
covers that one message. Qt really does fetch an `<img src="https://…">`, so
loading a message's pictures fires whatever tracking pixels it carries and tells
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

The message list, labels and profile are cached per account so switching never
waits on the network. Message bodies are cached one file per message — a
thousand of them, evicted least-recently-used.

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
- The OAuth client goes to `~/.config/omamail/credentials.json`, mode
  `0600`. Not to plugin settings — `shell.json` is world-readable.
- The access token exists only in memory.
- Signing out clears the keyring entry.

The app asks for `gmail.modify`, `gmail.send` and `calendar.events`.
`gmail.modify` covers reading, labelling, archiving and trashing, and
deliberately **cannot** delete anything permanently. `calendar.events` reads
calendars and writes events.

## Development

```bash
./install.sh          # symlink this checkout into ~/.config/omarchy/plugins
make validate         # node tests, source regressions, qmllint, manifest check
```

Working agreements are in [AGENTS.md](AGENTS.md) and the specification is in
[docs/SPEC.md](docs/SPEC.md).

Omamail is an independent project and is not affiliated with Google or
37signals. Gmail is a trademark of Google LLC; HEY is a trademark of 37signals,
LLC.

Licensed under the [MIT License](LICENSE).

[hey-cli]: https://github.com/basecamp/hey-cli
