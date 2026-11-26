# Omamail NSH client: design

The NSH client replaces the Qt/QML interface in `ui/` and `app/`. The Rust
backend stays as it is: the client starts `omamail serve` and speaks its
JSON-RPC protocol (see [docs/BACKEND.md](../docs/BACKEND.md)).

This file records the client's design rules. Change it in the same pull
request as the code it describes.

## Targets

Desktop first: macOS, Linux (Omarchy) and Windows, pointer and keyboard,
compact density. Mobile, web and TUI are not targets yet.

## Look

The client looks like the rest of Omarchy and like nsvim: square corners, one
accent, foreground-tinted state fills, compact desktop type, mono figures, and
an app-drawn title bar. It does not have a look of its own.

- **Components come from [`nsh-omarchy`](https://github.com/huacnlee/nsh-omarchy)**
  (`om::*`). Screens never build a button, list row, sidebar row, menu or input
  themselves. If a screen needs something nsh-omarchy lacks, add it there first.
- **Colors and sizes come from `nsh_omarchy::tokens`**, read in closures so they
  follow a theme change. The colors are the system's Omarchy theme, switched
  live; without Omarchy, Tokyo Night (dark) or Flexoki Light.
- `src/ui/mod.rs` only holds Omamail's layout sizes (row height, column widths).

## Layout

An `om::title_bar` over three columns:

| Column | Width | Content |
|---|---|---|
| Sidebar (`om::sidebar`) | 208 pt, fixed | Account as the section title, system mailboxes, inbox unread count in mono |
| Message list (`om::list` + `om::scrollbar`) | 360 pt, resizable, at least 260 | A 36 pt bar (mailbox, count, refresh), then 60 pt rows: square accent marker, sender and time, subject, snippet |
| Reader | the rest, at least 320; text at most 720 pt wide | Subject, sender in mono, the reading-mode body in a `TextView` |

The list and reader sit in an `om::resizable_panel_group`. Empty and loading
states use `om::empty_state`.

## Motion

Motion is nsh-omarchy's: `tokens::DURATION_FAST` 90 ms for hover and press
fills, `DURATION_BASE` 140 ms, `DURATION_SLOW` 220 ms, `PRESS_SCALE`. Reduced
motion makes every change instant.

### Motion inventory: main window

| State change | Tool | Tokens | Status |
|---|---|---|---|
| Pointer over a row, sidebar item or button: fill | nsh-omarchy hover fill | `DURATION_FAST` | Done (P0) |
| Press on any control | nsh-omarchy pressed fill | `DURATION_FAST` | Done (P0) |
| Focus by keyboard: accent border | nsh-omarchy focus border | — | Done (P0) |
| Selecting a mailbox or message: selected fill moves | nsh-omarchy selected fill | `DURATION_FAST` | Done (P0) |
| Selecting a message: reader content fades in | `AnimatedValue` opacity, 0 → 1 | `DURATION_BASE` | P1 |
| Pushed `mail.updated`: new rows insert at the top | list keyed by message id, `LayoutAnimation` | `DURATION_BASE` | Keys done; insert animation in P1 |
| Dragging the list/reader divider | `om::resizable_panel_group` | — | Done (P0) |

## Reader

`reader.open` (and `reader.render` when the open has no render) returns the
reading-mode document tree. `src/reader_html.rs` writes it back to HTML the
way the backend's `message::html::tree::serialize` does, and a `TextView`
shows it: selectable, links reported through `onLinkPress` and opened in
the system browser. Remote images are off until the user allows them (P1).

## Keyboard

Every control is an nsh-omarchy control, so Tab reaches it and Enter or
Space activates it. The full shortcut table from `docs/KEYS.md` moves into
the client in P1.
