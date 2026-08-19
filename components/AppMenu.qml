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

  signal markAllReadRequested()
  signal openWebRequested()
  signal shortcutsRequested()
  signal setupRequested()
  signal signOutRequested()

  implicitWidth: Style.space(24)
  implicitHeight: Style.space(24)

  Button {
    id: menuButton
    anchors.fill: parent
    text: "⋮"
    foreground: root.textColor
    bordered: false
    onClicked: menu.opened ? menu.close() : menu.open()
  }

  QQC.Popup {
    id: menu
    x: menuButton.width - width
    y: menuButton.height + Style.space(4)
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
        text: "OAuth client..."
        onActivated: { menu.close(); root.setupRequested() }
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
