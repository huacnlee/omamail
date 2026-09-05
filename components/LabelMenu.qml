import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "Menu.js" as Menu

// The menu a label opens on a right-click: what can be done to the label
// itself, as opposed to the messages in it. Every row that changes the
// server's list is offered only where the provider can be asked
// (`canManage`); an ancestor no label names (`labelId` empty) offers only the
// two rows that make something beneath or beside it.
Item {
  id: root

  required property color textColor
  required property color urgentColor
  required property color dimColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  property string labelId: ""
  property string labelPath: ""
  property bool monitored: false
  property bool canManage: false
  property int cursorIndex: -1
  readonly property var menuRows: [renameRow, newRow, newSubRow, moveRow, monitorRow, deleteRow]
  readonly property bool opened: menu.opened
  readonly property bool real: labelId !== ""

  signal renameRequested(string labelId)
  // `beneath` false means beside: under the same parent this label has.
  signal createRequested(string labelPath, bool beneath)
  signal moveRequested(string labelId)
  signal monitorToggled(string labelId)
  signal deleteRequested(string labelId)

  anchors.fill: parent
  z: 50

  property real anchorX: 0
  property real anchorY: 0

  function openAt(id, path, sceneX, sceneY) {
    labelId = String(id || "")
    labelPath = String(path || "")
    var local = root.mapFromGlobal(sceneX, sceneY)
    anchorX = local.x
    anchorY = local.y
    menu.open()
  }

  function place() {
    if (!menu.visible) return
    var tall = menu.height > 0 ? menu.height : menu.implicitHeight
    var placed = Menu.position(anchorX, anchorY, menu.width, tall, root.width, root.height)
    menu.x = placed.x
    menu.y = placed.y
  }

  function selectableRows() {
    var values = []
    for (var i = 0; i < menuRows.length; i++) values.push({
      selectable: true, visible: menuRows[i].visible, enabled: menuRows[i].enabled
    })
    return values
  }
  function moveCursor(step) { cursorIndex = Menu.nextSelectable(selectableRows(), cursorIndex, step) }
  function runCursor() { if (cursorIndex >= 0) menuRows[cursorIndex].activated() }
  function close() { menu.close() }

  // The parent a new sibling goes under: the label's own parent, which is
  // the path with its last segment taken off by whoever handles the signal.
  QQC.Popup {
    id: menu
    width: Style.space(220)
    implicitHeight: rows.implicitHeight + Style.space(8)
    padding: Style.space(4)
    modal: false
    focus: true
    closePolicy: QQC.Popup.CloseOnEscape | QQC.Popup.CloseOnPressOutside
    onHeightChanged: root.place()
    onOpened: {
      root.cursorIndex = Menu.firstSelectable(root.selectableRows())
      root.place()
    }
    background: Rectangle {
      radius: Style.cornerRadius
      color: root.popupBackgroundColor
      border.width: 1
      border.color: root.popupBorderColor
    }

    contentItem: Column {
      id: rows
      spacing: Style.space(2)

      focus: true
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_J || event.key === Qt.Key_Down) {
          root.moveCursor(1); event.accepted = true
        } else if (event.key === Qt.Key_K || event.key === Qt.Key_Up) {
          root.moveCursor(-1); event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
            || event.key === Qt.Key_O) {
          root.runCursor(); event.accepted = true
        }
      }

      // The label's name, so the menu says which one it is about.
      Text {
        width: menu.width - menu.leftPadding - menu.rightPadding
        leftPadding: Style.space(9)
        topPadding: Style.space(4)
        bottomPadding: Style.space(6)
        textFormat: Text.PlainText
        text: root.labelPath
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideMiddle
      }

      MenuRow {
        id: renameRow
        visible: root.canManage && root.real
        text: "Rename..."
        onActivated: { var id = root.labelId; menu.close(); root.renameRequested(id) }
      }
      MenuRow {
        id: newRow
        visible: root.canManage
        text: "New label beside..."
        onActivated: { var path = root.labelPath; menu.close(); root.createRequested(path, false) }
      }
      MenuRow {
        id: newSubRow
        visible: root.canManage
        text: "New sub-label..."
        onActivated: { var path = root.labelPath; menu.close(); root.createRequested(path, true) }
      }
      MenuRow {
        id: moveRow
        visible: root.canManage && root.real
        text: "Move to..."
        onActivated: { var id = root.labelId; menu.close(); root.moveRequested(id) }
      }

      MenuSeparatorLine {
        width: menu.width - menu.leftPadding - menu.rightPadding
        lineColor: root.textColor
      }

      MenuRow {
        id: monitorRow
        visible: root.real
        text: root.monitored ? "Stop monitoring" : "Monitor for new mail"
        onActivated: { var id = root.labelId; menu.close(); root.monitorToggled(id) }
      }
      MenuRow {
        id: deleteRow
        visible: root.canManage && root.real
        text: "Delete..."
        tone: root.urgentColor
        onActivated: { var id = root.labelId; menu.close(); root.deleteRequested(id) }
      }
    }
  }

  component MenuRow: MenuActionRow {
    width: menu.width - menu.leftPadding - menu.rightPadding
    textColor: root.textColor
    panelFontFamily: root.panelFontFamily
    collection: root.menuRows
    cursorIndex: root.cursorIndex
  }
}
