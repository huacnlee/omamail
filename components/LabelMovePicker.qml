import QtQuick
import QtQuick.Controls
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../account/Model.js" as Model
import "Menu.js" as Menu

// Where a label goes: the top level, or under another label. The rows are
// `Model.labelMoveTargets` — not the label itself, nothing beneath it, not
// the parent it already has — walked with j/k and taken with Enter or o.
Item {
  id: root

  required property color textColor
  required property color accentColor
  required property color dimColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  property string labelId: ""
  property var targets: []
  property int cursorIndex: 0
  readonly property bool opened: menu.opened

  signal targetChosen(string labelId, string parentPath)

  anchors.fill: parent
  z: 55

  function openFor(id, rows) {
    labelId = String(id || "")
    targets = Array.isArray(rows) ? rows : []
    cursorIndex = 0
    menu.open()
  }

  function close() { menu.close() }

  function moveCursor(delta) {
    var count = targets.length
    if (count === 0) return
    cursorIndex = Model.wrappedIndex(cursorIndex, delta, count)
  }

  function choose(index) {
    if (index < 0 || index >= targets.length) return
    var target = targets[index]
    menu.close()
    root.targetChosen(labelId, String(target.path || ""))
  }

  QQC.Popup {
    id: menu
    anchors.centerIn: parent
    width: Math.min(Style.space(320), parent.width - Style.space(32))
    implicitHeight: Math.min(parent.height - Style.space(64), list.implicitHeight + Style.space(24))
    padding: Style.space(8)
    modal: true
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
    }

    contentItem: Flickable {
      id: flick
      WheelScroller { view: flick }
      contentWidth: width
      contentHeight: list.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }
      focus: true

      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_J || event.key === Qt.Key_Down) {
          root.moveCursor(1); event.accepted = true
        } else if (event.key === Qt.Key_K || event.key === Qt.Key_Up) {
          root.moveCursor(-1); event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
            || event.key === Qt.Key_O) {
          root.choose(root.cursorIndex); event.accepted = true
        }
      }

      Column {
        id: list
        width: flick.width
        spacing: Style.space(2)

        Text {
          width: parent.width
          leftPadding: Style.space(9)
          bottomPadding: Style.space(4)
          text: "Move under"
          color: root.dimColor
          font.family: root.panelFontFamily
          font.pixelSize: Style.font.caption
        }

        Repeater {
          model: root.targets

          Rectangle {
            id: row
            required property var modelData
            required property int index
            readonly property bool hasCursor: root.cursorIndex === row.index

            width: parent.width
            implicitHeight: Style.spacing.popupRowHeight
            radius: Style.cornerRadius
            color: rowHover.hovered || hasCursor
              ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent"
            border.width: hasCursor ? Style.normalBorderWidth : 0
            border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

            ActionIcon {
              id: rowIcon
              anchors.left: parent.left
              anchors.leftMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              name: row.modelData.path === "" ? "inbox" : "label"
              iconSize: Style.font.iconSmall
              color: root.textColor
            }

            Text {
              anchors.left: rowIcon.right
              anchors.leftMargin: Style.space(8)
              anchors.right: parent.right
              anchors.rightMargin: Style.space(8)
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: row.modelData.name
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideMiddle
            }

            HoverHandler { id: rowHover }
            TapHandler { onTapped: root.choose(row.index) }
          }
        }
      }
    }
  }
}
