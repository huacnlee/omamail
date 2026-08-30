// @ts-check

import { View } from "gpui";
import { InputState } from "gpui-base";
import {
  appFrame,
  appShell,
  actionBar,
  bottomBar,
  button,
  centeredWorkspace,
  emptyState,
  field,
  fieldRow,
  formField,
  glyphButton,
  iconButton,
  kbd,
  menuItem,
  rowShell,
  pageColumn,
  panelHeader,
  statusLine,
  surface,
  topBar,
  title,
} from "./lib/omarchy-ui/index.js";

export default class OmarchyUiFixture extends View {
  /** @type {import("gpui-base").InputState} */
  input = /** @type {import("gpui-base").InputState} */ (
    /** @type {unknown} */ (null)
  );

  init() {
    this.input = InputState.new({ placeholder: "Filter" });
  }

  /** @param {import("gpui").Context} cx */
  render(cx) {
    const content = centeredWorkspace(
      "fixture-workspace",
      pageColumn("fixture-column", cx)
        .child(
          surface(cx)
            .child(
              panelHeader(
                "fixture-panel-header",
                title("Omarchy UI", cx),
                glyphButton("fixture-glyph", "×", "Close", () => {}, cx),
                cx,
              ),
            )
            .child(statusLine("Connected", "ready", cx))
            .child(
              fieldRow(
                "fixture-field-row",
                "Filter",
                field(this.input, cx),
                cx,
              ),
            )
            .child(
              formField(
                "fixture-form-field",
                "Query",
                field(this.input, cx),
                cx,
              ),
            )
            .child(rowShell("fixture-row", true, cx).child("Selected row"))
            .child(
              // Bordered, not accent-filled: the Omarchy kit has no primary
              // variant, and a solid accent block is louder than anything else
              // on the desktop.
              button("fixture-action", "Continue", () => {}, cx, {
                bordered: true,
              }),
            )
            .child(
              iconButton(
                "fixture-icon",
                "assets/gmail.svg",
                "Open menu",
                () => {},
                cx,
              ),
            )
            .child(
              menuItem("fixture-menu", "Settings…", () => {}, cx, {
                detail: "Cmd + ,",
              }),
            )
            .child(kbd("Cmd + K", cx)),
        )
        .child(emptyState("Nothing here", "Add an item to continue", cx))
        .child(
          actionBar(
            "fixture-action-bar",
            {
              actions: button("fixture-save", "Save", () => {}, cx),
              status: statusLine("Saving…", "loading", cx),
            },
            cx,
          ),
        ),
      cx,
    );
    return appShell(
      {
        top: topBar({ brand: title("Omarchy UI", cx) }, cx),
        content,
        bottom: bottomBar({ status: statusLine("Connected", "ready", cx) }, cx),
      },
      cx,
    );
  }
}
