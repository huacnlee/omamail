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

  // Bumped by App.qml when keybindings.json loads or the Keyboard settings
  // section changes an override. Keymap.js is a shared library and its
  // override map changing emits no QML signal, so the model binding reads this
  // to know it has to rebuild the Shortcuts from the new keys.
  property int keymapRevision: 0

  // While the user is recording a key in Settings, every Shortcut stands down
  // so the press reaches the capture field instead of firing — a window
  // Shortcut beats a focused item's Keys handler, so without this Ctrl+, could
  // never be captured because it would open Settings again.
  property bool suspended: false

  // The sequence travels with the id, because one row can bind several keys
  // that differ in what they mean: `Ctrl+1`…`Ctrl+9` are one binding and nine
  // mailboxes.
  signal triggered(string id, string sequence)

  // Native TextArea accepts ShortcutOverride for editing keys before a window
  // Shortcut can run. Decode those forwarded events, then use the same table
  // and context as the Shortcut path. Unbound events remain normal text input.
  function routeKeyEvent(event) {
    // The other door into the router, and `suspended` means both of them.
    if (root.suspended) return false
    var key = ""
    if (event.key === Qt.Key_Up) key = "Up"
    else if (event.key === Qt.Key_Down) key = "Down"
    else if (event.key === Qt.Key_Return) key = "Return"
    else if (event.key === Qt.Key_Enter) key = "Enter"
    if (key === "") return false
    var sequence = ""
    // Ctrl, Alt, Meta, Shift: the order keys/Keymap.js normalises to and
    // keys/Capture.js records in, so a sequence spelled here matches one.
    if (event.modifiers & Qt.ControlModifier) sequence += "Ctrl+"
    if (event.modifiers & Qt.AltModifier) sequence += "Alt+"
    if (event.modifiers & Qt.MetaModifier) sequence += "Meta+"
    if (event.modifiers & Qt.ShiftModifier) sequence += "Shift+"
    sequence += key
    var entries = Keymap.sequencesFor(root.context)
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      if (entry.sequence !== sequence || !Keymap.isSequenceEnabled(entry.binding,
          sequence, root.context, root.overlay)) continue
      event.accepted = true
      root.triggered(entry.id, sequence)
      return true
    }
    return false
  }

  Instantiator {
    // `root.keymapRevision` is read for the dependency, not the value: an override
    // rebuilds the list the same way a context change does.
    model: {
      root.keymapRevision
      return Keymap.sequencesFor(root.context)
    }

    delegate: Shortcut {
      required property var modelData
      sequence: modelData.sequence
      // Window-scoped so mailbox keys cannot match or ambiguously consume the
      // standalone close chord, which is application-wide on purpose.
      context: Qt.WindowShortcut
      enabled: !root.suspended && Keymap.isSequenceEnabled(modelData.binding,
        modelData.sequence, root.context, root.overlay)
      onActivated: root.triggered(modelData.id, modelData.sequence)
    }
  }
}
