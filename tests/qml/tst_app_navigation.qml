import QtQuick 2.15
import QtTest 1.3
import qs.Commons
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
    property bool refuseMove: false

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
    function editingIndex() { return 0 }
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
    function refuseUnavailableAction(action) {
      record("guard:" + String(action || ""))
      if (!refuseMove) return false
      note("HEY has no destination you can name")
      return true
    }
  }

  Omamail.App {
    id: app
    service: mailService
    shell: fakeShell
  }

  TestCase {
    name: "AppNavigation"
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

    // The first descendant the predicate accepts, wherever it sits.
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

    function backBar(item) {
      return having(item, function(it) {
        return it.label === "Back" && typeof it.activated === "function"
      })
    }

    function page() {
      var loader = named(app, "setup-page")
      verify(loader, "the setup loader is on the page")
      return loader.item
    }

    function kinds() { return app.navKinds.join(",") }

    function init() {
      // A test that failed part way through its scales must not leave the next
      // one measuring at somebody else's.
      Style.spacingScale = 1
      mailService.log = []
      mailService.lastSavedDraft = null
      mailService.refuseMove = false
      mailService.accountCount = 1
      mailService.providerId = "imap"
      mailService.hasSavedAccounts = true
      mailService.anyAccountReady = true
      mailService.searchQuery = ""
      mailService.mailboxKey = "inbox"
      mailService.selectedId = ""
      mailService.selectedMessage = null
      mailService.selectedBody = ({ text: "Original body", source: "plain" })
      fakeAuth.credentialsPresent = false
      fakeShell.hidden = []
      app.opened = true
      app.cursorId = ""
      // The root a reset rebuilds is the one the window is on, so a test that
      // ended on the calendar has to leave it first.
      app.backToList()
      app.resetNavigation()
      waitForRendering(app)
      compare(kinds(), "list", "every test starts on the list")
    }

    function test_settings_add_and_the_form_unwind_one_page_at_a_time() {
      app.openSettings()
      compare(kinds(), "list,settings")
      verify(app.showSettings)
      waitForRendering(app)
      var settingsBack = named(app, "page-back")
      verify(settingsBack && settingsBack.visible, "Settings always has a Back: it is never a root")

      app.addMailbox()
      compare(kinds(), "list,settings,picker")
      waitForRendering(app)
      verify(typeof page().chosen === "function", "the chooser is on the page")
      // `visible` reads effective visibility: a chooser that exists inside a
      // hidden page is a blank window, which is what Add a mailbox once was.
      verify(page().visible, "and is drawn")

      page().chosen("gmail")
      compare(kinds(), "list,settings,picker,setup")
      compare(mailService.count("add:gmail"), 1, "a saved account exists, so Add makes a row")
      compare(app.editingProvider, "gmail")
      verify(app.accountDraftOpen, "the row is a draft until it is saved")
      waitForRendering(app)
      var back = named(app, "page-back")
      verify(back && back.visible, "the form has a Back, because there is a chooser under it")

      back.activated()
      compare(kinds(), "list,settings,picker")
      compare(mailService.count("discard"), 1, "backing out of a draft discards its row")

      app.back()
      compare(kinds(), "list,settings")
      app.back()
      compare(kinds(), "list")
      compare(mailService.count("discard"), 1, "and only that once")
    }

    function test_a_draft_over_the_reader_returns_to_the_reader() {
      app.openMessage("message-1")
      compare(kinds(), "list,reader")
      compare(app.currentView, "reader")

      app.startCompose("new")
      compare(kinds(), "list,reader,compose")
      verify(app.composing)

      app.back()
      compare(kinds(), "list,reader", "Back closes the draft and leaves the message open")
      compare(app.currentView, "reader")
    }

    function test_a_reply_raised_from_the_list_leaves_the_message_with_it() {
      app.cursorId = "message-1"
      app.composeFromCursor("reply")
      compare(kinds(), "list,reader", "the message opens first, on the reply's behalf")
      // The draft waits for the fetch; the entry it makes must still remember
      // that the user was on the list.
      mailService.land()
      tryCompare(app, "composing", true)
      compare(kinds(), "list,reader,compose")
      compare(app.nav[2].returnTo, 1, "the draft returns to where it was raised")

      app.back()
      tryCompare(app, "composing", false)
      compare(kinds(), "list", "Back from the reply leaves the message it opened")
      compare(mailService.count("saveDraft"), 1, "a reply has an address, so Back saves it")
    }

    function test_the_shortcut_sheet_closes_before_the_page_under_it() {
      app.openMessage("message-1")
      app.runShortcut("help", "")
      compare(kinds(), "list,reader,help")
      verify(app.shortcutHelpVisible)

      app.goBack()
      compare(kinds(), "list,reader", "Escape closes the sheet, not the message")
      verify(!app.shortcutHelpVisible)

      app.runShortcut("help", "")
      app.runShortcut("help", "")
      compare(kinds(), "list,reader", "the key toggles")
    }

    function test_the_calendar_is_the_other_root_and_back_on_a_root_closes() {
      app.runShortcut("calendarView", "")
      compare(kinds(), "calendar")
      verify(app.calendarVisible)

      app.goBack()
      compare(fakeShell.hidden.length, 1, "Back on a root hides the window")
      compare(kinds(), "calendar", "and leaves the stack alone")

      app.runShortcut("mailView", "")
      compare(kinds(), "list", "the list is not a step back from the calendar")
    }

    function test_the_status_address_opens_the_account_switcher() {
      var trigger = named(app, "status-account-button")
      verify(trigger && trigger.visible, "the status address is the account-menu trigger")
      var switcher = having(app, function(it) {
        return typeof it.openCentered === "function" && typeof it.accountChosen === "function"
      })
      verify(switcher && !switcher.opened)

      mouseClick(trigger)
      tryCompare(switcher, "opened", true)
      compare(trigger.selected, true, "the trigger stays selected while its popup is open")
      switcher.close()
    }

    // The address is what this line is about and the key hints are a nicety
    // beside it, so the room goes to the address first.
    function test_the_status_address_keeps_its_room_from_the_key_hints() {
      // The right of the line carries a notice or the hints, never both, so a
      // status an earlier test left standing is a line with no hints on it.
      mailService.actionStatus = ""
      mailService.lastError = ""
      app.notice = ""
      mailService.syncedLabel = "Synced just now"
      waitForRendering(app)

      var label = named(app, "status-account-label")
      var hints = named(app, "status-key-hints")
      verify(label && hints)
      compare(label.text, "me@example.com \u00b7 just now")
      verify(!label.truncated, "a short address and its age fit beside the hints")
      verify(hints.visible, "and the hints keep the room they were left")

      // Grown rather than measured: how many characters fit is a fact about
      // the theme's font, and what is being asserted is which of the two gives
      // way, whatever that number turns out to be.
      var address = "a.long.standing.mailbox.address@example.org"
      for (var i = 0; i < 20 && hints.visible; i++) {
        address = "longer." + address
        mailService.accountEmail = address
        waitForRendering(app)
      }
      verify(!hints.visible, "the hints step off the line rather than cutting the address")
      verify(!label.truncated, "and the address keeps every character it has room for")

      mailService.accountEmail = "me@example.com"
      waitForRendering(app)
      verify(hints.visible, "the hints come back when the address gives the room up")

      // The one thing that still pushes the address over, because a notice is
      // what the window most needs to say.
      var slot = label.parent.parent
      var wide = slot.width
      mailService.actionStatus = "Moved to Archive"
      waitForRendering(app)
      verify(slot.width < wide, "a notice takes the right of the line back")

      mailService.actionStatus = ""
      mailService.syncedLabel = ""
      waitForRendering(app)
    }

    // The box around the address pads it by one number and measures itself by
    // another, and `Style.space` rounds each on its own. At the shell's
    // `base-size 14` the two disagree by a pixel, and a Text a pixel short of
    // its own content is elided however wide the window is — which is what put
    // "just n..." on the line and made it look like a fixed width.
    function test_the_status_address_is_not_a_pixel_short_of_its_box() {
      var label = named(app, "status-account-label")
      verify(label)
      mailService.syncedLabel = "Synced just now"

      // Every scale a rounded 4 and a rounded 8 can fall out of step on, and a
      // couple where they agree, because the assertion is the same either way.
      var scales = [1, 0.9, 7 / 6, 1.25, 1.375, 1.4, 1.5, 1.9]
      for (var i = 0; i < scales.length; i++) {
        Style.spacingScale = scales[i]
        waitForRendering(app)
        verify(!label.truncated,
          "the address fits its own box at spacing scale " + scales[i])
      }

      Style.spacingScale = 1
      mailService.syncedLabel = ""
      waitForRendering(app)
    }

    function test_header_creation_actions_keep_their_labels() {
      var compose = named(app, "compose-button")
      verify(compose && compose.visible)
      compare(compose.text, "Compose")
      compare(typeof compose.iconName, "undefined")

      app.showCalendar()
      waitForRendering(app)
      var createEvent = named(app, "create-event-button")
      verify(createEvent && createEvent.visible)
      compare(createEvent.text, "Create event")
      compare(typeof createEvent.iconName, "undefined")
    }

    function test_an_event_opened_for_reading_is_a_place() {
      app.runShortcut("calendarView", "")
      var calendar = having(app, function(it) { return typeof it.closeDetail === "function" })
      verify(calendar, "the calendar view is on the page")
      calendar.activateEvent({ uid: "e1", summary: "Standup",
        start: { ms: Date.now(), allDay: false }, end: { ms: Date.now() + 3600000 } })
      compare(kinds(), "calendar,calendarDetail")

      app.goBack()
      compare(kinds(), "calendar", "Escape closes the event, not the calendar")
      verify(!calendar.detailOpen)
    }

    function test_changing_the_list_drops_the_history_over_it() {
      app.openMessage("message-1")
      compare(kinds(), "list,reader")
      app.goMailbox("starred")
      compare(kinds(), "list", "another mailbox is another list, not a step")
      compare(mailService.mailboxKey, "starred")

      app.openMessage("message-1")
      app.openMessage("message-1")
      compare(kinds(), "list,reader", "reading the next message does not lengthen history")
    }

    function test_back_on_the_root_clears_a_search_before_closing() {
      mailService.searchQuery = "invoice"
      app.goBack()
      compare(mailService.count("search:"), 1, "an active search is the nearer thing to leave")
      compare(fakeShell.hidden.length, 0)
      mailService.searchQuery = ""
      app.goBack()
      compare(fakeShell.hidden.length, 1)
    }

    function test_first_run_stacks_follow_what_the_service_knows() {
      mailService.anyAccountReady = false
      mailService.hasSavedAccounts = false
      waitForRendering(app)
      compare(kinds(), "picker", "nothing saved: the question is the whole window")
      var picker = page()
      verify(!named(app, "page-back").visible, "and there is nothing to go back to")

      // A row saved with a valid server but never signed in — the Gmail
      // address on the IMAP form — opens on its form, with the chooser under.
      mailService.hasSavedAccounts = true
      fakeAuth.credentialsPresent = true
      waitForRendering(app)
      compare(kinds(), "picker,setup")
      compare(app.editingProvider, "imap")
      var back = named(app, "page-back")
      verify(back && back.visible, "the form has a way back")

      back.activated()
      compare(kinds(), "picker")
      compare(mailService.count("discard"), 0, "a saved row is not a draft")

      // Backed out, the user is left alone even as the service learns more.
      mailService.providerId = "gmail"
      waitForRendering(app)
      compare(kinds(), "picker", "a root the user moved off is not rebuilt under them")

      mailService.anyAccountReady = true
      waitForRendering(app)
      compare(kinds(), "list", "a mailbox becoming usable starts over on it")
    }

    function test_editing_an_account_from_settings_returns_to_settings() {
      app.openSettings()
      app.editAccount(0)
      compare(kinds(), "list,settings,setup")
      compare(app.editingProvider, "imap")
      verify(!app.accountDraftOpen)
      app.back()
      compare(kinds(), "list,settings")
      compare(mailService.count("discard"), 0)
    }

    function test_an_unavailable_move_is_refused_before_the_picker_opens() {
      mailService.refuseMove = true
      app.cursorId = "message-1"

      app.runShortcut("moveToLabel", "v")

      compare(mailService.count("guard:label:destination"), 1,
        "the provider guard answers the key before a destination is requested")
      compare(named(app, "label-picker").opened, false)
      compare(mailService.actionStatus, "HEY has no destination you can name")
    }
  }
}
