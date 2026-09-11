import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

Item {
  width: 500
  height: 300

  Omamail.RecipientSuggestions {
    id: picker
    width: 400
    contacts: [
      ({ name: "First Person", email: "first@example.com" }),
      ({ name: "Second Person", email: "second@example.com" }),
      ({ name: "Third Person", email: "third@example.com" })
    ]
    textColor: Qt.rgba(1, 1, 1, 1)
    dimColor: Qt.rgba(0.67, 0.67, 0.67, 1)
    accentColor: Qt.rgba(1, 0.5, 0, 1)
    popupBackgroundColor: Qt.rgba(0.13, 0.13, 0.13, 1)
    popupBorderColor: Qt.rgba(0.47, 0.47, 0.47, 1)
    panelFontFamily: "monospace"
  }

  SignalSpy {
    id: chosenSpy
    target: picker
    signalName: "chosen"
  }

  TestCase {
    name: "RecipientSuggestions"
    when: windowShown

    function init() {
      picker.currentIndex = -1
      chosenSpy.clear()
    }

    function test_down_starts_at_the_first_result_and_keeps_moving() {
      picker.moveSelection(1)
      compare(picker.currentIndex, 0)
      picker.moveSelection(1)
      compare(picker.currentIndex, 1)
    }

    function test_up_from_no_selection_starts_at_the_last_result() {
      picker.moveSelection(-1)
      compare(picker.currentIndex, 2)
    }

    function test_enter_accepts_the_highlighted_result() {
      picker.moveSelection(1)
      picker.moveSelection(1)
      verify(picker.acceptSelection())
      compare(chosenSpy.count, 1)
      compare(chosenSpy.signalArguments[0][0].email, "second@example.com")
    }
  }
}
