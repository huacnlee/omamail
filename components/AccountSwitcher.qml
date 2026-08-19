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

  signal accountChosen(int index)
  signal addAccountRequested()
  signal removeAccountRequested(int index)
  signal manageRequested()

  anchors.fill: parent
  z: 45

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
  // very first click its height is still zero — the "does it fit below?" test
  // passed trivially and the menu was placed at the click, then grew off the
  // bottom of the window. Placing again whenever the height changes is what
  // makes the first open behave like every one after it, and it also re-places
  // the menu when a row is added or removed.
  function place() {
    if (!menu.visible) return
    var tall = menu.height > 0 ? menu.height : menu.implicitHeight
    var x = Math.max(0, Math.min(anchorX, root.width - menu.width))
    var y = anchorY
    // Below the click by preference, above it if that would overflow, and
    // pinned to the bottom edge if the menu is taller than the room either way.
    if (y + tall > root.height) y = anchorY - tall
    if (y + tall > root.height) y = root.height - tall
    if (y < 0) y = 0
    menu.x = x
    menu.y = y
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
    onHeightChanged: root.place()
    onOpened: root.place()
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
          required property int index

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

            // The address, not the name derived from it. This list exists to
            // tell two mailboxes apart, and two accounts can easily share a
            // local part across different domains.
            Text {
              width: parent.width
              text: row.modelData.email !== "" ? row.modelData.email : "New account"
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
                // Only when it says something the address does not.
                var name = String(row.modelData.label || "")
                return name !== "" && row.modelData.email.indexOf(name) !== 0 ? name : ""
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
              root.removeAccountRequested(row.index)
            }
          }

          HoverHandler { id: rowHover; cursorShape: Qt.PointingHandCursor }
          TapHandler {
            onTapped: {
              menu.close()
              root.accountChosen(row.index)
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
        text: "Add a mailbox..."
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
