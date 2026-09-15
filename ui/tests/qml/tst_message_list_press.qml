import QtQuick 2.15
import QtTest 1.3
import qs.Commons
import "../../components" as Mail

// A press on a row survives the list being told its messages again.
//
// The list is handed a new array whenever anything about any message
// changes — a row opened half a second ago comes back marked read, a poll
// lands — and a Repeater fed the array itself tore every row down and built
// it again. A pointer pressed on a row at that moment was pressed on
// nothing: no release, no click, and the message did not open.
Item {
  width: 400
  height: 300

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

  Mail.MessageList {
    id: list
    width: parent.width
    service: fakeService
    textColor: Color.foreground
    accentColor: Color.accent
    dimColor: Color.foreground
    urgentColor: Color.accent
    panelFontFamily: "monospace"
    property var activated: []
    onMessageActivated: function(id) { activated.push(id) }
  }

  TestCase {
    name: "MessageListPress"
    when: windowShown

    function row(id, unread) {
      return ({ id: id, threadId: "", from: { email: "x@example.com", display: "X" }, subject: "Message " + id,
        snippet: "", time: "", date: "", unread: unread === true, starred: false, inInbox: true, labelIds: ["INBOX"] })
    }

    function rows(secondUnread) {
      return [row("1:INBOX"), row("2:INBOX", secondUnread), row("3:INBOX")]
    }

    function init() {
      fakeService.messages = rows(true)
      list.activated = []
      wait(30)
    }

    function test_a_press_outlives_the_messages_being_told_again() {
      var target = list.children[1]
      verify(target && target.summary && target.summary.id === "2:INBOX", "the second row is on screen")
      var x = 20, y = target.y + target.height / 2
      mousePress(list, x, y)
      // The second message comes back read, as it does after being opened.
      fakeService.messages = rows(false)
      wait(30)
      mouseRelease(list, x, y)
      compare(list.activated, ["2:INBOX"])
    }
  }
}
