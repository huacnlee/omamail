import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui as ShellUi
import "../theme"

// The shell's NumberField, drawn in the window's own theme.
//
// The label and the value are the base's, in the base's colours; the one part
// it paints from Style's baked state tokens is the spin box's own background.
// The base publishes that box as `field`, so a theme picked here replaces its
// background with an equivalent surface and leaves the stepper, the editing,
// the validation and the keyboard behaviour alone.
ShellUi.NumberField {
  id: root

  foreground: Paint.active ? Paint.foreground : Commons.Color.foreground
  accent: Paint.active ? Paint.accent : Commons.Color.accent

  // Only used with a theme picked.
  readonly property bool focusedField: root.field !== undefined && root.field !== null
    ? root.field.activeFocus : false

  readonly property Item themeBackground: Rectangle {
    color: Paint.controlFill(root.focusedField, false, root.foreground, root.accent)
    radius: Style.cornerRadius
    border.width: Paint.controlBorderWidth(root.focusedField, false)
    border.color: root.focusedField
      ? Paint.focusBorderFor(root.foreground, root.accent)
      : Paint.normalBorderFor(root.foreground, root.accent)
  }

  // A host whose NumberField publishes no `field` keeps its own background;
  // the rest — label, value, geometry — is already the window's colours.
  Binding {
    target: root.field !== undefined && root.field !== null ? root.field : root
    property: "background"
    when: Paint.active && root.field !== undefined && root.field !== null
    restoreMode: Binding.RestoreBindingOrValue
    value: root.themeBackground
  }

  // The text the spin box is edited in is the base's own item, and the tint on
  // a selection is taken from Style's baked `[controls]` tokens. While a theme
  // is picked the tint is the window's; with Follow Omarchy the base's own
  // binding is put back.
  Binding {
    target: root.field !== undefined && root.field !== null ? root.field.contentItem : root
    property: "selectionColor"
    when: Paint.active && root.field !== undefined && root.field !== null
      && root.field.contentItem !== undefined && root.field.contentItem !== null
    restoreMode: Binding.RestoreBindingOrValue
    value: Paint.selectionFillFor(root.foreground, root.accent)
  }
}
