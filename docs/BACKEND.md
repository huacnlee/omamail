# Rust backend migration

The intended architecture has one Rust domain implementation consumed by the
headless CLI and the Omarchy QML plugin. The shell still constructs Service.qml;
the plugin entry point is not replaced by Flea's standalone GUI launcher.
Service will own the backend process so opening or closing a window does not
restart accounts. QML will retain theme, focus, layout and rendering state.

Migration is incomplete. The versioned protocol, CLI entry point and read-only
account listing exist. Service.qml owns a persistent Backend component; setting `OMAMAIL_BIN` to the built executable enables it during migration. It performs a protocol handshake and exposes correlated calls with pending-request limits and deadlines. No mail operation has moved to Rust. `info` reports the implemented methods, not planned features.

## Build and protocol

Sources are organized by responsibility: `src/cli/mod.rs` handles command-line
arguments, `src/backend/mod.rs` composes the backend, and `protocol.rs`,
`rpc.rs`, `stdio.rs` and `upload.rs` within that directory handle its protocol,
dispatch, pipes and uploads. Shared account and MIME logic live in
`src/account/mod.rs` and `src/message/mod.rs`. Qt/QML and JavaScript live in
`ui/`, with artwork in `ui/assets/` and unit tests in `ui/tests/`. Rust unit
tests stay with their modules; `tests/` holds integration tests.

Run `make backend` and `make test-rust`. The binary is `target/release/omamail`.
`omamail info` prints JSON; `omamail --backend` reads newline-terminated JSON
requests on persistent stdin/stdout pipes using JSON-RPC 2.0 envelopes. QML will start one backend and communicate directly through these pipes, without invoking CLI commands for data operations. Unix sockets are not used. CLI commands share the Rust domain implementation; they do not currently attach to the GUI process.

Example request:

```json
{"jsonrpc":"2.0","id":"qml-1","method":"system.info","params":{}}
```

Replies contain `jsonrpc: "2.0"`, the original `id`, and either `result` or an `error` object with a numeric code and static message. Clients should use string IDs to avoid QML number precision issues. Notifications omit `id` and receive no response, including on method failures. Explicit null IDs receive responses. Batches contain at most 128 entries and return only non-notification responses. Invalid envelopes return null IDs; unknown fields and duplicate envelope keys are refused. Frames are bounded to 1 MiB including the newline. Oversized or unterminated frames return an error and end the stream. Invalid complete frames allow the next request. Errors never include input bytes.

Four worker threads process frames from a bounded 16-frame queue. Responses can arrive out of order and must be matched by ID. Writes are serialized to prevent interleaved JSON. `system.quit` drains earlier frames, acknowledges `quitReady`, then ends processing. A batch containing quit completes the batch before exiting. EOF also drains accepted work. Methods currently require empty object params, which may be omitted. This is bounded threaded dispatch; cancellation, asynchronous network I/O and mutation ordering are still pending.

Responses up to 1 MiB including their newline retain the ordinary JSON-RPC
envelope. Larger serialized responses, including batches, use contiguous
`transport.chunk` JSON-RPC notifications. Each `params` object contains a decimal
string `transfer`, zero-based `index`, `total` chunk count, `size` in UTF-16 code
units, and string `data`. Concatenating `data` reconstructs the original response
JSON. Rust splits at UTF-8 character boundaries into at most 64 KiB per chunk;
JSON escaping still leaves every output line below 1 MiB. Serialization is
bounded to 32 MiB before any response bytes are written. Exceeding that limit
returns correlated `-32001` errors without partial output. A whole transfer holds
the output lock, so transfers never interleave. QML accepts only consecutive
chunks with consistent metadata, at most 1024 chunks and 32 Mi UTF-16 code units,
and a 30-second assembly deadline. Disconnects discard partial transfers. This
bounds pipe frames; it does not remove the cost of reconstructing and parsing a
large result on the UI thread. Future attachment reads should use blob handles.

`omamail accounts list` and `accounts.list` read the desktop's
`$XDG_CONFIG_HOME/omamail/accounts.json` (default `$HOME/.config`). Empty params
are required. The result contains `accounts` and `activeId`; account summaries
contain only `id`, `email`, `provider`, `label` and `pending`. Credentials and
server settings are never returned. The reader refuses nonregular files, final
symlinks, files above 1 MiB and malformed or unsupported registries. Missing
files produce an empty list. Listing does not write or migrate the source file.

## Remaining delivery requirements

CLI discovery now includes `providers list`, with capability ceilings matching the existing UI registry. `omamail call METHOD` reads JSON parameters from stdin (maximum 1 MiB; empty input means `{}`), calls the same session dispatcher as the backend, and emits `{ "ok": true, "result": ... }` or `{ "ok": false, "error": { "code": ... } }` with a nonzero exit on error. Each invocation has its own session; multi-call upload sequences require the persistent backend protocol.

The Rust HEY adapter exposes `hey.status`, `hey.list` (`query`, `pageToken`, `pageSize`) and `hey.read` (`id`) through the official `hey` executable. Configured QML backend mode routes list/read requests through this adapter and preserves cached listing metadata on detail reads. GUI requests bind `program` and `accountId`: the executable must match the canonical absolute HEY program resolved from PATH and the official account listing must match the displayed identity. This check cannot prevent another application changing HEY's global login between commands. Process input/output and deadlines are bounded; diagnostics are not copied into user errors. Tests use synthetic output and an isolated fake executable, not real credentials or mailboxes. HTML feature negotiation, full conversation metadata and live interoperability remain migration requirements.

`hey.act` accepts a `verb` and message `ids` for read/unread, trash, spam and restore operations; invalid batches are refused before mutation. `hey.send` accepts `to`, optional `cc`/`bcc`, `subject` and `body`, or a numeric `replyTo` topic and `body`. Bodies travel on stdin. These methods currently return an acknowledgement rather than a sent-message ID. Configured QML backend mode routes these actions and text sends through the persistent connection, without falling back or retrying on failure. It refuses both attachment metadata and embedded MIME attachments before sending. Outgoing MIME extraction still runs in JS; attachments, draft writes, authentication and profile migration remain incomplete. An IPC timeout does not prove a mutation was not applied; callers must not automatically resend.

`omamail message parse` reads up to 16 MiB of RFC 822 bytes from stdin and returns the Gmail-shaped MIME payload. `message.parse` exposes the same parser to the backend with a `raw` parameter containing unpadded base64url; IPC requests still obey the smaller 1 MiB frame limit. The parser preserves decoded body octets, MIME hierarchy and attachment part IDs. Returned HTML is untrusted source content, not safe-to-render HTML. Provider call sites have not yet switched to this parser; malformed-message compatibility and sanitizer migration remain pending.

- Shared account configuration and keyring ownership, including existing account
  IDs, credential migrations, atomic persistence and concurrent CLI/UI access.
- All five providers, capabilities and refusals, authentication, list/search,
  pagination, conversations, body/attachment reads, actions, drafts and sending.
- Calendar sources, reads, writes and RSVP; contacts, outbox and agent commands.
- Bounded asynchronous jobs, cancellation, deadlines, push events and caches.
- QML process integration, request correlation and crash recovery, followed by
  removal of migrated QML transport and script implementations.
- CLI coverage of the same domain operations, stdin secret input, stable JSON
  output, human help, exit statuses, packaging and upgrade documentation.
- Regression coverage for every migrated security boundary, Linux keyring and
  Quickshell integration, and measured latency/memory comparisons.

Existing credential scope, byte validation, SSRF, redirect and raster policies
remain acceptance requirements. Rust alone is not evidence of security. The
current protocol tests cover framing and error disclosure only; network and
credential boundaries are not yet implemented or verified in Rust.
