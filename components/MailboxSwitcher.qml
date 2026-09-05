import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../account/Model.js" as Model
import "Menu.js" as Menu

// The rail as a menu: every mailbox and label the sidebar draws, opened from
// the header's scope line or from `Alt+M`, for a window whose rail is
// collapsed to icons, folded into tabs, or simply further from the pointer
// than the header is.
//
// The rows are `Model.switcherRows` over the same slots the rail numbers, so
// the digit a row shows here is the Ctrl key that opens it from the list, and
// a bare digit while this is up opens it too.
Item {
  id: root

  required property color textColor
  required property color accentColor
  required property color dimColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  // [{ kind, key|id, name, icon, count, selected, number }]
  property var rows: []

  readonly property bool opened: menu.opened
  readonly property alias menuRows: list

  // Where the keyboard is standing, and never where the mouse is: a row draws
  // its own hover, for the reason the account switcher gives.
  property int cursorIndex: 0

  signal rowChosen(int index)

  anchors.fill: parent
  z: 45

  property real anchorX: 0
  property real anchorY: 0

  function openAt(sceneX, sceneY) {
    var local = root.mapFromGlobal(sceneX, sceneY)
    anchorX = local.x
    anchorY = local.y
    menu.open()
    place()
  }

  // Placed after it opens and again whenever its height changes: a Popup has
  // no height until its first open, and this list changes length with the
  // account's labels.
  function place() {
    if (!menu.visible) return
    var tall = menu.height > 0 ? menu.height : menu.implicitHeight
    var placed = Menu.position(anchorX, anchorY, menu.width, tall, root.width, root.height)
    menu.x = placed.x
    menu.y = placed.y
  }

  function openCentered() {
    anchorX = Math.max(0, (root.width - menu.width) / 2)
    anchorY = Math.max(0, (root.height - menu.implicitHeight) / 2)
    menu.open()
    place()
  }

  function close() { menu.close() }

  function moveCursor(delta) {
    var count = root.rows ? root.rows.length : 0
    if (count === 0) return
    cursorIndex = Model.wrappedIndex(cursorIndex, delta, count)
  }

  function choose(index) {
    var count = root.rows ? root.rows.length : 0
    if (index < 0 || index >= count) return
    menu.close()
    root.rowChosen(index)
  }

  function chooseCursor() { choose(cursorIndex) }

  // Opening puts the keyboard on the scope already open, so the first `j` is
  // one step from it rather than back at the top.
  function restCursorOnActive() {
    var all = root.rows || []
    for (var i = 0; i < all.length; i++) {
      if (all[i].selected) { cursorIndex = i; return }
    }
    cursorIndex = 0
  }

  QQC.Popup {
    id: menu
    width: Style.space(230)
    implicitHeight: list.implicitHeight + Style.space(8)
    padding: Style.space(4)
    modal: false
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    onHeightChanged: root.place()
    onOpened: {
      root.restCursorOnActive()
      root.place()
    }
    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
    }

    // Keys answered here rather than in `KeyRouter`, because an open popup
    // takes every key before the shortcut map sees it. AGENTS.md, "Keys and
    // focus", and `tests/qml/tst_popup_keys.qml` hold the reason.
    contentItem: Column {
      id: list
      focus: true
      spacing: Style.space(2)

      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_J || event.key === Qt.Key_Down) {
          root.moveCursor(1)
          event.accepted = true
        } else if (event.key === Qt.Key_K || event.key === Qt.Key_Up) {
          root.moveCursor(-1)
          event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
            || event.key === Qt.Key_O) {
          root.chooseCursor()
          event.accepted = true
        } else if (event.key >= Qt.Key_0 && event.key <= Qt.Key_9) {
          // The digit on the row, which is the Ctrl digit from the list: `0`
          // is the tenth row, as it is on the rail.
          var number = event.key === Qt.Key_0 ? 10 : event.key - Qt.Key_0
          root.choose(number - 1)
          event.accepted = true
        }
      }

      Repeater {
        model: root.rows

        Rectangle {
          id: row
          objectName: "mailbox-row"
          required property var modelData
          required property int index

          readonly property bool hasCursor: root.cursorIndex === row.index

          width: menu.width - menu.leftPadding - menu.rightPadding
          implicitHeight: Style.spacing.popupRowHeight
          radius: Style.cornerRadius
          color: modelData.selected
            ? Style.selectedFillFor(root.textColor, root.accentColor)
            : (rowHover.hovered || hasCursor
              ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")
          border.width: hasCursor ? Style.normalBorderWidth : 0
          border.color: Style.hoverBorderFor(root.textColor, root.accentColor)

          ActionIcon {
            id: rowIcon
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            name: row.modelData.icon
            iconSize: Style.font.iconSmall
            color: root.textColor
          }

          Text {
            anchors.left: rowIcon.right
            anchors.leftMargin: Style.space(8)
            anchors.right: suffix.left
            anchors.rightMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            // A label's name was typed by the account's owner.
            textFormat: Text.PlainText
            text: row.modelData.name
            color: root.textColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.bodySmall
            font.bold: row.modelData.selected
            elide: Text.ElideRight
          }

          // The count where a label has one, then the key that opens the row.
          Row {
            id: suffix
            anchors.right: parent.right
            anchors.rightMargin: Style.space(9)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(6)

            Text {
              anchors.verticalCenter: parent.verticalCenter
              visible: row.modelData.count > 0
              text: row.modelData.count > 999 ? "999+" : String(row.modelData.count)
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            Text {
              anchors.verticalCenter: parent.verticalCenter
              visible: row.modelData.number >= 1 && row.modelData.number <= 10
              text: row.modelData.number === 10 ? "0" : String(row.modelData.number)
              color: root.dimColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
            }
          }

          HoverHandler { id: rowHover }
          TapHandler { onTapped: root.choose(row.index) }
        }
      }
    }
  }
}
