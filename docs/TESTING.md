# Testing standards

Tests should catch consequential mistakes and make changes easier. More tests, assertions or covered lines are not goals in themselves. These standards apply equally to human-written and generated tests. Use [CONTRIBUTING.md](../CONTRIBUTING.md) for required checks, PR evidence and review procedures.

## Decide whether a test earns its place

Before adding or keeping a test, answer these questions in its name, assertions or a short comment where the reason is not obvious:

1. **What could go wrong?** Name an observable behavior or deliberate contract: wrong recipients, lost drafts, stale account results, inaccessible controls, unsafe resource loading, incompatible releases. A private helper being renamed is not a product failure.
2. **Would this test catch it?** Exercise production code and assert a result independently derived from the requirement. A callback assertion needs evidence that the callback ran. A forbidden-effect assertion needs a working observer and a completed operation.
3. **What does it add?** Identify a distinct input class, boundary, state transition or integration failure not already protected. Several layers may legitimately test the same feature when they catch different failures.
4. **Will it survive a harmless refactor?** Prefer outputs, persisted state, rendered properties and external effects over exact source spelling, private fields, internal call order or complete snapshots.
5. **Is the cost proportionate?** Consider runtime, setup, flaky failures, fixture maintenance and failure diagnosis. Use the smallest test that can observe the failure, not automatically the smallest function or the largest end-to-end harness.

A test that cannot answer these questions should be improved, consolidated or removed. Do not turn the questions into a numerical score, a required PR form or one new test per changed function. A small test can protect an important contract; a large test can still assert nothing useful.

## What we want to test

| Risk or behavior | Useful evidence in this repository |
| --- | --- |
| Parsing and decision rules | Call the production Rust or JavaScript rule with representative valid inputs, meaningful invalid classes and boundary values; assert the intended result. |
| Mail, drafts, outbox and account ownership | Assert recipients, account identity, durable records, rollback and retry effects. For a failed save followed by retry, verify that no second message is sent. |
| UI interaction | Instantiate production QML components; drive the relevant key, pointer or signal transition and assert focus, selection, visibility, content or emitted action. Use an App/Service test when wiring between components is the risk. |
| Async work | Control response order and completion; verify stale results are ignored, cancellation finishes, queues drain and the latest account/selection wins. Use bounded condition waits rather than sleeps that merely hope work finished. |
| Security boundaries | Exercise the actual consuming boundary and assert the forbidden request, process, disclosure or file write never happened, alongside valid-input controls. Follow [SECURITY-BOUNDARIES.md](SECURITY-BOUNDARIES.md). |
| Provider, process and native-platform integration | Use controlled peers, private storage and real codecs/transports where their behavior matters. A fake provider is suitable for UI state, not proof of provider acceptance, TLS or native credential behavior. |
| Release compatibility and packaging | Exercise the current frontend against the pinned binary and inspect actual built/package outputs. Source inventories establish registration, not runtime compatibility. |
| Performance and resource limits | Assert a meaningful budget or bounded work on a representative workload. Counts of network requests, parses or repaints can be contracts when they protect a concrete cost. Keep timing benchmarks separate from fragile wall-clock unit assertions. |
| Repository policy | Narrow static checks may enforce a deliberate rule such as forbidden network APIs, unsafe text formats, missing lint inputs or artifact size. State that these are static checks and retain runtime evidence for behavior. |

Use representative equivalence classes and boundary values instead of every combination of booleans, providers and strings. Add a combination when a distinct implementation, past defect or interaction justifies it. Keep stable regressions for real bugs even when they have not failed recently.

## Patterns to avoid

- **Source checks presented as behavior tests.** Finding `timeout(` does not prove requests time out. Finding a test function's name does not prove it runs or asserts the right result. Prefer a controlled stalled peer and an observed deadline.
- **Tests of a replacement implementation.** Copying production logic into a fixture and testing that copy cannot detect production regressions. A historical implementation can be an independent migration oracle only when the test also runs current production code and compares results. Name the compatibility purpose and retire the oracle when that purpose ends; never update both implementations mechanically to make a test pass.
- **Expected values calculated by the code under test.** Round trips and parity tests are useful invariants, but can hide matching bugs. Include independently specified examples where the external meaning matters, especially wire formats, addresses and dates.
- **Mock choreography.** Do not assert every internal call in order. Observe results instead, except where the calls themselves are the contract: credentials sent only to the right origin, one send rather than two, or validation before a destructive effect. Mock external boundaries, not the decision being tested.
- **Huge or incidental snapshots.** Assert the fields and invariants that matter. Exact bytes are appropriate for protocol fixtures, integrity checks and preservation of user files, not every error message, private object or rendered document.
- **Vacuous success.** Empty loops, unmatched regexes, skipped callbacks, swallowed failures and unexecuted suites must not report evidence they did not collect. Check that the scenario and observer were actually reached. A skip is a reported limitation, not a pass.
- **Coverage padding.** Avoid isolated tests of trivial getters, constants or framework behavior unless they protect a specific contract not already exercised. Do not add a test simply because a line changed or an AI can generate it.

## Choose the right location

| Test | Location and runner |
| --- | --- |
| Rust rules and state | `src/` beside the module; `cargo test --locked --features integration-test-credentials` (`make test-rust`) |
| Rust process/CLI integration | `tests/*.rs`; Cargo discovers integration entry points |
| QML JavaScript rules | `ui/tests/test_*.js`, using `ui/tests/load.js` to load production module paths; `make test-js` |
| QML components and flows | `ui/tests/qml/tst_*.qml`; `make test-qml` supplies the native fixture and discovers QML cases |
| Scripts and repository contracts | `tests/test_*.py` / `tests/test_*.sh`; explicit Makefile or CI registration |
| Standalone host and packaging | `app/tests/`; `make test-app-qml`, CMake/CTest and the native CI jobs |

Inspect the Makefile, CMake and workflow registrations rather than assuming a filename runs automatically. Include new explicit registrations in the same change. Keep fixtures small and synthetic; isolate HOME/XDG, credentials, external processes and local servers. Do not depend on a developer's mailbox, desktop session or network availability. Report the platform and dependencies actually exercised.

## Adding, changing and removing tests

For a bug fix, first look for an existing test to extend. Demonstrate that the regression fails on the unfixed behavior and passes with the fix. The failing result must be the intended assertion, not a compilation error, missing fixture or unavailable dependency. For new behavior, use an independently specified expected result; for a refactor, existing behavioral tests may be all the new evidence needed.

Documentation-only changes and mechanically checked, low-risk edits do not need an invented behavioral test. Run the relevant existing checks and explain any material verification limitation. This does not waive required CI, the local gates in CONTRIBUTING, security evidence or visual evidence for an interface change.

Before deleting a test, identify its unique assertions and their production callers. Keep it if it still protects a distinct contract; extend or replace it if its intent matters but its assertion is weak. Remove redundant source-text assertions when named behavioral coverage protects the same risk, and remove disconnected tests of retired code only after checking parity, compatibility and fixture consumers. Do not remove useful negative cases just to reduce suite size or runtime. A failure during cleanup is something to investigate, not a reason to delete the test.

When a test's sensitivity is uncertain, use a focused fault injection: temporarily remove the relevant guard, return a wrong result or restore the pre-fix behavior, and verify the intended assertion fails. Restore the code and rerun the affected checks. This is a diagnostic technique, not a mandatory mutation-testing service or a score target. Ignore equivalent or irrelevant mutations; a changed log message need not demand another regression.

For a flaky test, determine whether the product races or the harness assumes timing, ordering or environment. Synchronize on observable events and isolate state. Retries and longer sleeps alone do not establish reliability. After relevant checks pass, repeat or broaden testing when a new change, failure or unresolved risk justifies it.

## Research behind these choices

These are project standards informed by published testing principles, not a claim of certification or a formula that proves every test valuable:

- [ISTQB Foundation syllabus v4.0.1, §§1.3 and 5.2](https://istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf): exhaustive testing is infeasible, testing is context-dependent, and risk should guide effort. Passing tests cannot prove absence of defects or product usefulness.
- [Software Engineering at Google, chapter 12](https://abseil.io/resources/swe-book/html/ch12.html): test behavior through suitable public boundaries; tests should survive internal refactoring and make failures easy to understand.
- [Google: Change-Detector Tests Considered Harmful](https://testing.googleblog.com/2015/01/testing-on-toilet-change-detector-tests.html): mechanically restating the implementation creates maintenance work without independently checking correctness.
- [Testing Library's guiding principles](https://testing-library.com/docs/guiding-principles/): tests gain confidence by resembling use. For Omamail this means actual QML interactions where Qt behavior matters, not adopting a web-specific test framework.
- [Google: Code Coverage Best Practices](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html): coverage helps locate untested code but is an indirect metric, not proof of good assertions or a reason for a universal percentage target.
- [Google: Mutation Testing](https://testing.googleblog.com/2021/04/mutation-testing.html): injected faults can expose weak assertions, but unproductive mutations and score-chasing can themselves produce low-value tests.
