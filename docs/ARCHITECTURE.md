# Omamail Architecture

This document describes how Omamail is divided, where state belongs, and how components communicate. It is an engineering guide rather than a product specification. `SPEC.md` says what the product promises; `DESIGN.md` says how the interface behaves and is laid out; this document says which part of the program owns each decision.

Except for visual styling, GPUI and GPUI Component provide the default architectural model for Omamail. Their principles of stable identity, explicit state ownership, contextual actions, controlled values, semantic events, composable parts, behavior/presentation separation, lifecycle safety, precise vocabulary, and testable decisions apply here unless a Qt or shell constraint proves otherwise. Omamail translates those principles into QML properties, signals, JavaScript libraries, and Qt lifecycle rather than reproducing Rust APIs.

Use the [GPUI Component Coding Guides](http://longbridge.github.io/gpui-component/docs/coding-guides) for the full architecture, state, lifecycle, naming, API, and testing guidance. This document keeps the Omamail module mapping and the places where QML, Qt, the shell, or the mail domain changes its application.

## Architectural position

Omamail is a stateful desktop application hosted as an Omarchy shell plugin. Its architecture has five layers:

1. The shell entry points connect Omarchy to the application.
2. The window composition owns window state, navigation, action dispatch, and top-level layout.
3. Domain modules own mail, provider, cache, message, and account decisions.
4. Interaction and layout primitives implement reusable UI behavior.
5. Feature views compose those primitives and render data they are given.

Dependencies point down this list. A view may ask the application to perform an action, but it does not acquire provider knowledge or mutate storage on its own. A provider may normalize mail into the shared message resource, but it does not know which row, popup, or page is visible.

The visual system is separate from all five layers. Colors, typography, spacing, fills, radii, icons, density, and surface treatment come from the active Omarchy theme through `App.qml` and semantic component properties. GPUI Component supplies the architectural and interaction baseline, not the visual language.

## Entry points and window composition

The repository root contains only the QML entry points the shell loads:

- `Service.qml` is the long-lived application and account host. The shell constructs it, so it declares no required properties beyond what the shell supplies. It owns state that must survive the window.
- `BarWidget.qml` is the shell-facing trigger and settings bridge.
- `App.qml` composes the application window. It owns visible navigation, action dispatch, focus context, non-popup surfaces, and the arrangement of the major panes.

This composition boundary is shaped by the shell entry-point contract and Qt's focus and popup behavior. `App.qml` coordinates:

- which page or mailbox surface is active;
- which keyboard context owns the window;
- where the keyboard is parked when nothing accepts text;
- the dismissal order of pages, drafts, search, and plain overlays;
- application-wide notices;
- responsive composition of sidebar, list, reader, and pages.

`App.qml` must not become the implementation of every one of those behaviors. It owns their state and policy; reusable mechanics belong in components or testable JavaScript modules. Composition ownership and implementation are not the same thing.

## State ownership

Every mutable value has one authoritative owner. Other objects receive it as input and report intent with signals or method calls.

Use these lifetimes to choose that owner:

| Lifetime                | Owner                                   | Examples                                                    |
| ----------------------- | --------------------------------------- | ----------------------------------------------------------- |
| Installation or account | service/domain storage                  | accounts, credentials, cached messages                      |
| Across window openings  | `Service.qml` plus its store            | collapsed sidebar, reading mode, reader zoom, future persisted pane sizes |
| Current window          | `App.qml`                               | visible page, list cursor, open reader, compose mode        |
| Open interaction        | the relevant popup or overlay component | popup selection, drag origin, submenu path                  |
| One rendering           | the view                                | hover, pressed appearance, measured bounds                  |

A value moves to a longer-lived owner only when users have expressed a preference that should survive. It does not move merely because persistence is possible. Derived state is recomputed from its source rather than stored beside it.

Stable identity matters wherever state outlives a render. A mailbox, message, menu item, popup, and resizable pane must have an identity based on what it is, not on the position at which it happened to render. This is the QML equivalent of GPUI's `ElementId` and keyed state. An index is suitable only when ordering is itself the identity.

### Controlled state and feedback

Follow the Coding Guides' controlled-state and feedback-loop rules. In Omamail, QML property bindings carry the owner value and signals report user intent; synchronizing search text, selection, open state, or filters must not echo the owner value as a second user change. Treat a signal handler as re-entrant because it may switch the account, replace the model, close the popup, or destroy its sender.

## Actions and contexts

The existing keyboard architecture is the clearest GPUI-derived part of Omamail and is the model for other interactions.

- `keys/Keymap.js` declares actions, bindings, and the contexts in which they mean something.
- `components/KeyRouter.qml` turns that declaration into window shortcuts.
- `App.qml` dispatches action identifiers to application operations.
- `docs/KEYS.md` documents the model and the platform-specific exceptions.

An action describes intent, not an input device. `archive` is the same operation whether it came from `e`, an icon, or a menu row. Components emit intent; the application decides what the intent means in the current state. This prevents parallel mouse and keyboard implementations from drifting.

The context is the guard. Do not add a second collection of `enabled` tests in the key handler for conditions already expressed by the context. Capability is different: it comes from the active provider and decides whether an operation exists at all. A provider capability should remove an unavailable action from the view rather than offer an action that fails after activation.

Qt Quick Controls popups intercept keys before window shortcuts. That is a platform fact, not an exception to the architecture. Popup-local navigation therefore lives on the popup content item, and the popup owns its own Escape dismissal. An application action may open a popup, but `goBack()` does not duplicate the popup's close policy. The tests in `tests/qml/tst_popup_keys.qml` preserve this boundary.

## Domain modules

Modules are grouped by responsibility rather than language or file type:

- `providers/` owns service descriptions, authentication, protocol behavior, capabilities, and normalization into the shared Gmail-shaped resource.
- `account/` owns accounts, a mailbox, and list behavior after actions.
- `cache/` owns stored query results and message bodies.
- `calendar/` owns event sources, the range cache, and event reads and writes.
- `message/` owns parsing, sanitizing, calendar data, and other decisions about a message's content.
- `keys/` owns the action and binding declaration.
- `components/` owns views and reusable interaction primitives.

Rules that parse, format, choose, clamp, or otherwise decide belong in `.js` libraries whenever they can. QML binds state and renders results. This is more than a testing convenience: it keeps behavior independent of compositor and widget lifecycle, in the same spirit as separating GPUI entity state from an element's layout and paint passes.

Reusable behavior and presentation remain separate without introducing a framework layer merely to name that separation. JavaScript owns portable decisions and state transitions; QML components own Qt lifecycle and input mechanics; feature views supply Omamail composition; semantic properties supplied from `App.qml` carry the Omarchy presentation. This is the `gpui-base` and `gpui-component` seam expressed through the units this repository already has.

Provider differences end at the provider boundary. Code above that boundary asks about capabilities and consumes the common message resource. It does not branch on provider IDs.

## Vocabulary is an interface contract

Follow the Coding Guides' vocabulary and API naming rules. Omamail keeps one canonical name for each mail object, command, and state across QML properties, signals, actions, sidebar rows, settings, menus, tooltips, notices, shortcuts, errors, and documentation. The project-specific distinction between `cursorId` and `selectedId` is load-bearing: the former is the keyboard position and the latter is the message shown by the reader.

Review terminology in the rendered surface beside neighboring labels, not as an isolated string. When a canonical term changes, search every interface surface and document that may use it.

## Components and primitives

`components/` may contain two kinds of QML type:

### Feature views

Feature views express mail concepts: `MessageList`, `MessageReader`, `MailboxSidebar`, `ComposeView`, and account/setup pages. They compose smaller parts, expose semantic properties, and emit semantic signals.

A feature view may decide how a mail concept is presented. It must not copy a general interaction algorithm just because that algorithm is currently short.

### Interaction and layout primitives

Primitives express reusable behavior: icon buttons, menu rows, anchored popups, overlay surfaces, split handles, and similar mechanics. Their public contract should answer:

- What state is controlled by the caller, and what state is local?
- Which semantic inputs are required?
- Which user intents are emitted?
- How are focus, dismissal, and geometry handled?
- What remains true when content size or window size changes?

The desired direction follows GPUI Component's separation between a component and its state object without forcing a literal state-object API onto QML. A QML primitive should usually have controlled durable state and local transient state:

- the caller owns `opened`, `selected`, active identity, and persisted size;
- the primitive owns pressed/hovered state, a drag's starting coordinates, and current measured geometry;
- the primitive emits `activated`, `openRequested`, `dismissRequested`, or `resized`, rather than reaching into application objects.

Required semantic properties are preferable to hidden dependencies on `App.qml`. Theme values must be passed from `App.qml` when a component needs them. Components do not look up mail services, account state, or sibling views through object names.

## Overlay architecture

Menus, the account switcher, the image popover, and shortcut help all draw above the mail panes, but they do not share one implementation or input model.

`App.qml` states back-navigation precedence for the non-popup surfaces it composes. Each Qt popup owns its close policy, placement, and popup-local keys; each plain overlay participates in the application key context and `goBack()`. Feature views supply content and translate activation back into domain actions. There is no common overlay manager between them.

An overlay contract includes:

- the trigger or explicit anchor bounds;
- preferred placement;
- flip, window-edge clamp, then zero clamp;
- placement after opening and after content size changes;
- whether outside press dismisses it;
- whether it takes focus;
- initial focus and any focus restoration it performs;
- local keyboard navigation where Qt consumes window shortcuts;
- a stable `z` order relative to the other surfaces in the window.

When a surface moves focus, its closing path must return control through the application's current key context rather than blindly focusing the item that used to be active. Where focus returns is not necessarily where an action should be dispatched.

Do not infer popup ownership from coordinates or visual ancestry. A popup may be declared outside clipped row content while still belonging to that row or its trigger. Its trigger remains selected for the popup's whole visible lifetime.

## Layout architecture

The shell window has three semantic regions: navigation, collection, and content. Responsive layout changes how those regions are composed, not what they mean.

- Wide: sidebar, message list, and reader are simultaneous panes.
- Medium: the sidebar becomes an icon rail; list and reader remain panes.
- Compact: mailbox tabs replace the sidebar and list/reader become navigation states rather than squeezed panes.

Breakpoints are discrete modes. Components should not accumulate unrelated width tests. `App.qml` chooses the mode and passes the consequences down.

Resizable panes use the same conceptual split as GPUI Component:

- group state knows the axis, available bounds, pane sizes, and active handle;
- each pane declares minimum/maximum constraints and optional preferred size;
- each handle provides a forgiving hit target independent of its visible rule;
- dragging changes the two adjacent allocations while preserving the group total and respecting constraints;
- double activation may restore the computed default;
- persistence records a user-selected size, not a transient clamped size from a smaller window.

Omamail currently has one hand-built list/reader splitter. It is a valid specialization, but future split layouts should share the state and constraint rules rather than copy the drag handler.

Layout state describes semantic regions and their allocation independently of the QML objects that render them. When a region is hidden, the remaining visible regions consume the released space; an invisible pane must not leave behind a slot. Restoring it reapplies its preferred allocation subject to the current bounds.

This does not justify a general dock tree. Omamail has one known navigation/collection/content arrangement and three responsive modes. A tree with tab groups, arbitrary nesting, drag-to-dock, registries, or layout normalization would model operations the product does not offer. Extract the invariant—visible panes fill the available layout—not the machinery built for an IDE workspace.

## Measurement and scrolling

Measurement is valid only for the conditions under which it was taken. Width-dependent content is measured at the actual viewport width, not at an unconstrained sample width. A change to viewport width, font metrics, body zoom, row content, or any other input to size invalidates the cached measurement that depended on it.

Every scrollable region has one owner. That owner fills the panel viewport and places its scrollbar on the panel edge. Content padding belongs inside the scroll owner; wrapping the viewport in padding moves the scrollbar away from the boundary and makes the layout hierarchy false. Avoid nested scrolling where one wheel event could plausibly belong to two regions.

## Rendering and security boundaries

Anything supplied by a sender is plain data unless it passes through the specific message-body renderer. Subjects, names, snippets, filenames, and labels explicitly use plain text. A reusable component cannot weaken that rule by relying on `Text.AutoText`.

`message/Html.js` is a security boundary, not a presentation helper. The body cache keeps source content; the sanitizer decides what Qt may render; remote resource policy remains centralized. Approved remote images are collected from that same parse, fetched by `scripts/image-fetch.sh` without redirects and handed back as validated `data:` URIs, so Qt sees neither a pending remote source nor its broken loading placeholder. Component extraction must not move any of those decisions into a reader view or a generic rich-text primitive.

Reading mode lives there for the same reason and is a rebuild rather than a filter: it constructs a fresh document whose elements begin with empty attribute lists, and carries across only text, a checked `href`, a checked `src`, and numeric image dimensions capped to a small inline size. Fixed alignment and spacing attributes the reader adds to its own compact avatar row carry no sender value. That is a structural guarantee rather than a list of removals, and it holds only while every element in the output is built here and every copied value is bounded where it is added. A resource-bearing attribute is refused before any appearance option is consulted, because no appearance option may buy a network request.

## Testing boundaries

Tests follow the ownership of behavior:

- JavaScript unit tests cover parsing, formatting, state transitions, constraints, and geometry decisions.
- QML tests cover Qt-specific focus, popup, shortcut, pointer, and lifecycle behavior.
- source tests enforce structural and security invariants.
- `qmllint` and plugin validation cover integration with the actual component graph.

A behavior discovered by running Qt should be captured in a QML regression test. A decision expressible without Qt belongs in a JavaScript function and a node test. Do not test the same decision indirectly through several views.

## Evolution rules

Architecture evolves by extracting proven repetition, not by building a general component library in advance.

1. State the invariant shared by at least two uses.
2. Move the decision into a pure JavaScript function when possible.
3. Give the primitive a semantic input/output contract.
4. Migrate one existing use and verify behavior.
5. Migrate the other use only when the contract still fits without feature flags that name its callers.

Do not make a primitive depend on `service`, `mailbox`, `message`, or provider IDs. If it needs those concepts, it is a feature view. Do not introduce a generic abstraction whose options are merely the union of two unrelated components.

Likely candidates, when implementation work calls for them, are:

- one anchored popup placement rule shared by application and message menus;
- one menu surface, separator, and row contract;
- one split-group constraint model;
- shared popup focus-return rules where Qt permits them;
- shared selectable action surfaces for icon and text controls.

These are directions, not a requirement for an immediate rewrite.

## Translation boundary

Architecture and interaction principles transfer by default; runtime machinery transfers only through an equivalent Omamail need. Translate `Entity` ownership into the appropriate service, feature view, or component property owner; translate semantic events into signals; translate controlled values into property input plus requested-change output; translate keyed identity into stable domain IDs; translate render-phase measurement into the Qt lifecycle point where resolved geometry actually exists.

Do not create Rust-shaped QML APIs or shadow facilities already owned by Qt. GPUI-specific contexts, handles, and render/prepaint/paint phases explain the lifecycle problem but are not types this project needs to imitate. Qt popup key capture, focus scope behavior, object lifetime, and QML binding semantics remain authoritative for the implementation.

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
- `Update App.qml`
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

Prefer concrete evidence over generic claims. Include measured timing, window sizes, protocol requirements, Qt behavior, or a minimal example when one of those caused the design. Explain surprising code close to the code as well; the commit records why the change happened, while the comment protects the invariant after the commit is no longer nearby.

A large commit may use short sections such as `Why`, `What replaces it`, and `Verification`. A small commit should remain prose rather than imitate a pull request template. Test lists distinguish passing automated checks, manual checks, and checks unavailable in the current environment.

Keep one architectural argument per commit where practical. A supporting fix belongs in the same commit when the primary change exposes it and cannot be correct without it; unrelated cleanup does not.

## Pull request design

A pull request title follows the GPUI Component form `<scope>: <Imperative outcome>`. The lowercase scope names the stable module or subsystem that owns the result; use `app` for one application-level change that honestly spans several UI modules. The outcome describes what the complete change makes true rather than the work performed or the file touched.

Derive the title from the final `base...HEAD` diff, not from the first commit. Later review fixes can change the actual scope, and a title that remains attached to the opening implementation gives reviewers the wrong boundary.

The description is a current explanation of the complete diff rather than a chronology. It covers the user-visible results, the architectural reason and invariants, and the verification actually performed. Rewrite it when later commits materially change any of those; do not append corrections to a stale description.

## Documentation source

Markdown prose uses one source line per paragraph. Do not hard-wrap prose to a column width. Use line breaks only for semantic structure such as headings, paragraphs, lists, tables, blockquotes, and code blocks.
