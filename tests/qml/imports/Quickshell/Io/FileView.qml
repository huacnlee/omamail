import QtQuick

QtObject {
  property string path: ""
  property bool watchChanges: false
  property bool printErrors: false
  signal loaded()
  signal fileChanged()
  signal loadFailed()

  function reload() {}
  function text() { return "" }
  function setText(_value) {}
}
