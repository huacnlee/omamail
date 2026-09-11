import QtQuick
import qs.Commons

// Rows shaped like the message summaries that will replace them. One shared
// pulse keeps initial mailbox loading calm and cheap on the shell's GUI thread.
Column {
  id: root

  required property color textColor
  property real pulse: 0.45

  spacing: Style.space(2)

  SequentialAnimation on pulse {
    running: root.visible
    loops: Animation.Infinite
    NumberAnimation { to: 1.0; duration: 900; easing.type: Easing.InOutQuad }
    NumberAnimation { to: 0.45; duration: 900; easing.type: Easing.InOutQuad }
  }

  Repeater {
    model: [0.76, 0.61, 0.84, 0.69, 0.79, 0.57]

    Item {
      required property real modelData
      width: root.width
      implicitHeight: Style.space(64)

      Column {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.leftMargin: Style.space(14)
        anchors.rightMargin: Style.space(14)
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.space(5)

        Bar { widthFactor: modelData; barHeight: Style.space(9) }
        Bar { widthFactor: Math.max(0.28, modelData - 0.34); barHeight: Style.space(8) }
        Bar { widthFactor: Math.min(0.72, modelData + 0.08); barHeight: Style.space(7) }
      }
    }
  }

  component Bar: Rectangle {
    required property real widthFactor
    required property real barHeight

    width: Math.max(1, parent.width * widthFactor)
    height: barHeight
    radius: Style.cornerRadius
    color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b,
      0.05 + 0.05 * root.pulse)
  }
}
