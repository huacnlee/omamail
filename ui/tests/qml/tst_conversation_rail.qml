import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "NativeDomainFixture.js" as NativeDomain

// `n` and `p` walk the conversation rail; Shift+J and Shift+K scroll the open message.
//
// Why this needs Qt rather than a node test: the whole claim is that two
// positions in one window move independently under real keystrokes. Three
// things have to agree for that — `KeyRouter` binding the letters only in the
// reader context, `App.runShortcut` routing them to the rail rather than to the
// cursor, and `openMember` putting the cursor back where it was after
// `openMessage` moved it. `Conversation.memberStep` is asserted on its own in
// `tests/test_conversation.js`; a test of that function alone would pass with
// the keys unbound, with them bound in the list context, or with the cursor
// following the reader — which are exactly the three ways this breaks.
//
// A fake service, the way `tst_app_navigation.qml` uses one: the account's own
// fetching is not what is under test, and the rail draws whatever it is given.
Item {
  width: 900
  height: 600

  QtObject {
    id: fakeShell
    function hide(id) {}
  }

  QtObject {
    id: fakeAuth

    property bool credentialsPresent: true
    property bool loggedIn: true
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
    property var settings: ({})

    function recheck() {}
    function saveCredentials() {}
  }

  // The seeded thread: three messages, oldest first, the newest one unread and
  // the one the list drew a row for.
  readonly property var members: ["maaaaad", "maaaaae", "maaaaaf"]

  function memberSummary(id, unread, labels) {
    return ({
      id: id,
      threadId: "d",
      subject: "The engine",
      snippet: "",
      from: ({ display: "Ada Lovelace", email: "ada@example.org" }),
      to: [], cc: [], bcc: [],
      time: "3d",
      fullTime: "2 September 2026 at 09:14",
      date: null,
      unread: unread,
      starred: false,
      labelIds: labels
    })
  }

  QtObject {
    id: mailService

    property bool ready: true
    property bool anyAccountReady: true
    property bool hasSavedAccounts: true
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
    property bool signInProgress: false
    property int sendSecondsRemaining: 0
    property int accountCount: 1
    property int inboxUnread: 1
    property real bodyZoom: 1
    property string bodyMode: "reader"
    property string providerId: "jmap"
    property string pluginDir: ""
    property string accountEmail: "me@example.com"
    property string accountAddress: "me@example.com"
    property string activeAccountId: "jmap:me@example.com"
    property string mailboxKey: "inbox"
    property string searchQuery: ""
    property string rawQuery: ""
    property string selectedId: ""
    property string lastError: ""
    property string actionStatus: ""
    property string syncedLabel: ""
    property string recipientContactStatus: ""
    property var auth: fakeAuth
    property var accountSummaries: [{ provider: "jmap", email: "me@example.com" }]
    property var mailboxes: [
      { key: "inbox", label: "Inbox", icon: "inbox" },
      { key: "sent", label: "Sent", icon: "sent" },
      { key: "drafts", label: "Drafts", icon: "compose" }
    ]
    property var labels: []
    property var selectedAttachments: []
    property var selectedInvite: null
    property var selectedResponse: ""
    property var recipientContacts: []
    property var sendAsAliases: []
    property var sendIdentities: []
    property var calendarController: null
    property var selectedBody: ({ text: Array(101).join("A body line\n"), source: "plain" })
    property var selectedMessage: null

    // What this test is about. The list is one row per conversation, so the
    // rail's other two stops are messages the list has no row for at all.
    property bool showsConversations: true
    property bool showsRail: true
    property string viewedMailboxKey: "inbox"
    property var selectedThread: ({
      id: "d", count: 3, unread: true, flagged: false,
      memberIds: ["maaaaad", "maaaaae", "maaaaaf"]
    })
    property var memberSummaries: ({})
    readonly property var conversationProjection: NativeDomain.conversation({
      thread: selectedThread, summaries: memberSummaries, selectedId: selectedId,
      conversations: showsConversations && showsRail, mailboxKey: viewedMailboxKey,
      searching: searchQuery !== "" || rawQuery !== "", mailboxes: mailboxes
    })

    // Two conversations in the Inbox, each drawn by its representative.
    property var messages: [
      { id: "maaaaaf", subject: "The engine", unread: true, starred: false,
        from: ({ display: "Ada", email: "ada@example.org" }), time: "3d",
        snippet: "", labelIds: ["INBOX", "UNREAD"],
        thread: ({ id: "d", count: 3, unread: true, flagged: false,
          memberIds: ["maaaaad", "maaaaae", "maaaaaf"] }) },
      { id: "yaaaaag", subject: "Notes", unread: false, starred: false,
        from: ({ display: "Grace", email: "grace@example.org" }), time: "1d",
        snippet: "", labelIds: ["INBOX"] }
    ]

    function editingIndex() { return 0 }
    function addAccount(provider) {}
    function configureCurrentAccount(values) {}
    function discardCurrentDraft() {}
    function switchToIndex(index) { return true }
    function selectMailbox(key) { mailboxKey = String(key || "") }
    function search(query) { searchQuery = String(query || "") }
    function preferredSendAs(recipients) { return null }
    function refreshRecipientContacts() {}
    // The list cursor's own movement, over the rows the list actually has.
    function cursorOffset(id, delta) {
      for (var i = 0; i < messages.length; i++) {
        if (messages[i].id !== String(id)) continue
        var next = i + (delta > 0 ? 1 : -1)
        if (next < 0 || next >= messages.length) return messages[i].id
        return messages[next].id
      }
      return messages.length > 0 ? messages[0].id : ""
    }
    function clearSelection() { selectedId = "" }
    // The account's own `select` holds the conversation across a move to one of
    // its members, which is `Conversation.threadAfterSelect`. Held here too,
    // because the rail must not empty underneath the keys being tested.
    function select(id) {
      selectedId = String(id || "")
      selectedMessage = memberSummary(selectedId, selectedId === "maaaaaf",
        selectedId === "maaaaad" ? ["INBOX", "DRAFT"] : ["INBOX"])
    }
    function loadAttachments(messageId, attachments, callback) { callback([], "") }
    function send(fields) { return true }
    function undoSend() { return false }
    function saveDraft(fields, callback) { callback("draft-1", "") }
    function refresh() {}
    function toggleStar(id) {}
    property var acted: []
    function act(id, action, quiet, memberOnly) {
      acted = acted.concat([[String(id), String(action), quiet === true, memberOnly === true]])
      return true
    }
    function fail(text) { lastError = String(text || "") }
    function note(text) { actionStatus = String(text || "") }
  }

  Omamail.App {
    id: app
    service: mailService
    shell: fakeShell
  }

  TestCase {
    name: "ConversationRail"
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

    function init() {
      app.opened = true
      app.backToList()
      app.resetNavigation()
      mailService.selectedId = ""
      mailService.selectedMessage = null
      mailService.memberSummaries = ({})
      app.cursorId = "maaaaaf"
      waitForRendering(app)
    }

    // The stop drawn for one member, found the way the rail itself finds it.
    function stopFor(id) {
      var rail = named(app, "conversationRail")
      var column = rail ? named(rail, "conversationRailFlick") : null
      if (!column) return null
      var stack = [column]
      while (stack.length > 0) {
        var item = stack.pop()
        if (item.memberId !== undefined && item.memberId === id) return item
        var kids = item.children || []
        for (var i = 0; i < kids.length; i++) stack.push(kids[i])
      }
      return null
    }

    function seedSummaries() {
      mailService.memberSummaries = ({
        maaaaad: memberSummary("maaaaad", false, ["INBOX"]),
        maaaaae: memberSummary("maaaaae", true, ["INBOX", "UNREAD"]),
        maaaaaf: memberSummary("maaaaaf", true, ["INBOX", "UNREAD"])
      })
    }

    // A right-click on a stop opens the row's own menu for that one message:
    // its summary is the member's, what it asks for reaches the member alone,
    // and the list cursor stays where the list has it.
    function test_a_right_click_on_a_stop_opens_the_message_menu_for_that_member() {
      seedSummaries()
      app.openMessage("maaaaaf")
      waitForRendering(app)
      var menu = named(app, "rowMenu")
      verify(!!menu, "the App holds the row menu")
      compare(menu.opened, false)

      var stop = stopFor("maaaaae")
      verify(!!stop, "the middle member has a stop")
      mailService.acted = []
      mouseClick(stop, stop.width / 2, stop.height / 2, Qt.RightButton)
      tryVerify(function() { return menu.opened }, 1000, "the menu opens")
      compare(menu.memberOnly, true, "for a member")
      compare(menu.messageId, "maaaaae")
      verify(!!menu.summary, "and finds the member's summary, which no row carries")
      compare(menu.summary.id, "maaaaae")
      compare(menu.summary.unread, true, "read off the member, so the rows say the right thing")

      menu.run("markRead")
      compare(mailService.acted.length, 1, "one action went to the service")
      compare(mailService.acted[0].join(","), "maaaaae,markRead,false,true",
        "the member alone, and not quietly")
      compare(mailService.selectedId, "maaaaaf", "reading a different member moves nothing")
      compare(app.cursorId, "maaaaaf", "and the list cursor stays on the row")
      compare(app.currentView, "reader")
    }

    // Taking the open member out of the view moves the reader to the stop
    // beside it — the newer one above, else the older below — rather than
    // leaving it on a message that has just gone.
    function test_trashing_the_open_member_from_its_stop_opens_the_neighbour() {
      seedSummaries()
      app.openMessage("maaaaaf")
      waitForRendering(app)
      keyClick(Qt.Key_N)
      compare(mailService.selectedId, "maaaaae", "the middle member is open")
      waitForRendering(app)
      var menu = named(app, "rowMenu")

      var stop = stopFor("maaaaae")
      mailService.acted = []
      mouseClick(stop, stop.width / 2, stop.height / 2, Qt.RightButton)
      tryVerify(function() { return menu.opened }, 1000)
      menu.run("trash")
      compare(mailService.acted[0].join(","), "maaaaae,trash,false,true")
      compare(mailService.selectedId, "maaaaaf",
        "the reader moved to the newer neighbour above")
      compare(app.currentView, "reader")
      compare(app.cursorId, "maaaaaf", "the cursor never moved")

      // The representative is a stop too, and from its stop it is one message.
      waitForRendering(app)
      stop = stopFor("maaaaaf")
      mailService.acted = []
      mouseClick(stop, stop.width / 2, stop.height / 2, Qt.RightButton)
      tryVerify(function() { return menu.opened }, 1000)
      compare(menu.summary.id, "maaaaaf", "the row's own summary serves the representative's stop")
      menu.run("trash")
      compare(mailService.acted[0].join(","), "maaaaaf,trash,false,true",
        "scoped to the one message even though a row stands for it")
      compare(mailService.selectedId, "maaaaae",
        "the newest member has only an older neighbour, and the reader went there")
      compare(app.currentView, "reader")
    }

    // A conversation of one other stop that goes: back to the list, as the
    // list's own delete does.
    function test_the_last_stop_going_returns_to_the_list() {
      mailService.selectedThread = ({ id: "d", count: 2, unread: true, flagged: false,
        memberIds: ["maaaaae", "maaaaaf"] })
      seedSummaries()
      app.openMessage("maaaaaf")
      waitForRendering(app)
      var menu = named(app, "rowMenu")
      var stop = stopFor("maaaaaf")
      verify(!!stop)
      mouseClick(stop, stop.width / 2, stop.height / 2, Qt.RightButton)
      tryVerify(function() { return menu.opened }, 1000)
      menu.run("trash")
      compare(mailService.selectedId, "maaaaae", "the one other stop is opened")
      mailService.selectedThread = ({ id: "d", count: 1, unread: false, flagged: false,
        memberIds: ["maaaaae"] })
      mailService.showsRail = true
      // Nothing beside it now.
      app.actOnMember("trash", "maaaaae")
      waitForRendering(app)
      compare(app.currentView, "list", "with no neighbour, the reader closes")
      mailService.selectedThread = ({ id: "d", count: 3, unread: true, flagged: false,
        memberIds: ["maaaaad", "maaaaae", "maaaaaf"] })
    }

    // The rail is on screen with one stop per member, whether or not the
    // summaries have arrived — that is what stops it moving when they do.
    function test_the_rail_draws_one_stop_per_member_before_the_summaries_land() {
      app.openMessage("maaaaaf")
      waitForRendering(app)

      var rail = named(app, "conversationRail")
      verify(rail, "the reader draws a rail for a conversation of three")
      compare(rail.stops.length, 3, "one stop per member id, summaries or not")
      compare(rail.stops[0].id, "maaaaaf", "newest first, the other way up from Thread/get")
      compare(rail.stops[2].id, "maaaaad")
      verify(!rail.stops[2].known, "and a member with no summary is a skeleton")
      verify(rail.stops[0].open, "the open message keeps its place in the timeline")
      compare(rail.caption, "3 messages", "the length is known before any summary")

      // The summaries land. The stops do not move: same ids, same order, same
      // count, and the same place on the rail — only the lanes inside them
      // fill in. The first member sits in Drafts, so it gains a mailbox name
      // on settling, which is the one thing that used to add a line.
      var before = rail.stops.map(function(s) { return s.id })
      var placed = members.map(function(id) { return rail.boundsFor(id) })
      verify(placed[0] && placed[0].height > 0, "a skeleton stop has a place and a height")
      mailService.memberSummaries = ({
        maaaaad: memberSummary("maaaaad", false, ["INBOX", "DRAFT"]),
        maaaaae: memberSummary("maaaaae", false, ["INBOX"]),
        maaaaaf: memberSummary("maaaaaf", true, ["INBOX", "UNREAD"])
      })
      waitForRendering(app)
      compare(rail.stops.map(function(s) { return s.id }).join(","), before.join(","))
      verify(rail.stops[2].known, "and now every stop is settled")
      compare(rail.stops[2].mailbox, "Drafts",
        "the member outside the mailbox on screen says where it is")
      compare(rail.stops[1].mailbox, "", "and one inside it says nothing")
      compare(rail.caption, "3 messages · 1 unread")
      for (var i = 0; i < members.length; i++) {
        var after = rail.boundsFor(members[i])
        compare(after.y, placed[i].y, "the stop for " + members[i] + " did not move")
        compare(after.height, placed[i].height, "nor change height")
      }
    }

    // The timeline joins the circles and goes nowhere else: it begins under
    // the first circle and ends above the last, rather than running the whole
    // height of the rail as if there were a stop above the top and below the
    // bottom. In between, each stop's segment spans its whole height so the
    // line is continuous from circle to circle.
    function test_the_timeline_runs_from_the_first_circle_to_the_last() {
      app.openMessage("maaaaaf")
      waitForRendering(app)
      var rail = named(app, "conversationRail")
      var top = rail.boundsFor(rail.stops[0].id)
      var middle = rail.boundsFor(rail.stops[1].id)
      var bottom = rail.boundsFor(rail.stops[2].id)
      verify(top.node.bottom > top.node.top, "a stop has a circle")
      compare(top.line.top, top.node.bottom, "the line begins at the bottom of the first circle")
      compare(top.line.bottom, top.y + top.height, "and runs to the foot of that stop")
      compare(middle.line.top, middle.y, "a middle stop carries the line the whole way through")
      compare(middle.line.bottom, middle.y + middle.height)
      compare(bottom.line.top, bottom.y)
      compare(bottom.line.bottom, bottom.node.top, "and it ends at the top of the last circle")
      verify(bottom.line.bottom > bottom.line.top, "so the last segment still reaches its circle")

      // One straight line. The open stop's circle is wider than the others,
      // and its segment must not follow that width sideways: every segment
      // shares one x, on a whole pixel, and every circle is centred on it.
      verify(rail.stops[0].open, "the open stop is the top one here")
      compare(top.line.x, middle.line.x, "the open stop's segment is in line with the next")
      compare(middle.line.x, bottom.line.x, "and with the last")
      compare(top.line.x, Math.round(top.line.x), "on a whole pixel")
      compare(top.line.width, middle.line.width, "and no thicker than the others")
      compare(top.node.centerX, middle.node.centerX, "the circles share the same centre")
      verify(Math.abs((top.line.x + top.line.width / 2) - top.node.centerX) <= 0.5,
        "and the line runs through it")
    }

    // The claim. Both keys move the reader along the rail and neither moves the
    // list cursor, while Shift+J and Shift+K scroll the open message.
    function test_n_and_p_move_along_the_rail_while_shift_j_and_k_scroll_the_message() {
      app.openMessage("maaaaaf")
      waitForRendering(app)
      compare(app.currentView, "reader")
      compare(app.cursorId, "maaaaaf", "opening a row put the cursor on it")

      keyClick(Qt.Key_N)
      compare(mailService.selectedId, "maaaaae", "n opens the stop below: the older member")
      compare(app.cursorId, "maaaaaf", "and leaves the list cursor where it was")

      keyClick(Qt.Key_N)
      compare(mailService.selectedId, "maaaaad", "n again, to the oldest member at the bottom")
      compare(app.cursorId, "maaaaaf")

      keyClick(Qt.Key_N)
      compare(mailService.selectedId, "maaaaad",
        "and stops there rather than wrapping to the newest")

      keyClick(Qt.Key_P)
      compare(mailService.selectedId, "maaaaae", "p walks back up the rail")
      keyClick(Qt.Key_P)
      compare(mailService.selectedId, "maaaaaf")
      keyClick(Qt.Key_P)
      compare(mailService.selectedId, "maaaaaf", "and stops at the newest, at the top")
      compare(app.cursorId, "maaaaaf", "the cursor never moved at all")

      var body = named(app, "messageBodyScroller")
      verify(body, "the reader exposes its body scroller")
      var before = body.contentY
      keyClick(Qt.Key_J, Qt.ShiftModifier)
      verify(body.contentY > before, "Shift+J scrolls the open message down")
      compare(app.cursorId, "maaaaaf", "and leaves the list cursor where it was")
      compare(mailService.selectedId, "maaaaaf", "and does not open another message")
      keyClick(Qt.Key_K, Qt.ShiftModifier)
      compare(body.contentY, before, "Shift+K scrolls the open message back up")

      keyClick(Qt.Key_J)
      compare(app.cursorId, "yaaaaag", "plain j still moves the mailbox cursor")
      compare(mailService.selectedId, "yaaaaag", "plain j immediately opens the cursor row")
      compare(app.currentView, "reader")
      keyClick(Qt.Key_K)
      compare(app.cursorId, "maaaaaf")
      compare(mailService.selectedId, "maaaaaf", "plain k opens the previous row")
    }

    function test_right_opens_the_cursor_and_left_returns_to_the_list() {
      compare(app.currentView, "list")
      keyClick(Qt.Key_Right)
      compare(app.currentView, "reader", "Right opens the selected row")
      compare(mailService.selectedId, "maaaaaf")
      keyClick(Qt.Key_Left)
      compare(app.currentView, "list", "Left returns to the list")
      keyClick(Qt.Key_Right)
      compare(app.currentView, "reader")
      keyClick(Qt.Key_Escape)
      compare(app.currentView, "list", "Escape also returns to the list")
    }

    // Opening a member replaces the reader entry rather than pushing one, so
    // Back from any member lands on the list. No new rule: `Navigation.push`
    // already replaces a reader entry with a reader entry.
    function test_back_from_any_member_returns_to_the_list() {
      app.openMessage("maaaaaf")
      waitForRendering(app)
      compare(app.navKinds.join(","), "list,reader")

      keyClick(Qt.Key_N)
      keyClick(Qt.Key_N)
      compare(mailService.selectedId, "maaaaad", "n twice, to the oldest member at the bottom")
      compare(app.navKinds.join(","), "list,reader",
        "walking the rail lengthens nothing")

      app.back()
      waitForRendering(app)
      compare(app.currentView, "list", "Back lands on the list from any member")
    }

    // A conversation of one draws no rail, and then both keys are dead letters
    // rather than keys that do something else.
    function test_a_message_of_one_draws_no_rail() {
      mailService.showsRail = false
      mailService.selectedThread = null
      app.openMessage("yaaaaag")
      waitForRendering(app)

      var rail = named(app, "conversationRail")
      verify(!rail || !rail.visible, "nothing is drawn beside a single message")
      keyClick(Qt.Key_N)
      compare(mailService.selectedId, "yaaaaag", "and n has nowhere to go")
      compare(app.cursorId, "yaaaaag")

      mailService.showsRail = true
      mailService.selectedThread = ({
        id: "d", count: 3, unread: true, flagged: false,
        memberIds: ["maaaaad", "maaaaae", "maaaaaf"]
      })
    }
  }
}
