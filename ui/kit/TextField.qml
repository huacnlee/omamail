import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui as ShellUi
import "../theme"

// The shell's TextField, drawn in the window's own theme.
//
// The field's foreground, accent and selection tint are public and are simply
// passed on. Its background is a BorderSurface painted from Style's state
// tokens, and those carry the desktop theme's hex — so with a theme picked the
// wrapper paints an equivalent surface itself. Padding, focus behaviour,
// editing and selection are the base's: only the two colours of the rectangle
// behind the text are ours.
ShellUi.TextField {
  id: root

  foreground: Paint.active ? Paint.foreground : Commons.Color.foreground
  accent: Paint.active ? Paint.accent : Commons.Color.accent

  readonly property bool themed: Paint.active

  // Only meaningful with a theme picked; with Follow Omarchy the base's own
  // background, selection tint and placeholder colour are untouched.
  readonly property Item themeBackground: Rectangle {
    color: Paint.controlFill(root.activeFocus, root.hovered || root.hasCursor, root.foreground, root.accent)
    radius: Style.cornerRadius
    border.width: Paint.controlBorderWidth(root.activeFocus, root.hovered || root.hasCursor)
    border.color: root.activeFocus ? Paint.focusBorderFor(root.foreground, root.accent)
      : (root.hovered || root.hasCursor ? Paint.hoverBorderFor(root.foreground, root.accent)
        : Paint.normalBorderFor(root.foreground, root.accent))
  }

  Binding {
    target: root
    property: "background"
    when: Paint.active
    restoreMode: Binding.RestoreBindingOrValue
    value: root.themeBackground
  }

  // The kit's own tint is the selected fill from those same baked tokens.
  Binding {
    target: root
    property: "selectionTint"
    when: Paint.active && root.selectionTint !== undefined
    restoreMode: Binding.RestoreBindingOrValue
    value: Paint.selectionFillFor(root.foreground, root.accent)
  }

  // A placeholder is a hint, not content: the base dims the foreground, which
  // follows the window already. Nothing to do here in either mode.
}
