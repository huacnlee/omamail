# Where network requests are made

All networking is in Rust, in `core/`. The TSX app makes no network requests: it asks the backend through `src/backend/client.ts`, and the native module `ext/omamail-native` carries the call to `core/` in the same process. Nothing runs curl, Python or shell scripts to reach a server.

This page replaces the evidence log kept while the Qt client's scripts and `XMLHttpRequest` calls were moved into Rust. That migration is finished and the Qt client is gone; the log is in the git history.

| Requests | Where they are made |
| --- | --- |
| Gmail reads, writes and sends | `core/src/providers/gmail*.rs` |
| Google sign-in (PKCE, loopback callback, token exchange) and Outlook's device-code sign-in | `core/src/auth/` |
| Microsoft 365 over Graph | `core/src/providers/m365/`, with tokens in `core/src/auth/credentials/m365.rs` |
| IMAP and SMTP, including Outlook.com | `core/src/providers/imap/`, with TLS in `core/src/tls/` |
| JMAP, including its event stream | `core/src/providers/jmap/` |
| HEY | The official HEY CLI, started from `core/src/providers/hey.rs` through `core/src/process/` |
| Calendars (Google, Microsoft Graph, CalDAV) | `core/src/calendar/` |
| Google contact suggestions | `core/src/contacts/google.rs` |
| Sender-chosen addresses: remote images and one-click unsubscribe | `core/src/public_http/` |

The rules these requests follow (deadlines, size bounds, redirects, pinned public addresses, where credentials may go) are in [SECURITY-BOUNDARIES.md](SECURITY-BOUNDARIES.md).
