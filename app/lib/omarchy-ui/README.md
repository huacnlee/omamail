# Omarchy UI for gpui-shell

Reusable ES-module presentation primitives for gpui-shell applications that follow Omarchy's visual and interaction language.

The package wraps `gpui-base` and reads every interface color, radius, and spacing value from `cx.theme()`. `theme.js` can project an Omarchy `colors.toml` file into gpui-base semantic tokens. Other modules grow from application-backed contract tests into domain-independent layout, control, data-view, and feedback surfaces.

Import only from `index.js` in application code. Pass stable domain IDs, content, state, and callbacks into the primitives; keep application navigation and domain decisions outside this package.

Asset paths are application-root-relative because gpui-shell resolves them from the directory containing `gpui-shell.json`. A consuming application owns any icon assets it passes to `iconButton` or `button`.
