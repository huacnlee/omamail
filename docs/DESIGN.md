# Omamail Interface Design

Omamail follows the Omarchy visual language and uses GPUI and GPUI Component as its default product and interaction design model. Their principles apply unless a mail-specific, NSH, or shell constraint gives a concrete reason to adapt them. This document defines that translation and the detailed behavior of the window; it does not make the application look like GPUI Component.

The upstream reference is [GPUI Component Design Guides](http://longbridge.github.io/gpui-component/docs/design-guides). Read it as the general design standard; this document records Omamail's mail-specific application, NSH and shell constraints, and Omarchy visual boundary. Do not duplicate the entire upstream guide here: keep shared principles there and document only the interpretation or exception that future Omamail work needs.

## Visual language v2: after NsVim

This section supersedes the older visual rules below wherever they conflict
(compactness, monospace everywhere, the Omarchy palette as the only palette).
The reference is NsVim (`~/work/nsvim`: `theme.json`, `src/controls.tsx`,
`src/settings/Settings.tsx`, `src/status-line.tsx`, `docs/media/*.png`).
Borrow its materials and proportions; Omamail stays a mail client.

### Themes

- **Default palette is Omamail's own**, modelled on NsVim's `editor` theme:
  - Dark "ink": background `#0E1016`, muted (sidebars, status line, deep wells) `#0A0C11`,
    surface-raised (hover, keycaps, table heads) `#151925`, border `#232838`, a stronger
    outer rule `#2E3448`, foreground `#D6DAE4`, muted text `#8B93A6`, faint `#7C8497`,
    primary `#6C9EFF` (hover `#8DB4FF`), on-primary `#0A0C11`, selection `#2A3150`,
    danger `#F2777A`, warning `#E5C07B`, success `#A7D46F`, violet `#C39BFF`, orange `#FFA266`.
  - Light "paper": background `#FAFAF7`, muted `#F0F0EB`, raised `#ECEDF2`, border `#D9DAE0`,
    foreground `#1F2330`, muted text `#5B6273`, primary `#2F5FD0`, selection `#D3DDF8`,
    danger `#B83A3E`, warning `#8A6200`, success `#39761D`.
- Settings → Appearance → Theme offers **System / Light / Dark / Omarchy**.
  - On an Omarchy desktop the default is Omarchy: it follows the desktop palette, as today.
  - Elsewhere the default is System, using the paper/ink pair.
  - Every role exists in all palettes. An Omarchy palette missing a role falls back to the
    nearest semantic role, never to nothing.

### Type

- **Interface and message text: a sans face** (`font-sans` = system UI sans).
- **Mono for measured and typed things**: key caps, times in the list, counts, version
  strings, addresses in technical contexts (`font-mono`).
  - On Omarchy, mono follows the desktop's `[font] family`.
  - `base-size` still scales everything (`uiScale`).
- **Ramp, at base 14**:
  - caption 12
  - body/chrome 13
  - list title 14
  - pane title 16
  - reader subject 20
  - message body 15 with 1.6 line height
- Headings get weight, not size; ligatures off in mono.

### Density: roomier than v1

v1 was too compact. Spacing follows a 4/8 scale with these defaults at base 14:

- Pane padding 16–24; settings content `px-6`, with sections 24 apart.
- Settings rows min 44 tall, title + description left, control right, a hairline under
  each row.
- List rows 72 (three lines with 6 between). Sidebar rows 32, with 12 inset.
- Toolbar and header 44. Status line 28.
- Control height 30 (small 26), horizontal padding 12. Menus: rows 30, padding 4, separators
  with 4 above and below.
- Dialog padding 24, with 16 between title, body and actions.

### Materials

- **Square corners**: radius 2px (`--radius`) for controls, panels and popups. No rounded
  pills.
- **Flat**: depth comes from the three ink steps and hairlines. Shadows only on popups.
- **Sidebars sit on `muted`** (deeper than content), with a hairline on their inner edge.
  The status line is on `muted` too.
- **Selection** is the item's own surface: the `selection` fill, a brighter foreground and
  semibold weight. **No leading-edge bar or one-sided border** (NSH Design Guides,
  "Interaction states": a bar is a web habit and adds a competing edge). Hover is
  `surface-raised`. Selected wins over hover. The keyboard cursor in a list is the selection
  (the cursor row draws the selected fill, `src/features/list/Row.tsx`).
- **Titled-border panels** (NsVim `Titled`): a 1px border with its title set on the top edge
  over a background knockout, offset 12, in caption size, muted text. Use them for grouped
  content that floats in a pane:
  - the invitation card
  - the assistant's proposals
  - settings previews
  - finder/picker overlays

  Use them instead of filled cards.
- **Section headings** in settings and menus: caption size, muted, sentence case, with
  space above. No uppercase tracking.
- **Segmented choices**: one outer border, hairlines between segments; the picked segment
  is filled with primary, on-primary text.
- **Choices are checkboxes, not switches** (square, primary when checked, a check glyph).
- **Steppers**: − value + inside one border.
- **Key caps**: mono caption on `surface-raised`, 1px border, 20 tall, min 20 wide. Use them
  in the status line hints, the shortcut sheet, menus and tooltips. The status line's caps
  are compact (`Kbd size="compact"`): 11pt on a 16 tall, min 16 wide cap, so they sit
  inside the 28 tall line with room above and below.
- **Status line**: 28 tall on `muted`.
  - At the left, a filled primary pill naming the current place (`INBOX`, `COMPOSE`,
    `SETTINGS`, `CALENDAR`), then the account.
  - At the right, key hints as key caps plus words.
- **Buttons**: primary is filled primary with on-primary text. Secondary is a bordered
  control. Ghost is text that fills `surface-raised` on hover. Danger is danger text, filled
  only when confirming.
- **Focus**: `focus-visible` only (never after a pointer press). Inputs draw a 1px primary
  border. A focused row or nav item draws a 1px primary ring inset on its own silhouette, and
  a row that is both focused and selected shows both. A ring must never read as a second
  selection: in navigation lists the keyboard moves the selection itself (roving focus), so a
  ring sits on a different item from the selection only while Tab is in transit.
- **One control per command**: a command has one visible home (plus its shortcut and menu
  entry). No duplicate toggles in two regions (e.g. the sidebar toggle lives in the header
  only; the status line shows no button for it).
- **Rows keep stable lanes** (Design Guides, "Alignment details"): trailing metadata (time,
  counts) ends on the pane's trailing spine; counts align to one trailing lane across all
  sidebar rows; a disclosure chevron sits in a leading slot, not after the count; names take
  the remaining width before truncating.
- **No reserved empty lanes for hover actions** (Design Guides, "Prefer command surfaces over
  hover toolbars"): row quick actions appear over the trailing metadata on hover/selection
  only, and every one of them is also in the context menu, the toolbar and the keymap.
- **Segmented control**: selected and unselected segments share the outer silhouette; the
  pick is a fill inside that silhouette, never an inset box with its own border.
- **Motion** is unchanged: colors fade 120–160ms (`cubic-bezier(0.16,1,0.3,1)`), content
  changes in the next frame, reduced motion is honored.

## Design character

Omamail is a compact, keyboard-capable desktop mail client. It should feel like part of the shell rather than a web application placed inside it:

- dense enough to scan quickly;
- quiet enough for the message to remain primary;
- explicit about state without depending on color alone;
- predictable under keyboard, pointer, and window resizing;
- native to the active Omarchy theme.

The visual baseline is a narrow mailbox rail, a dense list, a generous reader, monospace typography, restrained rules, and controls that appear where their actions belong.

## What comes from Omarchy

All visual tokens come from the active Omarchy theme:

- foreground, background, accent, urgent/danger, and popup colors;
- font family and font scale;
- spacing and component dimensions;
- corner radius;
- normal, hovered, pressed, and selected fills.

Semantic colors are theme roles. `src/ui/theme.ts` defines every role for each palette and fills the roles an Omarchy palette lacks from its nearest one; `src/ui/tokens.ts` names the classes features draw with (`FILL`, `LINE`, `TEXT`). Muted and faint text are roles of their own (`text-secondary`, `text-faint`), not colors a component mixes.

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

TSX components should express those contracts in NSH terms: props, signals, effects, and small pure decision functions (in `src/mail/` or beside the feature) that tests reach without rendering. A fluent Rust builder is not itself a pattern the interface needs to copy.

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
- provider labels or folders, A to Z;
- account identity and account menu trigger.

Expanded rows contain an icon, label, and optional suffix such as an unread count or visible key. Collapsed rows keep the icon and active state, while the label moves to a tooltip. The active mailbox uses fill plus persistent shape and text/icon treatment; unread additionally uses a dot and stronger weight.

The collapsed state is a user preference and survives the window. It is not inferred from temporary width except when the responsive mode removes the sidebar entirely.

Holding Ctrl reveals `1` through `9` on the same ordered rows Ctrl+1 to Ctrl+9 open (docs/KEYS.md; Ctrl+0 stays reset zoom). The visible hint and the action resolve from one data model. Pointer hover never changes the keyboard cursor.

Groups may scroll when provider folders exceed the available height, but the account footer remains reachable. Header, scrolling content, and footer are layout roles rather than arbitrary children; this mirrors GPUI Component's sidebar composition while retaining Omamail's compact geometry.

### NSH mailbox sidebar

The NSH sidebar lives in `src/features/mailbox/` and fills the pane the shell sizes and paints (184 pt at base 14, 140 to 360, the 44 pt rail when collapsed; the shell stores the collapse and draws the `muted` surface and the one inner hairline, so the sidebar view itself is transparent). Scrolling groups (mailboxes, then labels A to Z as a tree) and the footer (Calendar, then the account and its switcher trigger) are separate views, so the footer is reachable however many labels there are. The collapse toggle is the shell's, in the header, so the first row lines up with the list's first row. The open row is the selected fill plus foreground and bold text; a label whose menu is open stays selected. As in Qt, mailbox rows carry no count; a label with unread mail shows its count and bold text. Row digits follow docs/KEYS.md: holding Ctrl shows `1` to `9` on the rows Ctrl+1 to Ctrl+9 open, from the one slot list in `mailboxStore.slots()`. Label names are the server's and render as plain text.

Motion inventory (tokens from `src/ui/motion.ts`; every line is an instant change under reduced motion):

| State change | Tool | Tokens |
| --- | --- | --- |
| Collapse / expand the sidebar | The shell's `animateNextLayout` before the width change; rows swap label for tooltip in the same frame | `DURATION.normal`, `easeInEaseOut` |
| Pointer enters / leaves a row | `CLASS.wash` color transition on the `NavRow` fill | `DURATION.fast` |
| Open row changes | Fill and text weight transition, no slide | `DURATION.fast` |
| A label folds / unfolds | Chevron glyph swap; child rows enter and leave with the next layout | `DURATION.fast` |
| Ctrl held / released | Slot chips replace the count and fold chevron, fade in and out | `DURATION.fast` |
| Messages dragged over a target | Drop wash on the row under the pointer (`dropActive`) | `DURATION.fast` |
| A label's unread changes | Count changes, label weight swaps; on the rail the corner dot fades (`UnreadDot`) | `DURATION.fast` |
| Label menu, switcher popover | The `ui` `ContextMenu` / `Popover` popup motion (grows from its trigger) | `ui` popup tokens |
| Name prompt; Move to, Label as and label move (finder `Dialog`: titled frame, a Filter and a Results `FinderPanel` with "N / M") | The `ui` `Dialog` entry (`enterRise`) | `DURATION.normal`, `DISTANCE` |
| Picker cursor leaves the list's view | `reveal({ vertical: "nearest" })` on the cursor row | platform scroll |
| Compact tabs: selection moves | The `ui` segmented `Tabs` selection slide; the open tab is revealed in the sideways scroll | `DURATION.normal` |
| Label changed / failed | The `ui` `Toaster` and the status notice | `DISTANCE.toast` |

Behaviour is covered headlessly by `src/features/mailbox/Sidebar.test.tsx`; none of these lines has been seen in a running app yet, because screenshots need a real target and the tests' backend stand-ins run headless only.

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

### NSH message list

The NSH list is a virtualized `List` keyed by message id (`src/features/list/`). Cells are recycled, so a row keeps no state of its own: hover, cursor, selection and checks are read from `app` and the list store by id. Rows are ui's `ListRow` with `fixedHeight`: 72pt at base size 14, three lines 6 apart, scaled with Omarchy's base size. An empty snippet keeps its line, so the virtual layout never re-measures. Times and thread counts are mono (`TEXT.mono`); sender, subject and snippet are sans. As in Qt's MessageRow, the reader's row, the keyboard cursor, checked rows and the menu's row share one selected look: the `selection` fill with stronger text, and no left bar (v2). Hover is `surface-raised`, and selected wins over hover. Quick actions (archive, trash, star) appear on hover, cursor, selection or open menu, overlaying the trailing metadata; each is also in the row menu and the keymap. The batch bar is ui's 44pt `ActionBar`, and a load error with rows still shown is a danger `Notice` with Retry.

Motion inventory (tokens from `src/ui/motion.ts`; every line falls back to an instant change under reduced motion):

| State change | Tool | Tokens |
| --- | --- | --- |
| Pointer enters / leaves a row | `transition-colors` hover wash on the row fill | `DURATION.fast`, `EASING.standard` |
| Cursor or selection moves to a row | Fill color transition (selected fill), no slide | `DURATION.fast` |
| Quick actions appear on hover / cursor | Opacity transition of the overlay over the trailing metadata (no layout change) | `DURATION.fast` |
| Quick action press | Press scale from the `ui` `IconButton` | `SCALE.press` |
| Star toggles | Glyph swap (star outline / filled) with color transition | `DURATION.fast` |
| Unread changes (mark read / unread) | Dot fades, subject weight swaps | `DURATION.fast` |
| Rows removed by archive, trash, spam, move | `LayoutAnimation.configureNext` before the optimistic edit: rows below close the gap, removed row fades | `DURATION.normal`, `easeOut` |
| Failed action restores rows / undo | `LayoutAnimation` insert: rows open space, restored row fades in | `DURATION.normal` |
| A new view lists for the first time | Entry wave: the first 10 rows fade and rise once (`createMotion`), 40 ms apart; never on reloads or paging | `DURATION.normal`, `DISTANCE.toast` / 2 |
| Initial loading | Skeleton rows pulse (opacity 0.45 to 1, 900 ms), then the list replaces them | pulse only; no motion under reduced motion |
| Keyboard cursor leaves the viewport | `scrollToIndex` with the smallest scroll (`viewPosition` 0 or 1), animated | platform scroll |
| Load more footer | Button label swaps to a spinner icon while loading | `DURATION.fast` |
| Context menu opens / closes | The `ui` `ContextMenu` popup motion (grows from the pointer) | `ui` menu tokens |
| Undo / failure toast | The `ui` `Toaster` | `DISTANCE.toast` |

Deliberate difference from the Qt list: "Report spam" removes the row from every view but Spam (the Qt rule fell through and kept it in the Inbox until the next reload). A starred row at rest shows a quiet filled star (named "Starred") in the star's slot; on hover or cursor the star button takes its place, filled while starred. The row menu is a `ControlledContextMenu` held by the message's id, so a recycled cell never carries another message's menu.

Verification of each line is recorded in the list port report; lines not seen in a running app are reported as not verified.

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

Notices form a stack with one shared component contract. A notice explains a condition and may expose one immediate action, or two when they are narrower and wider answers to the same question: the blocked-images notice offers "Show images" for this message before "Always show" for every message. Structured content such as an invitation is a card because it adds actions and relationships not represented by ordinary prose; routine message metadata is not boxed merely to create visual variety.

Remote images remain blocked per message until requested. "Show images" loads them for the open message only and is forgotten when another message opens; "Always show" sets the standing preference that Settings revokes. The visual treatment must make the blocked state and the scope of each action clear without making the notice compete with the message.

Bottom actions remain attached to the reader rather than the body scroll. They are available at a stable location and correspond to the current selected message. Destructive actions use the semantic danger role and an accurate label.

### NSH reader

The NSH reader lives in `src/features/reader/`, and its message rules live in `src/mail/message/`. The body is one `TextView` given one of three documents.

- **Reading** is `reader.document`, serialised by `toHtml`. It uses the app's type at about seventy characters (`readingMeasure`) and is centred with `readingColumnOffset`.
- **Original** is the sanitised `document`, serialised the same way and capped at 800 points.
- **Plain** is a `TextViewDocument` built from text. Its markers become `omarchy-image:N` links and its public addresses become links.

`toHtml` is an allowlist serializer. It keeps structure and removes every attribute it does not name. An `img` survives only as raster bytes. A link survives only as `mailto:` or a public http(s) URL.

The TextView only reports links. Pressing a web link opens a confirmation that names the real address, and the link opens only after the confirmation is accepted.

Visual language v2 in the reader: the subject is `TEXT.subject` (20); the body is 15 on 24 (1.6) in the sans face, scaled by `uiScale` and the zoom (Original keeps 1.45); the page inset is 24 (12 in a narrow pane); the header's time is mono caption; the notices are ui's titled `Notice` (one component app-wide), the invitation and the agent's findings are `Titled` panels, not filled cards; the action bar is 44 with ghost buttons and the segmented mode control; the compact layout adds a 44 Back bar on top. While the body's zoom is not 100% the action bar shows it ("80%"), a ToolButton that resets it (as Ctrl+0 does); the zoom runs from 80% to 250%, a stored value under 80% (Qt's floor was 60%) read as 80%. The sender's layout tables (no header row, not a grid of numbers, or `role=presentation`) leave as their cells, each a block in the body's type; a table with a header row, a caption or numeric cells stays a table. `<small>`, `<sup>` and `<sub>` are 0.87 of the body, so they grow with it.

Zoom (Ctrl+= / Ctrl+- / Ctrl+0) changes the body's font sizes through `styles` and leaves the chrome alone. The mode, the zoom and the standing "Always show" answer persist in window.json under the Qt keys (`bodyMode`, `bodyZoom`, `alwaysShowImages`), written only by src/app/prefs.ts.

Motion inventory (tokens from `src/ui/motion.ts`). Under reduced motion, every line becomes an instant change.

| State change | Tool | Tokens | Reduced motion |
| --- | --- | --- | --- |
| A message opens (or the next one replaces it) | The page rises a few points and fades in (`createMotion().play(enterRise(4))`); the scroll returns to the top at once | `DURATION.normal`, `EASING.enter` | appears at once |
| Message loading | `ReaderSkeleton` bars pulse, then the body replaces them; header first when the list already knows the row | `PULSE_MS` | no pulse |
| A notice appears or goes (blocked images, heavy, unsubscribe done) | ui's titled `Notice` rises in (`enterRise()`) in a `NoticeStack` keyed by id, so the others stay still | `DURATION.normal`, `EASING.enter` | appears at once |
| Unsubscribe in flight | The notice's action swaps to its busy label ("Unsubscribing...") in place | the component's own | the same |
| Images arrive after "Show images" | Repaints batched on a backing-off timer (100 ms doubling to 3 s), not one per picture; a "Loading images..." notice while the queue runs | — | the same |
| Body mode changes (Reader / Original / Plain) | `SegmentedControl` selection slides; the body swaps in place without a cross-fade (it is a different document) | ui segmented tokens | selection jumps |
| Zoom | The body's text re-lays out at the new size; the chrome does not move | — | — |
| Shift+J / Shift+K | `ScrollRef.scrollTo` by 15% of the viewport, animated | platform scroll | not animated |
| Recipients "Show all" / "Show less", attachments "Show" / "Hide" | The line unclamps and the list opens in place; the toggle keeps its selected fill while open | `DURATION.fast` (ToolButton wash) | at once |
| Hover and press on every reader control | The ui layer's `ToolButton` / `Button` wash and press scale | `DURATION.fast`, `SCALE.press` | color only |
| Star toggles | `ToolButton` selected fill and label swap (Star ↔ Unstar) | `DURATION.fast` | at once |
| RSVP answer chosen | The chosen button takes the selected fill and a check glyph; never color alone | `DURATION.fast` | at once |
| Agent suggestions fold / unfold | The heading's chevron swaps, and the events open below it | `DURATION.fast` | at once |
| Image viewer opens / closes | The ui `Dialog`'s own entrance over a scrim | ui dialog tokens | appears at once |
| Image viewer pages / zooms / fits | The picture swaps in place, and its size steps by `ZOOM_STEP`; a loader shows while bytes are prepared | — | the same |
| Subject / address copy menu | The ui `ContextMenu` grows from the pointer, and the subject keeps a wash while its menu is open | ui menu tokens | at once |

The headless tests (`reader.test.tsx`) verify the behavior behind each line. Static screenshots in light and dark (`preview.test.tsx` under `nsh test --target macos`, written to `.nsh/shots/reader-*.png`) show the reading, Original and Plain bodies, the notices, the invitation, the attachments and the image viewer. The motion itself has not been recorded.

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

Icon-only actions require tooltips. The tooltip describes the action and may include the shortcut when the shortcut comes from `src/keys/keymap.ts`; it must not create a second hand-maintained binding description.

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

Opening a text-entry surface changes the application key context, and the surface focuses its meaningful field (a draft: the body for a reply, otherwise the first empty line). A command popup that walks its own rows takes those keys through a key layer (`pushKeyLayer` in `src/keys/commands.ts`) while it is open.

A ui popup or dialog binds Escape itself while it is the topmost overlay (`src/ui/overlays-stack.ts`), so a popover open inside a dialog closes first. Otherwise Escape is the window's and goes back (`goBack` in `src/keys/router.ts`). The two paths must not duplicate each other.

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

## The bar: a dot, not a count

The bar widget answers one question — is there mail waiting? — and it answers with a dot on the envelope, never with a number. This is a product decision, not a gap to be filled.

A count on a mail icon is a demand. On a busy mailbox it is never zero, it climbs while you are doing something else, and it asks to be cleared. A dot says something is there and leaves when to look to you, which is what lets Omamail sit in the bar all day without turning the mailbox into a queue to be worked down. The client is meant to be worked asynchronously: mail waits, and the person decides when.

A count is also rarely true. Gmail's list endpoint returns an estimate rather than a total, and that estimate is a placeholder on a short page whether four messages match or four thousand; Gmail counts conversations where this client lists messages; and a decade of phone mail apps has taught people that the number on the icon is wrong more often than it is right. A number that is usually wrong teaches people to stop reading it, and from then on it is only noise.

So the bar says whether, the tooltip says roughly how many, and the window says what. The dot follows the Primary-scoped unread count so that it reaches zero and can go out. Do not put digits on the envelope, a pill beside it, or a `99+`: a change that does so is answering a question the product chose not to ask, and making the number exact does not change that.

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
7. Which theme tokens from `src/ui/tokens.ts` does it draw with?
8. Is every sender-controlled string plain text?
9. Can its decisions be tested without rendering, and which behavior still needs a rendered `nsh test`?

A design that cannot answer these questions is not ready to become a reusable primitive. A feature-specific view may remain specific; clarity is more useful than an abstraction whose name is generic but whose contract knows one caller.

## NSH shell

The NSH window (`src/shell/`) keeps the regions above: a header (`TitleBar`,
44 tall, with the menu, the sidebar toggle, the centred search field, Check
mail and Compose), the body, the status line (28 tall on `muted`: a primary
`StatusPill` naming the place, INBOX or the mailbox's name, COMPOSE,
SETTINGS, SETUP, CALENDAR, then the account, the ticked count and activity;
key hints as `Kbd` caps at the right), and the overlay layer (the shortcut
sheet, toasts, the `ConfirmHost` where ui `confirm()` asks). The body follows
`src/shell/layout.ts`: wide from 1000 points of mail area (the window less the
assistant dock), compact below 760, medium between; the breakpoints and the
pane widths are base-14 points scaled by `uiScale()`.
The sidebar column (184 at base 14, least 140, most 360, rail 44) sits on
`muted`; its one hairline is the split separator, which the shell owns. It shows beside the list, the split and the calendar, never in
compact mode, on a page or over a draft; its one toggle sits in the header
beside the menu and follows it (plus `[` and the app menu). In compact mode
the list and the reader take turns in the same place, and the reader shows a
Back bar that takes the same step as Escape. Pane widths and the folded
sidebar are stored in NSH Storage (`shell.panes.v1`); 0 means the proportional
default, and a double click on a separator restores it.

Keys come from one table (`src/keys/keymap.ts`, docs/KEYS.md): the
router binds only what is live in the current context, the status-line hints
and the shortcut sheet read the same rows, and on macOS `Ctrl` in the table is
written and bound as Command.

### Motion inventory

Verified on `--target macos` with `src/shell/fixtures/WholeAppShots.test.tsx`
(synthetic fixture) unless marked otherwise; to be verified again in the v2
header pass.

| Change | Tool | Tokens | Reduced motion |
| --- | --- | --- | --- |
| Hover and press on header, status-line and menu controls; the place pill's words change with the page | ui controls' own state transitions; the pill swaps its words at once (the page change carries the motion) | `DURATION.fast`, `SCALE.press` | colors change at once, no scale |
| Sidebar folds to its rail or opens (`[`, the header toggle, the app menu) | `LayoutAnimation.configureNext` before the change (`animateNextLayout`, through the `toggleSidebar` command) | `DURATION.normal`, ease-out | lands at once |
| Compact list to reader, and back (Enter / Escape / the reader's Back) | `createMotion` on the arriving pane: fade and slide in from the side it comes from (`slideIn`) | `DURATION.normal`, `DISTANCE.page` | the pane swaps at once |
| Mode change as the window or base size crosses a breakpoint | instant relayout: the change follows the user's own resize | — | — |
| Shortcut sheet opens and closes (`?`, Escape, backdrop, Close) | ui `OverlayPanel` on nsh/base `Sheet`, rising from the bottom edge below the header; focus moves into it and returns | the component's own | lands at once |
| Shortcut sheet scrolls (j / k, arrows, page keys) | the scroll view's own scroll | — | — |
| A confirm question appears and is answered | ui `AlertDialog` in `ConfirmHost`: card fade and scale | 180 ms ease-out (`Dialog.tsx`) | at once (`motion-reduce`) |
| App menu and account switcher open; the app menu cursor (j / k) moves | `ui` `Popover`, grown from its trigger; the cursor row takes `NavRow`'s selected wash | the component's own | the component's own |
| Notice appears on the status line, replacing the hints | instant swap; the hints step off whole rather than arrive cut | — | — |
| Server search running | `Spinner` beside the field | 900 ms turn | rests; the words "Searching server" carry it |
| Split separator under the pointer and while dragged | `SplitPane` handle wash to the accent | `DURATION.fast` | color changes at once |
| Check mail running | `ToolButton` loader in place of the refresh glyph | the component's own | the component's own |

## NSH assistant

The AI dock (`src/features/assistant/`) sits at the body's trailing edge,
beside whatever page is open, and is about one message, a ticked selection or
the open draft. Its width keeps the Qt client's limits: at most 65% of the window
and never so wide that less than 320 points remain, at least 280 points (less
only when the window cannot spare them), 420 points (or 45% of the window) by
default. The width is the owner's choice once dragged, stored as
`dockWidth` in `assistant.settings.v1` and clamped to the window without being
replaced; a double click on the leading separator restores the default.

A reply is plain text drawn as spans: paragraphs, bold, inline code and code
blocks, and nothing else; a link or a tag in a reply is shown as written. A
proposed draft is a card under the reply that produced it, with the app's
routing on top, the subject and body, and two actions: "Edit draft..." (opens
an editor) and "Send email" (queues it in the outbox, then shows the outbox's
state in its label). The card says when the sender, recipients or quoted
history changed and refuses to send until the owner edits it.

In Visual language v2 the dock is a sidebar: it sits on `muted`, and the
`SplitHandle`'s hairline (`line="end"`) is its inner edge. Its header is 44
tall with the pane title at 16. Transcript rows are padded 16 across and 8
apart; replies, the owner's messages and the proposed body are message text
(15 on 24), and the owner's own messages sit on `surface-raised`. Code spans
and blocks are mono, spans on `surface-raised`, blocks framed by a hairline.
A proposal is a `Titled` panel ("Proposed reply"), padded 16, with "Include
quoted history" as a checkbox and its actions trailing: "Edit draft..."
(default, bordered) and "Send email" (primary, filled). Times are mono: the
working timer and each history row's start time, beside its request in sans.
The input's keys are key caps under it (`KeyHints`: enter send, / commands,
esc close or interrupt), one keymap with the commands the dock registers.

### Motion inventory

| Change | Tool | Tokens | Reduced motion |
| --- | --- | --- | --- |
| Dock opens or closes (Alt+G, the close button, Escape) | `LayoutAnimation.configureNext` before the change: the panes give way and take the room back | `DURATION.normal`, ease-in-out | lands at once |
| Separator dragged | the shared `SplitHandle` (grow -1): a guide line bound to the drag (`pan`), 1:1 on the UI thread; the width is set once on release | none while dragging | the same: it follows the pointer |
| Separator hovered and dragged | the hairline washes to the accent | `DURATION.fast` (`CLASS.wash`) | color changes at once |
| Separator double-clicked, or Return on it; Left/Right step it | the width changes in one layout change | — | — |
| Hover and press on header, card and input controls | the ui layer's controls (`ToolButton`, `Button`, `IconButton`, `ListItem`) | `DURATION.fast`, `SCALE.press` / `pressIcon` | colors change at once, no scale |
| Send ↔ Stop while a request runs | glyph swap in the same slot (Send leaves, Stop comes in) | the component's own | swaps at once |
| A message or reply arrives in the transcript | `List` keeps the end in view (`maintainVisibleContentPosition`), no row motion: a streamed reply grows many times a second | — | — |
| Earlier messages loaded | the list keeps the reader's position; the "Earlier messages" button shows its loader | the component's own | the same |
| A proposed draft appears | the card rises and fades in | `DISTANCE.toast`, `DURATION.normal`, ease-out | appears at once |
| Status line changes (working, ready, error) | the line rises a few points and fades in, not a bare text swap | `DISTANCE.popup`, `DURATION.normal` | changes at once |
| Working timer and progress | the mono time updates once a second; no spinner beside words that say it | — | — |
| "Include quoted history" ticked | the ui `Checkbox` (its check glyph and fill) | the component's own | changes at once |
| Slash-command suggestions open and move | the list appears under the input; one selected row (`ListItem` selected wash) | `DURATION.fast` | the selection jumps |
| History opens and closes | the transcript and the history list swap in place, no slide (siblings, not navigation) | — | — |
| Send button while queuing a proposal | `loading` glyph, then the outbox's label ("Queued for sending", "Sent" with a check) | the component's own | the same |

## NSH ui layer

`src/ui/` is the app's styled layer over `nsh/base`, and the only place controls get their look. Features import from `src/ui/index.ts` alone. The look is "Visual language v2: after NsVim" (above): the ui layer draws it, and nsh-omarchy's controls that it still wraps (`Button`, `IconButton`, `Input`, `Textarea`, `NumberInput`, `ListItem`, `TitleBar`) take it through host classes. Of nsh-omarchy itself only `Separator` and `Omarchy` pass through unchanged. A look a feature needs and `ui` lacks becomes a variant here first; a feature never styles a control itself. `src/ui/Gallery.tsx` shows every app-owned control in each state (`nsh run src/ui/GalleryApp.tsx`), with a switch for ink / paper / Omarchy and base 12 / 14 / 16; a change to the layer is looked at there before it reaches a screen.

### Standard

- **Themes** (`src/ui/theme.ts`, `theme.json`). `INK` (dark) and `PAPER` (light) hold every role: the v2 ones (`surface-raised`, `rule-strong`, `text-faint`, `selection`, `primary-hover`, `violet`, `orange`, `cyan`) and every role v1 and nsh-omarchy name (`surface`, `inset`, `bright`, `text-secondary`, `omarchy-accent`, `on-accent`, `chart-*`, `ansi-*`, ...), so a class means something in every palette. `theme.json` is the same pair (the app's first frame). `setThemeMode("system" | "light" | "dark" | "omarchy" | null)` sets the Theme setting; `themeMode()` reads it (reactive); `null` is the default, `defaultThemeMode()`: Omarchy on an Omarchy desktop (`isOmarchyDesktop()`: omamail-native's `Backend.isOmarchy()`, `~/.config/omarchy` (or `$XDG_CONFIG_HOME/omarchy`) is a directory), System elsewhere. System, Light and Dark draw ink / paper with `setColorScheme`; Omarchy calls `Omarchy.followSystem()`, and each time nsh-omarchy applies a palette (which replaces the tokens whole) `theme.ts` sets the roles it lacks from the nearest role it has (`surface-raised` ← `accent` / `surface`, `rule-strong` ← `input` / `border`, `text-faint` ← `text-secondary`, `primary-hover` ← `primary`, `violet` ← `ansi-5`, `orange` ← `ansi-11`, `cyan` ← `ansi-6`), with the 2pt radius and the mono family. At startup there is no frame without a role: `startTheme()` applies the first palette before the root's views exist (not in an effect), ui's `Omarchy.followSystem()` is `startTheme()` (nsh-omarchy's own applied its palette a message after the views), and in the Omarchy mode a root mounts its content behind `themeReady()`, which turns true once Omarchy's palette has arrived and been filled (at most 300 ms). A live switch to an Omarchy palette (the Theme setting, `Omarchy.applyTheme`) is accepted to draw one update without the missing roles: the fill runs in the same turn the palette reaches TS (`Omarchy.onChange` and a token watch), but nsh-omarchy sets the tokens on the Rust side a message earlier. The core logs "unknown classes" for that update (its own `log::warn`, which the app cannot silence); the role mapping stays in TS, not duplicated in Rust. Missing ansi roles are filled by hue (`ansi-1` ← `danger`, `ansi-4` ← `primary`, `ansi-5` ← `violet`, ...).
- **Tokens only.** No raw colors, no palette classes in presentation code. `src/ui/tokens.ts` names the shared classes: `FILL` (rest, hover `surface-raised`, pressed and selected `selection`, surface, inset `muted`, raised), `SELECTED_TEXT` (bright, semibold), `RING` (the keyboard focus of rows and non-text controls: `rest` reserves a 1pt transparent border, `focus` draws it primary under `focus-visible:` only, `on` draws it now: a drop target), `LINE` (hairline, border, strong `rule-strong`, clear, control, `focus` keyboard-only primary for non-text controls, `inputFocus` primary on any focus for text inputs, danger). `BAR` is deprecated: it maps to `RING` and draws no bar, `TEXT`, `TYPE`, `RADIUS` (2pt), `HEIGHT`, `TONE_TEXT`.
- **Lines.** Two kinds. Structural dividers separate the window's regions: a header's bottom, the status line's top, a split's rest line (`SplitPane`, `SplitHandle`), an `ActionBar`'s edge, `OverlayPanel`'s header, the settings rail's edge and header, the assistant dock's header and handle. They use the `divider` role (`LINE.divider` = `border-divider`, `LINE.dividerFill` = `bg-divider`): on Ink `#171A24` and on Paper `#E9E9E4`, a hair off the background and below `border`, so the regions read by their fills first. Content borders (fields, popovers, tables, chips, cards, titled panels) keep `border`. On Omarchy `divider` is `border` (`OMARCHY_FALLBACK`): strong structural lines are the Omarchy look and stay there only. A split's line still turns `rule-strong` under the pointer and primary while dragged, so the drag affordance appears on hover.
- **States.** Hover fills `surface-raised`. A selected item is the `selection` fill with `SELECTED_TEXT`; no leading-edge bar. Selected wins, so a selected row has no hover class. Focus: text inputs (Input, Textarea, ChipInput, TextEditor, Select's search) draw a 1pt primary border on any focus, since they hold the caret; every other control (buttons, rows, nav items, tabs, segments) draws its 1pt primary ring only under `focus-visible:` (the keyboard moved the focus; never after a press). A picker's or list's keyboard cursor away from the selection takes the hover fill, never a ring. Disabled is 40% opacity. Pressed is `selection`.
- **Type.** Interface and message text are the system's sans (`font-sans` is left to the system); `font-mono` (`TEXT.mono`) is for key caps, times, counts and versions, and follows Omarchy's `[font] family` where shell.toml names one, else the generic `monospace`. `followOmarchyFont()` (`src/ui/font.ts`, once in the root) starts the theme, reads `[font]` through `Backend.omarchyFont()` (fixed path, size cap, `family` and `base-size` only; `{}` off Omarchy) and polls it every 3 s while the app is active; it sets only the mono family and `base-size`. `uiScale()` = base-size / 14 scales `TYPE`, `TEXT`, `HEIGHT`, `SQUARE`, `PAD_X`, `TEXT_SIZE`, every `Icon`, `sizedBox`, and every 4pt-scale spacing utility in a class built with `cx`. The ramp at 14: caption 12 (`TYPE.sm`, `TEXT.caption`, `TEXT.section`), chrome body 13 (`TYPE.md`, `TEXT.body`), list title 14 (`TYPE.body`, `TEXT.listTitle`), pane title 16 (`TYPE.lg`, `TEXT.title`), subject 20 (`TYPE.xl`, `TEXT.subject`), message 15 on 24 (`TYPE.message`, `TEXT.message`). No feature sets `fontFamily` or a raw text size.
- **Sizes.** Controls 26 / 30 / 34 (`small` / `medium` / `large`), 12 across (`PAD_X.medium`); menu rows 30 in a 4pt-padded popup; dialogs padded 24 with 16 between parts; settings rows at least 44; sidebar rows 32; list rows 72; tool bars 44; key caps 20.
- **Props, not looks.** Components take `variant`, `size`, states (`selected`, `disabled`, `loading`, `busy`, `unread`, `invalid`) and slots (`trailing`, `actions`, `meta`, `menu`), never colors, radii or classes.
- **Never color alone.** A tone comes with its icon or word, an unread row with weight and its dot, a selected row with semibold brighter text as well as the fill, a picked segment with the fill and semibold text, an invalid token with a glyph and its name ("Remove x (invalid address)"), a drop target with the fill and a primary outline.
- **Plain text.** Every label a sender or a server can set renders as `<Text>`, which takes no markup.
- **Keyboard and names.** Every app-owned control is an `nsh/base` Button, Tab, Toolbar, Input or ResizablePanelGroup underneath, so it is focusable, pressed by Space and Return, and named for screen readers. An icon-only button has its label as a tooltip with its shortcut. Labels of actions that open another surface end in `...`.

### Components

| Component | Built on | For |
| --- | --- | --- |
| `Notice`, `NoticeStack` | View or `Titled`, `ui` `Button` (ghost, small) | One-line reasons above content: one contract, 0–2 actions, the narrower answer first, a busy action relabelled (`busyLabel`), never hidden. With `title` ("Agent", "Calendar"), the one titled notice of the app: a `Titled` panel with the title on its top hairline, the tone icon, a 13pt line and ghost actions (warning and danger still `alert`) |
| `Skeleton`, `SkeletonBar`, `ListSkeleton`, `ReaderSkeleton` | View, one `createAnimatedValue` | The shape of what is coming; one shared breath per skeleton |
| `SplitPane`, `SplitPanel` | `ResizablePanelGroup`, `ResizablePanel` | Hairline separator, 7-point hit band, accent while dragged, double-click `onReset` |
| `SplitHandle` | View with `pan`; `line="start" \| "end"` puts the hairline on the band's edge to meet a neighbour's borders | One pane edge whose size the app owns (the assistant dock): a guide follows the pointer on the UI thread, the size commits on release; arrows, Home / End, Return and double-click; announced as adjustable |
| `Kbd`, `KeyHints`, `keyCapLabel`, `keyCapParts`, `chordLabel`, `keyCaps`, `isApple` | View, Text, `keymap.label` | A key cap: mono 12pt on `surface-raised`, one hairline, 20 tall and at least 20 wide; a chord in any spelling (`mod-k`, `Ctrl+Enter`) is written as the platform does (⌘K on Apple platforms, Ctrl+K elsewhere), never `mod`; menus and tooltips use the same caps; hint pairs from data. The one key-label helper of the app: `chordLabel` writes a keys-table chord through `keymap.label` (`Ctrl++` ⌘+, `Ctrl+1…9` ⌘1…9, a single key as its cap, Escape "esc", "?" as is) and `keyCaps` splits a table text into one cap per key (alternatives apart, the same key once, "g then i" one cap "G I"); `KeyHints caps="perKey"` draws them. `src/keys/labels.ts` re-exports these |
| `ActionBar`, `ActionBarGroup`, `ActionBarSeparator`, `ActionBarSpacer`, `ToolButton` | `Toolbar`, `ToolbarGroup`, `ToolbarSeparator`, `Button` | Bars on a pane's edge; ghost buttons with icon, label, shortcut tooltip, loading, selected; under a ui `TitleBar` (or `inTitleBar`) it is a plain row with the `toolbar` role, each button its own Tab stop, as a macOS title bar's items are: a STOPGAP for an NSH bug where a Toolbar in the hidden title bar's band takes presses on its first item only (`titleband-macos.test.tsx`) |
| `NavRow` | View (pressable, `button` role, `focusable`) | Sidebar rows, 32 tall, gaps 8, one 12pt step per depth, with stable lanes: an optional leading disclosure slot (`leading`, a fold chevron, its own press target; `reserveLeading` keeps it empty), the icon slot, the name (takes the rest, then elides), a count lane that hugs its count (at least 20pt, right-aligned, tabular digits, `{testID}-count`) and is absent with no count, so counts end on one right edge and the name keeps the rest; a `slotKey` is the whole chord as a `Kbd` in that lane (`slotChord`: a digit is the keys table's Ctrl+digit, ⌘3 on Apple platforms, Ctrl+3 elsewhere; never a bare digit, which reads as a count), and the row's name says it ("Archive, ⌘3"); `focusable={false}` leaves a row out of the Tab order (a roving list's rows other than its stop); hover `surface-raised`, selected the `selection` fill with bright semibold text, the keyboard ring inset; `dropActive` adds a primary outline. A pointer press opens the row and gives it the focus, as a native sidebar does, so the arrows work at once; a focus that follows a pointer shows no ring (`focus-visible` is the keyboard's). A nav list should move the selection with the arrow keys (roving focus) so the ring and the selection sit on one row |
| `ToolButton` / `MenuButton` `accessibilityLabel` | — | What screen readers hear when the visible label is not the whole name |
| `ListRow` | View (focusable, `button` / `row` / `option` role) | Message rows with stable lanes (unread dot, overline and time, title and actions, detail); selection the `selection` fill with bright semibold text, the keyboard focus a 1pt ring inset (`cursor` away from the selection: the hover fill); passes press modifiers, mouse enter / leave / up and pan through for range selection, middle-click and dragging; `fixedHeight` (72pt, lines centred, an empty detail keeps its line), `quickActions`, the one rule for quick actions (they replace the first line's trailing metadata, thread count and time together, in place while the row is hovered, selected, holds the focus or `actionsShown`; no column is reserved, so times end on the pane's trailing edge; each must also be in the context menu and keymap; the default `"title"` is only for a state control such as a select-mode checkbox), `threadCount` (a `ThreadCount` chip of its own before the time, from 2), `timeTooltip`, `flush` (square corners). Enter / Space activate it with `clickCount` 0 (verified on macOS); keyboard activation carries no modifiers, so range and toggle by keyboard are the list's own commands; quick actions are `quickActions` (name, label, icon, shortcut, `onPerform`): lane icons for the pointer that are no Tab stops (Tab goes row to row, as Qt's list does; a long list is not three stops a row), offered to screen readers as the row's accessibility actions (`accessibilityActions`, performed by name through `quickActionsA11y`), and to the keyboard as the keymap and the row menu, which must hold each of them; `focus-within` still draws the lane should a focus land inside it (`roving-macos.test.tsx`). `actions` are state, not actions (the select-mode checkbox), always ending the title line |
| `PickerRow` | View (button role); `disabled` dims it, drops presses and focus and tells screen readers; with no `label` and no `detail` its lead alone, centred with equal padding (a rail's avatar: name it with `accessibilityLabel` and `tooltip`) | Picker and switcher rows: `cursor` (keyboard row: border and fill) apart from `selected` (in use: selected fill and bold); reports clickCount 1, 2 or 0 (keyboard) |
| `CountBadge`, `UnreadDot`, `badgeText` | Text, View | Counts in the suffix lane (nothing at zero, `cap+` past the cap); the unread dot keeps its lane while read |
| `ChipInput`, `ChipTokenView`, `splitEntries` | View, `Input`, `Button` | Recipients: Return, comma or semicolon commit; Backspace in the empty input removes the last (both the input method's while it composes); `autoFocus`, `inputRef`, `onCompositionChange` |
| `imeComposing`, `textInputActive`, `trackTextField` | one global signal (`ime.ts`) | Input methods (pinyin, kana): every ui text field (Input, Textarea, ChipInput, TextEditor) reports its composition. While one is open, Return chooses the candidate and reaches no `onSubmit` / `onCommit`, the placeholder hides, and `imeComposing()` is true, so the shell's router binds no shortcuts; it goes false when the composition ends, the field blurs or it unmounts. `textInputActive()` is also true while a ui field has the focus (single-letter shortcuts stand aside). Not covered: Select's built-in search and NumberInput, whose nsh components report no composition |
| `TextEditor` | `Input` (multiline) | Long plain-text writing (a message body; `size="message"` is 15pt on 24pt lines): control border, primary on any focus, grows with its text, reports pastes for attachments; `inputRef` (focus, insertText, setSelection), `autoFocus` |
| `SegmentedControl` | `Tabs`, `Tab` | Named options in one outline with hairlines between; the pick filled primary to the outline (its part of the outline is primary: never an inset box) with semibold on-primary text; 26 tall; hugging, it leaves its cross-axis placement to the parent (centres in an `items-center` row) |
| `EmptyPane` | View | What is empty and the next action, centered in the pane, no frame |
| `Spinner`, `LoadingRow` | View, `createMotion` | Work whose result has no shape yet |
| `confirmAction`, `confirm`, `ConfirmHost` | `AlertDialog` | Asks in the window's `ConfirmHost` (the platform's alert when none is mounted) with an accurate verb; questions wait their turn; only for what Undo cannot take back |
| `MenuButton` | `ui` `Menu` + `ToolButton` | A menu on its trigger's edge; the trigger stays selected while open |
| `ContextMenuArea` | `ui` `ContextMenu` | A secondary-click menu that tells its area it is open, so the row stays selected |
| `ControlledContextMenu` | `ContextMenu` (nsh/base), popup in nsh-omarchy's menu look | A context menu the caller opens and closes (closing it when its row goes away); opened by the app it drops below the area |
| `ChoiceDialog` | `ui` `Dialog` + `Button` | A question with more than one answer besides Cancel (Save / Discard / Cancel); Escape and the scrim cancel |
| `Icon` `filled`, `iconKeyFor` | nsh-icon, Lucide | The filled form of a name with an on state (`star` → `starFilled`), said in words too |
| `ShortcutTooltip` | `Tooltip` | A control's tooltip naming its action and chord; a `ToolButton`'s hides after a click until the pointer leaves, and while its popup is open (`popupOpen`, which `MenuButton` sets) |
| `followOmarchyFont`, `uiScale`, `scaled`, `setOmarchyFont`, `TYPE`, `sizedBox` | `setTheme`, `token`, omamail-native `Backend.omarchyFont` | The app's typeface and size from shell.toml (see Standard); the gallery's Base size control sets it by hand |
| `OverlayPanel` | nsh/base `Sheet` (bottom) | A modal panel over the window below `top` (the shortcut sheet): 96% background, title and Close (esc), content that scrolls only when it does not fit; dialog role, the focus moved onto the content as it opens (arrows, Page Up/Down, Space, Home, End scroll it), kept inside and returned; Close shows no tooltip under the keyboard focus, so one Escape closes; a backdrop press closes it; it rises in and falls out (at once under reduced motion); `scrollRef` / `onScroll` for the app's own keys |
| `Button`, `IconButton`, `Input`, `Textarea`, `NumberInput`, `ListItem`, `TitleBar` | nsh-omarchy's, wrapped (`Controls.tsx`); Input and Textarea on nsh/base `Input` with nsh-omarchy's props and ref, plus `onCompositionChange`, `onFocus`, `onBlur`; Input `variant="plain"` (no border or fill, same height and padding) for a field inside a frame that draws its focus | The same props, the v2 look through host classes: `primary` filled (hover `primary-hover`), `default` bordered, `ghost` (hover `surface-raised`), `danger` danger text (`confirm` fills it); 26 / 30 / 34 tall, icon buttons square; fields on the background with a hairline, `rule-strong` on hover, primary when focused. `controlHeight` gives whole-point heights so fields and selects side by side line up. Input, Textarea and NumberInput take the surrounding `Field`'s label as their name; `TitleBar` draws its title itself so it scales |
| `Checkbox`, `Switch` | `Checkbox`, `Switch` (`Toggles.tsx`) | A 14pt square box: a hairline when off, filled primary with an on-primary check (or a dash) when on. `Switch` keeps its props and role but draws the same box; value owned by `checked` or kept |
| `Tooltip` | View, for a control's `tooltip` | ≤320 wide, 8×4 padding, a hairline on the surface, 12pt label, the shortcut as key caps |
| `Tabs`, `Tab` | `Tabs`, `Tab` | `underline` (muted text; the pick bright and semibold over a 2pt primary line) or `segmented` (as `SegmentedControl`) |
| `Calendar`, `DatePicker` | `Calendar`, `DatePicker` | nsh-omarchy's props and look; the picked day is the selected fill, semibold and announced selected |
| `HoverCard` | `HoverCard` | nsh-omarchy's: 280 wide card, opens after 400ms, closes 200ms after |
| `Toaster`, `toast`, `dismissToast` | `ToastStack`, `Toast` | nsh-omarchy's API: 340 wide at the bottom right on the surface with a hairline and shadow, kind icon, 13pt title, 12pt description, 6s timeout, errors stay |
| `Menu`, `ContextMenu`, `MenuItem`, `MenuLabel`, `MenuSeparator`, `KeyCaps` | nsh/base `Menu`, `ContextMenu`, `MenuItem`, `MenuSeparator` (`Menu.tsx`) | Popover surface, one hairline, shadow, 4pt padding, at least 200 wide, fade and 4pt rise; 30pt rows at 13pt, the cursor `surface-raised`, pressed `selection`, dimmed disabled, danger text, the shortcut as key caps at the end; section labels in `TEXT.section` |
| `Field` | `View` + `FieldLabel` context (`Field.tsx`) | Label 11pt medium secondary, danger asterisk when required, the description or the error (danger) below; names the control inside |
| `Select` | nsh/base `Select` (`Select.tsx`) | The trigger as a field (30 tall, primary border while open or focused), placeholder muted, chevron; popup on the popover surface with a hairline and shadow, 30pt rows with the cursor `surface-raised`, the chosen row `selection` with a check, group headings, search field |
| `Dialog`, `AlertDialog`, `Sheet` | nsh/base `Dialog`, `Sheet` (`Dialog.tsx`) | 420pt card on the popover surface with a hairline and shadow, padded 24 with 16 between title (16pt semibold bright), description (muted) and the right-aligned actions, over a scrim that takes the window 70% toward `muted` (darker than the card on Ink and Paper, so the card reads raised); `variant="finder"` drops the title block: the card is a `Titled` frame on `popover` with the title on its top hairline, padded 12, for finder pickers (Move to, Label as) built from `FinderPanel`s, which inherit its surface; a 360pt edge sheet with header, Close (no tooltip under the keyboard focus, so one Escape closes), scrolling body and footer over a hairline; AlertDialog starts on Cancel. Escape (`overlays-stack.ts`): every ui overlay (Popover, Menu, ContextMenu, Select, Dialog, Sheet, OverlayPanel) is on one stack, and Escape closes only the topmost, even from a focused field (`useEscapeToClose`), so a popover or select in a dialog closes first and the dialog on the next Escape; no overlay closes on an Escape an input method takes mid-composition (`closeOnEscape={escapeMayClose()}`, `imeSafe`). Menus, tooltips and the date picker hold no ui field; a select's built-in search is nsh/base's own field (`overlays.test.tsx`) |
| `Popover` | nsh/base `Popover` | The popover surface, a hairline, shadow, 12pt padding (`title` sits on the border, as a `Titled` frame), fade and 4pt rise, plus `width` (scaled) and `padded={false}` for lists; 200 to 320 wide when no width is given |
| `ScrollBox` | `Scroll` | As tall as its content up to `maxHeight` (scaled), then it scrolls: a picker with one match is one row |
| `SettingSection`, `SettingRow`, `Hint`, `Disclosure` | `SectionHeading`, View (focusable `button`, `expanded`) | Settings and setup pages (from settings and accounts): a headed section, a row of words beside or above its control, a hint under it (danger / warning tone with words), a chevron disclosure that shows or hides more |
| `InitialAvatar`, `initialOf` | `Avatar` | Square mark (the radius token): picture, else the first letter of name or address, else `+`, or an icon for a row that is nobody's address |
| `SectionHeading` | View, Text | A pane's or sidebar's section caption (`TEXT.section`: 12pt, muted, sentence case) with a trailing slot |
| `NavList`, `NavListStep`, `useRovingFocus`, `rovingMove`, `restingIndex` | View (`list`, `onKeyDown`, `onFocusIn` / `onFocusOut`) | A column of `NavRow`s with roving focus. Simple form: Up, Down, Home and End call `onMove` and the newly selected row takes the focus; give only the stop row `focusable`. Tree form: `roving={useRovingFocus({ targets, selectedKey, open, fold, bindKeys? })}` and `NavRow rovingKey`: the rows are one Tab stop (the cursor while the keyboard is in the list, else the open row), Up / Down / Home / End move and open (a row that names nothing takes the focus without opening), Right unfolds then steps into the first child, Left folds then steps out to the parent, and the ends stop (no wrap). The arrows are bound only while the focus is in the list (`keymap.bind` by default, not while editing; an app with a key router passes its own layer). Tab is checked on macOS (`roving-macos.test.tsx`): headless runs move no focus |
| `Stepper` | nsh/base `Button` ×2, Text | − value + inside one hairline, 26 tall; the buttons are "Decrease / Increase {name}"; the value in mono |
| `Titled`, `FinderPanel` | View | A panel with a hairline frame and its title on the top edge (12 in, 12pt muted, the fill knocked out behind it); `surface` (`background`, `muted`, `surface`, `popover`, `raised`) sets the panel, title and trailing knockouts together, and defaults to the enclosing titled panel's (a finder dialog's `popover`), so a knockout is never a chip of another shade; `focusWithin` turns the frame primary while the keyboard focus is inside (FinderPanel's default: with an Input `variant="plain"` inside, the panel line is the field's one focus border); `trailing` sits on the top edge at the right (a finder's "3 / 12": `FinderPanel` `count`) |
| `StatusPill` | View, Text | A filled pill (primary, danger, warning or success) with on-primary 12pt semibold text, 20 tall; the status line's mode |
| `setThemeMode`, `themeMode`, `themeReady`, `defaultThemeMode`, `isOmarchyDesktop`, `INK`, `PAPER`, `Omarchy` | `setTheme`, `setColorScheme`, nsh-omarchy `Omarchy` | The Theme setting (see Standard); Settings → Appearance writes it. ui's `Omarchy` is nsh-omarchy's with `followSystem()` starting the Theme setting; `themeReady()` gates a root's content in the Omarchy mode |

### Motion inventory

Every duration and easing comes from `src/ui/motion.ts` (`DURATION`, `SCALE`, `DISTANCE`, `PULSE_MS`, `STAGGER`, `CLASS`, `enterRise`, `enterFade`). Under reduced motion every row of this table is an instant change; the `CLASS` transitions carry `motion-reduce:` resets, the motions and animated values are not started.

| Change | Tool | Tokens | Reduced motion |
| --- | --- | --- | --- |
| Hover and selection washes on rows, buttons, segments, the split hairline | class transition (`CLASS.wash`) | `DURATION.fast`, ease-out | colors change at once |
| Press on `ToolButton`, chip remove buttons | class transition to `active:scale` (`CLASS.press`, `CLASS.pressIcon`) | `SCALE.press` 0.97, `SCALE.pressIcon` 0.95, `DURATION.fast` | no scale |
| A notice is added to a stack | `createMotion` enter: fade and rise (`enterRise`) | `DISTANCE.popup`, `DURATION.normal`, ease-out | appears at once |
| A notice's action goes busy | the button's label swaps to `busyLabel` and its loader turns | nsh-omarchy's own | the label swaps, the loader rests |
| Skeleton waiting | one animated value per skeleton, keyframes 0.45 → 1 → 0.45 | `PULSE_MS` 900 each way, ease-in-out, infinite | rests at full opacity |
| Skeleton replaced by content | the caller's `enterFade` on the content | `DURATION.normal` | at once |
| `Spinner` | `createMotion` `spin`, linear, infinite | 900 ms a turn | rests; the words say it |
| `SegmentedControl` choice | the `Tabs` indicator slides natively to the chosen option | the core's indicator motion | jumps |
| `UnreadDot` read / unread | opacity transition in its fixed lane | `DURATION.fast` | at once |
| Split handle hovered, pressed, dragged | hairline color from `border` to `rule-strong` to `primary` | `DURATION.fast` | at once |
| Split dragged | `ResizablePanelGroup`'s native drag, frame by frame | none: it follows the pointer | the same |
| `SplitHandle` dragged | a 1-point primary guide bound to the drag (`pan`), the size set once on release | none: it follows the pointer | the same |
| Menu and context menu open | nsh-omarchy's popup entrance from the trigger | the component's own | the component's own |
| `ControlledContextMenu` opens and closes | popup starting / ending classes: fade and 4-point rise | 180 ms, ease-out | appears and goes at once |
| `ChoiceDialog` opens | `ui` `Dialog`'s own | the component's own | the component's own |
| `EmptyPane` appears | `createMotion` enter: fade (`enterFade`) | `DURATION.normal` | at once |
| Avatar picture loads | opacity transition over the initial | `DURATION.normal` | at once |
| A list's rows entering together | `staggerDelay(index)` on each row's `enterRise` | `STAGGER.step` 40 ms, first `STAGGER.cap` 10 rows only | all at once |

## NSH compose

The editor (`src/features/compose/`) fills the mail window over the panes,
or on desktops a window of its own ("Open in window..."). Moving it never
saves, sends or drops the draft; closing that window brings the draft back
over the mail. Send is the header's filled primary button (Ctrl+Enter, shown as a key cap
in the footer, or the reason Send is off when no From address can send); Back, the
arrow and Escape ask "Save this draft?" when the user changed something, with
Save draft as the default. Recipients are chips with the contact book's
matches under the line; a chip that does not parse says "invalid address" in
its name and a warning glyph, not only by color.

### Motion inventory

| Change | Tool | Tokens |
| --- | --- | --- |
| Compose opens over the mail | `createMotion` `enter: enterRise(16)` on the editor root | `DURATION.normal`, `DISTANCE.page` |
| A draft comes back by itself (undone send, recovered, held draft reopened) | `flash.play` opacity 0.32 to 0 on a `primary` layer | 720 ms, `ms()` makes it instant under reduced motion |
| Attachment row arrives | `createMotion` `enterRise(4)`, 30 ms apart, capped at six | `DURATION.normal` |
| Hover, press and selection of buttons, chips, suggestions | ui classes `CLASS.wash`, `CLASS.press`, `CLASS.pressIcon` | `DURATION.fast`, `SCALE.press` |
| Body and recipient line focus border | `CLASS.wash` color transition | `DURATION.fast` |
| Suggestions under a recipient line | appear and go with the field's focus (150 ms grace so a press lands) | instant swap; the list is anchored under its line |
| Contacts popover, From menu | `ui` `Popover` and `Menu`, growing from the trigger, which stays selected | the control's own motion |
| Exit dialog | `ui` `Dialog` | the control's own motion |
| File drag over the editor | a dashed `primary` frame appears; it goes on leave or drop | instant, the frame names the action in words |
| Undo window | nsh-omarchy toast "Sending in Ns" renamed in place each second, dismissed when the send goes or is undone | the toaster's motion |

## NSH calendar

The calendar page (`src/features/calendar/`) keeps the Qt client's four views
behind one bar: the period (previous, a date picker, next, Today), Create event...,
and a segmented Day / Week / Month / Agenda switch, which shows the four
exclusive views at once rather than behind a menu. An event's detail opens
beside the view (a 380 pt pane; the whole width when narrow) and Back or
Escape returns to the view. The editor is a sheet at the right edge, over the
calendar or over mail when an invitation or a suggestion opened it; nothing is
written until Create event, Save changes, Send update or Save without email.
Deleting always asks, and a recurring or shared event asks how. The last move
of a Google event offers Undo (u) in a notice. Calendar colors are the theme's
terminal colors (`ansi-1`..`ansi-6`) and the accent, always next to a title,
never the only signal. Titles, places, descriptions and guest names are the
organizer's text and render as plain text; links open only when pressed, and
only http and https ones.

### Motion inventory

| Change | Tool | Tokens |
| --- | --- | --- |
| View mode changes (day, week, month, agenda) | `createMotion` `enterFade()` on the view's frame; the bar stays put | `DURATION.normal` |
| Detail pane opens | `createMotion` `enterRise(8)` | `DURATION.normal`, `DISTANCE.toast` |
| Editor opens and closes | `ui` `Sheet` from the right edge | the control's own motion |
| More options, guest suggestions, a reminder row arrive | `createMotion` `enterRise()` | `DURATION.normal`, `DISTANCE.popup` |
| Timeline event dragged or resized | `pan` drives `translate` on the UI thread; a dashed accent preview shows the snapped range in words ("10:15–11:15"); the original card dims to 0.35 | live, no easing |
| Dropped card the write took | the card lands at its new time at once (`AnimatedValue.set(0)`), labelled "Saving" until the refresh | instant |
| Dropped card refused, cancelled or unchanged | `AnimatedValue.spring(0)` back to its slot; instant under reduced motion | stiffness 420, damping 34 |
| Month chip or span carried to another day | the same `pan` / `translate`; the target cell gets an accent frame and "Move to Tue 24 Nov · 09:30", then "Saving ·" and "Refreshing ·" | live; spring back as above |
| Slot drag down a column, all-day drag across columns | an accent range grows under the pointer with its times in words | live |
| "+N more..." overflow | `ui` `HoverCard` (opens after 400 ms, closes 200 ms after) | the control's own motion |
| Hover, press and selection of chips, cards and rows | `CLASS.wash` (fill; a selected event takes the deeper calendar wash and bright semibold text, its 3pt calendar bar unchanged, no selection border or bar), `CLASS.fade` for drag opacity | `DURATION.fast`, `DURATION.normal` |
| Now line and rail pill | move with the minute tick | instant |
| Date picker, selects, delete and move-series dialogs | `ui` `DatePicker`, `Select`, `Dialog`, `AlertDialog` | the controls' own motion |
| Undo notice, errors | `Notice` (`enterRise`) | `DURATION.normal` |
| Keyboard focus on an event, a day cell or "+N more..." | a 1pt primary border on `focus-visible` only (`LINE.focus`); Return or Space opens or creates, never moves | instant |
| An hour label reaches the timeline's top edge | it is left out rather than cut in half | instant |

Calendar colors come from the theme's terminal colors (ansi-1..6), which Ink
and Paper set and the ui layer fills for an Omarchy palette without them. A
theme that still leaves one unset gets the nearest role instead: red
`danger`, green `success`, yellow `warning`, blue `primary`, magenta
`violet`, cyan `cyan`.

Visual language v2 in the calendar: the bar and the day headers are 44 pt;
hour labels, event times, day numbers and agenda times are mono; event
blocks are square (2 pt) with the calendar's 3 pt bar; the event's detail
groups its meeting link, guests and reminders in titled panels, and the
editor groups When, Details and Options the same way, with one filled primary
action. Settings → Calendars builds every row from `SettingRow` (title and detail on the
left; color, actions and the Show checkbox on the right, on the settings' spine).
The header, the all-day row and the day columns end a 12 pt gutter before the
timeline's scrollbar, and the top hour in view keeps its label inside the grid.
The bottoms of the day header and the all-day row are structural dividers
(`LINE.divider`); the day columns and hour lines are content and keep `border`.
The calendar's name is in each event's accessible label and in its detail.
Shots: `.nsh/shots/v2/calendar-*` in Ink, Paper, Tokyo Night and Flexoki
Light at base 14 and 16.

## NSH accounts & settings

Adding a mailbox (`src/features/accounts/`) is two pages in the main window:
the chooser ("Add a mailbox" / "Which kind?", one row per provider with its
mark, name and summary; a provider that cannot be added is dimmed and says why
in words) and the provider's form. A new mailbox is a working row in the
registry until its form saves an address; leaving by Back, Escape or the
chooser drops a row that never got one. Every form keeps the Qt client's
order and copy: what the provider is, the fields, the one primary action
(Connect the mailbox, Sign in with Google..., Sign in with Microsoft...,
Sign in to HEY...), progress in words, the error under the fields, then Sign
out and Remove account apart at the foot. Actions that leave for a browser or
another page end in "...". Secrets are typed into masked fields and leave
them once stored; a form never shows one back.

Settings (`src/features/settings/`) follows NsVim's settings layout: a 44pt
header (Back, the title) across the page; under it, from 760pt up, the
sections' rail (230pt, on `muted`, a hairline on its inner edge, ui `NavRow`)
and one scrolling column of rows, `px-6`, sections 24 apart under caption
headings: Mail backend, Default mail client (Linux only), Appearance, Reading,
Notifications, Writing, Mailboxes, Calendars (the calendar feature's
`CalendarSettings`, with its own headings), Google OAuth client, AI, Keyboard.
Every setting is a ui `SettingRow`: at least 44 tall, its name and what it
costs or means on the left, the control on the right, a hairline under it, so
titles and controls keep two spines (preview.test.tsx asserts them). On / off
settings are square checkboxes named by the row, numbers are steppers, and
Theme is a segmented System / Light / Dark / Omarchy. A mailbox row's second
line is its session's error, "Signed out", or its unread count, with the
address in front when the row shows a name.

### Motion inventory

| Change | Tool | Tokens |
| --- | --- | --- |
| Chooser, a setup form or Settings opens | `createMotion` `enterRise(DISTANCE.page)` on the page column | `DURATION.normal`, `DISTANCE.page`; none under reduced motion |
| Hover, press and focus of provider rows, buttons and the rail | the ui `PickerRow`, `ui` `Button` and the ui `NavRow` (`CLASS.wash`, `CLASS.press`) | `DURATION.fast`, `SCALE.press` |
| Rail selection moves to another section | `NavRow` `selected` fill, and the column scrolls to the section with `reveal({ vertical: "start" })` (animated) | the platform's scroll animation; instant under reduced motion |
| Theme, reader mode and message direction change | ui `SegmentedControl`: its indicator slides | the core's indicator animation, instant under reduced motion |
| Switches | `ui` `Switch` thumb slide | 140 ms, the control's own |
| Server settings, Gmail "Need more detail?" open and close | instant swap; the toggle's chevron and label say which | none: a disclosure of form fields |
| A Gmail step completes | the step collapses to its done line ("Client connected · ...", "Signed in as ...") with a check mark | instant swap; the words carry it |
| Sign-in in progress | spinner glyph (`animate-spin`, off under `motion-reduce`) beside the words of the stage | continuous while waiting |
| Device code appears (Outlook, Microsoft 365, the Graph second code) | the code box replaces the progress line; the Graph code says it is "One more code" | instant; announced politely |
| Default mail client set or undone | the row's title and button swap words; a toast says what changed | instant; the toaster's motion |
| Error under the fields | `Notice` tone danger | `Notice`'s `enterRise` |
| Saved, signed in, copied | nsh-omarchy toast | the toaster's motion |
| Remove account? | `ui` `confirm` (`AlertDialog` in the `ConfirmHost`) | the control's own motion |
| Select (agent, mailbox), number fields | `ui` `Select`, `NumberInput` | the controls' own motion |

## Analytics consent

The startup permission uses the shared AlertDialog entrance and scrim, with focus on “Don’t allow”. Both choices use the shared button hover and press states. Settings → Privacy uses the shared Checkbox wash and checkmark for on/off feedback. With reduced motion, the dialog appears immediately and controls retain their state feedback.
