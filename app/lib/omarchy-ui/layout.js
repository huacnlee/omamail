// @ts-check

import { div, svg } from "gpui";
import { h_flex, v_flex } from "gpui-base";
import { resolveSurfaceColor, style } from "./style.js";
import { role } from "./theme.js";

// Type sizes are the shell's own scale in pixels, not rem: Omarchy sets a
// 12px monospace root and every token derives from it, so a window that talks
// in rem is sized by gpui's idea of a root rather than by the desktop's.

/** @param {string | number} value @param {import("gpui").Context} cx */
export const label = (value, cx) =>
  div()
    .text_size(style().font.body)
    .line_height(1.35)
    .text_color(cx.theme().colors.foreground)
    .child(value);

/** @param {string | number} value @param {import("gpui").Context} cx */
export const muted = (value, cx) =>
  div()
    .text_size(style().font.body)
    .line_height(1.35)
    .text_color(cx.theme().colors.muted_foreground)
    .child(value);

/** @param {string} value @param {import("gpui").Context} cx */
export const title = (value, cx) =>
  div()
    .text_size(style().font.title)
    .text_color(cx.theme().colors.foreground)
    .child(value);

/**
 * A section rule's caption — "LABELS" over the user's own folders. Upper-case
 * at the caption size and never bold: on a monospace face the weight change is
 * the loud part, and the case already says this is a heading.
 * @param {string} value @param {import("gpui").Context} cx
 */
export const sectionLabel = (value, cx) =>
  div()
    .text_size(style().font.caption)
    .text_color(cx.theme().colors.muted_foreground)
    .child(String(value).toUpperCase());

/**
 * A compact header for a bordered or tiled region.
 * @param {string} id
 * @param {any} heading
 * @param {any} actions
 * @param {import("gpui").Context} cx
 */
export const panelHeader = (id, heading, actions, cx) =>
  h_flex()
    .id(id)
    .role("section_header")
    .flex_none()
    .items_center()
    .justify_between()
    .gap(style().spacing.controlGap)
    .h(style().space(34))
    .px(style().spacing.rowPaddingX)
    .border_b(style().spacing.hairline)
    .border_color(role("separator", cx.theme().colors.border))
    .children([heading, actions].filter(Boolean));

/**
 * Identity first, controls after: the mark and the name say what this window
 * is, and everything to their right does something.
 *
 * The mark is two stacked files rather than one — gpui paints an SVG as a
 * single mask in the element's text colour, so the envelope and the M inside it
 * cannot be two colours from inside one file. The M is what makes this the mail
 * mark rather than a generic envelope, and it carries the theme accent.
 *
 * The name goes when the window is narrow. The mark still says which window
 * this is, and at that width the row is needed for the search field.
 * @param {import("gpui").Context} cx
 * @param {{compact?: boolean}} [options]
 */
export const brandLockup = (cx, options = {}) => {
  const tokens = style();
  const extent = tokens.font.iconLarge;
  return h_flex()
    .id("application-brand")
    .flex_none()
    .items_center()
    .gap(tokens.space(8))
    .child(
      div()
        .relative()
        .flex_none()
        .size(extent)
        .text_color(cx.theme().colors.foreground)
        .child(svg("assets/icons/gmail-envelope.svg").flex_none().size(extent))
        .child(
          svg("assets/icons/gmail-mark.svg")
            .absolute()
            .inset_0()
            .size(extent)
            .text_color(cx.theme().colors.primary),
        ),
    )
    .when(!options.compact, (lockup) =>
      lockup.child(
        div()
          .flex_none()
          .text_size(tokens.font.title)
          .text_color(cx.theme().colors.foreground)
          .child("Omamail"),
      ),
    );
};

/**
 * The window's own surface, and the one place the desktop's typography is
 * declared: gpui has no font alias support, so the family the host resolved
 * from fontconfig is set here and inherited by everything below.
 * @param {import("gpui").Context} cx
 */
export const appFrame = (cx) =>
  v_flex()
    .id("application-frame")
    .size_full()
    .min_w_0()
    .min_h_0()
    .font_family(style().fontFamily)
    .text_size(style().font.body)
    .bg(cx.theme().colors.background)
    .text_color(cx.theme().colors.foreground);

/**
 * @param {{brand?:any,center?:any,actions?:any}} options
 * @param {import("gpui").Context} cx
 */
export const topBar = (options, cx) =>
  h_flex()
    .id("application-top-bar")
    .h(style().space(48))
    .flex_none()
    .items_center()
    .justify_between()
    .gap(style().space(14))
    .px(style().space(14))
    .border_b(style().spacing.hairline)
    .border_color(role("separator", cx.theme().colors.border))
    .bg(cx.theme().colors.background)
    .children([options.brand, options.center, options.actions].filter(Boolean));

/**
 * @param {{status?:any,hints?:any,leadsWithIcon?:boolean}} options
 * @param {import("gpui").Context} cx
 */
export const bottomBar = (options, cx) =>
  h_flex()
    .id("application-bottom-bar")
    .h(style().space(28))
    .flex_none()
    .items_center()
    .justify_between()
    .gap(style().spacing.controlGap)
    // Not a uniform inset. `App.qml` anchors the rail toggle 8 from the left
    // and the status text at either `railToggle.right + 8` or, with no toggle,
    // 14 from the edge — so a 24-square icon button starts at 8 and its glyph
    // lands on the same 14 the text would have. Padding the bar itself at 14
    // put the toggle six pixels right of where every other left edge in the
    // window sits, which is exactly where the eye catches it.
    .pl(style().space(options.leadsWithIcon === true ? 8 : 14))
    .pr(style().space(12))
    .border_t(style().spacing.hairline)
    .border_color(role("separator", cx.theme().colors.border))
    .bg(cx.theme().colors.background)
    .children([options.status, options.hints].filter(Boolean));

/**
 * A page-local command bar. Domain commands remain owned by the caller.
 * @param {string} id
 * @param {{actions?:any,status?:any,hints?:any}} options
 * @param {import("gpui").Context} cx
 */
export const actionBar = (id, options, cx) =>
  h_flex()
    .id(id)
    .role("toolbar")
    .flex_none()
    .items_center()
    .gap(style().spacing.controlGap)
    .px(style().spacing.panelPadding)
    .py(style().spacing.sm)
    .border_t(style().spacing.hairline)
    .border_color(role("separator", cx.theme().colors.border))
    .children([options.actions].filter(Boolean))
    .child(div().flex_1())
    .children([options.status, options.hints].filter(Boolean));

/**
 * The window: a strip on top, the work in the middle, a line at the bottom.
 *
 * Both strips are optional. Composing takes the header away — the form carries
 * its own title band, and a window header above it would be two answers to
 * "what am I looking at".
 * @param {{top?:any,content:any,bottom?:any}} options
 * @param {import("gpui").Context} cx
 */
export const appShell = (options, cx) =>
  appFrame(cx)
    .children([options.top].filter(Boolean))
    .child(
      v_flex()
        .id("application-content")
        .flex_1()
        .min_w_0()
        .min_h_0()
        .overflow_hidden()
        .child(options.content),
    )
    .children([options.bottom].filter(Boolean));

/**
 * The single scroll owner for a centered settings, setup, or detail page.
 * @param {string} id
 * @param {any} content
 * @param {import("gpui").Context} cx
 */
export const centeredWorkspace = (id, content, cx) =>
  h_flex()
    .id(id)
    // Top-aligned, not centred on the cross axis: `h_flex` centres by default,
    // and a page taller than the window would then hang off the top with its
    // first line unreachable above the scroll.
    .items_start()
    .size_full()
    .min_w_0()
    .min_h_0()
    .justify_center()
    .overflow_y_scroll()
    .child(content);

/**
 * A readable-width page column for form and settings content.
 * @param {string} id
 * @param {import("gpui").Context} cx
 * @param {{maxWidth?:import("gpui").DefiniteLength}} [options]
 */
export const pageColumn = (id, cx, options = {}) =>
  v_flex()
    .id(id)
    .w_full()
    // The QML's own reading width for a form. Wider than this and a helper
    // line runs past the distance an eye tracks back comfortably; the window
    // is roomy, the column is not.
    .max_w(options.maxWidth ?? style().space(560))
    .gap(style().spacing.panelGap)
    .p(style().spacing.panelPadding);

/** @param {import("gpui").Context} cx */
export const surface = (cx) =>
  v_flex()
    .min_w_0()
    .min_h_0()
    .bg(cx.theme().colors.surface)
    .border(style().spacing.hairline)
    .border_color(cx.theme().colors.border)
    .rounded(style().cornerRadius)
    .overflow_hidden();

/**
 * A menu or popover card.
 *
 * Its ground and its edge are their own theme roles rather than the window's:
 * a card floating over the mailbox has to read as a separate surface, and
 * Omarchy's `[popups]` section says so per theme — typically the compositor's
 * own active-window border, so a menu's edge matches the frame Hyprland draws
 * around the window it belongs to.
 * @param {string} id @param {import("gpui").Context} cx
 */
export const popupSurface = (id, cx) => {
  const tokens = style();
  return v_flex()
    .id(id)
    .flex_none()
    .p(tokens.space(4))
    .gap(tokens.space(2))
    .rounded(tokens.cornerRadius)
    .bg(
      resolveSurfaceColor(
        tokens,
        tokens.surfaces.popupBackground,
        cx.theme().colors.background,
        tokens.surfaces.popupBackgroundAlpha,
      ),
    )
    .border(tokens.state.normalBorderWidth)
    .border_color(
      resolveSurfaceColor(
        tokens,
        tokens.surfaces.popupBorder,
        cx.theme().colors.ring,
        tokens.surfaces.popupBorderAlpha,
      ),
    )
    .text_color(
      resolveSurfaceColor(
        tokens,
        tokens.surfaces.popupText,
        cx.theme().colors.foreground,
      ),
    );
};
