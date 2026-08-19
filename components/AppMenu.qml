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
  // The menu is opened from wherever the account lives — the sidebar's user
  // bar, or the status bar when the sidebar is hidden — so it carries no
  // trigger of its own by default.
  property bool showTrigger: false
  readonly property bool opened: menu.opened

  // Positioned against the window rather than a button, and flipped when it
  // would run off the bottom, since it opens from a bar at the bottom.
  function openAt(sceneX, sceneY) {
    var local = root.mapFromGlobal(sceneX, sceneY)
    menu.x = Math.max(0, Math.min(local.x, root.width - menu.width))
    menu.y = local.y + menu.implicitHeight > root.height
      ? Math.max(0, local.y - menu.implicitHeight)
      : local.y
    menu.open()
  }

  function close() { menu.close() }

  signal markAllReadRequested()
  signal openWebRequested()
  signal shortcutsRequested()
  signal setupRequested()
  signal projectRequested()
  signal signOutRequested()

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
        text: "Mark everything here read"
        enabled: root.signedIn
        onActivated: { menu.close(); root.markAllReadRequested() }
      }
      MenuRow {
        text: "Open in browser..."
        enabled: root.signedIn
        onActivated: { menu.close(); root.openWebRequested() }
      }

      Separator {}

      MenuRow {
        text: "Keyboard shortcuts..."
        onActivated: { menu.close(); root.shortcutsRequested() }
      }
      MenuRow {
        text: "Settings..."
        onActivated: { menu.close(); root.setupRequested() }
      }

      Separator {}

      MenuRow {
        text: "GitHub..."
        onActivated: { menu.close(); root.projectRequested() }
      }

      Separator {}

      MenuRow {
        text: "Sign out"
        enabled: root.signedIn
        onActivated: { menu.close(); root.signOutRequested() }
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
