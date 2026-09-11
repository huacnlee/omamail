import QtQuick
import qs.Commons
import qs.Ui

// The line at the top of a switcher that typing goes into. Letters narrow
// the rows to the ones they name; the arrows, or Ctrl with J, K, N or P,
// walk what is left; Enter opens the row the cursor is on. Where the rows
// carry numbers, a bare digit with nothing typed opens the row that
// carries it — and only when a row does carry it, so a name of numbers can
// still be typed. The account switcher's rows carry none.
TextField {
  id: root

  signal moved(int delta)
  signal chosen()
  signal numbered(int number)
  // The numbers the rows on show carry, or none: a digit is a key only
  // for one of these, and a letter otherwise.
  property var numbers: []

  objectName: "switcher-search"
  placeholderText: "Type to find"

  function reset() { text = "" }
  function takeFocus() { forceActiveFocus() }

  Keys.onPressed: function(event) {
    var ctrl = (event.modifiers & Qt.ControlModifier) !== 0
    if (event.key === Qt.Key_Down || (ctrl && (event.key === Qt.Key_J || event.key === Qt.Key_N))) {
      root.moved(1)
      event.accepted = true
    } else if (event.key === Qt.Key_Up || (ctrl && (event.key === Qt.Key_K || event.key === Qt.Key_P))) {
      root.moved(-1)
      event.accepted = true
    } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      root.chosen()
      event.accepted = true
    } else if (!ctrl && root.text === "" && event.key >= Qt.Key_0 && event.key <= Qt.Key_9) {
      var number = event.key === Qt.Key_0 ? 10 : event.key - Qt.Key_0
      if ((root.numbers || []).indexOf(number) < 0) return
      root.numbered(number)
      event.accepted = true
    }
  }
}
