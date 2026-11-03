import QtQuick
import Quickshell

// With no store this is the old stub: a file that never loads. A test that
// sets Quickshell.fileStore gets a FileView that reads it, announces each
// result the way the shell's does, and reports a watched change.
QtObject {
  id: root
  property string path: ""
  property bool watchChanges: false
  property bool printErrors: false
  property bool atomicWrites: false
  property var store: Quickshell.fileStore
  property string _text: ""
  signal loaded()
  signal fileChanged()
  signal loadFailed()

  function reload() {
    if (!store) return
    var result = path !== "" && typeof store.read === "function" ? (store.read(path) || ({})) : ({})
    if (result.ok !== true) {
      _text = ""
      loadFailed()
      return
    }
    _text = String(result.text || "")
    loaded()
  }
  function text() { return _text }
  function setText(_value) {}

  onPathChanged: reload()
  onStoreChanged: reload()

  property Connections storeConnections: Connections {
    target: root.store
    ignoreUnknownSignals: true
    function onChanged(changedPath) {
      if (root.watchChanges && String(changedPath) === root.path) root.fileChanged()
    }
  }
}
