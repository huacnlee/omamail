import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "../keys/Keymap.js" as Keymap

// The reference sheet behind Ctrl+K. A plain list rather than a dialog because
// it never needs an answer — Esc, Ctrl+K again, or a click puts it away.
//
// **Wide and short, in as many columns as the window has room for.** One narrow
// column was taller than a short window, so it scrolled — and because the
// Flickable was only as wide as that column, its scrollbar rode the column's
// own edge and drew a bar down the middle of the screen. The Flickable fills
// the sheet now, which puts the scrollbar where a scrollbar belongs, and at two
// or three columns there is usually nothing left to scroll.
//
// The Flickable stays for the case that remains: a narrow window, where one
// column is all that fits and every binding still has to be reachable.
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

  // How wide one column of keys and their labels wants to be, and how many of
  // them this window can hold. Three is the ceiling: past that the sheet is
  // wider than it is readable, and the eye has to travel further to cross it
  // than to scroll it.
  readonly property real columnWidth: Style.space(330)
  readonly property int columnCount: Math.max(1, Math.min(3,
    Math.floor((width - Style.space(60)) / columnWidth)))

  // From the table, so this sheet cannot drift from what the keys actually do.
  // It used to be written by hand, and had: Esc listed twice, no `u` and no
  // `?`, and "Right-click a row" among the keyboard shortcuts.
  //
  // The split into columns is the table's too: balancing it here would put a
  // layout decision in a view, and the rule — in order, a heading counts as a
  // line — is worth a test.
  readonly property var columns: Keymap.helpColumns(columnCount)

  color: Qt.rgba(backgroundColor.r, backgroundColor.g, backgroundColor.b, 0.96)

  MouseArea {
    anchors.fill: parent
    onClicked: root.dismissed()
  }

  Flickable {
    id: scroller
    // Filling the sheet rather than hugging the content is the whole of the
    // scrollbar fix: a Flickable sized to its column puts the bar at that
    // column's edge, which on a wide window is the middle of the screen.
    anchors.fill: parent
    anchors.margins: Style.space(20)
    contentWidth: width
    contentHeight: holder.implicitHeight
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

    // A Flickable reparents its children, so an x written against the
    // Flickable's own width lands before that reparenting settles. The holder
    // owns the width, and the sheet centres inside it — and stays centred
    // vertically too for as long as it fits, which is what it did when the
    // Flickable was the size of its content.
    Item {
      id: holder
      width: scroller.width
      implicitHeight: Math.max(column.implicitHeight, scroller.height)

      Column {
        id: column
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.verticalCenter: parent.verticalCenter
        width: Math.min(scroller.width,
          root.columnCount * root.columnWidth + (root.columnCount - 1) * Style.space(28))
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

        Row {
          width: parent.width
          spacing: Style.space(28)

          Repeater {
            model: root.columns

            Column {
              id: sheetColumn
              required property var modelData
              width: (column.width - (root.columnCount - 1) * Style.space(28))
                / root.columnCount
              spacing: Style.space(6)

              Repeater {
                model: sheetColumn.modelData

                Column {
                  id: group
                  required property var modelData
                  width: sheetColumn.width
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
                        // Keeps its share of the column rather than a fixed
                        // measure: at three columns a fixed one left the label
                        // no room at all.
                        width: Math.round(parent.width * 0.54)
                        text: modelData.keys
                        color: root.textColor
                        font.family: root.panelFontFamily
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                      }

                      Text {
                        anchors.left: parent.left
                        anchors.leftMargin: Math.round(parent.width * 0.54) + Style.space(5)
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
      }
    }
  }
}
