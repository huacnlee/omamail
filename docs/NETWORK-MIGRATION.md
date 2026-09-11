# Rust network migration evidence

This checklist tracks the complete application migration requested on 2026-09-11.
An implementation file is not completion evidence: the production UI must reach
it, the previous transport must be unreachable, and behavior/security tests must
exercise the real boundary. The production paths are implemented locally; the records below distinguish
controlled tests, scoped security reviews and the two live-account probes.
This document does not certify compatibility with every mail server.

## Scope and ownership

| Capability | Previous production boundary | Required Rust behavior and evidence | Status |
| --- | --- | --- | --- |
| Gmail reads | `GmailApiClient.qml` XMLHttpRequest fallback | List, paged/search listings, metadata, full message, labels/counts/profile/send-as/attachments; shared TLS connection pool, bounded concurrent reads; UI backend only | Implemented locally |
| Gmail writes | `GmailApiClient.qml` HTTP request | Read/star/archive/trash/spam, labels, send, drafts and batch operations; correct errors and no unsafe mutation retries | Implemented locally |
| Google OAuth | `AuthManager.qml` XMLHttpRequest, socat, pkce.sh | PKCE generation, loopback callback, state validation, code exchange, refresh, revoke; private credentials and cancellation/deadlines | Implemented locally |
| Outlook OAuth | `OutlookAuth.qml` XMLHttpRequest | Device authorization/polling, slow-down/expiry/error behavior, refresh, keyring; no refresh tokens in normal UI requests or credentials in argv | Implemented locally |
| IMAP | `ImapClient.qml`, mail-transport.sh | TLS/STARTTLS authentication, SPECIAL-USE discovery, UID listing/search/count, literal octet framing, BODY.PEEK reads, mutations, UID EXPUNGE, drafts/APPEND, attachments; concurrent account isolation and connection reuse | Implemented locally |
| SMTP / Outlook Graph send | `ImapClient.qml`, mail-transport.sh | SMTP TLS/STARTTLS/auth/send, exact recipient/body validation, Graph MIME send, no uncertain-send retry | Implemented locally |
| JMAP | `JmapClient.qml`, jmap-transport.sh | HTTPS discovery, trusted session destinations, session/account/capabilities, queries, conversations, read/write/submission, drafts, blob upload/download and pagination | Implemented locally |
| JMAP push | `JmapPush.qml`, jmap-stream.py | Rust owns long-lived SSE, bounded framing before buffering, cancellation/reconnect/backoff, per-account state and change delivery | Implemented locally |
| HEY | `HeyClient.qml` and `HeyAuth.qml` processes | Rust owns official `hey` CLI invocation, login/status/logout, list/thread reads, actions/drafts/send/reply, optional flag compatibility, cancellation/size/time limits; private endpoints remain prohibited | Implemented locally |
| Calendar | `CalendarController.qml` XMLHttpRequest and calendar-{transport,write,delete}.sh | Google/Graph list/create/update/delete/RSVP and CalDAV reads/writes/deletes; event href stays configured origin before credential lookup, TLS/deadlines/bounds | Implemented locally |
| Remote reader images | `MailAccount.qml`, image_fetch.py, public_http.py | Public-address DNS policy and pinned socket, redirects refused, TLS verified, whole request deadline, raster signature/type/size enforcement; Qt receives successful data URI only | Implemented locally |
| One-click unsubscribe | `Unsubscribe.qml`, unsubscribe.py, public_http.py | Public HTTPS POST, same DNS/connection policy, no redirects/body forwarding, no sender-controlled argv or config | Implemented locally |
| Attachments | Provider clients, attachment/open/save helpers | Network downloads/upload owned by provider Rust; binary framing and limits; local save/open preserves safe paths and private storage | Implemented locally |
| Automatic mail checking | MailAccount timers and JMAP push | Backend independently schedules all supported accounts, bounded concurrency/coalescing and retry intervals, UI receives snapshots/notifications; closing reader does not stop checking | Implemented locally |
| Persistent data/cache | CacheStore.qml, BodyCache.qml, CalendarCache.qml, config-store.sh, body-cache.sh | Backend owns mail/cache reads/writes and invalidation, atomic private files, safe paths, bounded eviction; preserve existing account data | Implemented locally |
| Contacts | Service.qml and contact-suggestions.py | Current sources are local Thunderbird/Betterbird/cache/JSON/vCard, not a remote network source; migrate collection to Rust per reduced-JS/backend ownership request | Implemented locally |

## Explicit external boundaries

These are accounted for, not hidden as migrated HTTP:

* `scripts/backend-runtime.py` bootstraps a missing backend from an exact-version
  release. A backend that is absent cannot download itself. This separate
  installation boundary retains fixed HTTPS release hosts, bounded redirects,
  deadlines, archive/binary bounds, version verification and atomic installation.
  `make install` must compile and install the local Rust executable.
* `scripts/google-cloud-project.sh` is an explicit external provisioning workflow.
  Google's `gcloud` owns its signed-in Cloud account and project/API provisioning;
  the remaining OAuth app setup opens the Cloud Console. This is not ongoing
  mailbox transport. Ordinary Google authentication still belongs in Rust.
* HEY's official CLI owns HEY OAuth and its network protocol because the project
  explicitly prohibits use of HEY private endpoints. Rust must own and supervise
  every invocation; QML must not keep an alternate transport.
* Browser links and external AI CLI workflows hand an explicit user action to an
  external application. They are not application mail HTTP implementations.
  Local clipboard, notification, portal/file-picker and keyring integrations are
  also distinct from mail transport; their subprocess security still applies.

## Completion gates

- No production QML/JS XMLHttpRequest, raw network process, or fallback to legacy
  mail/calendar/resource network scripts. Detecting absent call sites proves only
  removal; it does not prove working replacements.
- Rust protocol exposes and actually dispatches each operation used by production
  UI. Controlled real-server tests cover valid responses, status/error handling,
  TLS rejection, timeout/cancellation, response bounds and credential origin.
- Native concurrency tests show overlapping delayed requests and connection reuse;
  no global token-refresh mutex or blocking subprocess monopolizes all work.
- Existing UI flows and provider capability differences remain correct, including
  HEY optional flags and thread IDs, IMAP UID scope, and JMAP conversation behavior.
- Backend automatically checks multiple providers without requiring a visible
  reader. Persisted cache is used for immediate repeat reads and invalidated after
  writes and account changes.
- `make test-local`, formatting/lint checks and local release installation pass
  against the final combined tree. Test output from an earlier tree is historical
  evidence only.
- Separate security verdict: **NOT VERIFIED** while migrations are in progress.
  No complete-backend claim or release approval follows from a narrow test pass.

## Verification recorded during migration

2026-09-11, independent audit, current working tree:

* `python3 tests/test_network_migration.py --self-test`: four detector tests pass.
  `python3 tests/test_network_migration.py`: passes; no legacy application network
  helpers, XMLHttpRequest constructors, or raw curl/wget/socat in production UI.
  This proves source removal only.
* Twelve focused Qt suites (`tst_jmap*.qml` and `tst_app_edit_connect.qml`): **47
  passed**, Qt 6.11.2, offscreen/software. Fixtures now intercept backend RPC,
  preserving real client/account behavior. Draft import/submission failure,
  original draft retention, deferred actions, rejected-credential gates, member
  versus conversation mutations and session invalidation remain covered.
* Discovery/scheme negotiation now executes through `jmap.verify`; UI tests assert
  its input and settled success/error state. Former HTTP-origin assertions must
  be supported by Rust discovery tests, not by synthetic UI success envelopes.
* `cargo test --locked providers::jmap --lib`: **10 passed**. Runtime evidence
  includes native concurrent requests, pooled connection reuse, redirected target
  receiving no request, TLS issuer/hostname refusal, bounded body/event parsing
  and stream cancellation. The stream backoff regression is
  `transient_closes_back_off_but_settled_clean_stream_reconnects_immediately`.
  UI stream tests separately cover stale open/poll replies, logout close,
  credential rejection, and polling continuation on the same stream.
* `cargo test --locked auth::callback --lib`: **3 passed**, including real loopback
  sockets rejecting forged state before accepting valid state, and cancellation
  releasing the listener without code exchange. Review found and fixed dropping
  finished unpolled flows during another sign-in and an incorrect HTTP length.

These focused passes do not establish complete migration. Global combined-tree
checks, end-to-end provider flows and the final security audit remain necessary.
Security verdict for the **whole migration remains NOT VERIFIED** pending the
final combined-tree audit. JMAP discovery additionally passed the real TLS
`html_and_empty_challenge_never_receive_credentials_or_followup_requests` test:
both HTML and an empty authentication challenge produced only an unauthenticated
probe, with no subsequent credential-bearing request.

Additional adapter evidence:

* `tst_folder_cache.qml`: **3 passed**, preserving fresh LIST after overlapping
  folder renames rather than accepting stale folder results.
* `tst_outlook_boundaries.qml`: **11 passed**, including normal IMAP/SMTP/APPEND
  calls carrying only saved account identity, never caller-supplied credentials,
  servers or bearer token. Edited settings cannot change that RPC boundary.
  An unsaved generic IMAP sign-in separately proves explicit settings/credential
  input and absence of a saved account id. Rust account-resolution tests must
  establish actual destination selection; the UI fixture does not claim that.

Background-check verification (2026-09-11):

* Native `sync::tests`: eight tests cover periodic checks without manual requests,
  independent accounts, coalescing, cancellation, stale generations, equal-count
  message replacement, registry notifications and invalid input.
* `tst_backend_sync.qml`: six tests/pass lifecycle entries cover registration
  without a window, deduplication, disconnect/reconnect, pending unwatch and
  recovery after failed registration. A registration retry timer does not poll
  mail; the mailbox timer remains in Rust.
* A local persistent `serve` process was exercised with existing Gmail and HEY
  accounts using read-only calls. Both emitted an initial `mail.updated` in
  approximately 1.2–1.5 seconds and a second notification automatically after the
  configured 30-second interval. Both included nonempty fingerprints and no
  errors; unwatch and shutdown completed with exit 0. No message contents,
  account identities or credentials were recorded in the result. This is live
  evidence for those two configured accounts, not every server/provider.
* The shared TLS fixture now creates a `CA:FALSE` server certificate. Gmail and
  JMAP include a successful trusted/correct-host control beside the rejected
  issuer and hostname cases. All four TLS suites (also IMAP and public HTTP)
  passed together.

A second live run used HEY's actual unread query (`box:imbox unseen`): Gmail
returned at 1.88s/33.02s and HEY at 5.48s/36.60s, with no errors. HEY unread
checking performs the official CLI's bounded unseen scan, so it remains slower
than its ordinary Imbox page. Native scheduling/concurrency does not remove
that upstream work. This run verifies the unread check as well as periodic
rescheduling; it is not a before/after performance benchmark.


## Final combined local verification — 2026-09-12

* `QT_QPA_PLATFORMTHEME= make validate`: exit 0. Rust library 184 tests plus
  integration suites passed; QML main 714, Outlook 6 and Sidebar 64 passed;
  JavaScript, shell/security regressions, qmllint and plugin validation passed.
  Existing QML warnings remain in the log; no test failed.
* `cargo fmt --all -- --check` and `cargo clippy --all-targets -- -D warnings`:
  exit 0.
* `make test-backend-process`: exit 0. The real Quickshell bridge exercised
  concurrent calls, MIME/JSON uploads, native cache, response chunks and
  confirmed shutdown. This caught and drove a fix for a dispatcher stack
  overflow: provider futures now use heap indirection.
* `make install-backend-local`: compiled release installed at
  `runtime/bin/omamail`; installer reported ready. After shell restart the live
  process ran that exact executable with `serve`.
* The final release binary's read-only Gmail and HEY unread checks each emitted
  two successful periodic notifications (initial 0.91s/1.14s, then
  31.26s/32.10s), followed by successful cancellation/shutdown.
* Scoped security re-reviews: **PASS** for native IMAP/SMTP (31 tests), JMAP
  (24 tests), and upload/account/cache/auth-origin boundaries. Fixes include
  validation before effects, actual read cancellation, JMAP preconstruction
  resource budgets, bounded retained caches and uncertain-submit handling.
  These are scoped verdicts, not a security audit of the entire application.

The earlier not-verified entries record intermediate checkpoints, not the final
result. The explicit external boundaries above still apply; live IMAP, Outlook,
JMAP and real sending were not exercised with user credentials. UI composition,
HTML sanitization and in-memory display state intentionally remain in QML/JS.
