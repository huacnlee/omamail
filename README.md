# Omamail

**Gmail as a native Omarchy window — not a browser tab.**

A Quickshell plugin that reads, triages, and answers your mail over the
official Gmail API. It runs inside the `omarchy-shell` process you already
have, follows your active theme, and puts an unread count in the bar.

<img width="800" alt="image" src="https://github.com/user-attachments/assets/3a554014-bcde-40af-a133-8e599a4c34e2" />

And with mini size mode:

<img width="330" alt="image" src="https://github.com/user-attachments/assets/670e2df9-d113-4e94-b4e7-f1787e3a8bc6" /> <img width="330" alt="image" src="https://github.com/user-attachments/assets/23e9dad0-d3f7-49a1-a47b-2227698e1a4d" />

## What it is

Three parts, one plugin:

- an **unread badge** in the bar, which keeps counting whether or not the
  window is open
- an **application window** — a real Hyprland window, tiled like any other,
  with your mailboxes, the message list, and the reader side by side
- **compose and reply inside that same window**, because a second window would
  take a region of its own under Omarchy's panel mechanism

Everything is monospace, square-cornered, and coloured from your theme, because
that is what the rest of Omarchy looks like.

## Add it to Omarchy

```bash
omarchy plugin add https://github.com/huacnlee/omamail.git --enable
```

Then click the envelope in the bar. To open it from the keyboard, add this to
`~/.config/hypr/bindings.lua`:

```lua
  o.bind("SUPER + SHIFT + G", "Omamail", "omarchy shell shell toggle omamail.omarchy '{}'")
```

The target is `shell`, not the plugin id: the window is summoned by the shell,
which is what loads it in the first place. A plugin-scoped target would have to
be registered by code that is only running once the window is already open.

Requires Omarchy 4, plus `socat`, `secret-tool`, `openssl` and `xdg-open` —
all of which Omarchy already ships.

To remove it:

```bash
omarchy plugin remove omamail.omarchy
```

That takes the plugin itself. Nothing it wrote lives inside your Omarchy
config, so removing those is separate and entirely up to you:

```bash
secret-tool clear service omamail    # the refresh token
rm -rf ~/.config/omamail             # the OAuth client and account list
rm -rf ~/.cache/omamail              # cached mail
```

Signing out from inside the app clears the keyring entry on its own. The plugin
never edits your shell, Hyprland or theme configuration — the one keybinding
above is yours to add and yours to remove.

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
| `Enter` | Open the selected message |
| `Esc` | Back to the list; close the window from the list |
| `e` | Archive |
| `d` | Move to trash |
| `s` | Star or unstar |
| `Shift+I` / `Shift+U` | Mark read / unread |
| `r` / `a` / `f` | Reply, reply all, forward |
| `c` | Compose |
| `Ctrl+Enter` | Send |
| `/` or `Ctrl+K` | Search |
| `g` then `i` / `s` / `u` / `t` | Inbox, starred, unread, sent |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom the message body, or reset it |
| `F5` | Check for mail |
| `Ctrl+?` | Every shortcut |
| `Esc` | Back, or close the window |

Search takes Gmail's own operator syntax straight through — `from:jane`,
`has:attachment`, `older_than:7d`. Right-click any row in the list for archive,
trash, spam, star and read/unread without leaving the keyboard cursor behind.

## What it does not do

- **No embedded browser.** Message bodies render through Qt's own rich text
  engine, which handles the HTML-4-and-inline-styles subset that real mail is
  written in. A browser engine cannot be embedded in a plugin at all:
  `QtWebEngineQuick::initialize()` has to run before the host process builds
  its `QGuiApplication`, and a plugin loads long after that.
- **No attachment downloads.** Not yet.

Images in a message body load by default. Qt really does fetch them, so opening
a message fires whatever tracking pixels it carries — the same as any mail
client that shows pictures without asking.

Several mailboxes can be added and switched between; each keeps its own cache,
its own refresh token, and its own unread count, and the bar badge counts all of
them. They share one OAuth client, since a client belongs to a Cloud project
rather than to an address.

The message list, labels and profile are cached per account so switching never
waits on the network. Message bodies are cached one file per message — a
thousand of them, evicted least-recently-used.

## Where your credentials live

- The refresh token goes to **GNOME Keyring**, keyed by client id, written over
  stdin so it never appears in the process table.
- The OAuth client goes to `~/.config/omamail/credentials.json`, mode
  `0600`. Not to plugin settings — `shell.json` is world-readable.
- The access token exists only in memory.
- Signing out clears the keyring entry.

The app asks for `gmail.modify` and `gmail.send`. `gmail.modify` covers reading,
labelling, archiving and trashing, and deliberately **cannot** delete anything
permanently.

## Development

```bash
./install.sh          # symlink this checkout into ~/.config/omarchy/plugins
make validate         # node tests, source regressions, qmllint, manifest check
```

Working agreements are in [AGENTS.md](AGENTS.md); the design canvas and the
implementation plan are under [docs/](docs/).

Omamail is an independent project and is not affiliated with Google.
Gmail is a trademark of Google LLC.

Licensed under the [MIT License](LICENSE).
