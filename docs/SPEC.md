# Omamail — Spec

A native mail client for Omarchy over the official Gmail API, Microsoft OAuth plus IMAP/SMTP, Microsoft Graph, the HEY CLI, JMAP and standard IMAP/SMTP. It is an NSH app: TSX views and interaction state (`App.tsx`, `src/`) over a Rust mail library (`core/`) linked into the same process through the native module `ext/omamail-native`. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Product shape

**This is a full application window, not a bar popup.** It runs as its own process with one main window (`App.tsx`), 1280×820 by default and 420×360 at the smallest. Hyprland treats it as an ordinary window. `nsh.json` makes it single-instance, so a second launch (a `mailto:` link, say) reaches the running window.

The Omarchy bar keeps one widget, `omarchy/notice/BarWidget.qml`: an envelope that opens the installed app, or says the app is missing and offers to install it. It runs no backend and reads no mail.

## Confirmed decisions

| Question | Decision |
|---|---|
| JMAP | **A fourth provider, after Gmail and HEY and ahead of IMAP.** "Any server that speaks JMAP": a protocol rather than a service, so there is no brand to draw and a mailbox here takes the themed envelope IMAP does, and no web front door either to link to or to open a message in. Signing in is an address and an app password or an API token — the auth scheme detected rather than asked, the server discovered from the address's domain unless one is typed — and the account id is `jmap:<address>`. It goes in front of IMAP because a server that speaks both is better read over JMAP: the server's own thread ids, a listing that collapses to conversations, a junk verb where the session proves the server learns from one, whole-account search, and one round trip for a batch. **A provider's capability list is a ceiling, not a promise.** An account may refuse one of them from what its own session and mailbox roles say, and the app weighs those refusals beside the ceiling: a server with no Archive mailbox loses the Archive rail row, the archive button and the `e` hint, and says why rather than failing after the row has already moved. The transport is Rust (`core/src/providers/jmap/`), and every signed-in account holds an event stream open while the app runs — a change on the server reaches the window within about a second, with the two-minute poll left as a backstop. |
| Microsoft 365 | **A work or school mailbox on Exchange Online over Microsoft Graph, with one device-code sign-in for mail and calendar; after Outlook in the chooser.** Microsoft refuses a device code that names two resources, so the sign-in asks only Graph scopes (`Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, and `openid`, `profile`, `email` and `offline_access` for the sign-in itself) and its one token serves mail and the existing Graph calendar code: no IMAP, no SMTP, no second code. Omamail ships no registration of its own (Outlook's built-in ID is another registration's), so the setup page asks for the Application (client) ID of a public client the person registers once in Microsoft Entra and says how. The account id is `m365:<address>`; the refresh token lives in the keyring and the access token in the backend's memory, and no token or device code is in the TSX app or `accounts.json` (the entry's `clientId` is a name, not a secret). **The ceiling is `archive`, `star`, `batch`, `search` and `send`.** The rail is Outlook's; Archive, Junk and Trash show when the mailbox has the folder. No labels, folders of your own, conversations or report-spam; drafts are kept in the mailbox's Drafts folder. The page warns that a browser signed in to another Microsoft account may offer that one and advises a private window. |
| List granularity | **One row per conversation where the provider declares `conversations`, one row per message everywhere else.** Having a server-side thread id is not the same question as whether the listing collapses, which is why `conversations` is a capability of its own beside `threads`. Gmail has thread ids and still lists messages (`messages.list`): aggregating them costs an extra `threads.get` round trip per page and doubles the UI states. That objection does not apply to JMAP, where the query, the ids and the members arrive in one chained POST and a collapsed listing therefore costs no extra round trip at all; HEY's rows have always been conversations, since `hey threads` answers one entry per topic. A row above the seam stands for a conversation on those two and for a message on Gmail and IMAP, and the reader draws a rail of the members when there is more than one. |
| Body rendering | **Three readings of one message, and reading mode is the default.** Reading mode discards the sender's presentation and rebuilds the message out of what it says — paragraphs, headings, lists, quotes, links, small data tables — in this window's type at a bounded measure; nothing but text, a checked `href`, a checked image source, and bounded numeric image dimensions crosses from the sender's document, so no sender markup reaches the window at all. Original is the sender's own layout, sanitised in Rust and redrawn from an allowlist, kept for the receipts and tables whose layout is carrying something. Plain is the text. All three are built from one parse when the body arrives, so choosing between them costs neither a fetch nor a reparse. Remote images are blocked in every one of them until the reader asks; approved visible images are then fetched without redirects and with byte/time limits, and the window receives only completed `data:` URIs, never pending remote sources or loading placeholders. The fetch still reports the read to the image host. A source aimed at loopback, a private address or a local file is never fetched at all. No browser engine: the body is drawn by NSH's `TextView`, which fetches nothing on its own. See [MESSAGE-RENDERING.md](MESSAGE-RENDERING.md). |
| Sending | **Included.** Reply, reply-all, forward, and compose, plain-text body with quoted original. Requires the `gmail.send` scope. |
| Bar click | **Opens the app window directly.** The notice widget has no other action. |
| Compose surface | **The whole content area of the one window.** A reply does not open a second window. Several accounts share that window; a second mailbox is not a second window. |
| Mailto handler | **This window's compose form.** On Linux, Settings > Default mail client writes the app's own `.desktop` entry claiming `x-scheme-handler/mailto` (`ext/omamail-native/src/mail_client.rs`); the link opens a draft in the running window. |
| List triage | **Right-click context menu** on any row: reply / reply all / forward, archive / trash / spam, mark read-unread, star, open in browser. |
| Reader actions | **Icons with tooltips**, not labelled buttons — six actions fit where six labels would not, with the destructive one set apart by a rule and the urgent colour. Icons are Lucide icons named in `src/ui/Icon.tsx`; provider marks keep their own colours. |
| Invitations | **Read from the message's own `text/calendar` part, answered as an RFC 5546 reply.** No calendar API and no second OAuth scope: an RSVP is a mail to the organiser carrying `METHOD:REPLY` and this account's `ATTENDEE` line, which is what every calendar server already listens for — so it works identically on IMAP. Gmail withholds the octets of any part the sender named and Google Calendar names both of the two it sends, so the file itself is one more request, made only for a message that has an invitation in it. Times are resolved through the `VTIMEZONE` the sender ships rather than a timezone database; a zone that arrives without one keeps the organiser's wall clock and names it, instead of showing a conversion nothing backs. |
| Unsubscribing | **One click where RFC 8058 promises it will work, and only there.** A `List-Unsubscribe-Post` header plus an `https` URL on a public host is a POST that finishes in the window; an address is a message; anything else opens the sender's page, and the label says so. Whether a URL may be fetched is the same judgement that decides whether a message may load a picture. |
| Sidebar | **An open but narrow icon rail** (148px; 44px collapsed), named by tooltips either way. Collapsing is one click. |
| Loading | **Cache first, then stream.** Every query, the label list, the profile and opened bodies are kept under `$XDG_CACHE_HOME/omamail`, keyed by query and bound to the mailbox address. Query summaries share one atomically written file and are capped per query; opened bodies live one file each. Switching mailboxes paints immediately and revalidates behind it. A first-time search filters only cached summaries inside the provider's server-search scope, then treats the server ids as authoritative so a stale preview cannot survive or be persisted. Interactive IMAP search reads only the highest UID first and reports one bounded newest range before taking a UID snapshot for any remaining message-bounded searches on a reused connection. Its settled prefix is final, and one queued metadata read feeds small header batches to the list before the rest of the page. A rotating `Searching server` state inside the query field says that this visible answer is still growing, and disappears only after the listing and its outstanding metadata reads have finished. |
| Setup | **Two steps, one at a time.** Finished steps collapse to a line with a check; the walkthrough hides behind a disclosure. The Publish-app warning stays beside the sign-in button, because it decides whether the session lasts seven days or indefinitely. |

## Authentication

Release backends ship a Google desktop OAuth client compiled in from CI
secrets (see BACKEND-RUNTIME.md). A user may still create their own client,
guided by an in-app four-step walkthrough; it always takes precedence, and
development builds ship none.

- Authorization Code + PKCE, loopback redirect `http://127.0.0.1:9481/oauth2callback`
- The listener is a single-shot loopback listener in Rust (`core/src/auth/callback.rs`); the browser does the rest
- The native token exchange and Gmail calls connect directly to
  `oauth2.googleapis.com` and `gmail.googleapis.com`. They do not use HTTP
  proxy environment variables or desktop proxy settings, so a network that
  requires a proxy needs a system-wide VPN that routes those hosts
- Scopes: `gmail.modify` (read, label, archive, trash — cannot permanently
  delete), `gmail.send` and `calendar.events` (read calendars, write events)
- Refresh token → the platform credential store (Secret Service over D-Bus on Linux, the Keychain on macOS, Credential Manager on Windows; `core/src/credentials/`), keyed by client and account
- User-supplied client id/secret → `~/.config/omamail/credentials.json`, mode 0600.
  Not app settings.
- Access token → process memory only

Outlook.com and Hotmail use Microsoft's OAuth device-code flow for delegated IMAP and SMTP access. The user supplies a public-client Application ID until the project has a maintainer-owned registration to ship.

- Tenant: `consumers`; scopes: `offline_access`, `https://outlook.office.com/IMAP.AccessAsUser.All`, `https://outlook.office.com/SMTP.Send`
- Refresh token → the platform credential store, keyed by provider, client and account
- Application ID → the account entry; it is public configuration and there is no client secret
- Access token → used by the backend's IMAP and SMTP connections; the TSX sign-in (and `auth.token`) also holds it in memory and never stores it

Microsoft 365 uses the same device-code flow with Graph scopes only, so one code serves mail and calendar. The backend holds the flow: the user supplies the Application (client) ID of a public client, there is no client secret, the refresh token goes to the keyring keyed by account and client (the ID in lower case, however it was typed), and the access token stays in the backend's memory. The sign-in names the tenant after the domain of the typed address and retries once with `organizations` when Microsoft does not know that domain.

## Features

**Ship in v1**

- Four kinds of mailbox, in the order the chooser offers them: Gmail, HEY, JMAP, and IMAP for every server the first three do not name
- Mailboxes: Inbox, Unread, Starred, Sent, All mail, Trash, plus user labels
- Message list: sender, subject, snippet, time, unread dot, star; paging. One row per conversation on HEY and JMAP, one per message on Gmail and IMAP
- Reader: headers, the message read three ways, attachment list, open in browser
- Actions: read/unread, star, archive, trash, untrash, report spam, mark all read
- Compose, reply, reply-all, forward
- Calendar invitations: full meeting detail, RSVP, and one-click Meet join
- Calendar: month and week views over Google Calendar, Microsoft calendars (Outlook.com and Microsoft 365, through Graph with the mailbox's sign-in) and CalDAV, with event create, edit and delete. Google calendars follow the current mailbox by default. A setting can combine every connected account in one view.
- One-click unsubscribe from mailing lists that support it
- Search using Gmail's own operator syntax
- Merged desktop notification for new mail
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
`BINDINGS` in `src/keys/keymap.ts`; the shortcut sheet, the status hints and `docs/KEYS.md` all
render or are checked against it, so no second list is maintained by hand.

`j`/`k` move · `Enter` or `o` open · `u` back to list · `e` archive · `d` trash ·
`s` star · `r`/`a`/`f` reply, reply all, forward · `c` compose · `/`
search · `Alt+1`…`0` the mailboxes · `Alt+A` switch account · `?` the reference sheet ·
`Esc` back or close.

**See `docs/KEYS.md`** for the model, the contexts and the full table.

## Constraints

- Every colour comes from the active Omarchy theme. No hard-coded hex outside
  a brand asset.
- Mail logic lives in Rust under `core/`; parsing, formatting and decision rules the interface needs live in plain TypeScript modules under `src/mail/`, testable headless with `nsh test`.
- No runtime helper programs: networking, TLS, the OAuth listener and the credential store are Rust. The app starts only the providers' official programs (the HEY CLI), a configured AI agent, and the desktop's own tools for opening links and attachments and, on Linux, for registering the default mail client.
