// @ts-check

// The controls a settings row is made of.
//
// Two of them — the switch and the number field — are ports of shell controls
// the kit does not carry yet (`Ui/ToggleSwitch.qml`, `Ui/NumberField.qml`).
// They are written against `style()` tokens rather than invented sizes, so
// when the kit grows them this file can hand them over unchanged.

import { div } from "gpui";
import { Button as BaseButton, h_flex, v_flex } from "gpui-base";
import {
  Button,
  Label,
  MutedText,
  SectionLabel,
  TextField,
  alpha,
  style,
} from "omarchy-ui";

/**
 * `remoteImages` → `remote-images`, so an id reads like the rest of them.
 * @param {string} value
 */
export function kebab(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * `Ui/ToggleSwitch.qml`: a track with a knob, and no label of its own.
 *
 * Never colour alone — the knob moves, the track's fill steps from the
 * theme's normal alpha to its selected one, and the control carries a `switch`
 * role. Some themes put the accent close enough to the foreground that a
 * recoloured knob says nothing at all.
 *
 * @param {string} id
 * @param {boolean} checked
 * @param {string} description
 * @param {(event: import("gpui").ClickEvent, cx: import("gpui").Context) => void} onToggle
 * @param {import("gpui").Context} cx
 * @param {{disabled?: boolean}} [options]
 */
export function toggleSwitch(
  id,
  checked,
  description,
  onToggle,
  cx,
  options = {},
) {
  const tokens = style();
  const state = tokens.state;
  const disabled = options.disabled === true;
  const foreground = cx.theme().colors.foreground;
  // ToggleSwitch.qml's own derivation, so the switch is the size the shell
  // draws it at whatever control height the theme asked for.
  const trackHeight = Math.max(
    22,
    Math.round(tokens.spacing.controlHeight * 0.55),
  );
  const trackWidth = Math.round(trackHeight * 1.9);
  const knobSize = Math.max(6, Math.round(trackHeight * 0.72));
  const knobInset = Math.max(1, Math.round((trackHeight - knobSize) / 2));
  // Pill on a rounded desktop, square on a sharp one — the switch follows
  // Hyprland's rounding the way every other corner in the window does.
  const round = tokens.cornerRadius > 0;
  return BaseButton.new(id)
    .role("switch")
    .disabled(disabled)
    .selected(checked)
    .accessibility_label(description)
    .tooltip(description)
    .flex()
    .flex_none()
    .items_center()
    .w(trackWidth)
    .h(trackHeight)
    .p(knobInset)
    .rounded(round ? Math.round(trackHeight / 2) : tokens.cornerRadius)
    .border(state.normalBorderWidth)
    .border_color(
      alpha(
        foreground,
        checked ? state.selectedBorderAlpha : state.normalBorderAlpha,
      ),
    )
    .bg(
      alpha(
        foreground,
        checked ? state.selectedFillAlpha : state.normalFillAlpha,
      ),
    )
    .when(checked, (track) => track.justify_end())
    .when(!checked, (track) => track.justify_start())
    .when(!disabled, (track) => track.on_click(onToggle))
    .when(!disabled, (track) =>
      track.hover((appearance) =>
        appearance.bg(
          alpha(
            foreground,
            checked ? state.pressedFillAlpha : state.hoverFillAlpha,
          ),
        ),
      ),
    )
    .when(disabled, (track) => track.opacity(0.4))
    .child(
      // The knob is the foreground when the switch is on and a dimmed
      // foreground when it is off, which is what `ToggleSwitch.qml` draws: the
      // shell's `selected-color` token names the foreground, not the accent,
      // and a control this size in the accent is louder than the marks the
      // accent is reserved for.
      div()
        .flex_none()
        .size(knobSize)
        .rounded(round ? Math.round(knobSize / 2) : tokens.cornerRadius)
        .bg(checked ? foreground : cx.theme().colors.muted_foreground),
    );
}

/**
 * `Ui/NumberField.qml`: a caption naming the unit, and under it a bordered box
 * holding the value with its two steppers stacked at the right edge.
 *
 * gpui has no editable numeric field, so the value is stepped rather than
 * typed. That is why the unit belongs in the caption and not in the box: a
 * number the keyboard cannot reach has to be readable at a glance, and
 * "3600 seconds" does not fit the kit's field width.
 *
 * @param {string} id
 * @param {{value:number,min:number,max:number,step:number,label:string,unit?:string,disabled?:boolean}} model
 * @param {(direction:number, cx: import("gpui").Context) => void} onStep
 * @param {import("gpui").Context} cx
 */
export function numberField(id, model, onStep, cx) {
  const tokens = style();
  const state = tokens.state;
  const foreground = cx.theme().colors.foreground;
  const disabled = model.disabled === true;
  // Built here rather than from `glyphButton`, which is a square command with
  // its own padding and rounding: a stepper is half a control tall and shares
  // its box with the value, so forcing those two shapes together is what left
  // the arrows as specks jammed against the number.
  /** @param {string} suffix @param {string} glyph @param {number} direction @param {boolean} stop */
  const stepper = (suffix, glyph, direction, stop) => {
    const stopped = disabled || stop;
    return BaseButton.new(`${id}-${suffix}`)
      .disabled(stopped)
      .accessibility_label(
        `${direction > 0 ? "Increase" : "Decrease"} ${model.label}`,
      )
      .flex()
      .items_center()
      .justify_center()
      .flex_none()
      .w(tokens.space(16))
      .h(Math.floor(tokens.spacing.controlHeight / 2))
      .text_size(tokens.font.caption)
      .text_color(cx.theme().colors.muted_foreground)
      .when(!stopped, (element) =>
        element.on_click((_event, eventCx) => onStep(direction, eventCx)),
      )
      .when(!stopped, (element) =>
        element.hover((appearance) =>
          appearance
            .bg(alpha(foreground, state.hoverFillAlpha))
            .text_color(foreground),
        ),
      )
      .when(stopped, (element) => element.opacity(0.4))
      .child(glyph);
  };
  return (
    v_flex()
      .id(id)
      .flex_none()
      // `NumberField.qml` sets its own column spacing to `spacing.md`, which is
      // wider than the gap a field and its caption take elsewhere in the kit.
      .gap(tokens.spacing.md)
      .when(disabled, (column) => column.opacity(0.4))
      .when(Boolean(model.unit), (column) =>
        column.child(
          new MutedText(model.unit ?? "")
            .build(cx)
            .text_size(tokens.font.bodySmall),
        ),
      )
      .child(
        h_flex()
          .id(`${id}-field`)
          .role("spin_button")
          .accessibility_label(model.label)
          .items_center()
          .w(tokens.spacing.numberFieldWidth)
          .h(tokens.spacing.controlHeight)
          // Padding on the reading side only: the stepper column is flush to the
          // border, which is where a spin box puts it.
          .pl(tokens.spacing.controlPaddingX)
          .rounded(tokens.cornerRadius)
          .border(state.normalBorderWidth)
          .border_color(alpha(foreground, state.normalBorderAlpha))
          .bg(alpha(foreground, state.normalFillAlpha))
          .child(
            // Centred, the way `NumberField.qml` aligns its TextInput. Right
            // against the steppers it read as though the arrows belonged to the
            // digits rather than to the box.
            div()
              .flex_1()
              .min_w_0()
              .text_center()
              .text_size(tokens.font.body)
              .text_color(foreground)
              .child(String(model.value)),
          )
          .child(
            v_flex()
              .flex_none()
              .items_center()
              .child(stepper("increase", "▴", 1, model.value >= model.max))
              .child(stepper("decrease", "▾", -1, model.value <= model.min)),
          ),
      )
  );
}

/**
 * A two- or three-option enum as the options themselves, rather than as a
 * dropdown that hides the alternative behind a click. The selected one carries
 * the theme's selected fill and border, which is how every other chosen thing
 * in this window is drawn.
 *
 * @param {string} id
 * @param {{options:string[],value:string,label:string,disabled?:boolean}} model
 * @param {(option:string, cx: import("gpui").Context) => void} onSelect
 * @param {import("gpui").Context} cx
 */
export function choiceField(id, model, onSelect, cx) {
  const tokens = style();
  return h_flex()
    .id(id)
    .role("radio_group")
    .accessibility_label(model.label)
    .flex_none()
    .items_center()
    .gap(tokens.spacing.xxs)
    .children(
      model.options.map((option) =>
        new Button(`${id}-${kebab(option.replace(/\s+/g, "-"))}`)
          .label(option)
          .selected(option === model.value)
          .bordered()
          .disabled(model.disabled === true)
          .size("small")
          .onClick((_event, eventCx) => onSelect(option, eventCx))
          .build(cx),
      ),
    );
}

/**
 * A free-text setting. The window owns no text state of its own, so a host
 * that has not handed one down gets the stored value read-only rather than an
 * empty box that forgets what was typed into it.
 *
 * @param {string} id
 * @param {{value:string,label:string,state?:import("gpui-base").InputState,disabled?:boolean}} model
 * @param {import("gpui").Context} cx
 */
export function textField(id, model, cx) {
  const tokens = style();
  if (!model.state || model.disabled === true)
    return div()
      .id(id)
      .flex_none()
      .w(tokens.spacing.dropdownWidth)
      .text_right()
      .truncate()
      .text_size(tokens.font.bodySmall)
      .text_color(cx.theme().colors.muted_foreground)
      .child(model.value || "—");
  return new TextField()
    .state(model.state)
    .build(cx)
    .id(id)
    .accessibility_label(model.label)
    .flex_none()
    .w(tokens.spacing.dropdownWidth);
}

/**
 * The QML page's setting row: a title and its cost on the left, the control on
 * the right, on the theme's idle control fill.
 *
 * @param {string} id
 * @param {{label:string,detail:string}} entry
 * @param {any} control
 * @param {import("gpui").Context} cx
 */
export function preferenceRow(id, entry, control, cx) {
  const tokens = style();
  return h_flex()
    .id(id)
    .role("group")
    .items_center()
    .justify_between()
    .w_full()
    .min_w_0()
    .gap(tokens.spacing.xl)
    .px(tokens.spacing.rowPaddingX)
    .py(tokens.spacing.lg)
    .rounded(tokens.cornerRadius)
    .bg(alpha(cx.theme().colors.foreground, tokens.state.normalFillAlpha))
    .child(
      v_flex()
        .flex_1()
        .min_w_0()
        .gap(tokens.spacing.xxs)
        .child(
          new Label(entry.label).build(cx).text_size(tokens.font.bodySmall),
        )
        .child(
          new MutedText(entry.detail).build(cx).text_size(tokens.font.caption),
        ),
    )
    .child(control);
}

/**
 * A run of rows under one caption, the way the QML page separates reading from
 * writing from mailboxes.
 *
 * The caption is one more child of the page's own column in `SettingsPage.qml`,
 * so the air under it is the air between any two things on that page —
 * `space(16)`. A section whose rows carry their own rhythm, as the calendars
 * do, says so.
 * @param {string} id @param {string} caption @param {any[]} rows
 * @param {import("gpui").Context} cx @param {{gap?:number}} [options]
 */
export function settingsSection(id, caption, rows, cx, options = {}) {
  const tokens = style();
  return v_flex()
    .id(id)
    .role("group")
    .accessibility_label(caption)
    .w_full()
    .min_w_0()
    .gap(options.gap ?? tokens.space(16))
    .child(new SectionLabel(caption.toUpperCase()).strong(false).build(cx))
    .children(rows.filter(Boolean));
}
