// @ts-check

import { View } from "gpui";
import { InputState } from "gpui-base";
import {
  appFrame,
  button,
  emptyState,
  field,
  iconButton,
  kbd,
  menuItem,
  rowShell,
  statusLine,
  surface,
  title,
} from "./lib/omarchy-ui/index.js";

export default class OmarchyUiFixture extends View {
  /** @type {import("gpui-base").InputState} */
  input = /** @type {import("gpui-base").InputState} */ (/** @type {unknown} */ (null));

  init() {
    this.input = InputState.new({ placeholder: "Filter" });
  }

  /** @param {import("gpui").Context} cx */
  render(cx) {
    return appFrame(cx)
      .p(cx.theme().spacing.lg)
      .gap(cx.theme().spacing.md)
      .child(title("Omarchy UI", cx))
      .child(
        surface(cx)
          .child(statusLine("Connected", "ready", cx))
          .child(field(this.input, cx))
          .child(rowShell("fixture-row", true, cx).child("Selected row"))
          .child(button("fixture-action", "Continue", () => {}, cx, { variant: "primary" }))
          .child(iconButton("fixture-icon", "assets/omamail.svg", "Open menu", () => {}, cx))
          .child(menuItem("fixture-menu", "Settings…", () => {}, cx, { detail: "Cmd + ," }))
          .child(kbd("Cmd + K", cx)),
      )
      .child(emptyState("Nothing here", "Add an item to continue", cx));
  }
}
