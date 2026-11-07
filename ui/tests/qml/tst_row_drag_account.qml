import QtQuick 2.15
import QtTest 1.3
import qs.Commons as Commons
import "../../components" as Mail

// A drag belongs to the account it began in. Switching accounts mid-drag
// cancels it, so a release over Trash never touches either account.
Item {
  width: 400
  height: 300

  QtObject {
    id: fakeService
    property string activeAccountId: "a"
    property string providerId: "imap"
    property bool unified: false
    property var messages: [{ id: "1:INBOX", inInbox: true, unread: false, starred: false, labelIds: ["INBOX"] }]
    property string mailboxKey: "inbox"
    property string rawQuery: ""
    property string searchQuery: ""
    property bool canArchive: true
    function refuseUnavailableAction() { return false }
  }

  property var acted: []

  Mail.RowDrag {
    id: drag
    service: fakeService
    checkedIds: []
    textColor: Commons.Color.foreground
    accentColor: Commons.Color.accent
    popupBackgroundColor: Commons.Color.background
    panelFontFamily: "monospace"
    act: function(id, action) { acted.push([id, action]); return true }
  }

  TestCase {
    name: "RowDragAccount"
    when: windowShown

    function init() { fakeService.activeAccountId = "a"; acted = []; drag.cancel() }

    function test_switching_accounts_mid_drag_cancels_it() {
      drag.start("1:INBOX", 10, 10)
      verify(drag.active)
      compare(drag.accountId, "a")
      fakeService.activeAccountId = "b"
      verify(!drag.active)
      drag.dropOnMailbox("trash")
      drag.end()
      compare(acted.length, 0)
    }

    function test_a_drop_in_the_starting_account_still_acts() {
      drag.start("1:INBOX", 10, 10)
      verify(drag.active)
      verify(!drag.stale)
      drag.dropOnMailbox("trash")
      compare(acted.length, 1)
      compare(acted[0][1], "trash")
      drag.end()
    }
  }
}
