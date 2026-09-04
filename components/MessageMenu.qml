import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "Menu.js" as Menu
import "../account/Model.js" as Model

// The list's right-click menu. It is a Popup rather than a child of the row
// because the list scrolls inside a clipping Flickable, which would cut the
// menu off at the column edge.
Item {
  id: root

  required property var service
  required property color textColor
  required property color urgentColor
  required property color dimColor
  required property color popupBackgroundColor
  required property color popupBorderColor
  required property string panelFontFamily

  property string messageId: ""
  property real anchorX: 0
  property real anchorY: 0
  property int cursorIndex: -1
  readonly property var menuRows: [replyRow, replyAllRow, forwardRow, archiveRow,
    unarchiveRow,
    trashRow, spamRow, readRow, starRow, browserRow]
  // Whether this message is archived — out of the inbox and not somewhere
  // that has its own verb. Read off the summary the menu was opened on rather
  // than asked of the service, because the menu is about one message. IMAP
  // synthesises all four of these from the folder, so one rule serves both
  // kinds of provider.
  readonly property bool archived: !!root.summary
    && root.summary.inInbox === false
    && root.summary.inTrash !== true
    && root.summary.inSpam !== true
    && root.summary.isSent !== true
    && root.summary.isDraft !== true

  // Whether the list it was opened from is a label's, and whether that label
  // is one a message can be taken out of — which is the same question
  // `labelChangesFor` asks, so the wording cannot promise a removal that does
  // not happen.
  readonly property bool inLabelView: !!root.service
    && !!root.service.hasLabels
    && String(root.service.rawLabelId || "") !== ""
    && !Model.isSystemLabelId(String(root.service.rawLabelId || ""))

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

      MenuRow { id: replyRow; text: "Reply"; onActivated: root.compose("reply") }
      MenuRow { id: replyAllRow; text: "Reply all"; onActivated: root.compose("replyAll") }
      MenuRow { id: forwardRow; text: "Forward"; onActivated: root.compose("forward") }

      MenuSeparatorLine {
        width: menu.width - menu.leftPadding - menu.rightPadding
        lineColor: root.textColor
      }

      // Hidden rather than disabled where the provider has no such verb. IMAP
      // archives by moving to a folder that may not exist, and has no junk
      // verb the server learns anything from — a "Report spam" that quietly
      // meant "move to a folder" would be a promise this cannot keep.
      MenuRow {
        id: archiveRow
        visible: (!root.service || root.service.canArchive) && !root.archived
        text: "Archive"
        onActivated: root.run("archive")
      }
      // The other direction, and only where it would be the truth.
      //
      // `inInbox === false` alone put this row in Spam, Trash, Drafts and
      // Sent, where adding INBOX is not what "move to the inbox" means:
      // `labelChangesFor` removes neither SPAM nor TRASH, so a spam message
      // would carry INBOX *and* SPAM and stay in Spam while the row claimed
      // otherwise, and on IMAP the same press physically relocates a draft
      // out of the Drafts folder. Spam has its own verb and trash has its own
      // endpoint, for exactly this reason; archived mail is what is left.
      MenuRow {
        id: unarchiveRow
        visible: (!root.service || root.service.canArchive) && root.archived
        text: root.inLabelView ? "Move to Inbox and remove label" : "Move to Inbox"
        onActivated: root.run("unarchive")
      }
      MenuRow { id: trashRow; text: "Move to trash"; tone: root.urgentColor; onActivated: root.run("trash") }
      MenuRow {
        id: spamRow
        visible: !root.service || root.service.canReportSpam
        text: "Report spam"
        tone: root.urgentColor
        onActivated: root.run("spam")
      }

      MenuSeparatorLine {
        width: menu.width - menu.leftPadding - menu.rightPadding
        lineColor: root.textColor
      }

      MenuRow {
        id: readRow
        text: root.summary && root.summary.unread ? "Mark as read" : "Mark as unread"
        onActivated: root.run(root.summary && root.summary.unread ? "markRead" : "markUnread")
      }
      MenuRow {
        id: starRow
        visible: !root.service || root.service.canStar
        text: root.summary && root.summary.starred ? "Unstar" : "Star"
        onActivated: root.run(root.summary && root.summary.starred ? "unstar" : "star")
      }

      MenuSeparatorLine {
        width: menu.width - menu.leftPadding - menu.rightPadding
        lineColor: root.textColor
      }

      // Only where there is a web mailbox to open. An IMAP account has no
      // address this plugin could know.
      MenuRow {
        id: browserRow
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

  component MenuRow: MenuActionRow {
    width: menu.width - menu.leftPadding - menu.rightPadding
    textColor: root.textColor
    panelFontFamily: root.panelFontFamily
    collection: root.menuRows
    cursorIndex: root.cursorIndex
  }
}
