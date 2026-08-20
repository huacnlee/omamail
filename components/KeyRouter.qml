import QtQuick
import QtQml
import "../keys/Keymap.js" as Keymap

// Turns the key table into live Shortcuts, and reports what was pressed by id.
//
// One place decides whether a binding is live, so there is no per-line
// `enabled:` expression to copy wrongly — which is how a hand-written typing
// guard came to miss nine text fields. Escape is routed here like every other
// key rather than through Keys.onEscapePressed, so it no longer depends on
// which item happens to hold the focus.
//
// An Instantiator rather than a Repeater: a Shortcut is a QtObject, and a
// Repeater only builds Items, so a Repeater here creates nothing at all and
// every key silently goes dead.
//
// This component draws nothing and deliberately imports no theme, so it can be
// instantiated without the shell's singletons and exercised in tests/qml.
Item {
  id: root

  // Where the window is: one of Keymap.CONTEXTS.
  property string context: "list"
  // The focused item is a text entry, so bare keys belong to it.
  property bool typing: false
  // Something is covering the window and should be dismissed before anything
  // else acts. Popups are excluded on purpose: a QQC.Popup with CloseOnEscape
  // consumes its own keys, so the router never sees them.
  property bool overlay: false

  signal triggered(string id)

  Instantiator {
    model: Keymap.sequencesFor(root.context)

    delegate: Shortcut {
      required property var modelData
      sequence: modelData.sequence
      // The sequence is passed as well as the row: whether a key stands down
      // while typing is a property of that key, not of its row.
      enabled: Keymap.isEnabled(modelData.binding, modelData.sequence,
                                root.context, root.typing, root.overlay)
      onActivated: root.triggered(modelData.id)
    }
  }
}
