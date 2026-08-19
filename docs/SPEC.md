# Omarchy Gmail — Spec

A native Gmail client for Omarchy, built as a Quickshell plugin on the official
Gmail REST API. Same technology as Omarchy-Spotify: QML views over plain-JS
logic, running inside the existing `omarchy-shell` process.

## Product shape

**This is a full application window, not a bar popup.** The bar widget exists
only as an unread indicator and a launcher.

Three plugin entry points (`manifest.kinds`):

| Kind | File | Responsibility |
|---|---|---|
| `service` | `Service.qml` | Shared singleton: auth, API, mailbox state, unread polling, new-mail notifications. Lives whether or not the window is open. |
| `bar-widget` | `BarWidget.qml` | Envelope icon + unread badge in the bar. Left click opens the app window. |
| `panel` | `App.qml` | The application window — `FloatingWindow`, 980×720 default, 760×520 minimum, plus a second `FloatingWindow` for compose. Hyprland treats both as ordinary windows. |

## Confirmed decisions

| Question | Decision |
|---|---|
| List granularity | **One row per message** (`messages.list`), not per thread. Thread aggregation costs an extra `threads.get` round trip per page and doubles the UI states. |
| Body rendering | **Qt RichText by default**, with remote images blocked until the reader opts in, plus a plain-text toggle. No browser engine — `QtWebEngineQuick::initialize()` must run before the host process's `QGuiApplication` is constructed, which a plugin loaded later cannot do. |
| Sending | **Included.** Reply, reply-all, forward, and compose, plain-text body with quoted original. Requires the `gmail.send` scope. |
| Bar click | **Opens the app window directly.** Middle click refreshes, right click opens a small menu. |
| Compose surface | **Its own window**, not a pane inside the mailbox. Hyprland tiles it beside the main window, so the message being answered stays on screen. 720×560. |
| List triage | **Right-click context menu** on any row: reply / reply all / forward, archive / trash / spam, mark read-unread, star, open in browser. |
| Reader actions | **Icons with tooltips**, not labelled buttons — six actions fit where six labels would not, with the destructive one set apart by a rule and the urgent colour. |

## Authentication

Gmail has no shared public client the way Spotify does — Google issues API
access per Cloud project — so each user creates their own OAuth client once,
guided by an in-app four-step walkthrough.

- Authorization Code + PKCE, loopback redirect `http://127.0.0.1:9481/oauth2callback`
- Listener is a single-shot `socat`; the browser does the rest
- Scopes: `gmail.modify` (read, label, archive, trash — cannot permanently
  delete) and `gmail.send`
- Refresh token → GNOME Keyring via `secret-tool`, keyed by client id
- Client id/secret → `~/.config/omarchy-gmail/credentials.json`, mode 0600.
  Not plugin settings: `shell.json` is world-readable.
- Access token → process memory only

## Features

**Ship in v1**

- Mailboxes: Inbox, Unread, Starred, Sent, All mail, Trash, plus user labels
- Message list: sender, subject, snippet, time, unread dot, star; paging
- Reader: headers, HTML or plain body, attachment list, open in browser
- Actions: read/unread, star, archive, trash, untrash, report spam, mark all read
- Compose, reply, reply-all, forward
- Search using Gmail's own operator syntax
- Unread badge in the bar; merged desktop notification for new mail
- CJK correctness: RFC 2047 encoded-word headers, hand-rolled base64 + UTF-8
- Full keyboard operation with Gmail's key bindings

**Explicitly out of scope**

- Embedded browser engine (see above)
- Multiple accounts (v2)
- Attachment download (v1.1)
- Offline cache

## Keyboard

`j`/`k` move · `Enter` open · `u` back to list · `e` archive · `#` trash ·
`s` star · `r` reply · `a` reply all · `f` forward · `c` compose ·
`/` or `Ctrl+K` search · `g i` inbox · `g s` starred · `Shift+I`/`Shift+U`
read/unread · `Ctrl+/` shortcut reference · `Esc` back or close

## Constraints

- Every colour comes from the active Omarchy theme. No hard-coded hex outside
  a brand asset.
- All parsing, formatting, and decision logic lives in `.pragma library` JS
  files so it is testable under node without a compositor.
- No dependency beyond what Omarchy already ships: `socat`, `secret-tool`,
  `openssl`, `xdg-open`, `notify-send`.
