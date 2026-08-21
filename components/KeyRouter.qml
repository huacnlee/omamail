import QtQuick
import QtQml
import "../keys/Keymap.js" as Keymap

// Turns the key table into live Shortcuts, and reports what was pressed by id.
//
// The keyboard belongs to the application, and the context says what a key
// means where — actions are scoped, the way a TUI or GPUI scopes them. One
// place decides whether a binding is live, so there is no per-line `enabled:`
// expression to copy wrongly. Escape is routed here like every other key
// rather than through Keys.onEscapePressed, so it does not depend on which
// item happens to hold the focus.
//
// An Instantiator rather than a Repeater: a Shortcut is a QtObject, and a
// Repeater only builds Items, so a Repeater here creates nothing at all and
// every key silently goes dead.
//
// This component draws nothing and deliberately imports no theme, so it can be
// instantiated without the shell's singletons and exercised in tests/qml.
Item {
  id: root

  // Where the window is: one of Keymap.CONTEXTS. It is the only thing that
  // decides what is live — a text-entry context binds no bare keys, so there is
  // no separate "are they typing" question to keep in step with this one.
  property string context: "list"
  // Something is covering the window and should be dismissed before anything
  // else acts. Popups are excluded on purpose: a QQC.Popup with CloseOnEscape
  // consumes its own keys, so the router never sees them.
  property bool overlay: false

  // The sequence travels with the id, because one row can bind several keys
  // that differ in what they mean: `Alt+1`…`Alt+0` are one binding and ten
  // mailboxes.
  signal triggered(string id, string sequence)

  Instantiator {
    model: Keymap.sequencesFor(root.context)

    delegate: Shortcut {
      required property var modelData
      sequence: modelData.sequence
      enabled: Keymap.isEnabled(modelData.binding, root.context, root.overlay)
      onActivated: root.triggered(modelData.id, modelData.sequence)
    }
  }
}
