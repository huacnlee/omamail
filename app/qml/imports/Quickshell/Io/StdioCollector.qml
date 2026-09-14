import QtQuick

QtObject {
  id: root

  property bool waitForEnd: false
  property string text: ""
  signal streamFinished()

  function accept(value) { text += String(value || "") }

  function acceptLine(value) {
    var line = String(value || "")
    text += line
    if (line.slice(-1) !== "\n") text += "\n"
  }

  function finish() { streamFinished() }
  function reset() { text = "" }
}
