// @ts-check

// One window drawn only from `omarchy-ui`, for `gpui-shell check` to load.
//
// It carries no application state and no Omamail copy on purpose: what it
// proves is that the declared Git dependency resolves, that the classes the
// window is built from are the ones the package publishes, and that every
// required slot is filled the way the library asks. `make test-app` runs it
// through `tests/test_omarchy_ui_fixture.sh` with `entry` pointed here.

import { View } from "gpui";
import { InputState } from "gpui-base";
import {
  ActionBar,
  AppShell,
  Button,
  CenteredWorkspace,
  EmptyState,
  FieldRow,
  FormField,
  GlyphButton,
  IconButton,
  Keycap,
  KeyHints,
  ListRow,
  MenuItem,
  PageColumn,
  PanelHeader,
  StatusBar,
  StatusItem,
  Surface,
  TextField,
  Title,
  TitleBar,
} from "omarchy-ui";

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
    const panel = new Surface()
      .children([
        new PanelHeader("fixture-panel-header")
          .heading(new Title("Omarchy UI").build(cx))
          .actions(
            new GlyphButton("fixture-glyph")
              .glyph("×")
              .description("Close")
              .quiet()
              .onClick(() => {})
              .build(cx),
          )
          .build(cx),
        new StatusItem().label("Connected").state("ready").build(cx),
        new FieldRow("fixture-field-row")
          .label("Filter")
          .control(new TextField().state(this.input).build(cx))
          .build(cx),
        new FormField("fixture-form-field")
          .label("Query")
          .control(new TextField().state(this.input).build(cx))
          .build(cx),
        new ListRow("fixture-row").selected().build(cx).child("Selected row"),
        // Bordered, not accent-filled: the Omarchy kit has no primary variant,
        // and a solid accent block is louder than anything else on the desktop.
        new Button("fixture-action")
          .label("Continue")
          .bordered()
          .tooltip("Continue · Enter")
          .onClick(() => {})
          .build(cx),
        new IconButton("fixture-icon")
          .icon("assets/gmail.svg")
          .description("Open menu")
          .quiet()
          .onClick(() => {})
          .build(cx),
        // The active row: where the arrow keys have got to.
        new MenuItem("fixture-menu")
          .label("Settings…")
          .detail("Cmd + ,")
          .selected()
          .onClick(() => {})
          .build(cx),
        new Keycap("Cmd + K").build(cx),
      ])
      .build(cx);

    const content = new CenteredWorkspace("fixture-workspace")
      .content(
        new PageColumn("fixture-column")
          .children([
            panel,
            new EmptyState()
              .heading("Nothing here")
              .hint("Add an item to continue")
              .build(cx),
            new ActionBar("fixture-action-bar")
              .actions(
                new Button("fixture-save")
                  .label("Save")
                  .onClick(() => {})
                  .build(cx),
              )
              .status(
                new StatusItem()
                  .label("Saved")
                  .loadingLabel("Saving…")
                  .state("loading")
                  .build(cx),
              )
              .build(cx),
          ])
          .build(cx),
      )
      .build(cx);

    return new AppShell()
      .top(new TitleBar().brand(new Title("Omarchy UI").build(cx)).build(cx))
      .content(content)
      .bottom(
        new StatusBar()
          .status(new StatusItem().label("Connected").state("ready").build(cx))
          .hints(
            new KeyHints("fixture-hints")
              .hints([
                { key: "j", label: "Next" },
                { key: "k", label: "Previous" },
              ])
              .build(cx),
          )
          .build(cx),
      )
      .build(cx);
  }
}
