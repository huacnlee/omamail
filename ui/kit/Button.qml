import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui as ShellUi
import "../theme"

// The shell's Button, drawn in the window's own theme.
//
// Two things are re-pointed. The fill comes from Paint, because the kit reads
// its state colours from Style's `[controls]` tokens — which Omarchy renders
// with the desktop theme's hex baked in, so a passed foreground is ignored.
// And the chosen state is `chosen` rather than `selected`, because `selected`
// also selects the label's colour from those same baked tokens and the base
// keeps that colour private. A chosen button therefore draws the selected fill
// itself, with its label in the colour the caller passed.
//
// In Follow Omarchy everything here delegates, `selected` is `chosen`, and the
// button is the shell's button: the same bindings, the same colours.
ShellUi.Button {
  id: root

  // Held while this button is the chosen one of a set. Never the only sign of
  // it: callers show it in shape or weight as well, because a theme can put the
  // selected fill close enough to the normal one that colour alone says nothing.
  property bool chosen: false

  foreground: Paint.active ? Paint.foreground : Commons.Color.foreground
  accent: Paint.active ? Paint.accent : Commons.Color.accent

  // Following Omarchy this is the kit's own chosen state, unchanged. With a
  // theme picked the base's selected colour is the desktop's, so the fill is
  // painted here instead (see the binding below) and the label stays legible.
  selected: !Paint.active && root.chosen

  // The kit's own MouseArea is private, so a passive handler watches the same
  // press to know when to paint the pressed fill.
  readonly property bool pressing: press.pressed

  TapHandler {
    id: press
    acceptedButtons: Qt.LeftButton | Qt.RightButton
  }

  Binding {
    target: root
    property: "color"
    when: Paint.active
    restoreMode: Binding.RestoreBindingOrValue
    // The kit's own ladder, in its own order: pressed, focus, hover, chosen,
    // then whatever background the caller set.
    value: root.pressing ? Paint.pressedFillFor(root.foreground, root.accent)
      : (root.focusable && root.activeFocus ? Paint.focusFillFor(root.foreground, root.accent)
        : (root.hot ? Paint.hoverFillFor(root.foreground, root.accent)
          : (root.chosen ? Paint.selectedFillFor(root.foreground, root.accent)
            : root.background)))
  }
}
