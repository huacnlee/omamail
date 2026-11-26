# Omamail NSH client: design

The NSH client replaces the Qt/QML interface in `ui/` and `app/`. The Rust
backend stays as it is: the client starts `omamail serve` and speaks its
JSON-RPC protocol (see [docs/BACKEND.md](../docs/BACKEND.md)).

This file records the client's design rules. Change it in the same pull
request as the code it describes.

## Targets

Desktop first: macOS, Linux (Omarchy) and Windows, pointer and keyboard,
compact density. Mobile, web and TUI are not targets yet.

## Layout

Three columns in a `SplitView`:

| Column | Width | Content |
|---|---|---|
| Sidebar | 220 pt | Account, system mailboxes, unread count of the inbox |
| Message list | 340 pt | The mailbox's messages, virtualized |
| Reader | the rest, text at most 720 pt wide | Subject, sender, the reading-mode body in a `TextView` |

In a narrow window the split view shows one column at a time.

## Tokens

Colors come from the theme's semantic roles (`theme()`): `background`,
`foreground`, `muted`, `muted_foreground`, `accent`, `border`, `ring`,
`primary`, and the `sidebar_*` family. Omamail's own roles are read by name
and fall back to a standard role:

| Token | Use | Fallback |
|---|---|---|
| `unread` | The unread dot | `primary` |

Sizes live in `src/ui/theme.rs`: sidebar rows 30 pt, controls 28 pt,
message rows at least 72 pt. Corners use the theme's `radius`. No screen
writes a color, radius or size of its own.

## Components (`src/ui/`)

Screens use only these. If a screen needs a look that is missing, add a
variant here first.

| Component | Variants and states |
|---|---|
| `button` | Primary, Secondary, Ghost; Small, Regular; hover, pressed, focus ring, disabled |
| `icon_button` | Ghost; hover, pressed, focus ring; always has an accessibility label |
| `list_row` | Message row: unread dot and weight, selected, hover, pressed, focus ring |
| `sidebar_item` | Icon, label, count; selected, hover, pressed, focus ring |
| `segmented` | One of a few options; selected segment raised |
| `badge` | A count, hidden at zero |
| `menu` | Popover-colored popup with a border and shadow; items with hover |
| `search_input` | Muted field with a search icon; focus ring on the field |
| `icon` | Line icons drawn with `currentColor`, so they follow the text color |

## Motion

Tokens live in `src/ui/theme.rs`, `motion`: `FAST` 120 ms (hover and press),
`STANDARD` 200 ms (selection, content changes), pressed opacity 0.72. When the
system asks for reduced motion, all motion becomes an instant change.

### Motion inventory: main window

| State change | Tool | Tokens | Status |
|---|---|---|---|
| Pointer over a row, sidebar item or button: background wash | Native `hover` state style | `FAST` | Done (P0) |
| Press on any control: opacity drop | Native `active` state style | `PRESSED_OPACITY` | Done (P0) |
| Focus by keyboard: ring | Native `focus_visible` state style | — | Done (P0) |
| Selecting a mailbox: highlight moves to the new item | Native `selected` state; P1 slides one highlight with `LayoutAnimation` | `STANDARD` | Highlight done; slide in P1 |
| Selecting a message: reader content fades in | `AnimatedValue` opacity, 0 → 1 | `STANDARD` | P1 |
| Pushed `mail.updated`: new rows insert at the top | `virtual_list` keyed by message id, `LayoutAnimation` | `STANDARD` | Keys done; insert animation in P1 |
| Narrow window: column change | `SplitView` / `NavStack` native transition | Platform | Done (platform) |
| Menu opens from its trigger | `menu` popup's native presentation | Platform | Done (platform) |

## Reader

`reader.open` (and `reader.render` when the open has no render) returns the
reading-mode document tree. `src/reader_html.rs` writes it back to HTML the
way the backend's `message::html::tree::serialize` does, and a `TextView`
shows it: selectable, links reported through `onLinkPress` and opened in
the system browser. Remote images are off until the user allows them (P1).

## Keyboard

Every control is a `button` or `input`, so Tab reaches it and Enter or
Space activates it. The full shortcut table from `docs/KEYS.md` moves into
the client in P1.
