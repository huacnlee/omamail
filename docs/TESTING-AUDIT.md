# Test-value audit, October 2026

Baseline: `a08f8d3` (2026-10-31). The ongoing policy is [Testing standards](TESTING.md); this document records the audit that motivated it. Findings refer to the baseline unless marked **addressed**. They describe test effectiveness, not confirmed production defects.

## Scope and method

The review covered 121 Rust test-bearing files (837 test declarations, including platform-gated and ignored cases), their two Rust support files and six Python peers, all 52 root `tests/test_*` scripts, 53 UI JavaScript suites, 135 main UI QML suites and their compatibility/oracle/fixture support, all 22 files under `app/tests/`, and Makefile, CMake and workflow registration. Test names and assertion counts were used to locate tests, not to rate their quality. Review traced production calls, expected results, boundary doubles and overlapping coverage; focused fault injections checked the specific repairs below.

This is a repository-wide source review with selected runtime probes, not exhaustive mutation testing or verification of every native platform. A retained suite has an identified purpose; that does not certify every assertion within it. In particular, passing fixture tests must not be described as proof of real provider acceptance or native notification delivery.

## Repairs in this change

| Finding | Decision and evidence |
| --- | --- |
| PowerShell negative tests accepted unexpected success | **Addressed.** `app/tests/Test-Package.ps1::Expect-Failure` and `app/tests/Test-Install.ps1::Expect-InstallFailure` caught their own assertion, whose message matched the expected error. Move that assertion outside the catch. Executing the extracted production test helpers in PowerShell showed both old helpers accept a no-op; both revised helpers reject it, accept the intended exception and reject an unrelated exception. Both complete synthetic suites pass on Linux-hosted PowerShell 7.6.9; that is not native Windows installation evidence. |
| A failed Windows CI inventory check could be overwritten by the next command | **Addressed.** `.github/workflows/ci.yml` now checks `$LASTEXITCODE` immediately after `test_qml_inventory.py`, as release CI already does. A controlled PowerShell probe with a failed inventory child and successful next child continued before the change and stopped after it. |
| Attachment preservation checked existence, not preserved contents | **Addressed.** `tests/test_attachment_save.sh` now saves different bytes for the second attachment and compares both files. A scratch mutation that writes the numbered file but also overwrites the original passed the old test and fails the revised assertion. Unmodified production passes. |
| Harmless checkout names broke a make-output test | **Addressed.** `tests/test_app_make.py` rejected any occurrence of `install`, including a checkout path containing `installed`. Retain the explicit private-backend helper check and suppress directory chatter. A scratch checkout with that name fails the old test and passes the revised test. This remains command-generation coverage, not an application launch test. |
| Two source guards could never reject their forbidden examples | **Removed.** The JMAP member and immediate-account-removal `awk` checks in `tests/test_source.sh` had `END` blocks that overwrote earlier exit statuses. Controlled forbidden snippets demonstrate both false greens. Removing them removes no effective detection. `tst_m365_sign_in.qml::test_removing_the_mailbox_deletes_its_sign_in_only_once_the_removal_is_confirmed` observes no sign-out or account removal on cancellation, then one sign-out on confirmation. Related JMAP member tests protect cached flags and action scope, but no direct QML assertion of `getSummaries` requesting `withBlocks: false` was found; that remains a coverage gap. |
| Checking that tests exist was presented as ordering coverage | **Removed.** Two `test_source.sh` greps only looked for IMAP test function names. The Cargo regressions themselves remain; renaming them should not fail a separate shell suite. |

## Follow-up findings

These findings remain in the baseline suite. They are concrete cleanup candidates, not a requirement to rewrite every test or add a new framework before an unrelated change can merge.

### Source-text checks often make stronger claims than they establish

`tests/test_source.sh` and `tests/test_service_source.sh` contain many exact helper names, expression spellings and source-order checks. Some enforce deliberate architecture rules, such as keeping network operations out of QML. Others claim timeout, focus, cache, persistence or layout behavior from a matching string. Those should be replaced by, or consolidated into, tests that observe the result. Map each assertion to existing coverage before deleting it; the two ineffective guards above are not a reason to delete all source lint.

Specific weak detectors include the menu-row scan matching `MenuRow` when the menus use `MenuActionRow`, and the mailbox-selection scan succeeding when its opening pattern is absent. `tests/test_qml_text_format.py` accepts any occurrence of `textFormat` in a matching block rather than establishing `Text.PlainText`. Its directory inventory is also fixed. Retain the actual Qt resource-request observer tests; improve the static detector's precision if it is kept as an early warning.

`app/tests/test_notification_sources.py`, `test_identity.py`, `test_qml_inventory.py` and `test_release_workflow.py` mix legitimate artifact/dependency contracts with exact implementation fingerprints. A source file containing an API name, namespace, callback or command cannot prove the operation runs or fails safely. Compiling the actual native source and inspecting package outputs already supplies independent value. Keep structural checks labeled as structural checks.

### Negative installer tests need observers that can detect the forbidden effect

- `app/tests/test_install.sh` checks absence of a launch log, but its header-only executable fixtures do not write that log. An attempted launch can fail without making the observer notice. Use a runnable controlled marker or a process boundary that records launch attempts.
- Its oversized-archive and checksum fixtures can also fail because the checksum or archive format is invalid. Assert the intended limit refusal, or rejection before the expensive operation, so removing the limit cannot leave the test green for another reason.
- Unix and PowerShell traversal cases check old-install preservation without checking all escape destinations. Use unique outside canaries and assert no write there. An error after an unwanted write is still a failure.
- The PowerShell uninstall data canary is in an arbitrary `user-data` directory rather than a directory selected by production platform paths. Tie preservation checks to the location the implementation could actually delete.

The transaction, checksum, archive-layout and rollback assertions in these suites remain valuable. Repair the weak observers rather than discarding the suites.

### Native and fixture coverage must be distinguished

The four `app/tests/native/tst_*.cpp` suites exercise real production process, resource, settings and notification-service code. In particular, real child-process shutdown, file preservation, Windows sharing locks and durable notification routes are useful boundaries to keep.

The notification service uses `FakeNotificationPlatform` for most cases. That is an appropriate service-level double, but does not establish Linux D-Bus or Windows activation behavior. The inspected app workflow registrations do not supply a separate real notification delivery/activation test; the source-text checks cannot fill that gap. Add a controlled native-boundary test when changing that boundary, rather than claiming the service fixture already verifies it.

The standalone composition suite instantiates production Main/App with synthetic host/file adapters. It meaningfully tests wiring and interaction. Its resize-persistence case manually invokes scheduling and saving, so it cannot detect removal of automatic resize hooks; its direct child-array selectors also make harmless layout refactors expensive. Prefer a resize followed by an observed write and stable selectors when revising these cases.

### Rust coverage is mostly behavioral, with several weak assertions

No whole Rust test file was identified for deletion: 113 files have a clear retained purpose, six have focused assertion improvements, and two contain narrow redundant fragments. Important examples to preserve include restart-safe outbox deduplication, controlled-peer IMAP paging bounds, JMAP preview request/filesystem observations, native credential prompt cleanup and actual Qt resource-request controls.

| Test | Needed improvement |
| --- | --- |
| `tests/gmail.rs`: preview and credential-gating cases | Their `secret-tool` marker watches a retired path; credentials now use the native store. Observe `OMAMAIL_INTEGRATION_CREDENTIAL_TRACE` with a valid control, as CLI tests already do. Keep the existing result and account checks. |
| `src/agent/mcp.rs::oversized_input_is_refused_before_any_effect` | The oversized input also has invalid JSON/framing, so an unrelated rejection satisfies `is_err()`. Use otherwise valid framed input and a limit-specific assertion. |
| `src/message/parity_tests.rs::outgoing_preserves_twenty_mebibyte_attachment_support` | It only checks an upper output-size bound. Independently decode and verify the attachment's bytes/length so omission or truncation cannot pass. |
| `tests/hey.rs::optional_read_flags_negotiate_without_retrying_real_failures` | The fixture only exercises successful optional-flag negotiation. Add an observed non-flag refusal and call count, or narrow the name's claim. |
| Dynamic parity collectors in `src/message/direction.rs` and `src/message/signature.rs` | Require nonempty captured cases and intended method-family coverage. Their current loops can succeed on an empty capture after a harness refactor. This does not mean the current captures are empty. |

Consolidation candidates are only the duplicate oversized-input fragment in `src/process/unix.rs::stderr_and_input_are_bounded_too` (the public-path case in `src/process/tests.rs` already covers it), and retired shell credential-shim setup in `tests/cli.rs`. Preserve continuous-stderr tests and the CLI's working native credential observer.

### Historical JavaScript tests can miss current production behavior

The UI inventory covered all 236 files, including 53 JavaScript suites, 135 main QML suites and one published-compatibility QML suite. Most production-component interaction and asynchronous ownership tests have clear value. Historical business logic needs function-level consumer tracing rather than wholesale deletion.

| Test or group | Finding and next action |
| --- | --- |
| `ui/tests/test_senders.js` | Loads `tests/oracles/Senders.js`, so its visibility and subtitle examples miss the current `compose/Senders.js` imported by ComposeView. A loader trap confirmed zero production-module imports. Point presentation assertions at production; migrate unique identity examples to the native request path. Preserve the oracle used by `src/account/senders.rs` and `NativeDomainFixture.js`. |
| `test_cache.js` and `test_render_cache.js` | Exercise retired `cache/Cache.js` and `account/RenderCache.js`; no application or Rust-parity consumer was found. Remove these test/module pairs after mapping unique cases to native coverage and removing related source hooks. Preserve the current QML cache/race suites and the separate live `calendar/Cache.js`. |
| `test_provider.js` | Grafts six historical methods onto the current Registry, so query assertions do not test the native resolver. Historical IMAP examples still expect `folder:INBOX` where native queries deliberately use account-wide `search:`. Remove the graft, retain current descriptor/capability checks and move query cases to native fixtures. Preserve provider oracles while the synthetic QML fixture consumes them. |
| `test_conversation.js`, `test_compose_recovery.js` and parts of `test_agent.js` | Historical self-tests do not run Rust. Actual Rust comparisons use selected corpora rather than every example in these suites. Share explicit cases with production comparisons before retiring or expanding historical assertions. Keep current agent presentation tests. |
| `test_imap.js`, `test_jmap.js`, `test_gmail_api.js`, `test_hey.js` and `test_outbox.js` | Mix live settings/presentation rules with migrated protocol or scheduler helpers. Trace individual callers before pruning. Replace the IMAP Rust-source regex with actual folder-listing assertions; make the required JMAP capability assertion unconditional rather than skipping it when the property disappears. Keep live outbox delay normalization. |

Some large JavaScript corpora genuinely feed native comparisons. Preserve `JmapThreads.js` while `src/providers/jmap/resource_tests.rs` consumes it; preserve live Model/Unified rules and their native comparisons. HTML, Direction and Signature collectors capture calls from their JavaScript suites for current Rust comparisons. These are materially different from standalone oracle self-tests.

### Framework examples and fixture boundaries need accurate claims

`tst_focus.qml` tests a homemade Item and its own focus binding. `tst_popup_keys.qml` and `tst_hover_under_scroll.qml` use only Qt primitives. Replace or retire these as application regressions, or explicitly label them optional framework-characterization tests. Actual ComposeView/App focus and account-switcher key tests already exist; check for a real stationary-pointer/list-cursor regression before retiring the hover example.

Localized cleanup candidates include the identical-call equality in `test_calendar_palette.js`, which accepts an always-constant result, and the exact animation timings/private point arrays in `tst_omamail_logo.qml`. Retain meaningful parser, visible-state and reset assertions. The queue/wire JavaScript tests extract current QML function bodies and have useful FIFO, cancellation and delivery assertions; retain them as functional checks, while recognizing they cannot establish QML bindings or lifecycle behavior.

`NativeDomainFixture.js` computes native-shaped replies using historical JavaScript, and `ModelFixture.js` synthesizes merged results. They support UI wiring tests, not native semantics. By contrast, `NativeIntentFixture.js` calls an allowlisted real Rust bridge. Quickshell Process/FileView stubs record actions or expose signals without executing subprocesses or filesystem writes. Emitting a stub button's signal proves receiver wiring, not pointer behavior. State these boundaries when reporting results.

Strong production-component examples to preserve include press/release across message-array replacement, real Qt signal-list conversion, wrong-account/stale-callback rejection, lost-send acknowledgement handling, and invitation-calendar retry with two calendar calls but only one email. These protect different failures from Node rule tests and native protocol tests.

### Registration and duplicated evidence need explicit boundaries

- `make validate` runs the standalone composition CTest filter, not every native app test it builds. Full CTest, host-contract QML, package and installer tests have separate CI registrations. Report the actual targets run; the testing standards now distinguish these locations and runners.
- `tests/test_plugin_workflow.py` locks exact `make -n install` output, while `test_backend_runtime.py::test_make_install_builds_and_installs_before_linking` executes the orchestration and verifies failed-build preservation. Consolidate the overlapping dry-run assertion; retain distinct uninstall/link behavior.
- `tests/test_agent_published_qml.py` requires API 5 while the current pinned backend advertises API 9. Its historical compatibility purpose needs an explicit supported fixture or retirement; it is not the current general published-backend gate. `tests/test_backend_api.py` does exercise current contract fixtures against a selected binary.
- Legacy transport tests execute real shipped helpers even though application networking migrated to Rust. Coordinate retirement of those tests with retirement of their production callers and compatibility uses. A migration alone is not evidence that every old test is redundant.
- Package scripts and workflows repeat some extracted-package smoke checks. Keep repeated checks where they validate a different artifact or publication boundary; consolidate identical checks with no additional failure mode.

## What to preserve

| Area | Distinct value worth retaining |
| --- | --- |
| Script and filesystem integration | Actual private files, exact attachment bytes, existing-data preservation, publication/pin rollback and executable-boundary observations. |
| Protocol and security boundaries | Controlled peers, production codecs, malformed and valid input classes, request/process observers and cancellation/size/deadline checks. Unit policy checks and actual transport checks protect different faults. |
| QML interaction | Real production components under Qt, focus/key/pointer transitions, account ownership, stale callback rejection, queue behavior and binding propagation. Node-only rule tests cannot establish Qt behavior. |
| Cross-language and release compatibility | Current production code compared with independent fixtures or a genuine historical oracle, and frontend codecs exercised against the pinned executable. |
| Native host | Real subprocesses, filesystem/watch behavior, resource decoding and extracted-package readiness, with fixture and platform limits stated accurately. |
| Narrow static policy | Dependency bans, lint/test registration, declared contract inventories and artifact integrity/size where the policy itself is intentional. |

The main recommendation is targeted repair and consolidation. Test volume alone did not justify deleting useful regression cases. Prefer observable, independently specified outcomes; spend additional test effort where a distinct failure could still escape.
