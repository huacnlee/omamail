import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import qs.Commons as Commons
import "../../components" as Mail

// Dragging an email onto the sidebar: a row reports its drag, and a label row
// takes the drop only where it would change something.
Item {
  width: 600
  height: 400

  QtObject {
    id: fakeService
    property var messages: []
    property bool hasMore: false
    property bool listLoading: false
    property bool listLoaded: true
    property string searchQuery: ""
    property string selectedId: ""
    property bool canArchive: true
    property string contentDirection: "auto"
    property var agentJobs: ({})
    property var agentAttentionByMessage: ({})
    function loadMore() {}
  }

  Flickable {
    id: flick
    x: 220
    width: 380
    height: 400
    contentWidth: width
    contentHeight: list.implicitHeight + 600
    clip: true

    Mail.MessageList {
      id: list
      width: flick.width
      service: fakeService
      textColor: Commons.Color.foreground
      accentColor: Commons.Color.accent
      dimColor: Commons.Color.foreground
      urgentColor: Commons.Color.accent
      panelFontFamily: "monospace"
    }
  }

  property var fake: ({
    labels: [{ id: "Label_1", name: "Work", rawName: "Work", delimiter: "/", unread: 0 }],
    mailboxes: [{ key: "inbox", label: "Inbox", icon: "inbox" }],
    collapsedFolders: [], rawQuery: "", mailboxKey: "inbox", searchQuery: "", providerId: "gmail"
  })

  Mail.MailboxSidebar {
    id: sidebar
    width: 220
    height: 400
    service: fake
    dropEnabled: true
    textColor: Commons.Color.foreground
    accentColor: Commons.Color.accent
    dimColor: Commons.Color.foreground
    panelFontFamily: "monospace"
    slots: [{ kind: "mailbox", key: "inbox" }]
  }

  Rectangle {
    id: source
    width: 20
    height: 20
    Drag.keys: ["omamail-message"]
    Drag.dragType: Drag.Internal
  }

  SignalSpy { id: started; target: list; signalName: "rowDragStarted" }
  SignalSpy { id: ended; target: list; signalName: "rowDragEnded" }
  SignalSpy { id: dropped; target: sidebar; signalName: "labelDropped" }

  TestCase {
    name: "MessageDrag"
    when: windowShown

    function row(id) {
      return ({ id: id, threadId: "", from: { email: "x@example.com", display: "X" }, subject: "Message " + id,
        snippet: "", time: "", date: "", unread: false, starred: false, inInbox: true, labelIds: ["INBOX"] })
    }

    function textItem(item, value) {
      if (item.text === value && item.textFormat !== undefined) return item
      var children = item.children || []
      for (var i = 0; i < children.length; i++) {
        var found = textItem(children[i], value)
        if (found) return found
      }
      return null
    }

    function dropOnWork() {
      var label = textItem(sidebar, "Work")
      verify(label, "the Work label is on screen")
      var at = label.mapToItem(null, label.width / 2, label.height / 2)
      source.x = at.x - 10
      source.y = at.y - 10
      source.Drag.active = true
      source.x = at.x - 9
      source.Drag.drop()
      source.Drag.active = false
    }

    function test_a_label_takes_a_drop_and_a_refused_one_is_ignored() {
      dropped.clear()
      sidebar.dropAllowed = function() { return true }
      wait(30)
      dropOnWork()
      compare(dropped.count, 1)
      compare(dropped.signalArguments[0][0], "Label_1")

      dropped.clear()
      sidebar.dropAllowed = function() { return false }
      wait(30)
      dropOnWork()
      compare(dropped.count, 0)
    }

    function test_dragging_a_row_sideways_reports_the_row() {
      fakeService.messages = [row("1:INBOX"), row("2:INBOX"), row("3:INBOX")]
      started.clear(); ended.clear()
      wait(30)
      var target = list.children[1]
      var y = target.y + target.height / 2
      mousePress(list, 100, y)
      mouseMove(list, 90, y, 20)
      mouseMove(list, 60, y, 20)
      mouseMove(list, 20, y + 5, 20)
      mouseRelease(list, 20, y + 5)
      compare(started.count, 1)
      compare(started.signalArguments[0][0], "2:INBOX")
      compare(ended.count, 1)
    }
  }
}
