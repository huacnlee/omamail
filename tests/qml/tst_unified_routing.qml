import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "../../account/Unified.js" as Unified

// The service routing a merged list, against a real `Service` with real
// account hosts.
//
// This is the gap the review named: `select`, `hostForId`, `sourceIdFor` on
// real messages, `chooseUnified`, the capability intersection and the
// per-mailbox properties had no test at all, and every defect found landed in
// exactly those gaps.
//
// The hosts are real `MailAccount`s with no credentials, so nothing is fetched
// and nothing is sent; what is asserted is which of them the service asked.
Item {
  width: 1200
  height: 700

  QtObject {
    id: fakeShell
    property var written: []
    function updateEntryInline(id, entry) {
      var next = written.slice()
      next.push({ id: id, entry: entry })
      written = next
    }
    function hide(_id) {}
  }

  Omamail.Service {
    id: service
    shell: fakeShell
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-unified-test" })
  }

  TestCase {
    name: "UnifiedRouting"
    when: windowShown

    readonly property string adaId: "ada@example.org"
    readonly property string bobId: "bob@example.net"

    function seed() {
      service.applySettings({ unifiedMailboxes: true })
      service.applyAccounts(JSON.stringify({
        version: 1,
        activeId: adaId,
        accounts: [
          { id: adaId, email: adaId, provider: "gmail" },
          { id: bobId, email: bobId, provider: "gmail" }
        ]
      }))
      wait(50)
    }

    function ada() { return service.findAccount(adaId) }
    function bob() { return service.findAccount(bobId) }

    // A summary shaped the way a provider hands one over, so `mergeMessages`
    // has real fields to copy and sort.
    function row(id, date, subject) {
      return { id: id, subject: subject, unread: true, starred: false,
        inInbox: true, inTrash: false, isDraft: false, labelIds: ["INBOX"],
        from: { email: "sender@example.com", display: "Sender" },
        snippet: "", time: "now", fullTime: "today", date: date }
    }

    function init() {
      seed()
      ada().messages = [row("1", 3000, "ada newest"), row("2", 1000, "ada oldest")]
      bob().messages = [row("1", 2000, "bob middle")]
      service.bumpListEpoch()
      wait(20)
    }

    // ------------------------------------------------------------ the merge

    function test_two_mailboxes_become_one_list() {
      compare(service.unified, true)
      compare(service.messages.length, 3)
      deepCompare(service.messages.map(function(m) { return m.subject }),
        ["ada newest", "bob middle", "ada oldest"])
    }

    function deepCompare(actual, expected) {
      compare(actual.join(" | "), expected.join(" | "))
    }

    // Two mailboxes numbering their own messages from 1 is the collision the
    // composed id exists for.
    function test_each_row_is_addressed_by_its_own_mailbox() {
      var ids = service.messages.map(function(m) { return m.id })
      compare(ids[0], Unified.unifiedId(adaId, "1"))
      compare(ids[1], Unified.unifiedId(bobId, "1"))
      compare(ids[2], Unified.unifiedId(adaId, "2"))
      compare(ids[0] === ids[1], false, "three rows, three distinct ids")
    }

    function test_one_mailbox_is_not_merged() {
      service.applyAccounts(JSON.stringify({
        version: 1, activeId: adaId,
        accounts: [{ id: adaId, email: adaId, provider: "gmail" }]
      }))
      wait(50)
      compare(service.accountCount, 1)
      compare(service.unified, false,
        "a merged view of one mailbox is the mailbox")
    }

    // ---------------------------------------------------------- the routing

    function test_an_id_names_the_mailbox_that_owns_it() {
      compare(service.hostForId(Unified.unifiedId(adaId, "1")), ada())
      compare(service.hostForId(Unified.unifiedId(bobId, "1")), bob())
      compare(service.sourceIdFor(Unified.unifiedId(bobId, "42:Sent Items")),
        "42:Sent Items", "a folder with a space in it survives the trip")
    }

    // An id for a mailbox that is not here reaches none rather than the wrong
    // one — which a bare id, read as composed, could have done.
    function test_an_id_for_a_mailbox_that_is_not_here_reaches_nothing() {
      compare(service.hostForId(Unified.unifiedId("gone@example.com", "1")), null)
      compare(service.hostForId("42:Sent Items"), null,
        "a bare IMAP id is not a composed one")
      compare(service.act("42:Sent Items", "archive"), false)
    }

    // Selecting routes to the owning mailbox, and clears the others: a second
    // mailbox still holding a selection goes on answering for the reader.
    function test_selecting_clears_every_other_mailbox() {
      service.select(Unified.unifiedId(bobId, "1"))
      compare(bob().selectedId, "1")
      compare(ada().selectedId, "", "whatever was open elsewhere is not what is shown")
      compare(service.selectedId, Unified.unifiedId(bobId, "1"),
        "and it comes back composed, because the panel compares it against the list")

      service.select(Unified.unifiedId(adaId, "2"))
      compare(ada().selectedId, "2")
      compare(bob().selectedId, "")
    }

    // A reply is written from the mailbox the message arrived in.
    function test_compose_belongs_to_the_mailbox_the_message_arrived_in() {
      service.select(Unified.unifiedId(bobId, "1"))
      compare(service.composeAccountId, bobId,
        "not the account that happens to be active")

      service.select(Unified.unifiedId(adaId, "1"))
      compare(service.composeAccountId, adaId)
    }

    function test_clearing_the_selection_clears_all_of_them() {
      service.select(Unified.unifiedId(bobId, "1"))
      service.clearSelection()
      compare(bob().selectedId, "")
      compare(ada().selectedId, "")
      compare(service.selectedId, "")
    }

    // ------------------------------------------------------- the properties

    function test_the_rail_is_what_every_mailbox_has() {
      var keys = service.mailboxes.map(function(m) { return m.key })
      compare(keys.indexOf("inbox") >= 0, true)
      compare(keys.indexOf("spam") >= 0, true, "two Gmail mailboxes share Gmail's rail")
    }

    function test_a_label_cannot_be_shown_or_moved_to() {
      compare(service.labels.length, 0, "a label belongs to one mailbox")
      compare(service.rawLabelId, "")
      compare(service.canMoveToLabel, false,
        "so there is nothing for the picker to offer")
    }

    function test_the_unread_count_is_every_mailbox() {
      ada().inboxUnread = 3
      bob().inboxUnread = 4
      service.recount()
      wait(20)
      compare(service.inboxUnread, 7)
    }

    // The rail row is chosen even with the calendar up, or every mailbox stays
    // on whatever it was showing while the rail claims one.
    function test_a_rail_row_reaches_every_mailbox() {
      service.selectMailbox("sent")
      compare(service.mailboxKey, "sent")
      compare(ada().mailboxKey, "sent")
      compare(bob().mailboxKey, "sent")
    }

    function test_a_search_reaches_every_mailbox() {
      service.search("invoice")
      compare(ada().searchQuery, "invoice")
      compare(bob().searchQuery, "invoice")
    }
  }
}
