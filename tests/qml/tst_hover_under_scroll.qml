import QtQuick
import QtTest

// Why hovering a row must not move the keyboard's cursor.
//
// Qt re-reports hover when content moves under a pointer that has not moved.
// The list scrolls to follow the keyboard, so a hover that wrote `cursorId`
// handed it straight back to whatever the mouse was resting on: j moved the
// cursor, the scroll brought a different row under the still pointer, and the
// cursor snapped back. It looked like j and k sticking on a few rows.
//
// This asserts the Qt behaviour rather than the app's wiring, because the
// behaviour is the reason the wiring has to stay apart.
Item {
  id: host
  width: 200; height: 100

  property string entered: ""

  Flickable {
    id: flick
    anchors.fill: parent
    contentWidth: width
    contentHeight: col.height
    clip: true

    Column {
      id: col
      width: flick.width
      Repeater {
        model: 10
        Rectangle {
          id: row
          required property int index
          width: col.width
          height: 40
          MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onEntered: host.entered = "row" + row.index
          }
        }
      }
    }
  }

  TestCase {
    name: "HoverUnderScroll"
    when: windowShown

    function test_scrolling_under_a_still_pointer_reports_a_new_row() {
      mouseMove(host, 100, 50)
      wait(50)
      compare(host.entered, "row1", "the pointer is parked on a row")

      host.entered = ""
      flick.contentY = 160          // the list scrolls; the pointer does not move
      wait(80)
      compare(host.entered, "row5",
        "a still pointer reports a different row once the content moves under it "
        + "— which is why hover must not be allowed to write the keyboard cursor")
    }
  }
}
