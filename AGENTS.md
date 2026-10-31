# Repository working agreements

## Required reading by task

Read the relevant document before changing its area; these contain constraints that are easy to miss in the code.

| Area | Required reading |
| --- | --- |
| Keyboard, focus and navigation | [docs/KEYS.md](docs/KEYS.md) |
| Provider adapters, capabilities and account identity | [docs/providers/README.md](docs/providers/README.md) |
| HEY | [docs/providers/hey.md](docs/providers/hey.md) |
| IMAP, SMTP and Proton Bridge | [docs/providers/imap.md](docs/providers/imap.md) |
| JMAP discovery and streaming | [docs/providers/jmap.md](docs/providers/jmap.md) |
| Microsoft 365 over Graph | [docs/providers/m365.md](docs/providers/m365.md) |
| Message HTML, images, direction and outgoing MIME | [docs/MESSAGE-RENDERING.md](docs/MESSAGE-RENDERING.md) |
| Network requests, credentials, subprocesses and security reviews | [docs/SECURITY-BOUNDARIES.md](docs/SECURITY-BOUNDARIES.md) |
| Backend APIs, binary pins and releases | [docs/BACKEND-RUNTIME.md](docs/BACKEND-RUNTIME.md) |
| Before making a commit or creating, updating, reviewing or requesting review of a pull request, including review follow-ups | [CONTRIBUTING.md](CONTRIBUTING.md) — mandatory; the single source of truth for commit/PR guidelines and evidence requirements |

## Structure and boundaries

- Group by module, not file type. Rust lives in `src/`, CLI handling in `src/cli/`, and dispatch in `src/backend/`. QML and its JavaScript live together under `ui/`. Rust unit tests live with their modules; UI tests live in `ui/tests/`; integration tests live in `tests/`.
- Rust owns mail business logic and durable agent jobs. QML owns presentation and interaction state, communicating with the persistent backend over stdin/stdout rather than invoking CLI commands. See `docs/BACKEND.md` and `docs/ARCHITECTURE.md`.
- QML JavaScript libraries start with `.pragma library` and use `var` and `function`, not `const`, `let`, arrows or template literals. Put testable presentation rules there. Tests load module paths, e.g. `load("cache/Cache.js")`; `ui/tests/load.js` resolves QML `.import` chains.
- A list or object received through a `var` signal argument (on Qt 6.12) or a delegate's `modelData` is a sequence or reference object, not a JavaScript array or object: `Array.isArray` says no and its keys come back sorted. A receiver that judges such a value, keeps it or writes to it takes `Plain.plain` (`ui/backend/Plain.js`) of it first; `ui/tests/qml/tst_signal_lists.qml` shows the pattern.
- List new QML files in the Makefile's lint inputs and import other modules explicitly.
- `Service.qml` is shell-constructed and must declare no required properties. The shell injects only `shell`, `manifest`, `pluginRegistry`, and `barWidgetRegistry`; settings arrive through the bar widget's `applySettings`.

## UI

- Use the active Omarchy theme. Pass semantic colors from `App.qml` as required component properties; derive variants with alpha or `Style.normalFillFor` / `hoverFillFor` / `selectedFillFor`. Secondary text mixes foreground toward background, never `Qt.darker`. Provider artwork retains its original colors.
- Render sender-controlled labels with `Text.PlainText`, never `AutoText`. Rich message bodies go through the sanitizer. Do not fetch remote message resources directly through Qt.
- Never convey state by color alone. Use accurate labels; suffix actions that open another dialog/page/browser/terminal workflow with `...`.
- An open popup keeps its trigger selected. Anchor to the control's edge, not the pointer. Place after opening and on height changes; on overflow, flip, clamp to the window, then clamp to zero.
- Keep content direction separate from interface layout; no `LayoutMirroring`.

## Backend compatibility

- `backend-version` is the plugin's exact binary pin, independent of Cargo's development version. Never substitute main/latest or a PATH binary. Keep both exact-version and API handshake checks; missing `apiVersion` is allowed only for historical 0.9.0/API 1.
- New QML dependencies on methods, parameters, responses or error semantics require contract fixtures and an API revision exactly one past `releasedApiVersion`, named under `unreleased`. Gate each feature on its fixed minimum revision even after release. Internal Rust-only changes do not require a release.
- The Published backend gate exercises the actual pinned release with current QML codecs. Inventory checks and source fingerprints do not replace behavioral compatibility tests.

## Security

- Treat mail, server responses, URLs, filenames and persisted settings as untrusted. Validate at the consuming boundary; encoding is not sanitization.
- Keep credentials out of argv, logs and world-readable settings. Use synthetic credentials and controlled targets for tests.
- Preserve account/draft ownership, human approval of AI proposals, and normal outbox dispatch. Model text must not supply routing or permission to send mail.
- Every review states **Security: PASS / BLOCK / NOT VERIFIED** for the affected boundaries. Missing evidence or a security failure blocks approval/release. Security regressions must verify the forbidden effect did not happen, not merely that an error was returned; follow `docs/SECURITY-BOUNDARIES.md`.

## Review priorities

Start with [CONTRIBUTING.md — Review](CONTRIBUTING.md#review) for scope decisions, review priorities and comment style. Use this file's task index to read only the domain guidance relevant to the change. Product, design and verification requirements belong in their source documents rather than being repeated in reviewer prompts.

## Releasing and verification

- `make publish VERSION=X.Y.Z` prepares one versioned release PR from clean, synchronized main; without VERSION it increments the patch. Never push main directly. Release CI publishes and verifies immutable assets before updating the binary pin and folding API metadata on that same branch. Tags alone do not publish. Follow `docs/BACKEND-RUNTIME.md` for release and recovery details.
- Preserve `scripts/release-notes.sh` aggregation of PR release-note sections; GitHub-generated notes are not a substitute.
- Run `make validate` after QML or behavior changes. `make test` includes Rust, JavaScript, source regressions and QML tests. Inspect the Makefile for the current targets.
- QML tests and `qmllint` are local gates using the installed Qt; release CI uses `make test-js test-shell`. Unresolved `qs.Ui` / `qs.Commons` lint warnings are expected; the exit code is the gate.
