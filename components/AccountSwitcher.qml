import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui

// The list of mailboxes, opened from the user bar.
//
// Switching is meant to be instant, which it is because every account keeps its
// own cache — so this shows each one's unread count even while you are looking
// at another, and says which is being checked right now. An account that has
// not finished signing in is listed too, because otherwise a half-added
// mailbox becomes invisible and unfixable.
Item {
  id: root

  required property color textColor
  required property color accentColor
  required property color urgentColor
  required property color dimColor
  required property string panelFontFamily

  // [{ id, email, label, unread, active, signedIn, busy, error }]
  property var accounts: []

  readonly property bool opened: menu.opened

  signal accountChosen(string id)
  signal addAccountRequested()
  signal removeAccountRequested(string id)
  signal manageRequested()

  anchors.fill: parent
  z: 45

  function openAt(sceneX, sceneY) {
    var local = root.mapFromGlobal(sceneX, sceneY)
    menu.x = Math.max(0, Math.min(local.x, root.width - menu.width))
    menu.y = local.y + menu.implicitHeight > root.height
      ? Math.max(0, local.y - menu.implicitHeight)
      : local.y
    menu.open()
  }

  function close() { menu.close() }

  QQC.Popup {
    id: menu
    width: Style.space(250)
    implicitHeight: rows.implicitHeight + Style.space(8)
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
      id: rows
      spacing: Style.space(2)

      Repeater {
        model: root.accounts

        Rectangle {
          id: row
          required property var modelData

          width: menu.width - menu.leftPadding - menu.rightPadding
          implicitHeight: Style.space(40)
          radius: Style.cornerRadius
          color: modelData.active
            ? Style.selectedFillFor(root.textColor, root.accentColor)
            : (rowHover.hovered ? Style.hoverFillFor(root.textColor, root.accentColor) : "transparent")

          Rectangle {
            id: rowAvatar
            anchors.left: parent.left
            anchors.leftMargin: Style.space(8)
            anchors.verticalCenter: parent.verticalCenter
            width: Style.space(22)
            height: width
            radius: width / 2
            color: Style.selectedFillFor(root.textColor, root.accentColor)

            Text {
              anchors.centerIn: parent
              text: row.modelData.email === ""
                ? "+" : row.modelData.email.charAt(0).toUpperCase()
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }
          }

          Column {
            anchors.left: rowAvatar.right
            anchors.leftMargin: Style.space(9)
            anchors.right: rowCount.left
            anchors.rightMargin: Style.space(6)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(1)

            Text {
              width: parent.width
              text: row.modelData.label
              color: root.textColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: row.modelData.active
              elide: Text.ElideMiddle
            }

            // Says why an account is not usable, rather than leaving it looking
            // identical to one that is.
            Text {
              width: parent.width
              visible: text !== ""
              text: {
                if (row.modelData.error !== undefined && row.modelData.error !== "")
                  return row.modelData.error
                if (!row.modelData.signedIn) return "Not signed in"
                if (row.modelData.busy) return "Checking…"
                return ""
              }
              color: row.modelData.error !== undefined && row.modelData.error !== ""
                ? root.urgentColor : root.dimColor
              font.family: root.panelFontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }

          Text {
            id: rowCount
            anchors.right: rowRemove.left
            anchors.rightMargin: Style.space(4)
            anchors.verticalCenter: parent.verticalCenter
            visible: row.modelData.unread > 0
            text: row.modelData.unread > 999 ? "999+" : row.modelData.unread
            color: root.accentColor
            font.family: root.panelFontFamily
            font.pixelSize: Style.font.caption
            font.bold: true
          }

          IconButton {
            id: rowRemove
            anchors.right: parent.right
            anchors.rightMargin: Style.space(4)
            anchors.verticalCenter: parent.verticalCenter
            visible: rowHover.hovered && root.accounts.length > 1
            iconName: "close"
            tooltipText: "Remove this account"
            foreground: root.dimColor
            hoverColor: root.urgentColor
            iconSize: Style.font.iconSmall
            size: Style.space(20)
            fontFamily: root.panelFontFamily
            onClicked: {
              menu.close()
              root.removeAccountRequested(row.modelData.id)
            }
          }

          HoverHandler { id: rowHover; cursorShape: Qt.PointingHandCursor }
          TapHandler {
            onTapped: {
              menu.close()
              root.accountChosen(row.modelData.id)
            }
          }
        }
      }

      Item {
        width: menu.width - menu.leftPadding - menu.rightPadding
        implicitHeight: Style.space(7)

        PanelSeparator {
          anchors.verticalCenter: parent.verticalCenter
          width: parent.width
          foreground: root.textColor
        }
      }

      MenuRow {
        text: "Add another account..."
        onActivated: {
          menu.close()
          root.addAccountRequested()
        }
      }
    }
  }

  component MenuRow: Rectangle {
    id: plainRow
    required property string text
    signal activated()

    width: menu.width - menu.leftPadding - menu.rightPadding
    implicitHeight: Style.spacing.popupRowHeight
    radius: Style.cornerRadius
    color: plainHover.hovered
      ? Qt.rgba(root.textColor.r, root.textColor.g, root.textColor.b, 0.08)
      : "transparent"

    Text {
      anchors.left: parent.left
      anchors.leftMargin: Style.space(9)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(9)
      anchors.verticalCenter: parent.verticalCenter
      text: plainRow.text
      color: root.textColor
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }

    HoverHandler { id: plainHover; cursorShape: Qt.PointingHandCursor }
    TapHandler { onTapped: plainRow.activated() }
  }
}
