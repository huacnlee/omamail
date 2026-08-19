import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui

// Links out, plus the handful of actions that have no natural home on screen.
Item {
  id: root

  required property color textColor
  required property string panelFontFamily
  property bool signedIn: false
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
    var x = Math.max(0, Math.min(anchorX, root.width - menu.width))
    var y = anchorY
    if (y + tall > root.height) y = anchorY - tall
    if (y + tall > root.height) y = root.height - tall
    if (y < 0) y = 0
    menu.x = x
    menu.y = y
  }

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
    onOpened: root.place()
    background: Rectangle {
      radius: Style.cornerRadius
      color: Color.popups.background
      border.width: 1
      border.color: Color.popups.border
    }
    contentItem: Column {
      id: menuItems
      spacing: Style.space(2)

      MenuRow {
        // "These" and not "all": it marks the messages that are loaded, which
        // is what you are looking at, not every message the mailbox holds.
        text: "Mark these read"
        enabled: root.signedIn
        onActivated: { menu.close(); root.markAllReadRequested() }
      }
      MenuRow {
        text: "Open in Gmail"
        enabled: root.signedIn
        onActivated: { menu.close(); root.openWebRequested() }
      }

      Separator {}

      MenuRow {
        text: "Switch account..."
        visible: root.accountCount > 1
        onActivated: { menu.close(); root.switchAccountRequested() }
      }
      MenuRow {
        text: "Settings..."
        onActivated: { menu.close(); root.setupRequested() }
      }

      Separator {}

      MenuRow {
        text: "Shortcuts"
        onActivated: { menu.close(); root.shortcutsRequested() }
      }
      MenuRow {
        text: "GitHub"
        onActivated: { menu.close(); root.projectRequested() }
      }
      MenuRow {
        text: "Twitter"
        onActivated: { menu.close(); root.authorRequested() }
      }
    }
  }

  component Separator: Item {
    width: menu.width - menu.leftPadding - menu.rightPadding
    implicitHeight: Style.space(7)
    PanelSeparator {
      anchors.verticalCenter: parent.verticalCenter
      width: parent.width
      foreground: root.textColor
    }
  }

  // `enabled` is Item's own, and it already stops the handlers below from
  // firing, so a disabled row only has to look disabled.
  component MenuRow: Rectangle {
    id: row
    required property string text
    signal activated()

    width: menu.width - menu.leftPadding - menu.rightPadding
    implicitHeight: Style.spacing.popupRowHeight
    radius: Style.cornerRadius
    opacity: row.enabled ? 1.0 : 0.4
    color: hover.hovered
      ? Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.08)
      : "transparent"

    Text {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(9)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(9)
      anchors.verticalCenter: parent.verticalCenter
      text: row.text
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }

    HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
    TapHandler { onTapped: row.activated() }
  }
}
