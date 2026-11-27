# Backend runtimes and releases

## The app links the backend

The NSH app has no backend process to install, start or check. `ext/omamail-native` links the `omamail` library in `core/` into the app, and the app and the library always build together (`nsh build`). There is no binary pin and no version, protocol or API handshake between them.

`ext/omamail-native/src/worker.rs` builds the runtime `omamail::backend::runtime()` returns and starts one thread, `omamail-backend`, that owns one `Session`. It subscribes to notifications before the first request, hands each JSON-RPC frame to `Session::request()` and forwards every notification. The TSX reaches it only through `src/backend/client.ts`: `call(method, params)` resolves with the `result` or throws a `BackendError`, `on(method, fn)` hears notifications such as `mail.updated`, outbox changes and `gmail.settled`, and `shutdown()` runs once at quit. Shutdown waits for the requests already in flight, then calls `Session::shutdown()`, which stops the watches and Gmail queues and saves the outbox and the query cache. Like `serve`, the session owns the outbox and listens on its private socket, so `omamail send` from a terminal hands mail to the running app ([BACKEND.md](BACKEND.md#mail-commands)). If the runtime cannot start, every call fails with code -32010 ("Backend unavailable"); nothing falls back to another path.

The AI assistant still runs its jobs as separate processes. The library starts them by running the current executable again with a hidden subcommand. Inside the app that executable is the app itself, so `ext/omamail-native/src/entry.rs` recognizes those subcommands before NSH starts and runs the library's own worker instead. No second binary is packaged or located.

The app uses the same state directories as the `omamail` CLI and the old Omarchy plugin (`core/src/platform/dirs.rs`): accounts, drafts, the outbox, caches and AI jobs need no migration. Credentials use the native store through the library: Keychain on macOS, Secret Service on Linux and Credential Manager on Windows. No secret is placed in process arguments.

### Forcing a clean reconnect

The app's backend session lives as long as the app. It keeps its Secret Service session, its account connections and their sign-in state, so a credential store that was locked at startup, an API a Cloud project only just enabled, or an OAuth grant that changed elsewhere is not re-checked on its own. Quit Omamail and open it again to start a fresh session. If that clears a failure, the old session was stale; if not, the failure is real.

## The standalone `omamail` binary

The same library also builds the standalone `omamail` executable: the CLI described in [BACKEND.md](BACKEND.md), and `omamail serve`, which speaks the same JSON-RPC over stdin and stdout for a client that runs it as a child process. The NSH app does not use it.

`core/backend-version` and `core/backend-api.json` belong to that binary's release flow. The app does not read them. Until that flow is ported to NSH packaging, do not bump them, and keep API changes to `core/` behind contract fixtures as before.

## In-process backend on iOS and Android

The NSH desktop app and the mobile hosts all run the backend in their own process. iOS apps cannot start child processes at all, so a phone could never run `omamail serve`. `omamail::backend::runtime()` builds the runtime `serve` uses; inside it the host creates one `Session`, subscribes with `Session::subscribe()` before its first request, sends JSON-RPC frames to `Session::request()` (or calls `Session::dispatch()` with a method and parameters), and calls `Session::shutdown()` once when it exits. `serve` is built on these same calls, so replies, notifications (`mail.updated`, outbox changes, `gmail.settled`) and the shutdown drain are identical; `core/tests/protocol.rs` checks the replies match frame for frame.

Some desktop features do not exist on phones, and they say so instead of failing quietly. The AI assistant re-launches the backend executable as a worker, so mobile builds report `capabilities.agent = false` and answer `agent.*` with `unknown_method`, as a build without the `agent` feature does. The outbox has no cross-process socket there, because the app is the only process that can own it; a lease conflict answers `outbox_ipc_unsupported`. HEY needs its command-line client and answers `hey_unavailable`. Credentials use the iOS keychain through the same Security framework code as macOS. Android has no secure store yet (it needs the Android Keystore), so every credential call fails as unavailable and nothing is stored. On Android the host sets `HOME` to the app's files directory before the first call; data directories then follow the Linux layout. On iOS they follow the macOS layout inside the app container, with downloads in `Documents`.

Three things work differently on a phone:

- **DNS.** Desktop builds resolve names with hickory, which reads `/etc/resolv.conf`. Android has no such file and an iOS app cannot count on it, so phones use the system resolver (`getaddrinfo`) for every connection: HTTP clients, IMAP/SMTP, and sender-chosen URLs. Lookups then follow the phone's own DNS settings, such as Private DNS or a VPN. Sender-chosen URLs still check every answer and connect only to the checked addresses.
- **Storage paths.** On desktop, private storage is opened one directory at a time from `/`, and every parent must be owned by root or the user. A phone app's parents belong to system users and may be unreadable: Android's `/data` is `system:system 0771` and `/data/user/0` is a symlink; iOS containers sit under `/var`, a symlink to `/private/var`. On a phone the walk therefore starts at the app's container (the canonical `HOME`), which must be owned by the app and not writable by other users. Everything below it gets the same checks as on desktop. All data directories use the canonical `HOME`. On Android, runtime files go to `$HOME/tmp`, because `/data/local/tmp` belongs to the shell user.
- **Keychain.** iOS keychain items are stored as *after first unlock, this device only*. Background sync can read them while the phone is locked, as long as it was unlocked once since boot. They are never synced to iCloud or restored to another device. Writing an existing item moves it to this class.

CI runs `cargo check --lib` for `aarch64-apple-ios`, `aarch64-apple-ios-sim` and `aarch64-linux-android`.

## Stable API and old plugins

Omarchy plugin releases from before the NSH app pinned one exact `omamail` release and downloaded it from this repository. An installation that has not been updated keeps using that exact private binary. Old release tags, binaries, checksums and API contract assets must therefore remain available and immutable, so an old plugin can still reinstall its pinned version. This keeps each old plugin paired with its backend; it cannot promise that mail providers never change their services.

The standalone binary has three version numbers of its own: the release in `core/backend-version`, the integer API revision in `core/backend-api.json`, and the JSON-RPC framing's `protocolVersion`. Internal Rust fixes can merge without changing the API revision.

The contract records the public method inventory and representative request and response fixtures. Changes to methods, accepted parameters, returned fields, errors or their meaning require contract review, updated fixtures and a higher API revision. `system.info.apiVersion` states the API revision. The first published binary, 0.9.0, predates that field; only that exact version is read as API 1, and missing revision information from any other version is refused.

The API sections below record when each method or behavior appeared. The TSX still carries the revision checks it inherited from the Qt client (for example `src/mail/mailboxes.ts` and `src/mail/calendar/invitations.ts`), but the linked backend always speaks this checkout's revision, so in the app those checks always pass. `src/features/calendar/controller.ts` states this directly with its `BACKEND` constant.

## Native AI conversations (API 6)

Settings → AI follows the Omarchy system default or selects Claude, Codex or OpenCode V2, with an optional model override. `agent.providerStatus` resolves the supported provider without starting an agent or creating a job. An unsupported default leaves the AI action visible but disabled; Settings explains the supported choices. Availability checks are repeated while following the system default. Explicit choices bypass the system-default lookup. CLI installation and authentication are still checked when a request starts. The AI worker exists only on Linux and macOS; other builds do not offer the `agent.*` methods.

Each conversation retains one native provider session, serializes follow-ups and leaves compaction to that provider. Durable jobs retain per-turn public transcripts and proposal records; history pages and a rebuildable head index keep polling bounded. Interrupted turns preserve their session and mail context when safe to continue; crashed or unconfirmed workers require a fresh chat. Agent/model changes start new chats, preserve unsent input and retain prior chats as read-only history.

The isolated provider launch preserves model/authentication configuration while excluding unrelated tools, plugins and hooks. The only mail-writing tool records a content-only draft proposal: account, recipients, threading and attachment ownership come from app-owned snapshots. Applying or sending a proposal requires a human action and uses the normal composer/outbox path. Delivery labels follow outbox receipts; the standard send toast provides Undo. Codex advertises the proposal namespace directly even for code-mode-only models, without general tool discovery.

Proposal cards show their saved From, To and optional Cc, Bcc and Reply-To. If routing in the corresponding open composer changes, direct card sending is disabled and rechecked at dispatch. Use this version applies subject/body without replacing the edited recipients; the normal composer Send then reviews and sends the current routing.

## API 7 sender name for IMAP and Outlook

An IMAP or Outlook account entry may carry a top-level `senderName`. `mail.send` uses it, trimmed, as the display name of the mailbox's own address in the From header; aliases keep their own names. An empty or missing value sends the bare address, as before. The app offers the name as "Your name" in Settings → Mailboxes (`src/features/settings/mailboxes.tsx`), and the composer names the From address with it.

## API 6 account-wide IMAP search

IMAP and Outlook text searches, and IMAP address searches, resolve to `search:<criteria>`. IMAP All mail resolves to `search:ALL`; folder queries remain folder-scoped. Microsoft 365 text searches resolve to `text:<words>` (see its API 8 section below).

`imap.list` and `imap.listContinue` return an empty `page` plus an opaque work `continuation` until the scan and page assembly have finished. Continue with the same account, query, request token and original `pageToken`, including when a later page needs a new scan. Partial scans are not a globally newest-first page. Expired or mismatched work continuations return `imap_search_expired`; refresh starts a new search.

A completed page's opaque `nextPageToken` is a self-contained cursor bound to the account's IMAP endpoint, username, query and versioned scope/ordering semantics. It records the last result's INTERNALDATE, folder, UID and UIDVALIDITY, plus an optional-cache reference. Results sort by INTERNALDATE descending, folder name ascending and UID descending; the next page starts strictly after that position without looking up the previous message. The cursor contains no credentials or credential hashes, and token refresh does not invalidate its binding. Invalid cursor encodings/versions return `invalid_params`; account/query mismatches and detected UIDVALIDITY changes return `imap_search_expired`.

Completed results are cached for five minutes after scan completion, subject to eviction. Available cached results avoid another inventory/search/metadata scan; an absent cache transparently triggers a new scan and applies the same cursor boundary. The CLI and UI use the same path, including across independent CLI invocations and backend restarts. Cached pages verify candidate UIDs and their folders' UIDVALIDITY before returning IDs, skipping expunged candidates and filling from subsequent results. This is live-result pagination with short-lived cache reuse, not a frozen historical snapshot: new messages before the boundary appear on refresh, and moves between physical folders may reappear under a new identity. A message can still disappear after IDs are returned and before a separate message read.

Each call advances at most four scan or page-verification folders, with at most four concurrent workers per account and a 12-second worker deadline inside the existing 22-second request deadline. The scanner captures UIDNEXT, streams a compact UID inventory through individually framed FETCH responses, and issues SEARCH and metadata FETCH operations in windows of at most 4096 existing UIDs. This bounds SEARCH response lines below the 64 KiB transport limit even for ten-digit UIDs, without walking empty numeric UID gaps. Scans are limited to 2048 folders, one million inventoried UIDs and 250,000 matching folder/UID identities; the existing 32 MiB per-command response ceiling also applies. Oversized responses fail explicitly instead of presenting incomplete results as complete. Inventory storage is released after scanning; at most 16 snapshots with a combined budget of two million inventory/result entries are retained. In-progress scans expire after five idle minutes; completed-cache reads do not extend their lifetime. No search state is written to disk.

Search includes aggregate All Mail destinations and excludes Trash/Junk membership from aggregate results. Cross-folder copies are collapsed using server-provided `EMAILID`/`X-GM-MSGID`. A generic server that advertises `\All` but no server identity is searched through its `\All` mailbox alone, because RFC 6154 defines it as every message in the store; scanning physical folders as well would only add copies that cannot be matched without reading them. Its Message-ID header and RFC822.SIZE nominate possible overlaps between All and Trash/Junk, then SHA-256 of complete message bytes verifies those candidates before excluding any aggregate result. Verification reads at most 64 candidates and 8 MiB per folder step with `BODY.PEEK[]` and retains only digests; a candidate larger than 8 MiB is not read and stays in the results. A server with neither `\All` nor a server identity preserves folder/UID copies, so overlapping folders may produce duplicate rows. A sender-written Message-ID, headers or size alone never suppress a result. Copies within one physical folder remain distinct. `mail.list` follows search continuations for at most 120 seconds; other IMAP listings still accept one continuation.

## Microsoft 365 mailboxes (API 8)

The `m365.*` methods arrived in API 8: `m365.signInBegin`, `m365.signInPoll`, `m365.signOut`, `m365.verify`, `m365.list`, `m365.messages`, `m365.read`, `m365.attachment`, `m365.modify`, `m365.trash`, `m365.untrash`, `m365.send`, `m365.saveDraft`, `m365.deleteDraft`, `m365.sendAs`, `m365.invalidate` and `m365.cancel`.

Queries are `role:<inbox|sent|drafts|archive|junk|trash> [unseen] [flagged]` or `text:<words>`, which Graph's `$search` reads as words (a text search leaves Trash and Junk out); a Flagged or Unread view lists the Inbox only. `m365.signInBegin` and `m365.signOut` take the Application (client) ID as `clientId`: the backend has no default. `m365.signInBegin` signs in at the tenant the address's domain names and, if Microsoft does not know the domain as a tenant, once more at `organizations`; refreshes ask the same way. `m365.signInPoll` asks Microsoft at most once per interval whatever its caller's rhythm, answers `pending`, `signedIn`, `declined`, `expired` or `failed`, and has stored the refresh token in the keyring before it says `signedIn`; no token or device code is ever returned. A poll whose token request or keyring save outlasts its 24 seconds answers `pending` with the warning `m365_exchange_running` while the exchange goes on, and the same `requestId` answers the outcome afterwards. `m365.signOut` ends the sign-ins under way of that account and `clientId` only. It and `m365.invalidate` wait at most 20 seconds for the mailbox's refresh lane, which a refresh holds while its keyring save waits to be unlocked, and then answer `m365_timeout`: a sign-out so answered may not have been done. `m365.list` answers `{page, rows}` (the rows are the header-only resources of the page, which `m365.messages` serves from memory for a minute) and `m365.cancel` ends a call made with its `requestToken`. `m365.saveDraft {accountId, raw, draftId?}` answers `{saved, warning, id}` like `imap.saveDraft` (plus the new draft's `id`), or fails with `m365_draft_unconfirmed` when Graph may have made the draft without saying so, and `m365.deleteDraft {accountId, id}` answers `{}` or refuses anything that is not a draft with `m365_not_a_draft`. Calendar requests for an `m365:` account take their Graph token from the same sign-in.

## Shipped Google OAuth client (API 9)

Release backends compile in a Google desktop OAuth client from the repository secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The release workflow passes them as `OMAMAIL_GOOGLE_CLIENT_ID` and `OMAMAIL_GOOGLE_CLIENT_SECRET` only to the `cargo build --release` steps; test steps, CI and development builds never receive them and ship no client. Every release contract run passes `--shipped-google-client`, so a missing or malformed secret fails the release instead of publishing a build without the client. Google treats a desktop client's secret as not confidential: this keeps the values out of the source tree and logs, not out of the binary.

`auth.builtinClient {}` answers `{clientId, clientSecret}`, both empty strings when the build ships none. The app asks for it in `builtinClient()` (`src/features/accounts/flows.ts`) and validates the answer itself (`src/mail/providers/google.ts`). The user's own client in `credentials.json` always wins, then a client shared from another account, then the shipped one; the backend's Gmail token refresh resolves the same order. Only an absent file, or one naming no usable client, falls back to the shipped client: an unsafe, oversized or malformed file stays an error.

## Calendar error diagnostics (API 10)

Calendar RPC errors retain their existing `code` and `message` and may add `data` with `provider`, `operation`, `stage`, `httpStatus`, `reason` and `field`. Context distinguishes local validation and token acquisition from calendar HTTP, and records the actual operation (`lookup`, `import`, `update`, etc.) within an invitation save. Network timeouts use `calendar_timeout`; other transport failures retain `calendar_network_failed`. Fields are optional: missing HTTP status means no HTTP response was captured, and an absent reason does not imply that the provider supplied none.

Only fixed provider/operation/stage names, an integer HTTP status, exact allowlisted Google/Graph reason codes and known field names cross the RPC boundary. Google field hints come from an allowlisted `location` or an exact known fixed message (for example an invalid start time zone maps to `start.timeZone`). Raw error messages, response headers, URLs, account/event IDs, tokens and mail content are excluded. Error bodies are read only up to 16 KiB with a one-second diagnostic deadline; oversized, malformed, truncated or stalled bodies preserve the original status/error without a reason. Each RPC owns an async-local capture scope, including uploaded calls, so concurrent requests and cancelled scopes cannot share error context. Direct Rust library callers retain string errors.

The invitation card (`failure()` in `src/mail/calendar/invitations.ts`) uses these details. It distinguishes authentication, refused access, invalid requests, conflicts, throttling and temporary failures; uncertain saves advise refreshing before retrying. A failure also exposes the existing status-bar diagnosis action. Retry remains explicit and calendar-only, without sending another RSVP. Diagnostic recording and report regeneration independently allowlist the structured fields, so an edited or older log cannot inject provider text into a report.

One-off invitation exports (including individual recurring occurrences) send their already-resolved UTC timestamps without the original ICS `TZID`. Inline `VTIMEZONE` names may be Windows/custom identifiers rather than Google-compatible IANA zones; omitting that redundant label preserves the exact start/end instants. Recurring series still require a named zone so future occurrences retain daylight-saving behavior; unresolved times remain refused. This payload correction also works with API 9.

Google private imports require the destination calendar to be the organizer or an attendee. The backend includes exactly that calendar as an attendee, resolving `primary` to the signed-in account, with the chosen response. It never copies guests from the invitation. Existing managed copies update only this participant using `attendeesOmitted`, preserve other attendees, and retain `sendUpdates=none`; creation still uses the private `events.import` endpoint. The safe reason vocabulary includes `participantIsNeitherOrganizerNorAttendee` so this failure is distinguishable from invalid times and access errors.

## CalDAV password checks (API 10)

`calendar.verify` is the API 10 method. It takes `{source: {kind: "caldav", url, username}, password}` and tries that password once against the calendar, a `PROPFIND` at depth 0 under the same HTTPS-only, no-redirect client and 24-second deadline as every other CalDAV request. It answers `{verified: true}` or refuses with `calendar_auth_refused`, `calendar_not_found`, `calendar_redirected`, `calendar_request_failed`, `calendar_network_failed` or `calendar_timeout`, with the usual `error.data` context; input that fails the address or password rules is refused before any connection. The backend neither reads nor writes the keyring here: the password travels only to the configured origin, and the frontend stores it, with the calendar, only after this answer. The app calls it from `verifyCalDavPassword` in `src/features/calendar/controller.ts`.

## Gmail grant refusals (API 10)

When Google's token endpoint refuses a Gmail refresh with HTTP 400 `invalid_grant`, the backend answers `gmail_signed_out` (API 9 answered `gmail_http_failed`), from `auth.token` and from every Gmail method that refreshes on its own. Methods and parameters are unchanged. The contract has no case for it, because only Google's token endpoint produces it; the Rust runtime tests cover it against a local server. Signing in replaces the grant and signing out deletes it; no refusal deletes one. A Gmail method that hears it mid-session reports the error and leaves the session as it is until the next `auth.token`. In the app, `gmailSignedIn` in `src/features/accounts/flows.ts` reads `gmail_signed_out` and `credential_missing` from `auth.token` as signed out and anything else as unknown; it does not delete the grant.

## Released and unreleased: one step ahead of the pin

Backends ship in batches, not per merge, so `main` may implement an API that the last published binary does not have yet. `core/backend-api.json` names that difference and nothing more:

- `releasedApiVersion` is the API the published binary in `core/backend-version` speaks. `apiVersion` is what this checkout's Rust implements: equal to it, or **one step ahead**. `check-api` in `omarchy/scripts/package-backend.py` refuses a second step until the first is released, which is what makes releases batches.
- `unreleased.methods` and `unreleased.cases` name what the step adds: methods only the step has, and contract cases only a binary from this checkout passes. A case on an unreleased method is itself unreleased. With `apiVersion` equal to `releasedApiVersion` both lists are empty.
- The release folds the step: `releasedApiVersion` becomes `apiVersion` and both `unreleased` lists empty. Published contracts from before the split are read as all released.

The NSH app is not part of this: it links the checkout's backend, so it always has the newest step. CI on this branch no longer runs the released and unreleased contract gates; the contract runner `core/tests/test_backend_api.py` and `check-api` run in the release workflow only.

For a change that needs a new API step: raise `apiVersion` one step past `releasedApiVersion` and name the new methods and cases under `unreleased`. The contract runner exercises the contract's cases and checks the advertised inventory. It covers representative mail processing and cached reader behavior, not every provider operation. Reviewers must extend fixtures for newly used behavior; passing them does not prove complete semantic compatibility. Contract fixtures, API revisions, workflows and repository policy changes require trusted review.

## Release before pin

Releasing is pending NSH packaging. The app is to be released as NSH packages; the release workflow (`.github/workflows/release.yml`), the installers (`omarchy/install.sh`, `omarchy/install.ps1`) and `omarchy/scripts/publish.sh` still describe the Qt-era release, in which the standalone binary was published and then pinned in `core/backend-version`. They are not expected to work on this branch and are being rewritten in their own pull request, which will document the new flow here.

Until then, never push `main` directly and never tag by hand; tags alone do not publish. Keep `omarchy/scripts/release-notes.sh` aggregating the `## Release Notes` sections of merged pull requests.

## Standalone security gates

Every build of the app and the standalone binary must hold these boundaries. CI jobs provide evidence for a scoped security assessment; a green job does not itself establish a security verdict or prove that every boundary was exercised. Assess the actual coverage, including fixture limitations, before reporting **PASS**, **BLOCK** or **NOT VERIFIED** for an affected boundary. A demonstrated failure blocks a release. Contributor and reviewer checks follow [CONTRIBUTING.md](../CONTRIBUTING.md#before-you-write-anything), which requires neither hands-on testing nor local macOS or Windows runs.

| Boundary | Evidence to assess |
| --- | --- |
| Credentials | Native Keychain, Secret Service or Credential Manager success, missing-item, denial, validation and bounded-prompt cases; secrets absent from argv, settings and diagnostics. |
| Untrusted mail and URLs | Plain-text metadata, HTML and resource sanitization, public-address DNS pinning, HTTPS/TLS, redirect, proxy, deadline and response-size cases using controlled targets. |
| Process argv and stdin | Hostile arguments preserved as one argument, exact stdin bytes including NUL, bounded stdout and stderr, timeout, cancellation and descendant termination. |
| Private files and outbox IPC | Platform directory resolution, unsafe ancestor, link and reparse refusal, ownership and ACL checks, atomic replacement and rollback, locks, peer identity and oversized IPC frames. |
| Opening files | Only files the backend stored to open, or saved downloads, are opened; other folders, links out of them and types the desktop would run are refused (`ext/omamail-native/src/lib.rs`). |
| Network requests | Every mail and calendar request keeps credentials on the configured origin or a validated public target, validates bytes before a process starts, applies TLS, protocol, redirect and proxy policy, and has a deadline and a response bound. |

CI (`.github/workflows/ci.yml`) runs the evidence on every pull request:

- **Standalone backend** on Linux, macOS and Windows: the native platform tests (`core/tests/platform_native.rs`), the process tests, and a check that a build without the `agent` feature has no AI worker or `agent.*` methods.
- **Native credential contracts** (`.github/workflows/native-credentials.yml`) on Ubuntu 22.04, macOS 15 and Windows Server 2022.
- **Mail core (Linux)**: the library's unit tests and the integration tests in `core/tests/`.
- **NSH app module**: `cargo fmt`, `clippy` and `cargo test` in `ext/omamail-native`.
- **NSH app (check and tests)**: `nsh check`, `scripts/check-keys.ts`, `scripts/check-native-members.ts` and the headless `nsh test` suite.
- **Mobile backend**: `cargo check --lib` for iOS and Android.

The CI jobs run on Linux, macOS and Windows hosted runners, but only the backend and credential jobs run on all three; the app's TSX suite runs headless on Linux. Package and installer checks for the NSH app do not exist yet; they belong to the packaging work.

## Local verification

Run `make validate` (`nsh check`, the key and native-member drift checks, `nsh build` and `nsh test`) after TSX or behavior changes, and `make run` to launch the app from the checkout. Run `cargo test` in `core/` for mail-library changes and in `ext/omamail-native` for the native module. These commands establish evidence only for the operating system that ran them. They do not verify live mailbox compatibility or release availability.
