import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

// Keyboard movement opens the reader immediately through explicit selection.
// No preview preference, settling delay, or dwell can delay that selection.
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
    property bool selectionIsPreview: false
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

    readonly property var initialMessages: [
      { id: "m1", subject: "first", unread: true, from: { email: "a@x", display: "A" },
        snippet: "one", time: "now", fullTime: "today", date: 3000 },
      { id: "m2", subject: "second", unread: true, from: { email: "b@x", display: "B" },
        snippet: "two", time: "now", fullTime: "today", date: 2000 },
      { id: "m3", subject: "third", unread: true, from: { email: "c@x", display: "C" },
        snippet: "three", time: "now", fullTime: "today", date: 1000 }
    ]

    property var messages: initialMessages.slice()

    // What the panel asked for.
    property string selectedId: ""
    property int selectCount: 0
    property int previewSelects: 0
    property int openSelects: 0
    property var markedRead: []

    function select(id, previewOnly) {
      selectedId = String(id || "")
      selectedMessage = messages.filter(function(row) { return row.id === selectedId })[0] || null
      selectCount += 1
      // What `MailAccount.select` records, because two decisions in the window
      // now turn on it.
      selectionIsPreview = previewOnly === true
      if (previewOnly === true) previewSelects += 1
      else openSelects += 1
    }

    // A body that has not landed. `select` puts the reader into this state on
    // the real service; here the test says when it comes out of it, which is
    // what a slow fetch and a failed one differ by.
    function beginFetch() {
      detailLoading = true
      detailPainted = false
    }

    function finishFetch() {
      detailLoading = false
      detailPainted = true
    }

    // A fetch that failed: it stopped, and nothing was painted.
    function failFetch() {
      detailLoading = false
      detailPainted = false
    }

    function markPreviewRead(id) {
      var next = markedRead.slice()
      next.push(String(id || ""))
      markedRead = next
      return true
    }

    function cursorOffset(id, delta) {
      if (messages.length === 0) return ""
      var at = -1
      for (var i = 0; i < messages.length; i++) if (messages[i].id === id) at = i
      if (at < 0) return delta < 0 ? messages[messages.length - 1].id : messages[0].id
      var next = at + delta
      return messages[Math.max(0, Math.min(messages.length - 1, next))].id
    }

    function clearSelection() {
      selectedId = ""
      selectionIsPreview = false
    }
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
    name: "KeyboardReaderNavigation"
    when: windowShown

    // The FloatingWindow, found by its title the way the other App tests find
    // it: `children[0]` is not reliably the window.
    function window() {
      return having(app, function(it) { return it.title === "Omamail" })
    }

    // The reader panel, found by the one property only it has. It draws no
    // objectName and `children[0]` is not reliably anything.
    function readerView() {
      return having(app, function(it) { return it.forceRichAnyway !== undefined })
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
      app.opened = true
      window().width = 1200
      window().height = 700
      waitForRendering(app)
      app.resetNavigation()
      app.cursorId = ""
      mailService.messages = mailService.initialMessages.slice()
      mailService.mailboxKey = "inbox"
      mailService.searchQuery = ""
      mailService.rawQuery = ""
      mailService.selectedMessage = null
      mailService.previewOnCursor = true
      mailService.markReadDelaySec = 2
      mailService.selectedId = ""
      mailService.selectCount = 0
      mailService.previewSelects = 0
      mailService.openSelects = 0
      mailService.markedRead = []
      mailService.finishFetch()
      app.cursorId = ""
    }

    function test_real_j_and_k_keys_keep_focus_parked_while_opening_rows() {
      var scope = having(app, function(item) { return item.keyContext !== undefined })
      verify(scope)
      scope.applyContextFocus()
      wait(20)
      app.cursorId = ""
      keyClick(Qt.Key_J)
      compare(mailService.selectedId, "m1")
      tryCompare(scope, "keyContext", "reader")
      wait(20)
      keyClick(Qt.Key_J)
      compare(app.cursorId, "m2")
      compare(mailService.selectedId, "m2")
      keyClick(Qt.Key_K)
      compare(app.cursorId, "m1")
      compare(mailService.selectedId, "m1")
      compare(scope.keyContext, "reader")
    }

    function test_j_opens_without_waiting_for_an_event_loop_or_dwell() {
      mailService.previewOnCursor = false
      mailService.markReadDelaySec = 30
      app.runShortcut("cursorDown", "J")
      compare(app.cursorId, "m1")
      compare(mailService.selectedId, "m1")
      compare(mailService.openSelects, 1)
      compare(mailService.previewSelects, 0)
      compare(mailService.selectionIsPreview, false)
      compare(app.currentView, "reader")
    }

    function test_repeated_movement_opens_each_selected_row_and_replaces_reader_history() {
      app.moveCursor(1)
      app.moveCursor(1)
      app.moveCursor(1)
      compare(app.cursorId, "m3")
      compare(mailService.selectedId, "m3")
      compare(mailService.openSelects, 3)
      compare(app.navKinds.join(","), "list,reader")
      app.moveCursor(-1)
      compare(app.cursorId, "m2")
      compare(mailService.selectedId, "m2")
    }

    function test_narrow_window_immediately_shows_reader() {
      window().width = 700
      waitForRendering(app)
      compare(app.compact, true)
      app.moveCursor(1)
      compare(mailService.selectedId, "m1")
      compare(app.currentView, "reader")
    }

    function test_bounds_do_not_reopen_the_same_message() {
      app.moveCursor(-1)
      compare(app.cursorId, "m3")
      app.moveCursor(1)
      compare(mailService.openSelects, 1)
      app.moveCursor(-1)
      app.moveCursor(-1)
      compare(app.cursorId, "m1")
      var count = mailService.openSelects
      app.moveCursor(-1)
      compare(mailService.openSelects, count)
    }

    function test_one_message_opens_once_and_an_empty_list_opens_nothing() {
      mailService.messages = [mailService.initialMessages[0]]
      app.cursorId = ""
      app.moveCursor(1)
      app.moveCursor(1)
      app.moveCursor(-1)
      compare(mailService.selectedId, "m1")
      compare(mailService.openSelects, 1)
      mailService.messages = []
      mailService.clearSelection()
      app.moveCursor(1)
      compare(mailService.selectedId, "")
      compare(mailService.openSelects, 1)
    }

    function test_drafts_navigation_reads_without_opening_the_composer() {
      mailService.mailboxKey = "drafts"
      app.moveCursor(1)
      compare(app.currentView, "reader")
      compare(app.composing, false)
      compare(mailService.selectedId, "m1")
    }

    function test_navigation_preserves_the_current_query() {
      mailService.searchQuery = "from:sender"
      mailService.rawQuery = "from:sender"
      app.moveCursor(1)
      compare(mailService.searchQuery, "from:sender")
      compare(mailService.rawQuery, "from:sender")
      compare(mailService.mailboxKey, "inbox")
    }

    function test_compose_and_settings_do_not_accept_mail_cursor_moves() {
      app.openSettings()
      app.moveCursor(1)
      compare(mailService.openSelects, 0)
      app.resetNavigation()
      app.runShortcut("compose", "C")
      compare(app.composing, true)
      app.moveCursor(1)
      compare(mailService.openSelects, 0)
    }

    function test_immediate_open_clears_the_previous_heavy_document_override() {
      var reader = readerView()
      verify(reader)
      app.moveCursor(1)
      reader.forceRichAnyway = true
      app.moveCursor(1)
      compare(reader.forceRichAnyway, false)
    }

    function test_navigation_never_uses_the_preview_mark_read_timer() {
      app.moveCursor(1)
      compare(mailService.openSelects, 1)
      wait(220)
      compare(mailService.previewSelects, 0)
      compare(mailService.markedRead.length, 0)
      compare(mailService.openSelects, 1)
    }
  }
}
