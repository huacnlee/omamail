import QtQuick
import qs.Commons
import qs.Ui

// What the reader shows while a message is on its way.
//
// Shaped like the thing that is coming — a subject, a sender, a meta line,
// then body — so the pane does not jump when the real message lands. A word
// like "Opening…" tells you nothing you did not already know from clicking.
Item {
  id: root

  required property color textColor
  required property string panelFontFamily

  // One animation drives every bar. Running it per bar would put a dozen
  // timers on the GUI thread to say a single thing.
  property real pulse: 0.5

  SequentialAnimation on pulse {
    running: root.visible
    loops: Animation.Infinite
    NumberAnimation { to: 1.0; duration: 900; easing.type: Easing.InOutQuad }
    NumberAnimation { to: 0.45; duration: 900; easing.type: Easing.InOutQuad }
  }

  Column {
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.margins: Style.space(14)
    spacing: Style.space(8)

    // Subject: two lines, the second short, the way a long subject wraps.
    Bar { widthFactor: 0.82; barHeight: Style.space(13) }
    Bar { widthFactor: 0.46; barHeight: Style.space(13) }

    Item { width: 1; height: Style.space(4) }

    // Sender, then the recipients-and-date line under it.
    Bar { widthFactor: 0.38; barHeight: Style.space(9) }
    Bar { widthFactor: 0.52; barHeight: Style.space(8) }

    Item { width: 1; height: Style.space(10) }

    PanelSeparator {
      width: parent.width
      foreground: root.textColor
    }

    Item { width: 1; height: Style.space(6) }

    // Body: paragraphs of a few lines each, with a short last line.
    Repeater {
      model: [0.96, 0.99, 0.72, 0.0, 0.94, 0.88, 0.97, 0.54, 0.0, 0.92, 0.63]

      Item {
        required property var modelData
        width: parent.width
        implicitHeight: modelData === 0.0 ? Style.space(10) : Style.space(15)

        Bar {
          visible: modelData !== 0.0
          widthFactor: modelData
          barHeight: Style.space(8)
        }
      }
    }
  }

  component Bar: Rectangle {
    property real widthFactor: 1.0
    property real barHeight: Style.space(8)

    width: Math.max(1, parent.width * widthFactor)
    height: barHeight
    radius: Style.cornerRadius
    color: Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b,
      0.06 + 0.05 * root.pulse)
  }
}
