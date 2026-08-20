import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui

// The list's right-click menu. It is a Popup rather than a child of the row
// because the list scrolls inside a clipping Flickable, which would cut the
// menu off at the column edge.
Item {
  id: root

  required property var service
  required property color textColor
  required property color urgentColor
  required property color dimColor
  required property string panelFontFamily

  property string messageId: ""
  readonly property bool opened: menu.opened
  readonly property var summary: {
    if (!service || messageId === "") return null
    var list = service.messages
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === messageId) return list[i]
    }
    return null
  }

  signal composeRequested(string mode, string id)
  signal actionRequested(string action, string id)

  anchors.fill: parent
  z: 50

  function openAt(id, sceneX, sceneY) {
    root.messageId = String(id || "")
    if (!root.summary) return
    var local = root.mapFromGlobal(sceneX, sceneY)
    // Flip rather than overflow: a menu opened near the bottom edge would
    // otherwise render half off-window.
    menu.x = Math.max(0, Math.min(local.x, root.width - menu.width))
    menu.y = local.y + menu.implicitHeight > root.height
      ? Math.max(0, local.y - menu.implicitHeight)
      : local.y
    menu.open()
  }

  function close() { menu.close() }

  function run(action) {
    var id = root.messageId
    menu.close()
    root.actionRequested(action, id)
  }

  function compose(mode) {
    var id = root.messageId
    menu.close()
    root.composeRequested(mode, id)
  }

  QQC.Popup {
    id: menu
    width: Style.space(200)
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

      MenuRow { text: "Reply"; onActivated: root.compose("reply") }
      MenuRow { text: "Reply all"; onActivated: root.compose("replyAll") }
      MenuRow { text: "Forward"; onActivated: root.compose("forward") }

      Separator {}

      // Hidden rather than disabled where the provider has no such verb. IMAP
      // archives by moving to a folder that may not exist, and has no junk
      // verb the server learns anything from — a "Report spam" that quietly
      // meant "move to a folder" would be a promise this cannot keep.
      MenuRow {
        visible: !root.service || root.service.canArchive
        text: "Archive"
        onActivated: root.run("archive")
      }
      MenuRow { text: "Move to trash"; tone: root.urgentColor; onActivated: root.run("trash") }
      MenuRow {
        visible: !root.service || root.service.canReportSpam
        text: "Report spam"
        tone: root.urgentColor
        onActivated: root.run("spam")
      }

      Separator {}

      MenuRow {
        text: root.summary && root.summary.unread ? "Mark as read" : "Mark as unread"
        onActivated: root.run(root.summary && root.summary.unread ? "markRead" : "markUnread")
      }
      MenuRow {
        visible: !root.service || root.service.canStar
        text: root.summary && root.summary.starred ? "Unstar" : "Star"
        onActivated: root.run(root.summary && root.summary.starred ? "unstar" : "star")
      }

      Separator {}

      // Only where there is a web mailbox to open. An IMAP account has no
      // address this plugin could know.
      MenuRow {
        visible: !root.service || root.service.canOpenOnWeb
        text: "Open in browser..."
        tone: root.dimColor
        onActivated: {
          var id = root.messageId
          menu.close()
          if (root.service) root.service.openInBrowser(id)
        }
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

  component MenuRow: Rectangle {
    id: row
    required property string text
    property color tone: root.textColor
    signal activated()

    width: menu.width - menu.leftPadding - menu.rightPadding
    implicitHeight: Style.spacing.popupRowHeight
    radius: Style.cornerRadius
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
      color: row.tone
      font.family: root.panelFontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }

    HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
    TapHandler { onTapped: row.activated() }
  }
}
