import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// "Move to Inbox", where it appears and what it says.
//
// The rule is the whole feature: `inInbox === false` alone put this row in
// Spam, Trash, Drafts and Sent, where adding INBOX is not what it means —
// `labelChangesFor` removes neither SPAM nor TRASH, so the message would carry
// both and stay where it was while the row claimed otherwise. Nothing in the
// suite touched either menu before this.
Item {
  width: 500
  height: 500

  QtObject {
    id: fakeService

    property bool canArchive: true
    property bool canReportSpam: true
    property bool canStar: true
    property bool canOpenOnWeb: false
    property bool hasLabels: true
    property string rawLabelId: ""
    property var messages: []
    property var unavailableActions: []

    // What was asked of it.
    property string ranAction: ""
    property string ranId: ""

    function act(id, action) {
      ranId = String(id || "")
      ranAction = String(action || "")
      return true
    }
    function toggleStar(_id) {}
  }

  Omamail.MessageMenu {
    id: menu
    anchors.fill: parent
    service: fakeService
    textColor: Qt.rgba(0.1, 0.1, 0.1, 1)
    urgentColor: Qt.rgba(0.8, 0.1, 0.1, 1)
    dimColor: Qt.rgba(0.45, 0.45, 0.45, 1)
    popupBackgroundColor: Qt.rgba(0.95, 0.95, 0.95, 1)
    popupBorderColor: Qt.rgba(0.6, 0.6, 0.6, 1)
    panelFontFamily: "monospace"
  }

  SignalSpy {
    id: actionSpy
    target: menu
    signalName: "actionRequested"
  }

  TestCase {
    name: "MessageMenuInbox"
    when: windowShown

    function rowFor(name) {
      for (var i = 0; i < menu.menuRows.length; i++) {
        var row = menu.menuRows[i]
        if (row && String(row.objectName || "") === name) return row
      }
      return null
    }

    // The rows have no objectName, so they are found by position in the array
    // the cursor itself indexes — which is also the thing that has to contain
    // the new row at all.
    function unarchiveRow() { return menu.menuRows[4] }
    function archiveRow() { return menu.menuRows[3] }

    // The popup builds its rows only once opened, so nothing about their
    // visibility is readable before that.
    function show(summary) {
      fakeService.messages = [summary]
      fakeService.ranAction = ""
      fakeService.ranId = ""
      fakeService.rawLabelId = ""
      menu.close()
      actionSpy.clear()
      menu.openAt(String(summary.id), 100, 100)
      wait(20)
    }

    function cleanup() { menu.close() }

    function archivedMessage() {
      return { id: "m1", subject: "filed", unread: false, starred: false,
        inInbox: false, inTrash: false, inSpam: false, isSent: false,
        isDraft: false, labelIds: ["Label_17"] }
    }

    // ---------------------------------------------------- where it appears

    function test_an_archived_message_offers_it_in_place_of_archive() {
      show(archivedMessage())
      compare(menu.archived, true)
      compare(unarchiveRow().visible, true)
      compare(archiveRow().visible, false,
        "a message out of the inbox cannot be archived again")
    }

    function test_an_inbox_message_offers_archive_instead() {
      var summary = archivedMessage()
      summary.inInbox = true
      show(summary)
      compare(menu.archived, false)
      compare(unarchiveRow().visible, false)
      compare(archiveRow().visible, true)
    }

    // The four that have their own verb or their own place. Adding INBOX to any
    // of them is not what "move to the inbox" means.
    function test_it_is_not_offered_where_it_would_lie_data() {
      return [
        { tag: "spam", field: "inSpam" },
        { tag: "trash", field: "inTrash" },
        { tag: "sent", field: "isSent" },
        { tag: "draft", field: "isDraft" }
      ]
    }

    function test_it_is_not_offered_where_it_would_lie(row) {
      var summary = archivedMessage()
      summary[row.field] = true
      show(summary)
      compare(menu.archived, false, row.tag + " has its own verb or its own place")
      compare(unarchiveRow().visible, false)
    }

    // ------------------------------------------------------- what it says

    function test_from_a_label_it_says_the_label_goes_too() {
      show(archivedMessage())
      compare(unarchiveRow().text, "Move to Inbox")

      fakeService.rawLabelId = "Label_17"
      compare(menu.inLabelView, true)
      compare(unarchiveRow().text, "Move to Inbox and remove label")
    }

    // The wording asks the same question `labelChangesFor` does, so it cannot
    // promise a removal that will not happen.
    function test_a_system_label_is_not_a_label_it_can_remove() {
      show(archivedMessage())
      fakeService.rawLabelId = "IMPORTANT"
      compare(menu.inLabelView, false)
      compare(unarchiveRow().text, "Move to Inbox")
    }

    // A folder provider's `rawLabelId` is a folder name, which is not a Gmail
    // label id and must not be promised as one.
    function test_a_folder_provider_promises_no_label_removal() {
      show(archivedMessage())
      fakeService.rawLabelId = "Archive"
      fakeService.hasLabels = false
      compare(menu.inLabelView, false)
      compare(unarchiveRow().text, "Move to Inbox")
      fakeService.hasLabels = true
    }

    // -------------------------------------------------------- the routing

    function test_choosing_it_asks_for_unarchive_on_that_message() {
      show(archivedMessage())
      unarchiveRow().activated()

      compare(actionSpy.count, 1)
      compare(actionSpy.signalArguments[0][0], "unarchive")
      compare(actionSpy.signalArguments[0][1], "m1",
        "and names the message the menu was opened on")
      compare(menu.opened, false, "choosing a row closes the menu")
    }

    // The cursor is an index into `menuRows`, so a row drawn but unlisted is
    // mouse-only: j and k step over it and Enter can never reach it.
    function test_the_keyboard_can_reach_it() {
      show(archivedMessage())
      var listed = false
      for (var i = 0; i < menu.menuRows.length; i++)
        if (menu.menuRows[i] === unarchiveRow()) listed = true
      verify(listed, "the row has to be in the array the cursor indexes")
    }
  }
}
