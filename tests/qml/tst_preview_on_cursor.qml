import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

// Showing a message as the cursor reaches it.
//
// This behaviour existed once and was taken out, because stepping through a
// list marked half of it read without any of it having been looked at. So the
// assertions that matter here are the ones about what a preview does *not*
// do: it marks nothing read on arrival, it pushes no history, and it does not
// happen at all in a narrow window where the reader takes the list's place.
Item {
  width: 1200
  height: 700

  QtObject {
    id: fakeShell
    function hide(_id) {}
  }

  QtObject {
    id: mailService

    property bool ready: true
    property bool anyAccountReady: true
    property bool previewOnCursor: true
    property int markReadDelaySec: 2
    property bool sendPending: false
    property bool sending: false
    property bool windowOpen: true
    property bool sidebarCollapsed: false
    property bool alwaysShowImages: false
    property bool unifiedCalendarView: false
    property bool selectedReaderEmpty: false
    property bool selectedReaderTooHeavy: false
    property bool selectedTooHeavy: false
    property bool detailLoading: false
    property bool detailPainted: true
    property bool canOpenOnWeb: false
    property bool canRespondToInvite: false
    property bool rsvpSending: false
    property bool canArchive: true
    property bool canStar: true
    property bool canSpam: true
    property bool canTrash: true
    property bool canMarkRead: true
    property bool canMarkUnread: true
    property bool accountDraftOpen: false
    property int accountCount: 1
    property int inboxUnread: 2
    property real bodyZoom: 1
    property string bodyMode: "reader"
    property string providerId: "gmail"
    property string pluginDir: ""
    property string accountEmail: "me@example.com"
    property string activeAccountId: "me@example.com"
    property string mailboxKey: "inbox"
    property string searchQuery: ""
    property string rawQuery: ""
    property string lastError: ""
    property string actionStatus: ""
    property string syncedLabel: ""
    property string recipientContactStatus: ""
    property var auth: null
    property var accountSummaries: [{ provider: "gmail", email: "me@example.com" }]
    property var accountSignatures: []
    property var mailboxes: []
    property var labels: []
    property var selectedAttachments: []
    property var selectedInvite: null
    property var selectedResponse: ""
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: []
    property var calendarController: null
    property var selectedBody: ({ text: "body", source: "plain" })
    property var selectedMessage: null

    property var messages: [
      { id: "m1", subject: "first", unread: true, from: { email: "a@x", display: "A" },
        snippet: "one", time: "now", fullTime: "today", date: 3000 },
      { id: "m2", subject: "second", unread: true, from: { email: "b@x", display: "B" },
        snippet: "two", time: "now", fullTime: "today", date: 2000 },
      { id: "m3", subject: "third", unread: true, from: { email: "c@x", display: "C" },
        snippet: "three", time: "now", fullTime: "today", date: 1000 }
    ]

    // What the panel asked for.
    property string selectedId: ""
    property int selectCount: 0
    property int previewSelects: 0
    property int openSelects: 0
    property var markedRead: []

    function select(id, previewOnly) {
      selectedId = String(id || "")
      selectCount += 1
      if (previewOnly === true) previewSelects += 1
      else openSelects += 1
    }

    function markPreviewRead(id) {
      var next = markedRead.slice()
      next.push(String(id || ""))
      markedRead = next
      return true
    }

    function cursorOffset(id, delta) {
      var at = -1
      for (var i = 0; i < messages.length; i++) if (messages[i].id === id) at = i
      if (at < 0) return delta < 0 ? messages[messages.length - 1].id : messages[0].id
      var next = at + delta
      if (next < 0 || next >= messages.length) return ""
      return messages[next].id
    }

    function clearSelection() { selectedId = "" }
    function refreshRecipientContacts() {}
    function preferredSendAs(_r) { return null }
    function loadAttachments(_i, _a, cb) { cb([], "") }
    function fail(_t) {}
    function note(_t) {}
    function act(_i, _a, _q) { return true }
    signal replySent()
  }

  Omamail.App {
    id: app
    service: mailService
    shell: fakeShell
  }

  TestCase {
    name: "PreviewOnCursor"
    when: windowShown

    // The FloatingWindow, found by its title the way the other App tests find
    // it: `children[0]` is not reliably the window.
    function window() {
      return having(app, function(it) { return it.title === "Omamail" })
    }

    function having(item, accept) {
      if (!item) return null
      if (accept(item)) return item
      var children = item.children || []
      for (var i = 0; i < children.length; i++) {
        var found = having(children[i], accept)
        if (found) return found
      }
      return null
    }

    function init() {
      window().width = 1200
      window().height = 700
      waitForRendering(app)
      app.resetNavigation()
      app.cursorId = ""
      mailService.previewOnCursor = true
      mailService.markReadDelaySec = 2
      mailService.selectedId = ""
      mailService.selectCount = 0
      mailService.previewSelects = 0
      mailService.openSelects = 0
      mailService.markedRead = []
    }

    // ------------------------------------------------------------ the point

    function test_moving_the_cursor_shows_the_message() {
      app.moveCursor(1)
      compare(app.cursorId, "m1")
      compare(mailService.selectedId, "m1", "the reader is given the message at once")
      compare(mailService.previewSelects, 1)
      compare(mailService.openSelects, 0, "and it was a preview, not an open")
    }

    function test_moving_again_previews_the_next_one() {
      app.moveCursor(1)
      app.moveCursor(1)
      compare(app.cursorId, "m2")
      compare(mailService.selectedId, "m2")
      compare(mailService.previewSelects, 2)
    }

    // ----------------------------------------------------- what it does not do

    // The reason this was taken out the first time.
    function test_a_preview_marks_nothing_read_on_arrival() {
      app.moveCursor(1)
      app.moveCursor(1)
      app.moveCursor(1)
      compare(mailService.markedRead.length, 0,
        "stepping through a list must not read it")
    }

    // Escape and Back have to mean what they meant.
    function test_a_preview_pushes_no_history() {
      var before = app.navKinds.join(",")
      app.moveCursor(1)
      app.moveCursor(1)
      compare(app.navKinds.join(","), before, "moving is not a place")
      compare(app.currentView, "list", "and the list is still what is open")
    }

    // A narrow window swaps the list for the reader, so previewing would
    // navigate away from the list being moved through.
    function test_a_narrow_window_does_not_preview() {
      window().width = 700
      waitForRendering(app)
      compare(app.compact, true)

      app.moveCursor(1)
      compare(app.cursorId, "m1", "the cursor still moves")
      compare(mailService.selectCount, 0, "but nothing is shown")
    }

    function test_the_setting_off_is_the_old_behaviour() {
      mailService.previewOnCursor = false
      app.moveCursor(1)
      compare(app.cursorId, "m1")
      compare(mailService.selectCount, 0, "moving is not opening")
    }

    // ---------------------------------------------------------- the dwell

    function test_staying_on_a_message_reads_it() {
      mailService.markReadDelaySec = 1
      app.moveCursor(1)
      compare(mailService.markedRead.length, 0)
      tryVerify(function() { return mailService.markedRead.indexOf("m1") >= 0 }, 3000,
        "a message the cursor stayed on counts as read")
    }

    // The held arrow key: every message is previewed, none is dwelled on.
    function test_moving_on_before_the_dwell_reads_nothing() {
      mailService.markReadDelaySec = 1
      app.moveCursor(1)
      app.moveCursor(1)
      app.moveCursor(1)
      wait(1400)
      compare(mailService.markedRead.indexOf("m1"), -1, "m1 was passed over")
      compare(mailService.markedRead.indexOf("m2"), -1, "so was m2")
      compare(mailService.markedRead.indexOf("m3") >= 0, true,
        "only the one it stopped on")
    }

    // Zero is a decision, not a disabled dwell.
    function test_a_zero_delay_reads_it_at_once() {
      mailService.markReadDelaySec = 0
      app.moveCursor(1)
      compare(mailService.markedRead.indexOf("m1") >= 0, true)
    }

    // Opening marks it read itself, so a dwell still counting has nothing to
    // do — and must not fire against a message that has since been opened.
    function test_opening_takes_over_from_the_dwell() {
      mailService.markReadDelaySec = 1
      app.moveCursor(1)
      app.openMessage("m1")
      compare(mailService.openSelects, 1, "opening is not a preview")
      wait(1400)
      compare(mailService.markedRead.length, 0,
        "the open path marks it read, not the dwell")
    }
  }
}
