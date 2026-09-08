import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail

// A menu drawn over the mailbox rail, and what a press on it reaches.
//
// The account menu opens from the address in the status line, which is at the
// bottom left, so it goes up from there across the rail's own rows. Two
// different presses used to reach those rows through it, and the fixture below
// is only what the window needs to be built and opened — the fake mailbox
// answers what `App.qml` reads, and nothing here drives mail.
Item {
  width: 900
  height: 600

  QtObject { id: fakeShell; function hide(_id) {} }

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
    property var settings: ({ imapHost: "", imapPort: 993, smtpHost: "", smtpPort: 465,
      username: "", aliases: [], insecure: false })
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
    property var messages: []
    property var selectedAttachments: []
    property var selectedInvite: null
    property var selectedResponse: ""
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: []
    property var calendarController: null
    property var selectedBody: ({ text: "", source: "" })
    property var selectedMessage: null

    signal accountAdded()
    signal replySent()

    // What the window calls while it is being opened, and what choosing an
    // account from the menu calls. None of them has to do anything here: this
    // test is about which of them are reached, not what they do.
    function selectMailbox(key) { mailboxKey = String(key || "") }
    function switchToIndex(_index) { return true }
    function clearSelection() { selectedId = "" }
    function select(id) { selectedId = String(id || "") }
    function search(_query) {}
    function refresh() {}
    function preferredSendAs(_recipients) { return null }
    function refreshRecipientContacts() {}
    function cursorOffset(_id, _delta) { return "" }
    function editingIndex() { return 0 }
    function fail(text) { lastError = String(text || "") }
    function note(text) { actionStatus = String(text || "") }
    function refuseUnavailableAction(_action) { return false }
  }

  Omamail.App {
    id: app
    service: mailService
    shell: fakeShell
  }

  SignalSpy { id: railSpy; signalName: "activated" }
  SignalSpy { id: chosenSpy; signalName: "accountChosen" }

  // A menu drawn over the rail, which is where the account menu opens: the
  // address in the status line is at the bottom left, and the menu goes up
  // from it across the mailbox rows.
  //
  // Both halves of a click leaked into those rows, by two different routes.
  // Choosing from the menu went through the menu row and fired the rail row
  // beneath it, because a `TapHandler` takes a passive grab and lets the press
  // carry on down. Pressing a rail row to dismiss the menu fired it too, for
  // the same reason: modality stops an item from seeing the press, and a
  // handler is not an item. So the rows on both sides of this are `MouseArea`s
  // now, which grab exclusively, and the press ends where it landed.
  TestCase {
    name: "MenuOverRail"
    when: windowShown

    function collect(item, accept, out) {
      if (!item) return out
      if (accept(item)) out.push(item)
      var kids = item.children || []
      for (var i = 0; i < kids.length; i++) collect(kids[i], accept, out)
      return out
    }

    function menuRows(item, out) {
      if (!item) return out
      if (item.objectName === "account-row") out.push(item)
      var kids = item.children || []
      for (var i = 0; i < kids.length; i++) menuRows(kids[i], out)
      return out
    }

    function railRows() {
      return collect(app, function(it) {
        return typeof it.activated === "function" && it.label !== undefined
          && it.icon !== undefined && it.width > 0
      }, [])
    }

    function switcher() {
      return collect(app, function(it) {
        return typeof it.openAt === "function" && it.accounts !== undefined
      }, [])[0]
    }

    // Enough rows that the rail reaches the part of the window the menu is
    // drawn over. A short rail leaves the menu hanging in empty space, which
    // is the arrangement in which this bug cannot be seen at all.
    function init() {
      var boxes = []
      for (var n = 0; n < 20; n++) {
        boxes.push({ key: "box" + n, label: "Mailbox " + n, icon: "inbox" })
      }
      mailService.mailboxes = boxes
      app.open("{}")
      // The rail has to have been laid out before anything can ask what the
      // menu is drawn over.
      waitForRendering(app)
    }

    function openOverTheRail() {
      var sw = switcher()
      verify(sw, "the window has an account menu")
      sw.accounts = [
        { id: "a@x", email: "a@x", label: "A", unread: 1, active: true,
          signedIn: true, busy: false, error: "" },
        { id: "b@x", email: "b@x", label: "B", unread: 0, active: false,
          signedIn: true, busy: false, error: "" }
      ]
      var where = sw.mapToGlobal(0, 0)
      sw.openAt(where.x + 8, where.y + sw.height - 12)
      // A popup builds its contents on its first open, so its height — and
      // therefore where `place` puts it — settles a frame later.
      waitForRendering(app)
      verify(sw.opened, "the menu is open")
      return sw
    }

    function test_choosing_from_the_menu_leaves_the_rail_alone() {
      var sw = openOverTheRail()
      var rail = railRows()
      var rows = menuRows(sw.menuRows, [])
      verify(rows.length > 1, "the menu drew its rows")

      // The row to press is one the menu actually covers; anywhere else and
      // the test proves nothing.
      var pressed = null
      var covered = null
      for (var m = 0; m < rows.length && !covered; m++) {
        var at = rows[m].mapToGlobal(rows[m].width / 2, rows[m].height / 2)
        for (var i = 0; i < rail.length; i++) {
          var corner = rail[i].mapToGlobal(0, 0)
          if (at.x >= corner.x && at.x <= corner.x + rail[i].width
              && at.y >= corner.y && at.y <= corner.y + rail[i].height) {
            pressed = rows[m]
            covered = rail[i]
            break
          }
        }
      }
      verify(covered, "a menu row is drawn over a rail row")

      railSpy.target = covered
      railSpy.clear()
      chosenSpy.target = sw
      chosenSpy.clear()
      mouseClick(pressed, pressed.width / 2, pressed.height / 2)

      compare(sw.opened, false, "choosing closes the menu")
      compare(chosenSpy.count, 1, "the account the pointer was on is the one chosen")
      compare(railSpy.count, 0, "and the rail row under it is not also chosen")
    }

    function test_pressing_the_rail_to_dismiss_the_menu_only_dismisses_it() {
      var sw = openOverTheRail()
      var rail = railRows()
      var rows = menuRows(sw.menuRows, [])

      // A rail row the menu does not cover: pressing it is "outside".
      var menuTop = rows[0].mapToGlobal(0, 0).y
      var free = null
      for (var i = 0; i < rail.length && !free; i++) {
        var corner = rail[i].mapToGlobal(0, 0)
        // Above where the menu begins, so pressing it is a press outside.
        if (corner.y + rail[i].height < menuTop) free = rail[i]
      }
      verify(free, "a rail row sits above the menu")

      railSpy.target = free
      railSpy.clear()
      mouseClick(free, free.width / 2, free.height / 2)

      compare(sw.opened, false, "the press outside closes the menu")
      compare(railSpy.count, 0, "and does not also switch the mailbox it landed on")
    }
  }
}
