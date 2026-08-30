// @ts-check

import { defaultKey, normalizeKey } from "../calendar/Palette.js";
import { alpha, role, style } from "../lib/omarchy-ui/index.js";

/**
 * `alpha`, `mix` and the palette file all answer in `#rrggbbaa`, which is a
 * `Color` the compiler cannot see is one. One cast, here, rather than at every
 * call that paints with a derived tone.
 * @param {string} value
 * @returns {import("gpui").Color}
 */
export const color = (value) =>
  /** @type {import("gpui").Color} */ (/** @type {unknown} */ (value));

/**
 * The colour roles the calendar draws with, named as `App.qml` named the
 * properties it handed to `CalendarView`.
 *
 * The grid's rules and the today marker are theme tokens rather than literals:
 * `calendarBorder` is `Style.normalBorderColor`, the foreground at the theme's
 * border alpha, and `calendarTodayBackground` is `Style.selectedAccentFill`,
 * the accent at the theme's selected-fill alpha. The three Omarchy roles gpui's
 * seventeen tokens have no room for are read from the palette beside the theme,
 * falling back to the token that carries the same meaning where no Omarchy
 * palette has been read at all.
 * @param {import("gpui").Context} cx
 */
export function calendarRoles(cx) {
  const colors = cx.theme().colors;
  const accent = role("accent", colors.primary);
  return {
    text: colors.foreground,
    background: colors.background,
    accent,
    urgent: role("urgent", colors.destructive),
    dim: role("dim", colors.muted_foreground),
    // `calendarBorder`
    border: colors.border,
    // `calendarTodayBackground`
    today: color(alpha(accent, style().state.selectedFillAlpha)),
    // `calendarBorderWidth`
    borderWidth: style().state.normalBorderWidth,
  };
}

/**
 * `CalendarPalette.colorFor`: a calendar's colour is one of the desktop
 * palette's own ANSI slots, so two calendars are told apart in the theme's own
 * hues rather than in colours this window invented. Where the desktop published
 * no palette the three roles the QML fell back to still stand, so an urgent
 * slot stays urgent and everything else reads as secondary.
 * @param {Record<string, string> | undefined} palette
 * @param {string} key
 * @param {import("gpui").Context} cx
 */
export function slotColor(palette, key, cx) {
  const normalized = normalizeKey(key);
  const value = palette ? palette[normalized] : "";
  if (typeof value === "string" && value !== "") return color(value);
  const roles = calendarRoles(cx);
  if (normalized === "red") return roles.urgent;
  if (normalized === "accent") return roles.accent;
  return roles.dim;
}

/**
 * The colour an event is drawn in: its calendar's slot. Which slot a source
 * holds is a fact about the configured calendars, so the controller answers it;
 * an event from a source nobody configured falls to the same hash the source
 * list would have given it.
 * @param {any} model @param {any} event @param {import("gpui").Context} cx
 */
export function eventColor(model, event, cx) {
  const sourceId = String(event?.sourceId || "");
  const key =
    typeof model.colorKeyFor === "function"
      ? model.colorKeyFor(sourceId)
      : defaultKey(sourceId);
  return slotColor(model.palette, key, cx);
}

// A chip is its calendar's colour at an alpha, and the selected one is the same
// colour louder behind a heavier outline. Colour alone never carries the
// selection: a theme can put two calendars close enough together that a shade
// change is the only difference, and a shade change is not a state.
export const CHIP_FILL = 0.15;
export const CHIP_SELECTED_FILL = 0.28;
export const BLOCK_FILL = 0.17;
export const BLOCK_SELECTED_FILL = 0.3;
export const ALL_DAY_FILL = 0.16;

/**
 * The fill, border colour and border width one event chip is drawn with.
 * @param {any} model @param {any} event @param {import("gpui").Context} cx
 * @param {{fill:number,selectedFill:number}} alphas
 */
export function chipSurface(model, event, cx, alphas) {
  const own = eventColor(model, event, cx);
  const selected =
    String(event?.uid || "") !== "" &&
    String(event?.uid || "") === String(model.selectedEventId || "");
  const roles = calendarRoles(cx);
  return {
    color: own,
    selected,
    fill: color(alpha(own, selected ? alphas.selectedFill : alphas.fill)),
    // The QML wrote 1 and 2; both follow the theme's rule width so a desktop
    // that draws heavier borders draws heavier chips too.
    borderWidth: selected ? roles.borderWidth * 2 : roles.borderWidth,
  };
}
