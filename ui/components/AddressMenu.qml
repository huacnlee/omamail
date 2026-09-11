import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "Menu.js" as Menu

// The menu an address opens on a right-click in the reader's header: copy
// it, or find the mail from it or to it. A line with several addresses asks
// which one first, then offers the same three rows for it.
Item {
  id: root

  required property color textColor
  required property color dimColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  // [{ name, email }] — what the line held. One means straight to the rows.
  property var addresses: []
  property string chosen: ""
  property bool canSearch: true
  property int cursorIndex: -1
  readonly property bool opened: menu.opened
  readonly property bool choosing: chosen === "" && addresses.length > 1
  readonly property var menuRows: choosing ? pickRows.rows : [copyRow, fromRow, toRow]

  signal copyRequested(string address)
  signal searchRequested(string field, string address)

  anchors.fill: parent
  z: 50

  property real anchorX: 0
  property real anchorY: 0

  function openAt(list, sceneX, sceneY) {
    var rows = []
    var seen = {}
    var given = Array.isArray(list) ? list : []
    for (var i = 0; i < given.length; i++) {
      var email = String(given[i] && given[i].email ? given[i].email : "").trim()
      if (email === "" || seen[email]) continue
      seen[email] = true
      rows.push({ name: String(given[i].name || given[i].display || ""), email: email })
    }
    if (rows.length === 0) return
    addresses = rows
    chosen = rows.length === 1 ? rows[0].email : ""
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

  function pick(email) {
    chosen = String(email || "")
    cursorIndex = 0
    place()
  }

  QQC.Popup {
    id: menu
    width: Style.space(240)
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

      // The address the rows are about. A stranger wrote it.
      Text {
        width: menu.width - menu.leftPadding - menu.rightPadding
        leftPadding: Style.space(9)
        topPadding: Style.space(4)
        bottomPadding: Style.space(6)
        textFormat: Text.PlainText
        text: root.choosing ? "Which address?" : root.chosen
        color: root.dimColor
        font.family: root.panelFontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideMiddle
      }

      // Choosing: one row per address on the line.
      Column {
        id: pickRows
        visible: root.choosing
        width: parent.width
        spacing: Style.space(2)
        property var rows: []

        Repeater {
          id: pickRepeater
          model: root.choosing ? root.addresses : []
          onItemAdded: function(index, item) { pickRows.rows = collect() }
          onItemRemoved: function(index, item) { pickRows.rows = collect() }
          function collect() {
            var out = []
            for (var i = 0; i < pickRepeater.count; i++) out.push(pickRepeater.itemAt(i))
            return out
          }

          MenuActionRow {
            required property var modelData
            width: menu.width - menu.leftPadding - menu.rightPadding
            textColor: root.textColor
            panelFontFamily: root.panelFontFamily
            collection: pickRows.rows
            cursorIndex: root.cursorIndex
            text: modelData.name !== "" && modelData.name !== modelData.email
              ? modelData.name + " <" + modelData.email + ">" : modelData.email
            onActivated: root.pick(modelData.email)
          }
        }
      }

      MenuRow {
        id: copyRow
        visible: !root.choosing
        text: "Copy address"
        onActivated: { var address = root.chosen; menu.close(); root.copyRequested(address) }
      }
      MenuRow {
        id: fromRow
        visible: !root.choosing && root.canSearch
        text: "Search mail from"
        onActivated: { var address = root.chosen; menu.close(); root.searchRequested("from", address) }
      }
      MenuRow {
        id: toRow
        visible: !root.choosing && root.canSearch
        text: "Search mail to"
        onActivated: { var address = root.chosen; menu.close(); root.searchRequested("to", address) }
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
