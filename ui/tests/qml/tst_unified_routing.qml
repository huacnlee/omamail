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

    // ------------------------------------------------------- attachments

    // Saving reached whichever mailbox was active, so the file that came down
    // was A's part id under B's filename — and on an IMAP pair, where a part
    // id is a number in a tree rather than anything unique, the two collide
    // routinely. Neither host can actually fetch here, so what is asserted is
    // which of them was asked: the refusal lands on the mailbox that owns the
    // message and nowhere else.
    function test_saving_an_attachment_asks_the_mailbox_that_owns_it() {
      ada().lastError = ""
      bob().lastError = ""
      compare(service.activeAccountId, adaId, "A is the active mailbox")

      service.saveAttachment(Unified.unifiedId(bobId, "1"),
        { attachmentId: "2", filename: "invoice.pdf" })

      verify(bob().lastError !== "", "B was asked, because the message is B's")
      compare(ada().lastError, "", "and A was not asked at all")
    }

    // The spinner is keyed by mailbox and attachment, and the reader holds
    // only an attachment id — so composing the key is the service's job. It
    // was looked up bare, found nothing, and the row never went busy.
    function test_the_saving_row_is_the_owning_mailboxs_row() {
      bob().markSavingAttachment("2", true)

      compare(service.attachmentIsSaving(Unified.unifiedId(bobId, "1"), "2"), true)
      compare(service.attachmentIsSaving(Unified.unifiedId(adaId, "1"), "2"), false,
        "A is not saving anything, whatever B is doing")
      compare(service.attachmentIsSaving("", "2"), false)
      compare(service.attachmentIsSaving(Unified.unifiedId(bobId, "1"), ""), false)

      bob().markSavingAttachment("2", false)
      compare(service.attachmentIsSaving(Unified.unifiedId(bobId, "1"), "2"), false)
    }

    // ------------------------------------------- every mailbox is live

    // `active` is what earns a mailbox a list: `refresh` will not reload one
    // without it, and neither will the poll. Leaving it on the visible account
    // meant a merged list refreshed one mailbox's rows and left the others as
    // they were — the counts moved and the mail did not.
    function test_every_merged_mailbox_is_given_a_list() {
      compare(service.unified, true)
      compare(ada().active, true)
      compare(bob().active, true, "B is on screen too, so B gets a list")
      compare(bob().windowOpen, ada().windowOpen,
        "and the same answer about the window, which refresh also asks")
    }

    // Turning it off puts the list back on the one mailbox being shown.
    function test_leaving_the_merged_view_stands_the_others_down() {
      service.applySettings({ unifiedMailboxes: false })
      wait(30)
      compare(service.unified, false)
      compare(ada().active, true, "A is the mailbox on screen")
      compare(bob().active, false, "and B is no longer being drawn")
    }

    // ------------------------------------------------- the sending identity

    // Two mailboxes can share a send-as alias, and the address alone then
    // names both. Whichever host answered first got the message.
    function test_a_draft_is_sent_from_the_mailbox_it_names() {
      compare(service.sendHostFor({ accountId: bobId, from: "shared@example.com" }),
        bob(), "the mailbox the composer named, not the one the address matched")

      // The collision itself: one address, both mailboxes claiming it. Named
      // still decides, and the first match no longer does.
      ada().profile = { email: "shared@example.com" }
      bob().profile = { email: "shared@example.com" }
      compare(service.sendHostFor({ from: "shared@example.com" }), ada(),
        "with nothing named the first match is all there is to go on")
      compare(service.sendHostFor({ accountId: bobId, from: "shared@example.com" }),
        bob(), "and naming one is what settles it")
      ada().profile = null
      bob().profile = null

      // With neither, the mailbox on screen.
      compare(service.sendHostFor({}), service.current)
    }

    // A draft raised from a merged list names its mailbox in its own id, so a
    // submission that carries only that still reaches the right one.
    function test_a_draft_id_alone_names_the_sending_mailbox() {
      compare(service.sendHostFor({ draftId: Unified.unifiedId(bobId, "d1") }), bob())
    }

    // A named mailbox that is not here is a refusal rather than permission to
    // fall back to matching the address.
    function test_a_draft_naming_a_mailbox_that_is_gone_is_not_sent() {
      ada().lastError = ""
      bob().lastError = ""
      compare(service.sendHostFor({ accountId: "gone@example.com", from: adaId }), null,
        "A matches the address, and is still not asked")
      compare(service.send({ accountId: "gone@example.com",
        from: adaId, to: "her@example.com", subject: "x", body: "y" }), false)
      compare(ada().lastError, "", "nothing was sent from anywhere")
      compare(bob().lastError, "")
    }

    // ------------------------------------------------------- the draft id

    // A draft opened from a merged list carries a composed id, and a provider
    // handed one answers that the draft is gone and writes nothing.
    function test_a_draft_is_saved_under_the_id_its_provider_issued() {
      compare(service.draftOwner({ draftId: Unified.unifiedId(bobId, "d1") }), bobId,
        "the owner is readable from the id alone")
      compare(service.withSourceDraftId(
        { draftId: Unified.unifiedId(bobId, "d1") }).draftId, "d1")

      // Named account wins, and a bare id is left exactly as it is.
      compare(service.draftOwner({ accountId: adaId, draftId: Unified.unifiedId(bobId, "d1") }),
        adaId)
      compare(service.withSourceDraftId({ draftId: "d1" }).draftId, "d1")
    }

    // Not gated on the merged view still being on: the composer can be opened
    // from one and saved after the reader has left it.
    function test_a_composed_draft_id_is_decoded_after_the_view_changes() {
      service.applySettings({ unifiedMailboxes: false })
      wait(30)
      compare(service.unified, false)
      compare(service.withSourceDraftId(
        { draftId: Unified.unifiedId(bobId, "d1") }).draftId, "d1")
      compare(service.draftOwner({ draftId: Unified.unifiedId(bobId, "d1") }), bobId)
    }

    // ----------------------------------------------- what a merge may do

    // What the intersection is taken over: one row per mailbox, each row that
    // mailbox's own answer.
    //
    // A host narrows its provider by the refusals its server reported and the
    // mailboxes it turned out not to have, so a merged list that asks the
    // provider ids puts back an Archive the account's own view hides. The
    // narrowing itself arrives through `api`, which is a read-only loader
    // item and cannot be injected here — so what is asserted is that every
    // row is the host's answer and not a provider's. `everyMailboxCan` and
    // `sharedMailboxRows` are held to the divergent case in
    // tests/test_unified.js, and test_source.sh guards the call sites.
    function test_the_intersection_is_taken_over_the_mailboxes_themselves() {
      var rows = service.unifiedAbilities
      compare(rows.length, 2, "one row per mailbox in the merge")

      var hosts = [ada(), bob()]
      for (var i = 0; i < hosts.length; i++) {
        compare(rows[i].archive, hosts[i].canArchive)
        compare(rows[i].spam, hosts[i].canReportSpam)
        compare(rows[i].star, hosts[i].canStar)
        compare(rows[i].labels, hosts[i].hasLabels)
        compare(rows[i].web, hosts[i].canOpenOnWeb)
        compare(rows[i].move, hosts[i].canMove)
        compare(rows[i].conversations, hosts[i].showsConversations)
        compare(rows[i].mailboxes.length, hosts[i].mailboxes.length)
      }

      compare(service.canArchive,
        Unified.everyMailboxCan(rows, "archive"),
        "and the offered verb is that intersection, nothing else")
    }

    // ------------------------------------------------ conversation members

    // The rail steps from one member to the next and hands the id back to
    // `select` and `act`. A raw member id reached no mailbox, so a merged
    // conversation could be drawn and not walked.
    function test_a_conversation_member_is_addressed_like_every_other_row() {
      bob().selectedThread = { id: "t1", count: 2, unread: false, flagged: false,
        memberIds: ["1", "2"] }
      bob().memberSummaries = ({
        "1": { id: "1", unread: true, labelIds: ["UNREAD"] },
        "2": { id: "2", unread: false, labelIds: [] }
      })
      service.select(Unified.unifiedId(bobId, "1"))

      deepCompare(service.selectedThread.memberIds,
        [Unified.unifiedId(bobId, "1"), Unified.unifiedId(bobId, "2")])
      compare(service.selectedThread.id, "t1",
        "the thread's own handle is not a message id and is left alone")

      var key = Unified.unifiedId(bobId, "2")
      verify(service.memberSummaries[key], "the summaries are keyed the same way")
      compare(service.memberSummaries[key].id, key,
        "and a stop carries that id onward to an open")

      // Which is what makes the next stop reachable.
      compare(service.hostForId(service.selectedThread.memberIds[1]), bob())

      bob().selectedThread = null
      bob().memberSummaries = ({})
    }

    function test_a_search_reaches_every_mailbox() {
      service.search("invoice")
      compare(ada().searchQuery, "invoice")
      compare(bob().searchQuery, "invoice")
    }
  }
}
