import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "../../account/Unified.js" as Unified
import "ModelFixture.js" as NativeModel

// A Microsoft 365 mailbox and an Outlook one in the same window, against a real
// `Service` with real account hosts: the merged list and what the two may offer
// together. The routing of an id to its mailbox is the provider-independent
// `tst_unified_routing`'s.
//
// The hosts are real `MailAccount`s with no credentials, so nothing is fetched.
Item {
  id: fixtureRoot
  width: 1200
  height: 700

  QtObject {
    id: fakeShell
    function updateEntryInline(id, entry) {}
    function hide(_id) {}
  }

  Omamail.Service {
    id: service
    shell: fakeShell
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-m365-unified-test" })
  }

  TestCase {
    name: "M365Unified"
    when: windowShown

    readonly property string janeId: "m365:jane@corp.example.test"
    readonly property string bobId: "outlook:bob@example.net"

    function initTestCase() { NativeModel.install(service) }

    function seed(accounts) {
      service.applySettings({ unifiedMailboxes: true })
      service.applyAccounts(JSON.stringify({ version: 1, activeId: janeId, accounts: accounts || [
        { id: janeId, email: "jane@corp.example.test", provider: "m365" },
        { id: bobId, email: "bob@example.net", provider: "outlook" }] }))
      wait(50)
    }

    function jane() { return service.findAccount(janeId) }
    function bob() { return service.findAccount(bobId) }

    function row(id, date, subject) {
      return { id: id, subject: subject, unread: true, starred: false, inInbox: true, inTrash: false, isDraft: false,
        labelIds: ["INBOX"], from: { email: "sender@example.com", display: "Sender" }, snippet: "", time: "now",
        fullTime: "today", date: date }
    }

    function init() {
      seed()
      jane().messages = [row("ifau222bi5itcqkbifat2", 3000, "jane newest"), row("same", 1000, "jane oldest")]
      bob().messages = [row("same", 2000, "bob middle")]
      service.bumpListEpoch()
      wait(20)
    }

    function cleanup() { service.applySettings({ unifiedMailboxes: true }) }

    function test_the_two_mailboxes_have_their_own_kinds_and_become_one_list_by_date() {
      compare(jane().providerId, "m365")
      compare(bob().providerId, "outlook")
      verify(jane().auth.effectiveClientId !== undefined, "the Microsoft 365 mailbox runs on its own sign-in")
      compare(service.unified, true)
      compare(service.messages.map(function(m) { return m.subject }).join(" | "), "jane newest | bob middle | jane oldest")
      var ids = service.messages.map(function(m) { return m.id })
      compare(ids[2], Unified.unifiedId(janeId, "same"), "one id in two mailboxes is two rows")
      compare(service.hostForId(ids[0]), jane())
      compare(service.hostForId(ids[1]), bob())
    }

    function test_a_button_is_offered_only_when_every_mailbox_can_honour_it() {
      compare(service.canArchive, true, "both Microsoft kinds can archive")
      compare(service.canReportSpam, false, "and neither reports spam")
      seed([{ id: janeId, email: "jane@corp.example.test", provider: "m365" },
        { id: "bob@example.net", email: "bob@example.net", provider: "gmail" }])
      compare(service.hasLabels, false, "Gmail has labels and the Microsoft 365 mailbox has none: a merged list has none")
      compare(service.canArchive, true)
    }

    function test_a_rail_row_reaches_both_mailboxes_each_in_its_own_words() {
      service.selectMailbox("sent")
      compare(jane().mailboxKey, "sent")
      compare(bob().mailboxKey, "sent")
      compare(jane().effectiveQuery, "role:sent")
      compare(bob().effectiveQuery, "folder:\\Sent")
    }

    function test_the_summaries_name_each_mailboxs_provider_and_calendar() {
      var summaries = service.accountSummaries
      for (var id of [janeId, bobId]) {
        var mine = summaries.filter(function(item) { return item.id === id })[0]
        compare(mine.calendarProvider, "microsoft", id + " has a Graph calendar")
      }
      compare(summaries.filter(function(item) { return item.id === janeId })[0].provider, "m365")
    }
  }
}
