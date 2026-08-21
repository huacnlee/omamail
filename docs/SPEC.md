# Omamail — Spec

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
| `panel` | `App.qml` | The application window — a single `FloatingWindow`, 980×720 default, 760×520 minimum. Hyprland treats it as an ordinary window. |

## Confirmed decisions

| Question | Decision |
|---|---|
| List granularity | **One row per message** (`messages.list`), not per thread. Thread aggregation costs an extra `threads.get` round trip per page and doubles the UI states. |
| Body rendering | **Qt RichText by default**, with a plain-text toggle. Remote images are blocked until the reader asks, per message: Qt performs the fetch for real, so rendering one fires the sender's tracking pixels and reports the read. A source aimed at loopback, a private address or a local file is never fetched at all. No browser engine: `QtWebEngineQuick::initialize()` must run before the host process's `QGuiApplication` is constructed, which a plugin loaded later cannot do. |
| Sending | **Included.** Reply, reply-all, forward, and compose, plain-text body with quoted original. Requires the `gmail.send` scope. |
| Bar click | **Opens the app window directly.** Middle click refreshes, right click opens a small menu. |
| Compose surface | **The whole content area of the one window.** Omarchy's panel mechanism gives every extra window its own region, so a reply must not open one. Several accounts share that window; a second mailbox is not a second window. |
| List triage | **Right-click context menu** on any row: reply / reply all / forward, archive / trash / spam, mark read-unread, star, open in browser. |
| Reader actions | **Icons with tooltips**, not labelled buttons — six actions fit where six labels would not, with the destructive one set apart by a rule and the urgent colour. Icons are Canvas paths on one 16px grid, because Qt's SVG renderer smears strokes at this size. |
| Invitations | **Read from the message's own `text/calendar` part, answered as an RFC 5546 reply.** No calendar API and no second OAuth scope: an RSVP is a mail to the organiser carrying `METHOD:REPLY` and this account's `ATTENDEE` line, which is what every calendar server already listens for — so it works identically on IMAP. Gmail withholds the octets of any part the sender named and Google Calendar names both of the two it sends, so the file itself is one more request, made only for a message that has an invitation in it. Times are resolved through the `VTIMEZONE` the sender ships rather than a timezone database; a zone that arrives without one keeps the organiser's wall clock and names it, instead of showing a conversion nothing backs. |
| Unsubscribing | **One click where RFC 8058 promises it will work, and only there.** A `List-Unsubscribe-Post` header plus an `https` URL on a public host is a POST that finishes in the window; an address is a message; anything else opens the sender's page, and the label says so. Whether a URL may be fetched is the same judgement that decides whether a message may load a picture. |
| Sidebar | **An open but narrow icon rail** (148px; 44px collapsed), named by tooltips either way. Collapsing is one click. |
| Loading | **Cache first.** Every query, the label list, the profile and opened bodies are kept in one atomically written file under `$XDG_CACHE_HOME/omamail`, keyed by query and bound to the mailbox address. Switching mailboxes paints immediately and revalidates behind it. |
| Setup | **Two steps, one at a time.** Finished steps collapse to a line with a check; the walkthrough hides behind a disclosure. The Publish-app warning stays beside the sign-in button, because it decides whether the session lasts seven days or indefinitely. |

## Authentication

Gmail has no shared public client the way Spotify does — Google issues API
access per Cloud project — so each user creates their own OAuth client once,
guided by an in-app four-step walkthrough.

- Authorization Code + PKCE, loopback redirect `http://127.0.0.1:9481/oauth2callback`
- Listener is a single-shot `socat`; the browser does the rest
- Scopes: `gmail.modify` (read, label, archive, trash — cannot permanently
  delete) and `gmail.send`
- Refresh token → GNOME Keyring via `secret-tool`, keyed by client and account
- Client id/secret → `~/.config/omamail/credentials.json`, mode 0600.
  Not plugin settings: `shell.json` is world-readable.
- Access token → process memory only

## Features

**Ship in v1**

- Mailboxes: Inbox, Unread, Starred, Sent, All mail, Trash, plus user labels
- Message list: sender, subject, snippet, time, unread dot, star; paging
- Reader: headers, HTML or plain body, attachment list, open in browser
- Actions: read/unread, star, archive, trash, untrash, report spam, mark all read
- Compose, reply, reply-all, forward
- Calendar invitations: full meeting detail, RSVP, and one-click Meet join
- One-click unsubscribe from mailing lists that support it
- Search using Gmail's own operator syntax
- Unread badge in the bar; merged desktop notification for new mail
- CJK correctness: RFC 2047 encoded-word headers, hand-rolled base64 + UTF-8
- Full keyboard operation with Gmail's key bindings
- Several accounts at once, each with its own cache and unread count, switched
  from the sidebar, the menu, or `Alt+A`

**Explicitly out of scope**

- Embedded browser engine (see above)
- Attachment download (v1.1)
- Offline cache

## Keyboard

The keyboard belongs to the application and the context says what a key means
where, the way a TUI scopes its keys. Every binding lives in one table,
`keys/Keymap.js`; the shortcut sheet, the status hints and `docs/KEYS.md` all
render or are checked against it, so no second list is maintained by hand.

`j`/`k` move · `Enter` or `o` open · `u` back to list · `e` archive · `d` trash ·
`s` star · `r`/`a`/`f` reply, reply all, forward · `c` compose · `/` or `Ctrl+K`
search · `Alt+1`…`0` the mailboxes · `Alt+A` switch account · `?` the reference sheet ·
`Esc` back or close.

**See `docs/KEYS.md`** for the model, the contexts, the full table, and the four
Qt behaviours this design is shaped around.

## Constraints

- Every colour comes from the active Omarchy theme. No hard-coded hex outside
  a brand asset.
- All parsing, formatting, and decision logic lives in `.pragma library` JS
  files so it is testable under node without a compositor.
- No dependency beyond what Omarchy already ships: `socat`, `secret-tool`,
  `openssl`, `xdg-open`, `notify-send`.
