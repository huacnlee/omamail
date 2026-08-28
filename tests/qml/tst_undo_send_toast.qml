import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

Item {
  width: 500
  height: 200

  Omamail.UndoSendToast {
    id: toast
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    secondsRemaining: 7
    textColor: Qt.rgba(1, 1, 1, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    popupBackgroundColor: Qt.rgba(0.13, 0.13, 0.13, 1)
    popupBorderColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    panelFontFamily: "monospace"
  }

  SignalSpy {
    id: undoSpy
    target: toast
    signalName: "undoRequested"
  }

  TestCase {
    name: "UndoSendToast"
    when: windowShown

    function named(item, objectName) {
      if (!item) return null
      if (item.objectName === objectName) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = named(values[i], objectName)
        if (found) return found
      }
      return null
    }

    function init() {
      toast.secondsRemaining = 7
      undoSpy.clear()
    }

    function test_countdown_is_visible_and_updates() {
      var message = named(toast, "undo-send-message")
      verify(message)
      compare(message.text, "Sending in 7s")
      toast.secondsRemaining = 3
      compare(message.text, "Sending in 3s")
    }

    function test_button_requests_undo() {
      var button = named(toast, "undo-send-button")
      verify(button)
      compare(button.text, "Undo  Alt+Z")
      mouseClick(button, button.width / 2, button.height / 2)
      compare(undoSpy.count, 1)
    }
  }
}
