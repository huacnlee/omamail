# Contributing to Omamail

There is no issue tracker here. Issues are turned off on purpose: a bug report
asks somebody else to reproduce a problem, decide what it means, and find the
time to fix it, and a queue of those grows faster than one project can answer
it. A pull request is the same information with the answer already in it.

Coding agents are why that is a reasonable thing to ask now. Point Codex,
Claude Code, or whatever you use at this checkout, describe what went wrong,
and let it read the code — the working agreements it needs are in
[AGENTS.md](AGENTS.md), which both of those read on their own.

## Write for people

Write issue reports, pull request titles and descriptions, reviews and discussion comments for human readers, including when an agent writes them. Keep them clear, concise and easy to understand without knowing the implementation. Lead with the problem or conclusion, explain why it matters, and make any requested action or decision clear.

Use everyday words and short sentences. Avoid unnecessary jargon and abbreviations; explain technical terms when they are needed. For example, say "show the remaining pictures as soon as all downloads finish" rather than "flush on queue drain".

Include the reasoning, important tradeoffs and evidence needed to understand the change or make a decision. Link to code, tests or logs for implementation details instead of walking through every function and file. Readers can explore those details themselves or with their agents; they should not have to do that to understand the main point. Keep required reproduction steps, verification results and security findings in the report.

## You found a bug

1. Reproduce it, and write down the smallest way to.
2. Fix it — yourself or with an agent — and add a test that fails without the
   fix.
3. Open a pull request whose body contains the reproduction. That is where the
   bug report lives now, next to the change that ends it.

**If you cannot fix it**, open a draft pull request that contains a failing
test and nothing else. A failing test is a bug report that cannot be
misunderstood, cannot go stale, and tells whoever picks it up when they are
done.

**A security fault is the exception.** Do not publish a working exploit in a
pull request. Report it privately first — GitHub's *Report a vulnerability*
button on the repository's Security tab — and send the fix afterwards, or with
it, described in terms of what it protects rather than what it opens.

## Before you write anything

- [AGENTS.md](AGENTS.md) is the working agreement: colours, layout, focus and
  keys, providers, secrets. Most of it exists because the obvious thing was
  tried and was wrong, and each rule says which. Read the section you are about
  to touch.
- [docs/SPEC.md](docs/SPEC.md) is what the app is meant to do,
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) how it is put together,
  [docs/KEYS.md](docs/KEYS.md) the key design — read that one before touching a
  binding.

## Contribution priorities

Omamail's core product is substantially complete. Prefer fixes and refinements to existing functionality: reproducible bugs, small focused fixes, wording corrections, and performance improvements that preserve the intended design and workflow. New features and email providers are considered cautiously; explain the unmet need, why existing workflows are insufficient, and the ongoing interface and maintenance cost before expanding scope.

Discuss large features, new providers, and substantial architectural changes with @huacnlee or @klaudworks before implementation. Passing tests does not establish that a capability belongs in the product.

## Project boundary

Omamail has two hosts over one shared mail and calendar implementation: a [Quickshell plugin hosted by `omarchy-shell`][omarchy-shell], and the Qt host under `app/`. A shared behavior belongs under `ui/` or in the Rust backend; `ui/Service.qml`, `ui/BarWidget.qml`, and `ui/App.qml` remain the Omarchy entry points, while `app/qml/Main.qml` supplies the standalone composition and adapters.

Helper scripts and the plugin's private Rust backend belong here. The same executable exposes CLI commands over its shared business modules, and both hosts use its persistent stdio RPC service. The standalone release bundles the exact backend beside its host. Separate daemons, SDKs, and automatic system-wide integrations remain outside this boundary. The plugin must not install commands or integrations into global user paths when it loads. Omarchy's plugin installer deliberately [clones and validates plugins, and can enable them, without running installation hooks][plugin-installation].

The first standalone scope includes mail, calendar, and native notifications. It deliberately exposes no tray, AI, or operating-system `mailto:` registration. Keep platform integration behind the native interfaces in `app/src/`; do not branch the shared UI by operating system.

Programmatic access to mail may be useful, but it needs an integration boundary designed independently from the Quickshell plugin. Omarchy defines [IPC as the standard boundary for commands that communicate with the running shell][shell-ipc]; proposals that need a different lifecycle or ownership model should begin with a design discussion.

[omarchy-shell]: https://github.com/omacom/omarchy/blob/quattro/docs/omarchy-shell.md
[plugin-installation]: https://github.com/omacom/omarchy/blob/quattro/manual/32-shell-plugins.md#adding-a-plugin-from-git
[shell-ipc]: https://github.com/omacom/omarchy/blob/quattro/docs/omarchy-shell.md#ipc

```bash
./dev backend    # build the private backend for development
./dev run        # build and print shell environment/start instructions
make app-build   # build the standalone backend and Qt host
make app-run     # build and launch the standalone app from source resources
make validate    # node tests, source regressions, QML tests, qmllint, manifest
```

`make app-build` needs Rust, CMake 3.21 or newer, and Qt 6.5 or newer. On Linux, the Qt DBus development component is also required. It builds the backend with `--no-default-features --features standalone`, so the resulting process has no AI worker surface. `make app-run` sets only the development resource and bundled-backend overrides needed to run that build.

`make validate` needs `node`, `python3`, Qt 6 QML test tooling (`qt6-declarative` on Arch, `qt6-declarative-dev-tools` and `qml6-module-qttest` on Debian and Ubuntu) and the `omarchy` CLI. It has to be green before you open the pull request, and green on your machine — nothing in CI runs it for you. Standalone changes must also pass `make test-app-qml` locally.

Linux verification satisfies contributor and reviewer platform-testing requirements. Testing on macOS or Windows is optional; reviewers must not request it as a prerequisite or block a PR because those local or hands-on results are absent. Required automated CI still needs to pass, including its native platform jobs described in [Backend runtime](docs/BACKEND-RUNTIME.md#standalone-security-gates). Report the platform actually tested without claiming verification on others.

Contributors are not required to test anything by hand. Use reproducible automated checks and generated visual evidence appropriate to the changed behavior. If verification is missing, the review comment must identify the specific behavior, expected result and automated test or evidence to add, so the contributor's agent can address it.

## How the change gets made

In this order, and none of the steps fold into each other:

1. **Implement it.** One change, finished — not a sketch with the hard half
   left for review to find.
2. **Verify the changed behavior.** Run `make validate`, confirm any bug regression fails against the unfixed behavior, and use automated interaction or integration checks where needed. Follow [testing standards](docs/TESTING.md) to decide whether to extend an existing test, add one or rely on existing coverage. Record results for the submitted revision; rerun affected checks after review fixes.
3. **Have a fresh agent review it.** Open a *new* agent — an empty context,
   nothing of the conversation that wrote the code — hand it the diff and
   `AGENTS.md`, and ask it to find what is wrong. The agent that wrote a patch
   is the worst reviewer of it: it already believes the reasoning, so it reads
   the code it meant to write. Fix what the review finds, or write down why it
   is not a fault.
4. **Then open the pull request.**

## Tests

A test earns its place by catching a meaningful failure, not by accompanying every changed line. Read [Testing standards](docs/TESTING.md) before adding, changing or reviewing tests: it defines useful assertions, appropriate test boundaries and when to consolidate or remove coverage. Bug fixes need a regression that fails on the unfixed behavior; extending an existing test is preferred when it covers the same scenario. Documentation-only changes and low-risk mechanical edits do not need invented behavioral tests.

| What you changed | Where the test goes |
|------------------|---------------------|
| Rust rules or process/CLI behavior | Module tests in `src/` or integration tests in `tests/*.rs`, run by Cargo |
| Parsing, formatting, or a decision rule in `.js` | `ui/tests/test_*.js`, run by `node` — no compositor needed |
| A script in `scripts/` | `tests/test_*.sh` or `tests/test_*.py` |
| Focus, key routing, layout, or anything needing the QML engine | `ui/tests/qml/tst_*.qml`, run offscreen |
| Standalone host, adapter, packaging, or installer behavior | `app/tests/`, run locally on Linux |
| A rule that grep can enforce — no literal colours, no `LayoutMirroring` | `tests/test_source.sh` |

Verify that the runner discovers the new test, or register it in the Makefile, CMake or CI in the same commit. Assert the fault, not the spelling of the fix: for a bug regression, run it against the old behavior and report the observed failure in the pull request. Coverage counts and source-text matches do not establish behavioral correctness.

## If you touched the interface

- Follow the **omarchy-style** skill's guidance — Omamail is an Omarchy
  application before it is a mail client, and its look is not a matter of taste
  per pull request. If your agent does not carry that skill, take the existing
  components as the specification and change nothing about the visual language
  that the change did not require. [AGENTS.md's UI section](AGENTS.md#ui)
  gives the same rules where they are specific to this
  codebase, and `tests/test_source.sh` enforces the part of them that grep can.
- **Automate verification of the changed interaction.** Exercise the applicable mouse, keyboard, focus and state transitions with QML or host integration checks. Use generated captures to inspect layout in the relevant light/dark themes and compact/wide sizes. Component harnesses using production components are valid evidence for the behavior they exercise; request broader integration coverage only for a concrete gap they leave. Hands-on testing is optional.
- **Every UI change requires clear, detailed visual evidence.** Attach labeled before-and-after screenshots of every changed view and relevant state, captured at matching window dimensions, theme, and scale. Explain what changed and identify the platforms, themes, and sizes tested. Screenshots must be legible enough to evaluate the actual layout, labels, and states; update them whenever the UI changes.
- **Multi-stage or stateful workflows also require a detailed screen recording, including bug fixes to existing workflows.** Show the complete path from entry to result, including the relevant keyboard and mouse interactions and loading, empty, error, cancellation, or recovery states. Show observable side effects and retry invariants rather than only the final status: for an invitation-calendar change, record invitation import, update of the same existing event, and a failed save followed by calendar-only retry, with evidence that retry sends no second RSVP. Add steps or timestamps and expected results so maintainers can assess the interaction without installing or running the app. Screenshots alone are not sufficient for these changes.
- Identify the capture's host (Omarchy plugin, standalone app, or component/test harness), platform, UI commit, theme, dimensions and scale, plus the backend version, API revision and source commit when built locally. For mocked backends, identify the fixture contract/API revision and explicitly say that no real backend/provider ran. Label synthetic component recordings and any fixture-only controls or side-effect counters; distinguish UI-flow evidence from real backend/provider verification. Automated screenshots and recordings are acceptable. Refresh affected recordings after interaction changes and verify uploaded attachments are accessible and decodable before requesting review or re-review.
- Use synthetic or redacted data in screenshots and recordings. Upload the evidence as PR attachments rather than committing it to the repository. Visual evidence complements regression tests; neither requires a contributor to operate the app by hand.

## The pull request

This document is the source of truth for commit and pull request guidelines. Read it before committing or creating, updating, reviewing, or requesting review of a pull request, including review follow-ups.

Keep runtime assets, source, tests and maintained documentation in the tree, and planning notes outside it. Tracked files must stay under 128 KiB. Markdown prose uses one source line per paragraph.

**One change per pull request.** A refactor travelling with a bug fix makes the
fix impossible to review and impossible to revert on its own.

**The title is the commit message.** Merges here are squashes, so the title you
write becomes the line in `git log` with `(#123)` appended, and it is read by
people looking for when something changed. Write a sentence in the imperative,
sentence case, naming what is different afterwards — no `fix:` or `feat:`
prefix:

```
Fix MIME decoding for bodies declared as UTF-8
Fix Exchange junk folder lookup using its declared name
Add an action to save an attachment
```

Not `fix imap bug`, not `Update ImapClient.qml`.

Commit and PR titles name the concrete machinery and action: use `Fix ` for bugs, `Add ` for features, otherwise an accurate imperative. Choose a scope prefix from the final change: `ai: ` for AI changes, `docs: ` for repository documentation, `website: ` for the website, and `chore: ` for repository maintenance such as release workflows, CI, builds, dependency upkeep and developer tooling. Other changes have no scope prefix. For mixed changes, choose one prefix from the primary outcome: a release-flow PR with README cleanup uses `chore: `, for example `chore: Fix backend release ordering with a single release PR`. These rules also apply to individual commit subjects.

Reconcile the title and description with the complete final diff whenever scope changes. Describe shipped behavior, architectural reasons and verification actually performed.

**The body is prose, with two headings that are read by a machine.** Say what
was wrong and why this is the fix; a paragraph of reasoning is worth more than
a bulleted diff summary, and the surprising part is the part to spend words on.
Then:

````markdown
## Verification

`make validate` green. `tests/test_message.js` covers the 8-bit body with an
accent in it, and fails with the change reverted. An automated rendering
fixture confirms the French subject displays correctly.

## Release Notes

- Accented characters in message bodies no longer render as mojibake.
````

`## Verification` names the commands you ran and what they said. Measured, not
inferred: "should work" is not verification, and neither is a test you did not
watch fail. Four things belong in it, and a reviewer will ask for any that is
missing:

- `make validate`, and that it was green on the commit you are sending.
- For a bug fix, the new or extended regression and its observed failure against the unfixed behavior. Otherwise, name the applicable existing checks; do not add a test merely to fill this item.
- The relevant automated behavior checks and visual evidence, with provenance required under [If you touched the interface](#if-you-touched-the-interface).
- That a fresh agent reviewed the diff, and what it found. "Nothing" is an
  answer; not having asked is not.

`## Release Notes` is lifted verbatim by `scripts/release-notes.sh` into the
GitHub release for the version that ships it — the heading is matched exactly,
so spell it that way. Write the bullets for somebody reading a changelog, in
terms of their mail, not the code: what they could not do before and can now.
Leave the section out only when nothing a user can see changed — a test, a
document, an internal rename.

## Review

Draft pull requests are not reviewed or approved. The failing-test-only draft described above is a way to preserve a reproducible report; mark a completed change ready for review when it has the required implementation and evidence.

Review existing-functionality bug fixes, small fixes, wording corrections, and performance improvements first. A reviewer may approve a reasonable, focused, low-risk change that preserves product intent once the current diff and discussion have been checked, the relevant tests and required checks pass on the latest revision, and the affected security boundaries satisfy [AGENTS.md](AGENTS.md). Missing verification must be reported, not inferred from an earlier green commit.

Judge product and interaction design independently of implementation quality: necessity, fit with existing workflows, discoverability, keyboard/focus behavior, defaults, and relevant loading, empty, error and cancellation states. Consider simpler alternatives and interface or maintenance cost when they affect the recommendation. Correctness, tests, performance and affected security boundaries remain requirements; passing checks alone does not justify expanding the product.

Routine improvements within existing functionality do not need a separate product-direction decision. This includes focused bug fixes, small workflow refinements, wording, performance, text selection/copy, focus recovery and minor layout or spacing tradeoffs. Several reasonable implementation or UI choices do not by themselves make a change fundamental. Review the actual behavior, conflicts, regressions and applicable evidence before recommending approval; identify concrete gaps in automated or visual evidence rather than demanding hands-on testing.

Large new capabilities or workflows, new providers, substantial architecture changes and integrations beyond the project boundary require explicit product confirmation from a maintainer. Tag @huacnlee or @klaudworks with the focused decision question; either may confirm the direction. Resolve explicit maintainer objections before proceeding. Scope acceptance never waives correctness, security or the verification requirements above.

Keep review summaries easy to act on, using **Status → Summary → Findings → Next step**. State whether this is a request for missing information or a completed review. Explain the user-visible change, who benefits and the recommendation, then give the actual findings in plain language. The next step names who should act, what they should do and what result or evidence to report. Prefer a short paragraph or a few bullets; group related requests and link evidence when it helps resolve a finding. Omit passed CI/check summaries already visible in the PR. Keep detailed investigation in logs or linked code rather than repeating file inventories, every reviewed criterion, speculative alternatives or caveats that do not affect the decision. State the affected security result as required by [AGENTS.md](AGENTS.md#security), and retain limitations that materially affect the recommendation. These priorities also apply when recommending deferral or skipping a review.

Make missing-verification requests actionable by the contributor's agent: name the scenario, the observable assertion or capture needed and where the result should be reported. For example, ask for an automated selection → copy → Escape regression that asserts clipboard contents and restored focus, rather than asking someone to test the app manually. Inspect existing coverage first and request only the uncovered behavior.

An approval is not permission to merge: maintainers make the final merge decision, and automated reviewers must never merge.

Answer a review comment by changing the code or by saying why the change would
be wrong, and re-run `make validate` after every round — a fix made under
review is a change like any other. Both answers are useful; silence and a
force-push are not.

If an agent wrote the patch, you are still its author: read the diff before you
send it, and be able to explain any line in it.

## Releasing

A release is one command, run on a clean `main` that matches `origin/main`:

```bash
make publish VERSION=0.11.0
```

The command requires a clean main synchronized with origin and an authenticated `gh`. It creates `release/0.11.0`, updates `Cargo.toml`, `Cargo.lock` and `manifest.json`, pushes that branch and opens one PR. Without `VERSION`, it increments the patch version. It never pushes main or creates a tag locally.

The branch push triggers **Release**. CI tests and builds both native backends, creates the tag and GitHub release, downloads and verifies the published assets, then updates `backend-version` and the released API contract in the same PR. The required backend gate blocks that PR until the new pin is present and the actual released binaries pass. Review and merge the completed PR once; version metadata and the backend dependency reach main together.

- Keep main's ruleset active without an always-on bypass. Every update, including a release, goes through a PR; the administrator's PR-only bypass is not part of the release workflow.
- Never tag by hand or delete an existing release tag to reuse its version. If publication fails, inspect the retained tag, draft or release and follow the recovery instructions before choosing a new version.
- Features may merge with one unreleased API step while checking the connected backend against their fixed minimum API revision. Publish a backend release to make that step available to users; the feature check remains valid after publication.
- If publication succeeds but the pin push fails, keep the published assets and recover the pin on the same PR after verification.

See [backend releases and recovery](docs/BACKEND-RUNTIME.md#release-before-pin) for the complete sequence and token requirements.
