# Rust backend migration

The CLI and the Omarchy plugin share a persistent Rust backend. The shell still
constructs `Service.qml`, which owns the backend process independently of any
window. QML owns theme, focus, layout, rendering and interaction state. Network
requests use native asynchronous Rust transports; HEY is the deliberate
exception, driven by Rust through the official `hey` executable because HEY
provides no supported public mail API.

The backend now includes Gmail reads and mutations, native IMAP/SMTP, JMAP
transport and domain modules, OAuth networking, calendar networking, public
image fetching and unsubscribe requests, private account/cache persistence,
attachments, contacts and automatic mailbox checks. Shared Rust modules also own
MIME composition, message summaries and direction, HTML sanitization and reader
preparation, query and render caches, action reconciliation, the send queue and
compose recovery. The ownership and remaining boundaries below distinguish
implemented paths from live-provider compatibility evidence.

`Service.qml` starts the plugin-private exact backend version, validates its
exact version/protocol/API handshake and exposes correlated calls with pending-request
limits and deadlines. `OMAMAIL_BIN` selects an explicit development executable.
Migrated operations report an unavailable backend instead of silently falling
back to QML networking. `info` lists implemented RPC methods; it is not a claim
that every method has passed live-provider interoperability testing.

## Build and protocol

Sources are organized by responsibility: `src/cli/mod.rs` handles command-line
arguments, `src/backend/mod.rs` composes the backend, and `protocol.rs`,
`rpc.rs`, `stdio.rs` and `upload.rs` within that directory handle its protocol,
dispatch, pipes and uploads. Shared account and MIME logic live in
`src/account/mod.rs` and `src/message/mod.rs`. Qt/QML and JavaScript live in
`ui/`, with artwork in `ui/assets/` and unit tests in `ui/tests/`. Rust unit
tests stay with their modules; `tests/` holds integration tests.

Run `make install` to compile the release binary, atomically install it into
`runtime/bin/omamail`, and install/link the plugin locally. `make install-backend-local`
updates just the private binary. `make test-local` runs the local suite and the
real offscreen backend process harness. For development, use `./dev backend` and
`make test-rust`; `./dev run` builds and prints instructions
for starting the plugin through the existing shell. It does not open or restart it.
See [runtime ownership and development](BACKEND-RUNTIME.md).

CLI commands use clap and print human-readable Markdown tables by default,
including when piped. The global `--json` flag may appear before or after a
subcommand and selects indented JSON without changing the result's data shape:

```sh
omamail info
omamail accounts list
omamail providers list --json
printf '{}' | omamail call system.info --json
omamail message parse --json < message.eml
```

Pretty-mode operation errors go to stderr and exit 1; JSON-mode operation errors
go to stdout as `{"ok":false,"error":{"code":"..."}}` and exit 1.
Invalid command syntax exits 2. `--version` retains the installer's plain version
probe; `version --json` returns a JSON version object. `serve` always speaks the
line-framed JSON-RPC protocol and rejects `--json`.

`omamail info` prints a human-readable table; add `--json` for JSON. `omamail serve` reads newline-terminated JSON
requests on persistent stdin/stdout pipes using JSON-RPC 2.0 envelopes. QML starts one backend and communicate directly through these pipes, without invoking CLI commands for data operations. Unix sockets are not used. CLI commands share the Rust domain implementation; they do not currently attach to the GUI process.

Example request:

```json
{"jsonrpc":"2.0","id":"qml-1","method":"system.info","params":{}}
```

Replies contain `jsonrpc: "2.0"`, the original `id`, and either `result` or an `error` object with a numeric code and static message. Clients should use string IDs to avoid QML number precision issues. Notifications omit `id` and receive no response, including on method failures. Explicit null IDs receive responses. Batches contain at most 128 entries and return only non-notification responses. Invalid envelopes return null IDs; unknown fields and duplicate envelope keys are refused. Frames are bounded to 1 MiB including the newline. Oversized or unterminated frames return an error and end the stream. Invalid complete frames allow the next request. Errors never include input bytes.

A Tokio runtime runs up to 32 concurrent frame futures behind a bounded 16-frame queue. Gmail uses a shared native reqwest/rustls connection pool, with asynchronous HTTP and Hickory DNS resolution, verified TLS, fixed Google HTTPS origins, no redirects or environment proxies, and a streamed 16 MiB response ceiling. OAuth refresh is coalesced per account; one account's refresh does not block another account. HTTP has a 10-second connection timeout and a 20-second whole-request timeout. Gmail IPC requests have a 25-second deadline including queue time. Expired queued frames never start domain operations.

Blocking keyring and file operations run on a separate bounded thread pool;
the runtime has two async workers and at most eight blocking workers. The
official HEY child processes use asynchronous pipes, output limits, deadlines
and process-group cleanup. Other native providers enforce their own request
deadlines. The 25-second RPC timeout currently wraps Gmail operations; expired
queued requests for every method are rejected before dispatch. An operation
that has already submitted a mutation must not be automatically retried: a
lost reply does not establish whether the provider applied it.

Responses can arrive out of order and must be matched by ID. One writer
serializes output. `system.quit` and EOF drain accepted work; a quit batch
completes in order before shutdown. Batches execute entries sequentially to
preserve dependent uploads. Different frames do not establish mutation order.
UI handles suppress stale results; cancellation is explicit where provided
(such as OAuth, JMAP streams and mailbox watches), not a general guarantee that
an already-dispatched mutation can be recalled. `system.info`, `accounts.list`
and `providers.list` require empty object params, which may be omitted.

Large request parameters use `upload.begin`, ordered `upload.append` calls and
`request.upload` with a target method and upload ID. The uploaded bytes are UTF-8
JSON parameters; the same domain validator runs after decoding. Uploads have a
64 MiB individual limit, a 128 MiB aggregate budget and expiration; target
methods retain their own, often smaller, limits. Only two uploaded operations
are decoded/dispatched concurrently. Nested uploads and uploaded shutdown
requests are refused. The QML adapter uses this path for large parameters so
mail attachments do not require oversized pipe frames. A standalone CLI call
still accepts at most 1 MiB of JSON parameters from stdin; multi-call uploads
require `serve`.

Responses up to 1 MiB including their newline retain the ordinary JSON-RPC
envelope. Larger serialized responses, including batches, use contiguous
`transport.chunk` JSON-RPC notifications. Each `params` object contains a decimal
string `transfer`, zero-based `index`, `total` chunk count, `size` in UTF-16 code
units, and string `data`. Concatenating `data` reconstructs the original response
JSON. Rust splits at UTF-8 character boundaries into at most 64 KiB per chunk;
JSON escaping still leaves every output line below 1 MiB. Serialization is
bounded to 64 MiB before any response bytes are written. Exceeding that limit
returns correlated `-32001` errors without partial output. A whole transfer holds
the output lock, so transfers never interleave. QML accepts only consecutive
chunks with consistent metadata, at most 1025 chunks and 64 Mi UTF-16 code units,
and a 30-second assembly deadline. UTF-8 scalar boundaries can shorten a chunk,
so a response near the 64 MiB byte ceiling can need the 1025th chunk.
Disconnects discard partial transfers. This
bounds pipe frames; it does not remove the cost of reconstructing and parsing a
large result on the UI thread. Future attachment reads should use blob handles.

`omamail accounts list` and `accounts.list` read the desktop's
`$XDG_CONFIG_HOME/omamail/accounts.json` (default `$HOME/.config`). Empty params
are required. The result contains `accounts` and `activeId`; account summaries
contain only `id`, `email`, `provider`, `label` and `pending`. Credentials and
server settings are never returned. The reader refuses nonregular files, final
symlinks, files above 1 MiB and malformed or unsupported registries. Missing
files produce an empty list. Listing does not write or migrate the source file.

## Domain ownership

| Area | Rust backend responsibility | UI or external boundary |
| --- | --- | --- |
| Gmail | Fixed-origin pooled HTTP; per-account token refresh; list, metadata/full message, attachments, labels/counts, profile and send-as; modify/batch modify, trash/restore, label changes, sending and draft create/update/delete. Draft message IDs are resolved to draft resources in Rust with bounded pagination. | QML tracks selection, displays progress and composes the user's message. |
| IMAP / SMTP | Async DNS, verified TLS/STARTTLS, authenticated connection reuse, bounded octet-aware literals, special-use folders, UID search windows and continuations, counts, MIME reads, attachment extraction, mutations, folder changes, drafts and submission. Rust validates the SMTP envelope and preserves confirmed-send results if filing the Sent copy fails. | `ImapClient.qml` is a presentation adapter using account-bound domain requests. Setup presentation remains in QML; cached-query interpretation runs in Rust, and old wire helpers remain as test references. |
| Outlook | Native Microsoft OAuth and Graph sending; native IMAP handles mailbox reads with XOAUTH2. | Browser/device authorization still requires the user's interaction. |
| JMAP | HTTPS session discovery and requests, bounded SSE parsing/reconnection, native query/mailbox/read/mutation/resource modules and background checks. Resource conversion preserves MIME depth bounds, charset and conversation-count semantics. | `JmapClient.qml` and `JmapPush.qml` pass account-bound domain requests and display returned state. Legacy JS helpers remain for presentation/configuration and parity tests. |
| HEY | Async execution of the official client, account identity checks, queries/paging, resource conversion, HTML feature negotiation, profile/labels/send-as, login lifecycle, supported actions, sends and drafts. | `hey` owns its OAuth credential and supported service interface. No private HEY endpoints are accessed and no unavailable capability is invented. |
| Authentication | Native Google/Microsoft token networking, Google loopback callback, credential lookup/store/clear, fixed credential destinations and account-bound tokens. Gmail first-login identity is verified and its refresh token stored before the UI receives success. | Keyring access uses the system credential service; opening the browser remains a desktop interaction. |
| Calendar | Native Google/Microsoft and CalDAV requests and pagination, origin checks before CalDAV credential access. | Calendar presentation, iCalendar interpretation and compose/RSVP state remain in UI modules where not explicitly migrated. |
| Local data | Account read/save with conflict detection; private body/calendar persistence; session-owned query cache policy and persistence; bounded render cache; local contacts and attachment read/store. | QML keeps returned snapshots, selection and progress for drawing the interface. |
| Message content | MIME parsing and outgoing composition; header/address decoding, summaries, body/attachment extraction, direction and signature import; HTML sanitization and reader document preparation. | QML owns editor text, theme values and drawing the returned document. |
| Actions | Model transforms, unified mailbox calculations and account-bound intent reconciliation. | QML submits user intent and displays authoritative returned state; provider requests remain separate from pure model transforms. |
| Delivery and recovery | Durable outbox state, undo deadlines, serial delivery, authoritative cancellation and uncertain-delivery handling; private compose recovery with revision conflicts. | QML parks/restores editor drafts and displays countdowns and status. It never starts delivery from a UI timer. |
| Sender-controlled URLs | Native public HTTP for remote raster images and unsubscribe, with checked DNS and pinned connections, TLS verification, no redirects, size/deadline bounds and image signature checks. | Native HTML preparation applies the resource policy; QML records the user’s image permission and draws approved raster data. |

The official HEY adapter keeps the posting/topic distinction, uses JSON outputs,
and negotiates optional HTML flags for older installed clients. Account checks
cannot prevent another application changing HEY's global login between commands.
Unsupported attachments and operations are refused rather than emulated; installed
`hey` capabilities remain the ceiling. Process diagnostics are never copied
verbatim into user-facing errors. Synthetic executable fixtures establish command
and process behavior, not compatibility with every released HEY version.

`message.parse` and `message.parseUpload` use the shared Rust MIME parser.
`omamail message parse --json` reads up to 16 MiB of RFC 822 bytes from stdin;
the direct RPC accepts `raw` as unpadded base64url within the frame limit. The
parser preserves decoded octets, MIME hierarchy and attachment part IDs. HTML
in that payload remains untrusted source markup until `message.render` applies
the native sanitizer and reader policy. CPU-heavy content operations run on
blocking workers so parsing and composition do not occupy async network workers.
Outgoing composition has a separate 32 MiB wire limit and preserves the UI’s
20 MiB attachment allowance; incoming MIME parsing retains its 16 MiB limit.

The principal shared-domain RPC families are:

| Methods | Result and ownership |
| --- | --- |
| `message.summarize`, `message.summaries`, `message.prepare` | Row summaries, ISO date strings, resolved direction, body text, source HTML and attachment descriptors. `prepare` accepts a full provider-neutral message resource. |
| `message.compose`, `message.composeText` | Provider-neutral encoded MIME payloads and initial reply/signature text. Composition performs no delivery. |
| `message.render`, `message.direction`, `message.signatureImport`, `message.signatureInline` | Sanitized reader output, direction metadata and signature processing. Render-cache identity includes account, message, source and policy. |
| `cache.queryRestore`, `cache.queryGet`, `cache.queryPut`, `cache.querySnapshot`, `cache.queryFlush` | Native query-cache loading, lookup, updates, snapshots and durable flush. Related profile, label, session, bind, clear and invalidate methods update the same account-owned state. |
| `model.apply`, `model.unified`, `model.intent` | Pure model transformations, cross-account snapshots and stateful action-intent reconciliation. |
| `outbox.enqueue`, `outbox.snapshot`, `outbox.undo`, `outbox.flush`, `outbox.abandon`, `outbox.forget` | Backend-owned delivery lifecycle. `outbox.changed` publishes revisions; terminal or stale snapshots cannot authorize a resend. |
| `compose.recoveryRead`, `compose.recoverySave` | Normalized private recovery records with expected-revision checks. An editor conflict keeps the live draft rather than silently overwriting another instance. |

`outbox.snapshot` omits payloads by default. Recovering a particular payload
requires an explicit send ID. A send whose result is unknown remains unknown;
reopening the app does not retry it automatically. Undo succeeds only while the
backend still reports that entry queued. Cancelling UI work cannot recall a
mutation already accepted by a mail server.

JavaScript that remains live owns presentation and interaction: navigation,
focus, labels, editor fields and adaptation of returned snapshots. Some legacy
pure helpers are retained as test oracles during migration; their presence does
not authorize a production fallback. The immutable benchmark oracle is under
`benchmarks/mail/baseline/`, outside the application’s live imports.

## Cached reader data and disk limits

`cache.resourceRead`, `cache.resourcePut` and `cache.resourceClear` manage full
provider message resources. Parsed body files and these resources share a
256 MiB quota across all accounts; LRU eviction and entry-count limits bound
both disk use and directory scans. Private temporary files left by an interrupted
write also count toward the budget. `cache.bodyClear` clears both representations
for the named account. Attachment exports, drafts and the outbox are separate
from this disposable cache and are never evicted by its quota.

`reader.open` reads cached or live provider resources, prepares content and
sanitizes HTML entirely inside Rust. It returns display documents, summaries,
attachment locators and calendar leaf parts. Raw MIME data and sender HTML stay
native. `reader.render` accepts an account/message-bound source key and transient
render options, so changing image policy does not upload the original HTML.
UI theme, layout and settings remain owned by QML.

The QML bridge decodes each ordinary response once, then validates notifications
and replies against that same value. Chunk frames are individually decoded and
bounded; their assembled response is decoded once. Unrecognized response IDs
must be own keys of the pending-request map before any callback can run.

The reader retains prepared content and the native HTML source, rather than a
second full MIME resource. Image-policy rerenders reuse that preparation; they
do not decode MIME bodies again. Responses contain safe document trees for both
display modes without redundant serialized HTML copies. A source-and-policy
revision lets QML retain an unchanged document across cache/live delivery.
Approved image bytes survive revalidation of the same selected message, and
image completions are coalesced before rerendering. Changing the selection
invalidates pending image callbacks and clears those bytes.

The native source store has a 64 MiB serialized-payload budget, with at most 64
entries overall and 12 per account; this is not a total heap/RSS limit. Existing
interactive message limits are unchanged. A cache
hit can paint before live revalidation; a failed refresh retains the displayed
body. Request cancellation guards cache/store commits, and account, selection
and source-generation checks reject stale results. Cached plus live delivery
cannot mark the same open message read twice. Calendar invitation interpretation
remains in QML and receives only calendar metadata/leaf content.

## Mail organization and assistant context

`account.identities` merges account-qualified sender identities.
`account.conversation` returns membership, summaries and navigation projections;
QML consumes the snapshot without an RPC for each navigation key.
Provider capabilities and mailbox query definitions originate in Rust; a
parity-checked generated snapshot serves immediate UI reads. Dynamic query and
web-address construction use `providers.resolve`. Labels and artwork remain UI
presentation.

`agent.context` performs bounded concurrent read-only mail retrieval and native
content extraction, preserving selection order. It accepts at most 20 selected
messages, four concurrent reads, 200,000 UTF-16 text units and a 60-second overall
deadline. Cancellation is account/request-scoped. It returns a bounded job
payload, not provider resources. `agent.job*` methods own durable task lifecycle
and status projections; the native detached worker streams only validated
public answers into private storage. See [agent lifecycle](AGENT.md).

## Automatic mailbox checks

`mail.watch` registers one background task per account with a query, page size
(default 25, UI supplies its configured page size), and interval
between 30 and 3600 seconds. `mail.check` triggers an immediate check,
`mail.snapshot` returns its current state, and `mail.unwatch` stops it. Checks
run independently of window lifetime, are bounded to 25 seconds and do not
overlap for the same account. Different accounts check concurrently. Replacing
a watch invalidates its previous generation so stale results cannot publish.

Inbox preloading runs after the first successful check, when the mailbox
fingerprint changes, and at the configured check interval so changes outside an
unread-only badge query are also found. It warms the configured first page in
the same query cache the UI reads. Full resources already cached are reused.
At most two background provider requests run concurrently; each request has a
10-second deadline and a warming job has a 180-second deadline. Replacing or
removing the watch and shutting down invalidate pending cache commits.

Automatic preloading is limited to small messages/resources (2 MiB), with
unknown-size IMAP/Outlook messages skipped before fetching their whole MIME
body. Larger messages remain available on demand under the existing limits;
this does not change the 16 MiB parser or other interactive size limits.
Preloading issues read-only requests and never marks messages read. `j`/`k`
navigation opens the selected message explicitly, so its normal mark-read
behavior is separate from preloading.

All five providers have native check paths: Gmail reads an unread query and a
small metadata sample; HEY uses its official unread listing; JMAP performs
`Email/query` and `Email/get`; IMAP and Outlook read mailbox status. The last
pair currently provide counts/fingerprints without message preview samples.
The backend publishes `mail.updated` notifications containing the account,
sequence, timestamp, count, available message samples and static error state.
A failure preserves the last successful data. Native fingerprints also detect changed message samples when the count stays equal. The service updates desktop
state from these events instead of using an open reader's timer to fetch mail.
This is periodic checking; JMAP's separate event stream supplies push support,
and other providers do not thereby gain push delivery.

The backend also observes account-registry revisions and publishes
`accounts.changed` without including account settings or credentials. Shutdown
cancels and joins the watcher tasks. The GUI service must still register the
accounts it wants watched; the CLI's independent process does not attach to
or control the GUI session's in-memory watches.

## Validation and remaining boundaries

Run `make test-local` for Rust, JavaScript, QML/security checks and the real
Quickshell/persistent-process harness. Native transport tests use synthetic
local peers to verify concurrent progress, connection reuse, deadlines,
response/literal bounds, TLS refusal and forbidden redirect/credential effects.
Resource golden tests run the original JS on synthetic input and compare the
Rust result. These tests do not certify live-provider delivery behavior.

Earlier network-migration evidence is recorded in [NETWORK-MIGRATION.md](NETWORK-MIGRATION.md).
The newer content, cache, model and outbox integration must be checked with the
current full suite; historical results do not certify later changes. Live
interoperability remains to be checked where synthetic fixtures cannot establish
compatibility. External browser, keyring, desktop-opening and official HEY
integrations remain intentional.
Release installation/bootstrap scripts may download artifacts before a backend
exists; that is separate from production mail networking. Legacy scripts must
not remain a hidden fallback for migrated operations.

Credential scope, exact-byte validation, SSRF, TLS/redirect restrictions and
raster policies are acceptance requirements for each affected path. A method
inventory or a faster benchmark does not substitute for its security evidence.
Document separate PASS, BLOCK or NOT VERIFIED verdicts for reviewed boundaries,
and do not describe scoped transport tests as a complete security audit.


## Mail processing performance

The current cached-reader comparison includes disk reads and the full QML
request/response path:

```sh
python3 benchmarks/mail/reader_pipeline.py
```

[Reader results](../benchmarks/mail/reader-pipeline-results.md) compare the
full-resource bridge, the previous prepared-cache bridge and native `reader.open`
with equivalent display output. A separate before/after run isolates the latest
reader optimization. This ends at the completed display-data callback, before
subsequent model updates, QML layout or painting; network and image downloads
are excluded. It is a comparison of Rust pipeline arrangements, not the original
JavaScript application.

[Concurrency results](../benchmarks/mail/reader-concurrency-results.md) separately
compare 1/2/4/8 outstanding reader calls and isolate the single-decode QML bridge
change. They report both throughput and individual callback p95 with identical
display output, using the same frozen Rust executable for both bridge versions.
The projection comparison above predates this bridge change.

The independent processing-stage comparison is retained:

```sh
python3 benchmarks/mail/roundtrip.py
```

[Measured results](../benchmarks/mail/roundtrip-results.md) compare the frozen
previous Qt JavaScript implementation with the release application backend,
including request encoding/uploads, processing, serialization, transport and
QML decoding. All 15 case/stage combinations require equivalent output.
This starts with input in QML; it excludes network, disk and drawing, and does
not measure the native provider/preloaded-cache pipeline. Regressions are
reported alongside improvements. Do not infer application speed from CPU-only
ratios or sum separate synthetic transfer numbers into them.

## CPU-only diagnostic

Run the reproducible synthetic benchmark after other builds and tests finish:

```sh
python3 benchmarks/mail/run.py --samples 31 --batch 3 --qml
```

It compares release Rust with a hash-verified frozen JavaScript baseline in Node
and Qt’s QML engine. MIME parsing, HTML sanitization and reader preparation are
measured independently; output equivalence is required before timings are
reported. See [benchmark methodology](../benchmarks/mail/README.md) for phase
selection, warmups, timer resolution, memory accounting and report artifacts.
These CPU measurements exclude provider latency, synchronization, IPC and UI
rendering. They cannot establish end-to-end inbox speed or live-mail reliability.


## Response transport measurements

`python3 benchmarks/ipc/run.py` measures a synthetic Rust response through the
current production writer/chunker and unchanged QML bridge using real Quickshell
pipes. The report includes serialization, transport, chunk reassembly, JSON
parsing and callback delivery, but no mail parsing, disk access or drawing.
See [IPC results](../benchmarks/ipc/results.md) for payload-size measurements and
timer/fixture limitations; these are distinct from the CPU-only mail benchmark.
