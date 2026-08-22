import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "Menu.js" as Menu

// Links out, plus the handful of actions that have no natural home on screen.
Item {
  id: root

  required property color textColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily
  property bool signedIn: false
  // Whether this mailbox has a web address for what is on screen. Off, the row
  // goes rather than opening something else's inbox.
  property bool canOpenWebInbox: false
  // The rail carries the switcher, and the rail is gone at a narrow window —
  // so at that size this menu is the only way left to reach it.
  property int accountCount: 1
  // The menu is opened from wherever the account lives — the sidebar's user
  // bar, or the status bar when the sidebar is hidden — so it carries no
  // trigger of its own by default.
  property bool showTrigger: false
  readonly property bool opened: menu.opened

  // Positioned against the window rather than a button, and flipped when it
  // would run off the bottom, since it opens from a bar at the bottom.
  // Where the menu was asked to appear, kept because it cannot be placed yet.
  property real anchorX: 0
  property real anchorY: 0
  property int cursorIndex: -1
  readonly property var menuRows: [markRow, webRow, switchRow, settingsRow,
    shortcutsRow, projectRow, authorRow]

  function openAt(sceneX, sceneY) {
    var local = root.mapFromGlobal(sceneX, sceneY)
    anchorX = local.x
    anchorY = local.y
    menu.open()
    place()
  }

  // A Popup does not build its contents until it is first opened, so on the
  // very first click its height is still zero: the "does it fit below?" test
  // passed trivially and the menu was placed at the click and then grew off the
  // bottom. That matters more now the trigger sits on the status line, where
  // below is where there is no room at all.
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

  signal markAllReadRequested()
  signal openWebRequested()
  signal shortcutsRequested()
  signal setupRequested()
  signal switchAccountRequested()
  signal projectRequested()
  signal authorRequested()

  anchors.fill: root.showTrigger ? undefined : parent
  implicitWidth: root.showTrigger ? Style.space(24) : 0
  implicitHeight: root.showTrigger ? Style.space(24) : 0
  z: 40

  Button {
    id: menuButton
    visible: root.showTrigger
    anchors.fill: parent
    text: "⋮"
    foreground: root.textColor
    bordered: false
    onClicked: menu.opened ? menu.close() : menu.open()
  }

  QQC.Popup {
    id: menu
    width: Style.space(210)
    implicitHeight: menuItems.implicitHeight + Style.space(8)
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
      id: menuItems
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

      MenuRow {
        id: markRow
        // "These" and not "all": it marks the messages that are loaded, which
        // is what you are looking at, not every message the mailbox holds.
        text: "Mark these read"
        enabled: root.signedIn
        onActivated: { menu.close(); root.markAllReadRequested() }
      }
      MenuRow {
        id: webRow
        text: "Open web inbox..."
        visible: root.canOpenWebInbox
        enabled: root.signedIn
        onActivated: { menu.close(); root.openWebRequested() }
      }

      MenuSeparatorLine {
        width: menu.width - menu.leftPadding - menu.rightPadding
        lineColor: root.textColor
      }

      MenuRow {
        id: switchRow
        text: "Switch account..."
        visible: root.accountCount > 1
        onActivated: { menu.close(); root.switchAccountRequested() }
      }
      MenuRow {
        id: settingsRow
        text: "Settings..."
        onActivated: { menu.close(); root.setupRequested() }
      }

      MenuSeparatorLine {
        width: menu.width - menu.leftPadding - menu.rightPadding
        lineColor: root.textColor
      }

      MenuRow {
        id: shortcutsRow
        text: "Keyboard..."
        onActivated: { menu.close(); root.shortcutsRequested() }
      }
      MenuRow {
        id: projectRow
        text: "GitHub..."
        onActivated: { menu.close(); root.projectRequested() }
      }
      MenuRow {
        id: authorRow
        text: "Twitter..."
        onActivated: { menu.close(); root.authorRequested() }
      }
    }
  }

  // `enabled` is Item's own, and it already stops the handlers below from
  // firing, so a disabled row only has to look disabled.
  component MenuRow: MenuActionRow {
    width: menu.width - menu.leftPadding - menu.rightPadding
    textColor: root.textColor
    panelFontFamily: root.panelFontFamily
    collection: root.menuRows
    cursorIndex: root.cursorIndex
  }
}
