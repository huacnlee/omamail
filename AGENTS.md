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
| Adding, changing or reviewing tests | [docs/TESTING.md](docs/TESTING.md) |
| Writing issue reports, PR descriptions, reviews or discussion comments | [CONTRIBUTING.md — Write for people](CONTRIBUTING.md#write-for-people) |
| Before making a commit or creating, updating, reviewing or requesting review of a pull request, including review follow-ups | [CONTRIBUTING.md](CONTRIBUTING.md) — mandatory; the single source of truth for commit/PR guidelines and evidence requirements |

## Structure and boundaries

- Group by module, not file type. The app is TSX on NSH: features in `src/features/`, domain logic in `src/mail/`, keys in `src/keys/`, the window shell in `src/shell/`, and the styled `ui` layer (tokens and controls every feature builds from) in `src/ui/`. The mail library is Rust in `core/` (CLI in `core/src/cli/`, dispatch in `core/src/backend/`); the NSH native module is `ext/omamail-native/`. `omarchy/` holds only the Omarchy notice widget and release tooling.
- Rust owns mail business logic and durable agent jobs. TSX owns presentation and interaction state and reaches Rust only through `src/backend/client.ts` (the `omamail-native` module), never by invoking CLI commands. See `docs/NSH-PORT.md` and `docs/ARCHITECTURE.md`.
- Tests live next to their modules: `*.test.ts(x)` beside the TSX (`nsh test`), Rust unit tests in their modules, Rust integration tests in `core/tests/`. Read component props and signals in JSX or closures; types come from `.nsh/types`, never by analogy.
- Features import controls from `src/ui`, never from `nsh/base` directly, and draw only with theme tokens.
- `omarchy/notice/` is the only QML left: a bar widget for existing Omarchy installs and its helper `omamail-app.sh`. Keep the helper's commands fixed and its tests (`make -C omarchy test lint`) passing.

## UI

- Follow [docs/DESIGN.md](docs/DESIGN.md). Colors come from theme tokens (`src/ui/tokens.ts`: `FILL`, `LINE`, `TEXT`); no raw colors in features. The Omarchy theme is followed through nsh-omarchy. Provider artwork retains its original colors.
- Sender-controlled labels render as plain `Text`. Message bodies are sanitized in Rust (`core/src/message/html`) and drawn from that tree (`src/mail/message/html.ts`); never fetch remote message resources directly.
- Never convey state by color alone. Use accurate labels; suffix actions that open another dialog/page/browser/terminal workflow with `...`.
- An open popup keeps its trigger selected and anchors to the control's edge, not the pointer; build popups from `src/ui` (`Popover`, `Menu`), never from a bare view.
- Keep content direction separate from interface layout.

## Backend compatibility

- The NSH app links `core/` in process through `ext/omamail-native`, so app and backend always build together: no binary pin or API handshake between them.
- `core/backend-api.json` is the method inventory of the JSON-RPC API (`omamail serve`, the agent and MCP entry points); its Rust test fails when a method is added or removed without it. Version numbers live in `nsh.json`, and `make publish` keeps `core/Cargo.toml` and `manifest.json` in step.

## Security

- Treat mail, server responses, URLs, filenames and persisted settings as untrusted. Validate at the consuming boundary; encoding is not sanitization.
- Keep credentials out of argv, logs and world-readable settings. Use synthetic credentials and controlled targets for tests.
- Preserve account/draft ownership, human approval of AI proposals, and normal outbox dispatch. Model text must not supply routing or permission to send mail.
- Every review states **Security: PASS / BLOCK / NOT VERIFIED** for the affected boundaries. Missing evidence or a security failure blocks approval/release. Security regressions must verify the forbidden effect did not happen, not merely that an error was returned; follow `docs/SECURITY-BOUNDARIES.md`.

## Review priorities

Start with [CONTRIBUTING.md — Review](CONTRIBUTING.md#review) for scope decisions, review priorities and comment style. Use this file's task index to read only the domain guidance relevant to the change. Product, design and verification requirements belong in their source documents rather than being repeated in reviewer prompts.

## Releasing and verification

- Run `make validate` (`nsh check`, the key and native-member drift checks, `nsh build`, `nsh test`) after TSX or behavior changes; `cargo test` in `core/` for Rust changes; `make -C omarchy test lint` for the notice widget, the installers and the release tooling.
- `make publish VERSION=x.y.z` opens a release PR; its branch push runs `release.yml`, which packages macOS (arm64), Linux (x86_64) and Windows (x86_64) with `nsh package`, signs `latest.json` for the in-app updater with the `NSH_UPDATE_KEY` secret, and publishes. Run `release.yml` by hand with `dry_run` to prove a release change before merging it. Never push main directly; tags alone do not publish.
- The update key's public half is `nsh.json`'s `updater.publicKey`. Changing it, the app id, or the archive names (`Omamail-<version>-<os>-<arch>`) strands installed copies: they refuse or cannot find the next update.
- Preserve `omarchy/scripts/release-notes.sh` aggregation of PR release-note sections; GitHub-generated notes are not a substitute.
