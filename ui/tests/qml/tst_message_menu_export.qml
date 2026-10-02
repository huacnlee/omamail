import QtQuick 2.15
import QtTest 1.3
import "../../components" as Omamail

// "Save as .eml" in the message menu: it appears only where the service says
// the provider and the connected backend can do it, and choosing it asks the
// service for the account and native id captured when the menu opened rather
// than resolving them against whatever mailbox is on screen when it is chosen.
Item {
  width: 500
  height: 500

  QtObject {
    id: fakeService
    property bool canArchive: true
    property bool canReportSpam: true
    property bool canStar: true
    property bool canOpenOnWeb: false
    property bool hasLabels: false
    property string rawLabelId: ""
    property bool exportable: true
    property var exported: []
    property var messages: []
    property var memberSummaries: ({})
    property string ada: "imap:ada@example.org"
    // The menu captures the owner and the provider's own id at open time. A
    // row id belongs to the visible mailbox; a member id in this fixture is
    // composed as `<account>/<native>` so the two answers are distinguishable.
    function canExportEmlFor(id) { return exportable }
    function accountForMessage(id) {
      var at = String(id).indexOf("/")
      return at > 0 ? String(id).substring(0, at) : ada
    }
    function sourceIdFor(id) {
      var at = String(id).indexOf("/")
      return at > 0 ? String(id).substring(at + 1) : String(id)
    }
    function exportEmlFor(accountId, id) {
      exported = exported.concat([{ account: String(accountId), id: String(id) }])
      return true
    }
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

  TestCase {
    name: "MessageMenuExport"
    when: windowShown

    // exportRow sits after star, before the browser and AI rows.
    function exportRow() { return menu.menuRows[11] }

    function summary() {
      return { id: "42:INBOX", subject: "Project update", unread: false,
        starred: false, inInbox: true, inTrash: false, inSpam: false,
        isSent: false, isDraft: false, labelIds: [] }
    }

    function memberSummary(id) {
      var value = summary()
      value.id = id
      value.sourceId = "42:INBOX"
      return value
    }

    function show() {
      fakeService.messages = [summary()]
      fakeService.memberSummaries = ({})
      fakeService.exported = []
      menu.close()
      menu.openAt("42:INBOX", 100, 100)
      wait(20)
    }

    function showMember(id) {
      fakeService.messages = []
      var members = ({})
      members[id] = memberSummary(id)
      fakeService.memberSummaries = members
      fakeService.exported = []
      menu.close()
      menu.openForMember(id, 100, 100)
      wait(20)
    }

    function cleanup() { menu.close() }

    function test_the_row_appears_only_when_the_service_says_it_can() {
      fakeService.exportable = true
      show()
      compare(exportRow().visible, true)
      compare(String(exportRow().text), "Save as .eml")

      fakeService.exportable = false
      show()
      compare(exportRow().visible, false,
        "a provider or backend without export must not offer the row")
    }

    function test_choosing_it_routes_the_owning_account_and_message() {
      fakeService.exportable = true
      show()
      exportRow().activated()
      compare(fakeService.exported, [{ account: fakeService.ada, id: "42:INBOX" }])
      compare(menu.opened, false, "the menu closes on choosing")
    }

    // A stop on the conversation rail is one message, and its id is the
    // composed member id. The menu keeps the account and the member's native
    // id, so the export reaches that member rather than the list's root row.
    function test_a_member_menu_routes_the_member_id() {
      fakeService.exportable = true
      showMember(fakeService.ada + "/17:INBOX")
      compare(exportRow().visible, true)
      exportRow().activated()
      compare(fakeService.exported, [{ account: fakeService.ada, id: "17:INBOX" }],
        "the native member id, not the composed rail id")
    }
  }
}
