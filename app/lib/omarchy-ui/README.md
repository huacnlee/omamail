# Omarchy UI for gpui-shell

Reusable ES-module presentation primitives for gpui-shell applications that follow Omarchy's visual and interaction language.

The package wraps `gpui-base` and reads every interface color, radius, and spacing value from `cx.theme()`. `theme.js` can project an Omarchy `colors.toml` file into gpui-base semantic tokens. Other modules grow from application-backed contract tests into domain-independent layout, control, data-view, and feedback surfaces.

Import only from `index.js` in application code. Pass stable domain IDs, content, state, and callbacks into the primitives; keep application navigation and domain decisions outside this package.

The public layers are intentionally small:

- `layout.js`: application shell, fixed bars, panel headers, centered page workspaces, readable columns, and bordered surfaces.
- `controls.js`: semantic `gpui-base` buttons and inputs, icon commands, compact field rows, and settings-form rows.
- `data.js`: stable-ID list row presentation.
- `feedback.js`: empty and ready/loading/error states.
- `theme.js`: projection from the active Omarchy palette into semantic `gpui-base` tokens.

Pages compose these primitives instead of reproducing borders, spacing, hover, focus, disabled, selected, or status mechanics. The library owns presentation; the page owns domain state, stable IDs, copy, callbacks, and navigation.

Asset paths are application-root-relative because gpui-shell resolves them from the directory containing `gpui-shell.json`. A consuming application owns any icon assets it passes to `iconButton` or `button`.
