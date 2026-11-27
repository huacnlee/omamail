# Omamail Architecture

This document describes how Omamail is divided, where state belongs, and how components communicate. It is an engineering guide rather than a product specification. `SPEC.md` says what the product promises; `DESIGN.md` says how the interface behaves and is laid out; this document says which part of the program owns each decision. [NSH-PORT.md](NSH-PORT.md) records how the app was ported from the earlier Qt client and which differences are deliberate.

Except for visual styling, GPUI and GPUI Component provide the default architectural model for Omamail. Their principles of stable identity, explicit state ownership, contextual actions, controlled values, semantic events, composable parts, behavior/presentation separation, lifecycle safety, precise vocabulary, and testable decisions apply here unless an NSH or platform constraint proves otherwise. Omamail translates those principles into NSH components, props, reactive signals, and plain TypeScript modules rather than reproducing Rust APIs.

Use the [GPUI Component Coding Guides](http://longbridge.github.io/gpui-component/docs/coding-guides) for the full architecture, state, lifecycle, naming, API, and testing guidance. This document keeps the Omamail module mapping and the places where NSH, the platform, or the mail domain changes its application.

## Architectural position

Omamail is one stateful mail and calendar application: an NSH TSX app (`App.tsx`) over the Rust mail library in `core/`, which it links in process through the NSH native module `ext/omamail-native`. Its architecture has five layers:

1. The entry point (`App.tsx`) opens the window and starts the shell.
2. The shell (`src/shell/`) owns window regions, navigation, key dispatch, and top-level layout.
3. Domain modules own mail, provider, cache, message, and account decisions: in Rust under `core/src/`, and in TypeScript under `src/mail/`.
4. The ui layer (`src/ui/`) implements reusable controls, interaction primitives, and theme tokens.
5. Feature views (`src/features/<feature>/`) compose those controls and render data they are given.

Dependencies point down this list. A view may ask the application to perform an action, but it does not acquire provider knowledge or mutate storage on its own. A provider may normalize mail into the shared message resource, but it does not know which row, popup, or page is visible.

The visual system is separate from all five layers. Colors are theme roles from `src/ui/theme.ts` and `src/ui/tokens.ts`: Omamail's own light and dark palettes by default, or the active Omarchy theme through nsh-omarchy when the Omarchy mode is on. Features draw only with those tokens. GPUI Component supplies the architectural and interaction baseline, not the visual language.

## Entry point and window composition

`App.tsx` mounts one `Window` and renders `Shell` (`src/shell/Shell.tsx`) once the theme's color roles are ready. It also follows the Omarchy font settings and asks the backend to shut down when the app quits. There is no separate host per platform: the same TSX runs on Linux, macOS and Windows, and platform differences sit behind NSH and `ext/omamail-native`.

The shell slots each feature in through the one entry component its `index.tsx` exports (`MailboxSidebar`, `MessageList`, `Reader`, `ComposeSurface`, `CalendarView`, `SettingsPage`, `AccountSetup`, `AssistantDock`). It decides only where each sits and when it shows. The shell coordinates:

- which page or mailbox surface is active;
- which keyboard context owns the window;
- the dismissal order of pages, drafts, search, and popups;
- application-wide notices and the status bar;
- responsive composition of sidebar, list, reader, and pages.

The shell must not become the implementation of every one of those behaviors. It owns their state and policy; reusable mechanics belong in `src/ui/` or in testable TypeScript modules such as `src/shell/layout.ts` and `src/app/navigation.ts`. Composition ownership and implementation are not the same thing.

## Native and backend boundaries

The TSX reaches the mail library only through `src/backend/client.ts`. It sends the same JSON-RPC methods `omamail serve` answers, but in process: `ext/omamail-native` exposes `Backend.request`, `Backend.nextEvent` and `Backend.shutdown`, and `ext/omamail-native/src/worker.rs` runs the backend `Session` on one thread inside the backend runtime. There is no backend child process and no pipe. `client.ts` keeps the refusal after shutdown starts and the notification listeners (`on(method, fn)`); request deadlines are the backend's (`core/src/backend/rpc.rs`). The standalone `omamail` binary and its stdio service (`core/src/backend/stdio.rs`) remain for the CLI only; [BACKEND.md](BACKEND.md) records the method contract.

`ext/omamail-native` builds `core/` with its default features, so the `agent` feature is on. AI jobs run the app's own executable again as a worker: `ext/omamail-native/src/entry.rs` recognizes the worker subcommands before NSH starts, so no second binary is packaged.

Credentials cross the TSX/backend boundary through typed `credentials.get`, `credentials.put`, and `credentials.delete` methods. Rust validates the provider-specific key and secret bytes before calling Keychain, Secret Service, or Credential Manager. Secrets travel in the request body and must never be placed in argv, logs, settings, or notification routes.

All network access is in Rust (`core/src/providers/`, `core/src/public_http/`); the TSX makes no requests of its own. Cross-platform storage is owned by `core/src/platform/`: `dirs.rs` selects platform application directories, `private_fs/` supplies handle-anchored private files, and `ipc/` supplies Unix sockets or Windows named pipes for the outbox. Platform implementations must preserve the same refusal and deadline semantics even though their operating-system primitives differ. The app's own small files (such as `window.json` and `calendars.json`) are read and written through `Backend.readConfig` and `Backend.writeConfig`, which `core/src/platform/app_config.rs` restricts to known names.

New-mail notifications are decided in `src/features/list/store.ts` and shown through NSH's `Notifications`. Title and body are untrusted plain text. A pressed notification's id is parsed back into an account and a message, and both are checked against the loaded accounts before the window navigates.

## State ownership

Every mutable value has one authoritative owner. Other objects receive it as input and report intent through callbacks or method calls.

Use these lifetimes to choose that owner:

| Lifetime | Owner | Examples |
| --- | --- | --- |
| Installation or account | the Rust backend and its storage | accounts, credentials, cached messages |
| Across window openings | `src/app/prefs.ts` (`window.json`) and each feature's settings store | collapsed sidebar, pane widths, reading mode, reader zoom |
| Current window | `src/app/store.ts` and the navigation stack in `src/app/navigation.ts` | visible page, list cursor, open reader, compose |
| Feature data | `src/features/<feature>/store.ts` | loaded messages, the open message's body, a draft |
| Open interaction | the relevant popup or overlay component | popup selection, drag origin, submenu path |
| One rendering | the view | hover, pressed appearance, measured bounds |

A value moves to a longer-lived owner only when users have expressed a preference that should survive. It does not move merely because persistence is possible. Derived state is recomputed from its source (a `computed`) rather than stored beside it.

Stable identity matters wherever state outlives a render. A mailbox, message, menu item, popup, and resizable pane must have an identity based on what it is, not on the position at which it happened to render. This is the NSH equivalent of GPUI's `ElementId` and keyed state. An index is suitable only when ordering is itself the identity.

### Controlled state and feedback

Follow the Coding Guides' controlled-state and feedback-loop rules. In Omamail, props carry the owner's value and callback props (`onSelect`, `onOpenChange`, `onResize`) report user intent; synchronizing search text, selection, open state, or filters must not echo the owner value as a second user change. Treat a callback as re-entrant because it may switch the account, replace the list, close the popup, or unmount its sender.

## Actions and contexts

The keyboard architecture is the clearest GPUI-derived part of Omamail and is the model for other interactions.

- `src/keys/keymap.ts` declares actions, bindings, and the contexts in which they mean something.
- `src/keys/router.ts` binds every sequence that is live in the current context, and only those, so a key that does nothing reaches the focused control.
- `src/keys/commands.ts` lets features answer a binding id with `registerCommand` while they are mounted; the shell answers the navigation ids.
- `docs/KEYS.md` documents the model and the platform-specific exceptions. `scripts/check-keys.ts` checks its bindings table against the keymap.

An action describes intent, not an input device. `archive` is the same operation whether it came from `e`, an icon, or a menu row. Components emit intent; the application decides what the intent means in the current state. This prevents parallel mouse and keyboard implementations from drifting.

The context is the guard. Do not add a second collection of `enabled` tests in the key handler for conditions already expressed by the context. Capability is different: it comes from the active provider and decides whether an operation exists at all. A provider capability should remove an unavailable action from the view rather than offer an action that fails after activation.

Popups own their keys. nsh/base menus, popovers and selects handle their own navigation and close on Escape or a press outside, returning focus to the trigger. `src/ui/overlays-stack.ts` makes the newest open ui overlay take Escape first, and never while an input method is composing. The router's Escape only reaches navigation after `registerEscape` layers and open popups have had it. An application action may open a popup, but Back does not duplicate the popup's close policy. `src/ui/overlays.test.tsx` covers this boundary.

## Domain modules

Rust lives under `core/src/`, the native module under `ext/omamail-native/src/`, and the TSX under `src/`. Within each layer, modules are grouped by responsibility, not file type. In Rust, `core/src/cli/` handles headless commands, `core/src/backend/` dispatches JSON-RPC methods for both the app and `omamail serve`, and shared business modules such as `core/src/account/`, `core/src/providers/` and `core/src/message/` serve both. The TypeScript modules are:

- `src/mail/providers/` owns provider descriptions, sign-in, and account setup checks.
- `src/mail/list/providers/` owns each provider's mail client for listing, paging, actions and updates, over the backend.
- `src/mail/` (`accounts*.ts`, `mailboxes*.ts`, `labels*.ts`, `listModel.ts`, `listCache*.ts`, `unified.ts`, `batch.ts`) owns accounts, mailboxes, labels, the list's model and cache, and the combined view.
- `src/mail/calendar/` owns event sources, the range cache, and event reads and writes.
- `src/mail/message/` turns the backend's sanitized message into what the reader draws, and owns direction, unsubscribe, images and calendar parts.
- `src/mail/compose/` owns drafts, recipients, senders, the send queue and recovery.
- `src/mail/agent/` owns the AI assistant's job and proposal handling.
- `src/keys/` owns the action and binding declaration.
- `src/ui/` owns reusable controls and interaction primitives; `src/features/` owns feature views.

Mail fetching, updates, parsing, classification, organization and storage belong in the Rust library. UI decisions such as navigation and layout calculations stay in testable TypeScript modules; components bind state and render results. TypeScript tests sit beside their modules as `*.test.ts(x)` and run with `nsh test`; Rust unit tests sit in their modules, and integration tests in `core/tests/`.

Reusable behavior and presentation remain separate. Rust owns business decisions; TypeScript modules own UI decisions; components own NSH lifecycle and input mechanics. Feature views supply Omamail composition; `src/ui` carries the presentation.

Provider differences end at the provider boundary. Code above that boundary asks about capabilities and consumes the common message resource. It does not branch on provider IDs.

## Vocabulary is an interface contract

Follow the Coding Guides' vocabulary and API naming rules. Omamail keeps one canonical name for each mail object, command, and state across props, store fields, actions, sidebar rows, settings, menus, tooltips, notices, shortcuts, errors, and documentation. The project-specific distinction between `cursorId` and `selectedId` is load-bearing: the former is the keyboard position and the latter is the message shown by the reader.

Review terminology in the rendered surface beside neighboring labels, not as an isolated string. When a canonical term changes, search every interface surface and document that may use it.

## Components and primitives

Components come in two kinds.

### Feature views

Feature views under `src/features/` express mail concepts: `MessageList`, `Reader`, `MailboxSidebar`, `ComposeSurface`, and the account setup pages. They compose smaller parts, take semantic props, and report semantic intent.

A feature view may decide how a mail concept is presented. It must not copy a general interaction algorithm just because that algorithm is currently short.

### Interaction and layout primitives

Primitives in `src/ui/` express reusable behavior: buttons, menu rows, anchored popovers, dialogs, split panes, and similar mechanics. Features import them from `src/ui/index.ts`, never from `nsh/base` or nsh-omarchy directly. Their public contract should answer:

- What state is controlled by the caller, and what state is local?
- Which semantic inputs are required?
- Which user intents are reported?
- How are focus, dismissal, and geometry handled?
- What remains true when content size or window size changes?

A primitive should usually have controlled durable state and local transient state:

- the caller owns `open`, `selected`, active identity, and persisted size;
- the primitive owns pressed/hovered state, a drag's starting coordinates, and current measured geometry;
- the primitive reports `onSelect`, `onOpenChange`, `onResize`, or `onReset`, rather than reaching into application stores.

Required semantic props are preferable to hidden dependencies on shared stores. Components draw with theme tokens and do not look up mail services, account state, or sibling views on their own.

## Overlay architecture

Menus, the account switcher, the image viewer, and shortcut help all draw above the mail panes, but they do not share one implementation or input model.

The shell keeps one navigation history for the non-popup surfaces: a stack of entries in `src/app/navigation.ts`, held by `src/app/store.ts`. Its entries are the pages (list, calendar, reader, event detail, settings, provider chooser, setup form) and the overlays drawn over a page (compose, event composer, shortcut help). What shows is read off the top of that stack, and `back()` is the one way out. Popups (account switcher, labels, move, menus) stay outside the stack: each owns its close policy, placement, and popup-local keys. Feature views supply content and translate activation back into domain actions. There is no common overlay manager between them.

An overlay contract includes:

- the trigger or explicit anchor bounds;
- preferred placement;
- flip, window-edge clamp, then zero clamp;
- placement after opening and after content size changes;
- whether outside press dismisses it;
- whether it takes focus;
- initial focus and any focus restoration it performs;
- local keyboard navigation;
- a stable stacking order relative to the other surfaces in the window.

When a surface moves focus, its closing path must return control through the application's current key context rather than blindly focusing the item that used to be active. Where focus returns is not necessarily where an action should be dispatched.

Do not infer popup ownership from coordinates or visual ancestry. A popup may be declared outside clipped row content while still belonging to that row or its trigger. Its trigger remains selected for the popup's whole visible lifetime.

## Layout architecture

The window has three semantic regions: navigation, collection, and content. Responsive layout changes how those regions are composed, not what they mean.

- Wide and medium (the mail area at least 760pt wide): sidebar, message list, and reader are simultaneous panes. The sidebar folds to an icon rail when the user collapses it.
- Compact (below 760pt): mailbox tabs replace the sidebar, and list and reader become navigation states rather than squeezed panes.

Breakpoints are discrete modes. Components should not accumulate unrelated width tests. `src/shell/layout.ts` chooses the mode and the body (`modeFor`, `bodyFor`, `sidebarVisible`), and the shell passes the consequences down.

Resizable panes use the same conceptual split as GPUI Component:

- group state knows the axis, available bounds, pane sizes, and active handle;
- each pane declares minimum/maximum constraints and optional preferred size;
- each handle provides a forgiving hit target independent of its visible rule;
- dragging changes the two adjacent allocations while preserving the group total and respecting constraints;
- double activation may restore the computed default;
- persistence records a user-selected size, not a transient clamped size from a smaller window.

`SplitPane` and `SplitPanel` in `src/ui/SplitPane.tsx` implement this over nsh/base's resizable panels. The shell uses them for both the sidebar and the list/reader split, and stores the dragged widths through `src/app/prefs.ts`.

Layout state describes semantic regions and their allocation independently of the components that render them. When a region is hidden, the remaining visible regions consume the released space; an invisible pane must not leave behind a slot. Restoring it reapplies its preferred allocation subject to the current bounds.

This does not justify a general dock tree. Omamail has one known navigation/collection/content arrangement and a small set of responsive modes. A tree with tab groups, arbitrary nesting, drag-to-dock, registries, or layout normalization would model operations the product does not offer. Extract the invariant—visible panes fill the available layout—not the machinery built for an IDE workspace.

## Measurement and scrolling

Measurement is valid only for the conditions under which it was taken. Width-dependent content is measured at the actual viewport width, not at an unconstrained sample width. A change to viewport width, font metrics, body zoom, row content, or any other input to size invalidates the cached measurement that depended on it.

Every scrollable region has one owner. That owner fills the panel viewport and places its scrollbar on the panel edge. Content padding belongs inside the scroll owner; wrapping the viewport in padding moves the scrollbar away from the boundary and makes the layout hierarchy false. Avoid nested scrolling where one wheel event could plausibly belong to two regions.

## Rendering and security boundaries

Anything supplied by a sender is plain data unless it passes through the message-body renderer. Subjects, names, snippets, filenames, and labels render as plain `Text`. A reusable component cannot weaken that rule by interpreting markup in them.

The HTML sanitizer in `core/src/message/html/` is a security boundary, not a presentation helper. `reader.open` and `reader.render` return trees, never markup. `src/mail/message/html.ts` turns a tree into the document NSH's `TextView` draws, and checks every value again on the way out. The `TextView` never fetches: `src/features/reader/Body.tsx` draws a picture only from raster bytes already in the message. Approved remote images are requested with `public.image` and fetched by `core/src/public_http/`, which checks every DNS answer, connects only to the checked public addresses and never follows redirects; the bytes come back as validated `data:` URIs. One-click unsubscribe uses the same transport (`public.unsubscribe`). Nothing in this path runs a shell or a subprocess. Component extraction must not move any of those decisions into a reader view or a generic rich-text primitive. [MESSAGE-RENDERING.md](MESSAGE-RENDERING.md) and [SECURITY-BOUNDARIES.md](SECURITY-BOUNDARIES.md) hold the details.

Reading mode lives in the sanitizer for the same reason (`core/src/message/html/reader.rs`) and is a rebuild rather than a filter: it constructs a fresh document whose elements begin with empty attribute lists, and carries across only text, a checked `href`, a checked `src`, and numeric image dimensions capped to a small inline size. Fixed alignment and spacing the reader adds to its own compact avatar row carry no sender value. That is a structural guarantee rather than a list of removals, and it holds only while every element in the output is built there and every copied value is bounded where it is added. A resource-bearing attribute is refused before any appearance option is consulted, because no appearance option may buy a network request.

## Testing boundaries

Tests follow the ownership of behavior:

- TypeScript unit tests (`*.test.ts`) cover parsing, formatting, state transitions, constraints, and geometry decisions.
- Component tests (`*.test.tsx`, through `nsh/test`) cover focus, popup, shortcut, pointer, and lifecycle behavior in a running window. They run headless by default; files named `*-macos.test.tsx` cover behavior that needs the real platform and run with `nsh test --target macos` (headless runs skip their platform checks).
- Rust unit and integration tests (`cargo test` in `core/` and `ext/omamail-native/`) cover mail rules, the sanitizer, and the network and platform boundaries.
- `scripts/check-keys.ts` and `scripts/check-native-members.ts` check that the key table and the native module's members have not drifted.

A behavior discovered by running the app should be captured in a component test. A decision expressible without a window belongs in a TypeScript function and a unit test. Do not test the same decision indirectly through several views. [TESTING.md](TESTING.md) has the full guidance.

## Evolution rules

Architecture evolves by extracting proven repetition, not by building a general component library in advance.

1. State the invariant shared by at least two uses.
2. Move the decision into a pure TypeScript function when possible.
3. Give the primitive a semantic input/output contract.
4. Migrate one existing use and verify behavior.
5. Migrate the other use only when the contract still fits without feature flags that name its callers.

Do not make a primitive depend on mail stores, accounts, messages, or provider IDs. If it needs those concepts, it is a feature view. Do not introduce a generic abstraction whose options are merely the union of two unrelated components.

Likely candidates, when implementation work calls for them, are:

- one anchored popup placement rule shared by application and message menus;
- one menu surface, separator, and row contract;
- shared popup focus-return rules;
- shared selectable action surfaces for icon and text controls.

These are directions, not a requirement for an immediate rewrite.

## Translation boundary

Architecture and interaction principles transfer by default; runtime machinery transfers only through an equivalent Omamail need. Translate `Entity` ownership into the appropriate store, feature view, or component prop owner; translate semantic events into callback props; translate controlled values into a prop plus a requested-change callback; translate keyed identity into stable domain IDs; translate render-phase measurement into the point in NSH's layout where resolved geometry actually exists.

Do not create Rust-shaped TSX APIs or shadow facilities NSH already owns. GPUI-specific contexts, handles, and render/prepaint/paint phases explain the lifecycle problem but are not types this project needs to imitate. NSH's reactivity, focus, popup and lifecycle behavior remain authoritative for the implementation.

The same distinction applies to large feature systems. Dock's pure-data layout, canonical state, stable identity, and fill-after-removal invariants apply; a Dock tree, panel registry, arbitrary tab groups, tiles, and drag-to-dock editing do not exist until Omamail offers those product operations. Virtualization's separation of model coordinates, visible range, measurement, and row rendering applies; virtual-list machinery is introduced only when the loaded-message model needs it.

The visual exception is explicit. GPUI Component theme tokens, dimensions, cursor styling, animation curves, shadows, radii, and surface appearance do not transfer. Omarchy remains the visual authority.

## Commit design

Commits should preserve the reasoning that makes an architectural choice safe to change later. The best history in both Omamail and GPUI Component follows a consistent structure.

### Subject

Write an imperative, outcome-oriented subject. Describe what becomes true for the user or maintainer, not the file operation.

Good:

- `Keep the popup attached to the control that opened it`
- `Restore focus after the account switcher closes`
- `Share pane constraints between drag and restore`

Weak:

- `Refactor popup code`
- `Update Shell.tsx`
- `Add helper`

Conventional prefixes such as `fix:` or `docs:` are useful where the repository already uses them, but they do not replace a precise result.

### Body

Use the body to explain:

1. the previous observable behavior;
2. the cause or architectural mismatch;
3. the invariant chosen by the change;
4. important alternatives rejected and why;
5. verification actually performed;
6. known verification that could not be performed.

Prefer concrete evidence over generic claims. Include measured timing, window sizes, protocol requirements, platform behavior, or a minimal example when one of those caused the design. Explain surprising code close to the code as well; the commit records why the change happened, while the comment protects the invariant after the commit is no longer nearby.

A large commit may use short sections such as `Why`, `What replaces it`, and `Verification`. A small commit should remain prose rather than imitate a pull request template. Test lists distinguish passing automated checks, manual checks, and checks unavailable in the current environment.

Keep one architectural argument per commit where practical. A supporting fix belongs in the same commit when the primary change exposes it and cannot be correct without it; unrelated cleanup does not.

## Pull request design

A pull request title follows the GPUI Component form `<scope>: <Imperative outcome>`. The lowercase scope names the stable module or subsystem that owns the result; use `app` for one application-level change that honestly spans several UI modules. The outcome describes what the complete change makes true rather than the work performed or the file touched.

Derive the title from the final `base...HEAD` diff, not from the first commit. Later review fixes can change the actual scope, and a title that remains attached to the opening implementation gives reviewers the wrong boundary.

The description is a current explanation of the complete diff rather than a chronology. It covers the user-visible results, the architectural reason and invariants, and the verification actually performed. Rewrite it when later commits materially change any of those; do not append corrections to a stale description.

## Documentation source

Markdown prose uses one source line per paragraph. Do not hard-wrap prose to a column width. Use line breaks only for semantic structure such as headings, paragraphs, lists, tables, blockquotes, and code blocks.
