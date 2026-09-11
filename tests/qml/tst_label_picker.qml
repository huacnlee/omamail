import QtQuick 2.15
import QtTest 1.3
import "../../components" as Components

// The move picker gives pointer and keyboard users the same cursor. A single
// click only places it; moving mail requires Return or the deliberate second
// click of a double-click.
Item {
  id: host
  width: 640
  height: 480

  property string chosenId: ""
  property int chosenCount: 0

  Components.LabelPicker {
    id: picker
    anchors.fill: parent
    textColor: Qt.rgba(0.1, 0.1, 0.1, 1)
    accentColor: Qt.rgba(0.2, 0.4, 0.8, 1)
    dimColor: Qt.rgba(0.4, 0.4, 0.4, 1)
    popupBackgroundColor: Qt.rgba(0.95, 0.95, 0.95, 1)
    popupBorderColor: Qt.rgba(0.2, 0.2, 0.2, 1)
    panelFontFamily: "sans"
    labels: [
      { id: "A", name: "Archive", system: false },
      { id: "B", name: "Bills", system: false }
    ]
    onLabelChosen: function(labelId) {
      host.chosenId = labelId
      host.chosenCount += 1
    }
  }

  TestCase {
    name: "LabelPicker"
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
      if (picker.opened) keyClick(Qt.Key_Escape)
      host.chosenId = ""
      host.chosenCount = 0
      picker.open()
      tryVerify(function() { return picker.opened })
      wait(60)
    }

    function cleanup() {
      if (picker.opened) keyClick(Qt.Key_Escape)
    }

    function test_a_single_click_only_moves_the_cursor() {
      var bills = named(picker.Window.window.contentItem, "label-picker-row-1")
      verify(bills)

      mouseClick(bills)

      compare(picker.cursorIndex, 1)
      compare(host.chosenCount, 0)
      verify(picker.opened)
    }

    function test_a_double_click_activates_the_pointed_destination() {
      var bills = named(picker.Window.window.contentItem, "label-picker-row-1")
      verify(bills)

      mouseDoubleClickSequence(bills)

      compare(host.chosenId, "B")
      compare(host.chosenCount, 1)
      verify(!picker.opened)
    }

    function test_arrows_and_return_activate_the_keyboard_cursor() {
      keyClick(Qt.Key_Down)
      compare(picker.cursorIndex, 1)

      keyClick(Qt.Key_Return)

      compare(host.chosenId, "B")
      compare(host.chosenCount, 1)
      verify(!picker.opened)
    }
  }
}
