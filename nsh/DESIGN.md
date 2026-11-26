# Omamail NSH design

The NSH client keeps the Qt app's design (`../docs/DESIGN.md`): compact, mail
content first, a narrow sidebar, a dense list and a wide reader. What changes is
the toolkit: controls come from `nsh-omarchy`, colors from `theme.json`.

## Foundations

- **Components.** `nsh-omarchy` supplies every general control (Sidebar,
  ResizablePanelGroup, IconButton, EmptyState, TitleBar, Menu, Dialog, Input…).
  `src/ui/` only holds mail-specific compositions (`MessageRow`). Screens never
  style a control themselves; a missing look becomes a variant in `src/ui/`.
- **Colors.** `theme.json` is NsVim's default palette mapped onto the Omarchy
  token names (`surface`, `inset`, `text-secondary`, `omarchy-accent`, …), plus
  Omamail's own roles: `unread` and `star`. Presentation code uses token
  classes only, never hex values.
- **Icons.** Every symbol is an `Icon` from `nsh-omarchy`; no emoji.
- **State is not color alone.** Unread is a dot and a bold sender and subject;
  starred is a star icon with a label for screen readers.

## Motion inventory

| Screen | Change | Tool | Tokens |
| --- | --- | --- | --- |
| Sidebar | Selected mailbox moves | `SidebarItem` selection fill (nsh-omarchy) | its own |
| Sidebar | Hover over a mailbox | `SidebarItem` hover wash | its own |
| Message list | Hover over a row | `hover:bg-accent` | instant, as list rows in the Qt app |
| Message list | Selected row | `bg-selection` swap | instant: selection must follow `j`/`k` without lag |
| Message list | Pull to refresh (touch) | `List` `refreshing` | platform |
| Reader | A message opens | content swap | none yet; P1 adds a short fade on the body (150 ms, honours reduced motion) |
| Panes | Resize | `ResizablePanelGroup` drag | follows the pointer |

Not done yet, listed so it is not forgotten: the row's exit when a message is
archived or deleted (P1, `LayoutAnimation`), the compose sheet (P2).
