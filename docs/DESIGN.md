# Omamail Interface Design

Omamail follows the Omarchy visual language and uses GPUI and GPUI Component as its default product and interaction design model. Their principles apply unless a mail-specific, Qt, or shell constraint gives a concrete reason to adapt them. This document defines that translation and the detailed behavior of the window; it does not make the application look like GPUI Component.

The upstream reference is [GPUI Component Design Guides](http://longbridge.github.io/gpui-component/docs/design-guides). Read it as the general design standard; this document records Omamail's mail-specific application, Qt and shell constraints, and Omarchy visual boundary. Do not duplicate the entire upstream guide here: keep shared principles there and document only the interpretation or exception that future Omamail work needs.

## Design character

Omamail is a compact, keyboard-capable desktop mail client. It should feel like part of the shell rather than a web application placed inside it:

- dense enough to scan quickly;
- quiet enough for the message to remain primary;
- explicit about state without depending on color alone;
- predictable under keyboard, pointer, and window resizing;
- native to the active Omarchy theme.

The screenshots in `preview.png` express the visual baseline: a narrow mailbox rail, a dense list, a generous reader, monospace typography, restrained rules, and controls that appear where their actions belong.

## What comes from Omarchy

All visual tokens come from the active Omarchy theme:

- foreground, background, accent, urgent/danger, and popup colors;
- font family and font scale;
- spacing and component dimensions;
- corner radius;
- normal, hovered, pressed, and selected fills.

Semantic colors originate in `App.qml` and travel through required component properties. Muted text mixes foreground toward background. Derived fills use the shared `Style` helpers or alpha from an inherited semantic color.

Do not import GPUI Component colors, shadows, radii, typography, sidebar width, or control decoration. A GPUI example may demonstrate an interaction contract; its pixels are not a design token for this application.

## What comes from GPUI and GPUI Component

Everything except visual styling is applicable as a design principle: task hierarchy, composition, state ownership, controlled values, stable identity, semantic actions and events, focus and keyboard behavior, overlays, measurement, scrolling, responsive layout, lifecycle safety, interface language, accessibility, error handling, and verification. The default is to translate the principle, not to decide whether it is worth learning.

In particular:

- actions are scoped by context;
- controls expose selected, disabled, and open state explicitly;
- compound components are assembled from small parts with clear roles;
- overlays are anchored to triggers and managed above clipped content;
- focus is captured, constrained where necessary, and restored;
- resizable groups preserve constraints and communicate size changes;
- stable identity keeps transient state attached to the same logical element;
- compound controls keep trigger, surface, state, and dismissal behavior coherent.

QML components should express those contracts in QML terms: properties, signals, bindings, and small JavaScript decision functions. A fluent Rust builder is not itself a pattern the interface needs to copy.

## Window regions

The window has a fixed hierarchy:

1. Header: identity, global search, refresh, and compose.
2. Body: navigation, collection, and content.
3. Status bar: sidebar control, synchronization/account state, notice, and contextual key hints.
4. Overlay layer: menus, account switcher, shortcut sheet, and other transient surfaces.

The header and status bar span the whole window so the body panes read as one application. Pane separators meet those bars rather than creating independent cards.

### Wide mode

The sidebar, list, and reader are visible together. The reader receives the remaining width after the navigation and list panes. The message list has a computed default width and may be resized.

### Medium mode

The sidebar collapses to an icon rail while list and reader remain visible. Labels return through tooltips and the explicit expand control. Collapsing changes information density; it does not change which mailbox is active.

### Compact mode

The sidebar becomes mailbox tabs above the list. The list and reader are separate navigation states. Opening a message replaces the list; going back returns to the same cursor and scroll context.

These are modes, not a continuously degrading desktop layout. A region that cannot remain useful at a width is recomposed instead of compressed into illegibility.

## Region constraints

Every major region defines three relationships rather than one arbitrary width:

- minimum: the smallest size at which its task still works;
- preferred: the comfortable starting size before the user expresses a preference;
- surplus: how it grows when the window has more room.

The navigation region remains subordinate, the message collection remains scannable, and the reader receives the surplus. A restored user split is clamped to the current window without overwriting the stored preference merely because this window is temporarily smaller. Hiding a region releases its whole allocation; the remaining regions fill the window with no invisible slot.

## Alignment spines

Each surface has a small number of shared alignment spines: the outer boundary, repeated content inset, text baseline, metadata lane, and trailing action lane. A heading, list row, skeleton, empty state, and footer at the same hierarchy level attach to the same relevant spine instead of inventing their own margins.

Repeated rows reserve stable lanes for icons, labels, counts, time, badges, and actions when comparison matters. Optional content does not move the remaining text: an absent icon or action leaves its intentional lane, or the entire region consistently uses a layout without that lane. Indentation communicates real hierarchy and ends exactly when that hierarchy ends.

Text of different sizes aligns by baseline when it shares a row. Icons sit in a fixed slot so different path bounds do not move labels. Comparable numbers and times share a trailing edge. Hairlines belong to one boundary owner; adjacent panes do not each draw the same separator.

Equal edges and gaps are layout invariants. Verify their resolved bounds at representative window widths, body zoom levels, and display scales; do not approve alignment only by looking at a screenshot. Fix drift at the shared component, inset, or layout rule rather than adding unrelated one-pixel offsets to individual callers.

A scrollbar belongs to the viewport that scrolls and sits on that region's outer edge. Text and row padding live inside the viewport; they must not inset the scrollbar into the content column. When content needs clearance from the scrollbar, reserve it deliberately inside the content rather than moving the scroll owner.

## Sidebar

The sidebar is a compound component with four roles:

- application identity and collapse trigger;
- primary mailboxes;
- provider labels or folders;
- account identity and account menu trigger.

Expanded rows contain an icon, label, and optional suffix such as an unread count or visible key. Collapsed rows keep the icon and active state, while the label moves to a tooltip. The active mailbox uses fill plus persistent shape and text/icon treatment; unread additionally uses a dot and stronger weight.

The collapsed state is a user preference and survives the window. It is not inferred from temporary width except when the responsive mode removes the sidebar entirely.

Holding Alt reveals `1` through `0` on the same ordered rows those keys open. The visible hint and the action resolve from one data model. Pointer hover never changes the keyboard cursor.

Groups may scroll when provider folders exceed the available height, but the account footer remains reachable. Header, scrolling content, and footer are layout roles rather than arbitrary children; this mirrors GPUI Component's sidebar composition while retaining Omamail's compact geometry.

## Message list

The list is optimized for scanning. Each row establishes, in order:

- subject and time;
- sender;
- snippet;
- state and quick actions.

Unread state is redundant by design: dot, weight, and brighter subject. Hover is local visual feedback. Keyboard cursor and opened message remain separate states:

- `cursorId` says where the next keyboard action applies;
- `selectedId` says what the reader displays;
- hover says only that the pointer is over a row.

Selected and hovered fills extend to the list/splitter edge. Text padding is inside the row; viewport margins must not create a dead strip that breaks the relationship between row and reader.

Quick actions may appear on hover or selection, but their layout space should not make text jump. Right-click first establishes the action target, then opens the contextual menu. The menu remains associated with that message even if the list changes underneath it; if the message disappears, the menu dismisses rather than acting on a new row at the same index.

A critical or primary action cannot exist only on hover. Hover may reveal a faster pointer path for a secondary row action, but the same operation remains reachable through a visible command surface or the documented keyboard context. A compact row of hover icons must not replace an understandable primary action plus a menu for secondary commands.

Keyboard movement reveals the cursor with the smallest necessary scroll. It does not recenter every step and the pointer does not rewrite it when content moves below a stationary mouse.

## Reader

The reader is the content pane and receives the most flexible width. Its hierarchy is:

- subject and message-level state;
- sender, recipients, and time;
- notices and structured cards;
- message body;
- attachments;
- persistent message actions at the bottom edge.

Long-form body text follows the user's body font size and reader zoom. Chrome uses the smaller theme token. Reader zoom changes the message body, not the surrounding application.

A message can be read three ways, and the choice is the window's rather than the message's: it survives moving to the next message and closing the window, because how somebody reads their mail is a fact about them and not about the message that made them reach for the control.

Reading mode is what a message opens as. It is a rebuilt document, not a restyled one: headings, paragraphs, lists, quotes, links and small data tables in the window's own type, at a measure of sixty-five to seventy-five characters, centred in the pane when the pane is wider than that and filling it when it is not. Nothing of the sender's presentation is in it — no type, no colour, no width, no alignment, no table scaffolding — so every message reads the same way and looks deliberate rather than half-stripped. Original is the sender's own layout, sanitised, for the receipts and statements whose arrangement is carrying meaning. Plain is the text.

The three are named rather than iconed, because no drawing distinguishes them and telling them apart is the point. The chosen one carries the selected surface and a border, not a colour alone. A message that cannot be drawn the chosen way — too heavy to lay out, or with nothing readable in it — falls through to one that can and says so in a notice; the choice itself does not move, because it still stands for the next message. The two notices are not the same sentence: a message arriving as text nobody asked for and a message arriving in a layout unlike every other are different questions, and a reader told neither is left to wonder what broke.

Notices form a stack with one shared component contract. A notice explains a condition and may expose one immediate action. Structured content such as an invitation is a card because it adds actions and relationships not represented by ordinary prose; routine message metadata is not boxed merely to create visual variety.

Remote images remain blocked per message until requested. The visual treatment must make the blocked state and the scope of the action clear without making the notice compete with the message.

Bottom actions remain attached to the reader rather than the body scroll. They are available at a stable location and correspond to the current selected message. Destructive actions use the semantic danger role and an accurate label.

## Split panes

The visible separator is a hairline; the pointer target is wider. A precision line should not demand precision pointing.

For the list/reader split:

- the list begins at a proportional default;
- dragging creates a user-selected width;
- list and reader minimums are enforced together;
- the cursor changes across the whole hit target;
- double-click restores the proportional default;
- resizing the window may temporarily clamp the rendered width without replacing the stored preference;
- compact mode ignores the split without destroying it.

The handle should gain a subtle active treatment while dragged, derived from the theme foreground or accent. It must not introduce a permanent heavy bar.

If more resizable regions are introduced, they use one group model: axis, available size, pane constraints, adjacent redistribution, and a resize event. Nested groups remain possible, but the mail window should add them only for a real independent region, not for decoration.

## Buttons and action surfaces

Controls describe their role through semantic state:

- normal: available, not under pointer;
- hovered: pointer target is clear;
- pressed: activation is in progress;
- selected: a persistent state is on, or this trigger owns an open popup;
- disabled: visible but unavailable for a temporary reason;
- absent: the provider does not offer the capability.

Selected and pressed are not synonyms. A menu trigger stays selected from open until close even after the press has ended. A toggle uses selected for its value. A momentary action returns to normal.

Icon-only actions require tooltips. The tooltip describes the action and may include the shortcut when the shortcut comes from `Keymap.js`; it must not create a second hand-maintained binding description.

A control that opens another surface uses `...` in its label. An action that completes immediately does not. An external destination that is already unambiguous uses its proper name plus the suffix—`GitHub...`, not `Open GitHub...`—and may carry an external-link icon when space permits. Use a verb only when the destination name alone does not predict the result, such as `View invoice in browser...`.

## Menus

A menu is composed from a surface, rows, separators, optional labels, and submenus. Omamail currently needs rows and separators; future variants should extend the same contract instead of making another private `MenuRow`.

A menu row may have:

- a label;
- an optional leading icon or check state;
- an optional trailing shortcut or submenu indicator;
- enabled/disabled state;
- semantic tone;
- an activation signal.

Columns reserve shared space across the menu. If one item has a leading icon, all labels align as though that column exists. The same applies to trailing shortcuts. Separators divide action groups; they are not padding substitutes.

Menus follow these behavior rules:

- the trigger remains selected while its menu is visible;
- pointer and keyboard selection share one highlighted row;
- disabled rows are skipped by keyboard navigation;
- Up/Down move, Enter activates, Escape dismisses;
- selection begins at the first available item or the action-relevant item;
- activation dismisses before dispatching an operation that may change the underlying view;
- destructive actions are grouped and use the danger semantic role;
- unavailable provider capabilities are omitted rather than disabled;
- temporary unavailability may be disabled when its reason is apparent.

Menu labels describe the actual scope. `Mark these read` is correct when only loaded messages are affected. Brevity does not justify a broader promise.

## Popups and positioning

Contextual surfaces anchor to the control or row that caused them, not to an arbitrary pointer position unless pointer position is the semantic anchor of a context menu.

Placement follows one algorithm:

1. Open the popup so its contents are instantiated and measured.
2. Place it on the preferred side of the anchor.
3. If it overflows on that axis, flip to the opposite side.
4. Clamp to the far window edge.
5. Clamp to zero.
6. Repeat placement whenever the popup size changes.

For a button menu, the anchor is the trigger's edge from `mapToGlobal(0, 0)`. Where inside the control the pointer landed must not move the menu. For a row context menu, pointer position is acceptable because the requested context is spatial and the row itself may be much wider than the menu.

A popup declared outside clipped row content is not visually detached from its owner: the trigger's selected state and stable anchor establish that relationship.

## Overlays, modality, and focus

Use the lightest surface already supported by the application that preserves the task:

- menu: a short choice or command list tied to a trigger;
- popover: richer contextual content tied to a trigger;
- page: a substantial workflow that replaces the mail chrome while preserving the window;
- plain overlay: non-control content such as shortcut help where application actions remain meaningful.

Opening a text-entry surface changes the application key context, and that context focuses the meaningful field. A command popup focuses its content when it implements popup-local navigation under Qt Quick Controls.

Closing a non-popup surface lets the application's resulting key context choose focus. A `QQC.Popup` owns its Escape behavior because Qt consumes that key before the window shortcut map. The two paths must not duplicate each other.

Only the top visible surface receives pointer interaction. Non-modal popups dismiss on outside press. A plain overlay explicitly blocks or forwards pointer input according to its purpose.

## Search and text entry

Search occupies a stable, central place in the header. Focusing it changes the key context; bare mailbox shortcuts stop while text is being entered. Escape clears or leaves search according to the application's single `goBack()` order.

Placeholder text demonstrates query shape without masquerading as existing content. Search results keep the same list row and cursor model as a mailbox so actions behave consistently.

Text fields own typed characters, not application actions. Modified global actions that are valid in text-entry contexts remain routed through the central keymap.

## Settings and forms

Follow [Forms and settings](http://longbridge.github.io/gpui-component/docs/design-guides#forms-and-settings) for control choice, labels, help, validation, submission, and workflow sizing. In Omamail, an independent switch takes effect immediately; account and authentication work remain full pages. Privacy descriptions state what information leaves the machine, who receives it, and whether the choice covers one message, one mailbox, or every mailbox.

## Interface language

Follow [Interface language](http://longbridge.github.io/gpui-component/docs/design-guides#interface-language) for terminology, command labels, confirmation copy, capitalization, punctuation, errors, and localization. Omamail uses the user's mail vocabulary, keeps one term across every surface, and lets the surrounding mailbox or settings context remove redundant words without hiding an action's object, scope, or result.

Project-specific rules take precedence: use three periods in `Settings...`, `Edit...`, and other commands that open another surface or require more input; an immediate command has no ellipsis. Labels must describe their real scope—`Mark these read` does not claim to affect unloaded mail—and provider capabilities that do not exist are omitted rather than explained by a failing command.

## Status and feedback

The status bar answers three questions without opening another surface:

- Is synchronization current or working?
- Which scope or account is active when that is otherwise hidden?
- Which actions are immediately available in this context?

Transient notices replace secondary status content rather than stacking a new bar. They expire when the information is no longer useful. Errors that require action persist or lead to the relevant page.

Keyboard hints are generated from the same bindings that execute them. They are contextual and intentionally incomplete: the status bar shows the few actions useful now; the shortcut sheet shows the full map.

Loading preserves layout. Skeletons approximate the structure that will replace them so panes and scroll positions do not jump. Empty states explain what is empty and offer the next relevant action; they do not decorate an otherwise self-explanatory blank pane.

## Accessibility and input parity

Color never carries state alone. Active, unread, selected, destructive, and disabled states also differ through shape, icon, text, weight, or label.

Pointer targets are larger than fine visual marks. Keyboard navigation exposes where it will act. Focused text entry and application action contexts never silently overlap.

Every operation should have one semantic implementation even when several inputs reach it. Input parity does not require every gesture to exist on every device; it requires the operation to remain reachable and to produce the same state transition.

Sender-controlled strings always render as plain text outside the sanitized message body. This is both security behavior and interface behavior: a subject that resembles markup is still a subject.

## Applying these rules

When designing or reviewing a component, ask in order:

1. Which application or domain state does it display?
2. Which state does it own only for the current interaction?
3. What semantic intent does it emit?
4. Which context receives keyboard actions?
5. What happens when it opens, closes, resizes, or loses its anchor?
6. How does it behave in wide, medium, and compact modes?
7. Which theme tokens does it receive from `App.qml`?
8. Is every sender-controlled string plain text?
9. Can its decisions be tested without rendering, and which Qt behavior still needs a QML test?

A design that cannot answer these questions is not ready to become a reusable primitive. A feature-specific view may remain specific; clarity is more useful than an abstraction whose name is generic but whose contract knows one caller.
