import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../keys/Keymap.js" as Keymap

// The reference sheet behind Ctrl+?. A plain list rather than a dialog because
// it never needs an answer — Esc, Ctrl+? again, or a click puts it away.
//
// The list is taller than a short window once every binding is on it, and a
// centred Column just clips the middle out. A Flickable keeps the new rows
// reachable — Alt+1…9 among them — instead of pretending they are not there.
Rectangle {
  id: root

  required property color textColor
  required property color backgroundColor
  required property color dimColor
  required property string panelFontFamily

  signal dismissed()

  // The keyboard's answer to a sheet that scrolls. `j`/`k` survive the overlay
  // for this and nothing else, so the reference sheet is not the one screen in
  // the window that needs a mouse to read.
  function scrollBy(steps) {
    if (!scroller.interactive) return
    var limit = scroller.contentHeight - scroller.height
    scroller.contentY = Math.max(0, Math.min(limit,
      scroller.contentY + steps * Style.space(20)))
  }

  // From the table, so this sheet cannot drift from what the keys actually do.
  // It used to be written by hand, and had: Esc listed twice, no `u` and no
  // `?`, and "Right-click a row" among the keyboard shortcuts.
  readonly property var groups: Keymap.helpGroups()

  color: Qt.rgba(backgroundColor.r, backgroundColor.g, backgroundColor.b, 0.96)

  MouseArea {
    anchors.fill: parent
    onClicked: root.dismissed()
  }

  Flickable {
    id: scroller
    anchors.centerIn: parent
    width: column.width
    height: Math.min(column.implicitHeight, parent.height - Style.space(40))
    contentWidth: column.width
    contentHeight: column.implicitHeight
    clip: true
    boundsBehavior: Flickable.StopAtBounds
    flickableDirection: Flickable.VerticalFlick
    interactive: contentHeight > height
    ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

    // An interactive Flickable accepts the press itself, so the dismiss
    // MouseArea underneath stops seeing clicks on the sheet — which is exactly
    // the tall list this Flickable exists for. A tap is not a drag: a flick
    // scrolls and does not close.
    TapHandler {
      onTapped: root.dismissed()
    }

    Column {
      id: column
      width: Math.min(root.width - Style.space(80), Style.space(460))
      spacing: Style.space(6)

      Text {
        text: "Keyboard shortcuts"
        color: root.textColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.subtitle
        font.bold: true
      }

      Item {
        width: parent.width
        implicitHeight: Style.space(6)
      }

      Repeater {
        model: root.groups

        Column {
          id: group
          required property var modelData
          width: parent.width
          spacing: Style.space(6)

          Item {
            width: parent.width
            implicitHeight: Style.space(8)
          }

          Text {
            text: group.modelData.name
            color: root.dimColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
          }

          Repeater {
            model: group.modelData.rows

            Item {
              required property var modelData
              width: group.width
              implicitHeight: Style.space(20)

              Text {
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(178)
                text: modelData.keys
                color: root.textColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
              }

              Text {
                anchors.left: parent.left
                anchors.leftMargin: Style.space(183)
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                text: modelData.action
                color: root.dimColor
                font.family: root.panelFontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
              }
            }
          }
        }
      }
    }
  }
}
