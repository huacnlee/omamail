import QtQuick
import Quickshell.Io
import "Keymap.js" as Keymap

// Where the user's moved keys live.
//
// The keyboard table in keys/Keymap.js is data at runtime as well as at
// authoring time: keybindings.json names the rows the user has moved, and the
// Keyboard section of Settings writes it through here. The table stays the
// source of the defaults — an entry is dropped the moment it equals the row's
// own keys, so a reset is the absence of an entry rather than a copy of the
// default sitting on top of it.
//
// Beside the table rather than in `components/`, which draws what it is given
// and decides nothing: this owns the path, the reader, the writer, and asks
// `checkBinding` before it commits. One seam to the window — `revision`.
QtObject {
  id: root

  required property var service

  // Bumped whenever the override map changes. Keymap.js is a shared library
  // and that change emits no QML signal, so KeyRouter, ShortcutHelp, the
  // status hints and the reader's legend read this to know they have to
  // rebuild from the new keys.
  property int revision: 0

  readonly property string path: service ? service.configPath("keybindings.json") : ""

  function load(raw) {
    Keymap.setOverrides(Keymap.parseOverrides(raw))
    revision++
  }

  // Returns "" when the rebind took, or a sentence the settings row shows.
  // checkBinding is asked first so a collision never reaches the file.
  function rebind(id, keys) {
    var problem = Keymap.checkBinding(id, keys)
    if (problem !== "") return problem
    Keymap.applyOverride(id, keys)
    revision++
    save()
    return ""
  }

  function resetBinding(id) {
    Keymap.applyOverride(id, [])
    revision++
    save()
  }

  function resetAll() {
    Keymap.resetAll()
    revision++
    save()
  }

  // A write that failed has to say so: the rebind is live in this session
  // either way, so without this the key works until the next launch and then
  // is silently gone.
  property string saveError: ""

  // Written through Service so the standalone app, which has no plugin
  // directory and no shell scripts, saves the same file its own way.
  function save() {
    if (!service) {
      saveError = "Settings storage is unavailable"
      return
    }
    saveError = ""
    service.writeConfig("keybindings.json", Keymap.serializeOverrides(),
      function(ok, error) {
        root.saveError = ok ? ""
          : (error ? String(error) : "Could not save your keys to " + root.path)
      })
  }

  property var reader: FileView {
    path: root.path
    printErrors: false
    onLoaded: root.load(text())
    // No file yet is the ordinary first-run state, not an error.
    onLoadFailed: root.load("")
  }
}
