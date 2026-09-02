import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

// Where the window is, is a history. Every page is an entry on it, every Back
// — the bar on a page, Escape, a draft closing — pops one, and the root is
// what the window closes on. These are the rules `App.qml` applies on top of
// `account/Navigation.js`, run against the real views with a fake service.
Item {
  width: 900
  height: 600

  QtObject {
    id: fakeShell
    property var hidden: []
    function hide(id) {
      var next = hidden.slice()
      next.push(String(id || ""))
      hidden = next
    }
  }

  QtObject {
    id: fakeAuth

    property bool credentialsPresent: false
    property bool loggedIn: false
    property bool loginBusy: false
    property bool toolsChecked: true
    property bool toolsPresent: true
    property bool credentialsWriteBusy: false
    property var missingTools: []
    property string lastError: ""
    property string clientId: ""
    property string clientDescription: ""
    property string credentialsPath: ""
    property var credentials: null
    property var settings: ({
      imapHost: "imap.example.org", imapPort: 993,
      smtpHost: "smtp.example.org", smtpPort: 465,
      username: "", aliases: [], insecure: false
    })

    function recheck() {}
    function saveCredentials() {}
  }

  QtObject {
    id: mailService

    property bool ready: true
    property bool anyAccountReady: true
    property bool hasSavedAccounts: true
    property bool sendPending: false
    property bool sending: false
    property bool windowOpen: false
    property bool sidebarCollapsed: false
    property bool alwaysShowImages: false
    property bool unifiedCalendarView: false
    property bool selectedReaderEmpty: false
    property bool selectedReaderTooHeavy: false
    property bool selectedTooHeavy: false
    property bool detailLoading: false
    property bool detailPainted: false
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
    property bool signInProgress: false
    property int sendSecondsRemaining: 10
    property int accountCount: 1
    property int inboxUnread: 0
    property real bodyZoom: 1
    property string bodyMode: "reader"
    property string providerId: "imap"
    property string pluginDir: ""
    property string accountEmail: "me@example.com"
    property string accountAddress: "me@example.com"
    property string activeAccountId: "me@example.com"
    property string mailboxKey: "inbox"
    property string searchQuery: ""
    property string rawQuery: ""
    property string selectedId: ""
    property string lastError: ""
    property string actionStatus: ""
    property string syncedLabel: ""
    property string recipientContactStatus: ""
    property var auth: fakeAuth
    property var accountSummaries: [{ provider: "imap", email: "me@example.com" }]
    property var mailboxes: []
    property var labels: []
    property var messages: [{ id: "message-1", subject: "One" }]
    property var selectedAttachments: []
    property var selectedInvite: null
    property var selectedResponse: ""
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: []
    property var calendarController: null
    property var selectedBody: ({ text: "Original body", source: "plain" })
    property var selectedMessage: null

    property var log: []
    property var lastSavedDraft: null

    signal accountAdded()
    signal replySent()

    function record(text) {
      var next = log.slice()
      next.push(text)
      log = next
    }
    function count(text) {
      var n = 0
      for (var i = 0; i < log.length; i++) if (log[i] === text) n++
      return n
    }
    function indexOfActiveAccount() { return 0 }
    function addAccount(provider) {
      record("add:" + String(provider || ""))
      accountCount += 1
      accountAdded()
    }
    function configureCurrentAccount(values) {
      record("configure:" + String(values.provider || ""))
      if (values.provider !== undefined) providerId = String(values.provider)
    }
    function discardCurrentDraft() {
      record("discard")
      if (accountCount > 1) accountCount -= 1
    }
    function switchToIndex(_index) { return true }
    function selectMailbox(key) {
      mailboxKey = String(key || "")
      record("mailbox:" + mailboxKey)
    }
    function search(query) {
      searchQuery = String(query || "")
      record("search:" + searchQuery)
    }
    function preferredSendAs(_recipients) { return null }
    function refreshRecipientContacts() {}
    function cursorOffset(_id, _delta) { return "" }
    function clearSelection() {
      selectedId = ""
      record("clear")
    }
    function select(id) {
      selectedId = String(id || "")
      selectedMessage = null
      selectedBody = ({ text: "", source: "" })
      selectedAttachments = []
      detailPainted = false
      detailLoading = true
    }
    // What the fetch would deliver, delivered by the test when it wants it.
    function land() {
      detailLoading = false
      detailPainted = true
      selectedMessage = ({
        id: selectedId,
        messageId: "<" + selectedId + "@example.com>",
        threadId: "thread-1",
        subject: "One",
        from: ({ email: "sender@example.com", display: "Sender" }),
        replyTo: ({ email: "sender@example.com" }),
        to: [], cc: [], bcc: [],
        fullTime: "today"
      })
      selectedBody = ({ text: "Original body", source: "plain" })
    }
    function loadAttachments(_messageId, _attachments, callback) { callback([], "") }
    function send(_fields) { return true }
    function undoSend() { return false }
    function saveDraft(fields, callback) {
      lastSavedDraft = fields
      record("saveDraft")
      callback("draft-1", "")
    }
    function refresh() {}
    function fail(text) { lastError = String(text || "") }
    function note(text) { actionStatus = String(text || "") }
  }

  Omamail.App {
    id: app
    service: mailService
    shell: fakeShell
  }

  TestCase {
    name: "SettingsSidebar"
    when: windowShown

    function named(item, objectName) {
      if (!item) return null
      if (item.objectName === objectName) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = named(values[i], objectName)
        if (found) return found
      }
      return null
    }

    function flick() {
      var page = named(app, "settings-page")
      var item = page
      while (item && String(item.toString()).indexOf("QQuickFlickable") < 0) item = item.parent
      return item
    }

    // The window `App` measures itself by is the one it draws, not the test
    // root: find it by its title to size it.
    function window() {
      return having(app, function(it) { return it.title === "Omamail" })
    }

    function having(item, accept) {
      if (!item) return null
      if (accept(item)) return item
      var values = item.children || []
      for (var i = 0; i < values.length; i++) {
        var found = having(values[i], accept)
        if (found) return found
      }
      return null
    }

    function init() {
      mailService.anyAccountReady = true
      mailService.hasSavedAccounts = true
      app.opened = true
      window().width = 980
      app.backToList()
      app.resetNavigation()
      app.openSettings()
      waitForRendering(app)
    }

    // The rail names the sections in the page's order, and the page reports
    // where each begins, in that same order.
    function test_the_rail_lists_the_pages_sections_in_order() {
      var rail = named(app, "settings-sidebar")
      verify(rail && rail.visible, "a wide window has a rail")
      var page = named(app, "settings-page")
      var keys = page.sections.map(function(s) { return s.key })
      compare(keys.join(","), "reading,notifications,writing,mailboxes,calendars,oauth")
      for (var i = 1; i < page.sections.length; i++)
        verify(page.sections[i].y > page.sections[i - 1].y, "sections are laid out top to bottom")
      for (var j = 0; j < keys.length; j++)
        verify(named(rail, "settings-section-" + keys[j]), "the rail has a row for " + keys[j])
    }

    // A click scrolls the page to the section rather than opening another
    // page: Settings stays one place in history, and the highlight follows.
    function test_a_click_scrolls_the_page_and_the_highlight_follows() {
      var rail = named(app, "settings-sidebar")
      var page = named(app, "settings-page")
      var view = flick()
      verify(view, "the page scrolls inside a Flickable")
      compare(view.contentY, 0)
      compare(rail.activeKey, "reading")
      compare(app.navKinds.join(","), "list,settings")

      // The rail sits against the page, and the pair is centred in the area.
      var area = rail.parent
      verify(Math.abs((rail.x + rail.width + 18) - page.x) < 1, "the rail is against the page's left edge")
      verify(Math.abs(rail.x - (area.width - page.x - page.width)) < 1, "and the block is centred")
      // Back belongs to the block too: on its left edge, above the rail.
      var back = named(app, "page-back")
      verify(back.visible)
      var railLeft = rail.mapToItem(back.parent, 0, 0).x
      verify(Math.abs(back.x - railLeft) < 1, "Back is aligned with the rail's left edge")

      var writing = named(rail, "settings-section-writing")
      mouseClick(writing)
      tryVerify(function() { return Math.abs(view.contentY - page.sections[2].y) < 1 }, 1000,
        "the page slid until the Writing heading was at the top")
      compare(app.navKinds.join(","), "list,settings", "still one page in history")
      tryCompare(rail, "activeKey", "writing")

      // Every section can be put at the top, the last included: the content
      // is padded under the page for exactly that.
      mouseClick(named(rail, "settings-section-oauth"))
      tryVerify(function() { return Math.abs(view.contentY - page.sections[5].y) < 1 }, 1000,
        "the last heading reaches the top too")
      tryCompare(rail, "activeKey", "oauth")

      // Scrolled by other means — the wheel, say — the highlight still
      // follows the page, because the page is what it describes.
      view.contentY = 0
      tryCompare(rail, "activeKey", "reading")
      view.contentY = page.sections[3].y + 5
      tryCompare(rail, "activeKey", "mailboxes")
    }

    // Narrow, the rail has no room; the page keeps the whole width and its
    // own scroll, which is all it ever had.
    function test_a_narrow_window_has_no_rail() {
      window().width = 600
      waitForRendering(app)
      var rail = named(app, "settings-sidebar")
      verify(rail && !rail.visible)
      var page = named(app, "settings-page")
      verify(page.visible, "the page itself is still drawn")
    }
  }
}
