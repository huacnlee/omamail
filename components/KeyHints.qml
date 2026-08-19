import QtQuick
import qs.Commons
import qs.Ui

// What the keyboard offers from wherever you are standing.
//
// This was one string with wide runs of spaces between the pairs, which asked
// the gaps to do two jobs at once: separate a key from its label, and separate
// one pair from the next. Both gaps ended up the same size, so the whole line
// read as an undifferentiated run of words, and the line took far more room
// than it needed. Giving the key a quiet fill separates it from its label by
// shape instead, which is what lets the pairs sit close together.
Row {
  id: root

  required property color textColor
  required property color dimColor
  required property string panelFontFamily

  // [{ key: "j / k", label: "move" }, ...]
  property var hints: []

  spacing: Style.space(7)

  Repeater {
    model: root.hints

    delegate: Row {
      id: pair
      required property var modelData
      spacing: Style.space(3)

      Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        width: cap.implicitWidth + Style.space(5)
        height: cap.implicitHeight + Style.space(2)
        radius: Style.cornerRadius
        // Fill only. An outline as well made these read as buttons you could
        // press, which drew far more attention than a hint deserves.
        color: Style.normalFillFor(root.textColor, Color.accent)

        Text {
          id: cap
          anchors.centerIn: parent
          text: pair.modelData.key
          color: root.textColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
        }
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: pair.modelData.label
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }
}
