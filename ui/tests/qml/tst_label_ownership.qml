import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture
import "../../account/Accounts.js" as Accounts

// A label change goes to the account whose menu asked for it. Ada and Bob
// both have a folder named Work — an IMAP id is a folder name, unique in one
// account and no further — so a rename or a delete confirmed after the
// window switched to Bob must still reach Ada's server and never Bob's, and
// a switch closes the popups that were about Ada. The watched ids follow a
// renamed folder to its new name, on to disk, and a deleted folder's watch
// goes with it. The counts a poll asks for are bounded.
Item {
  width: 900
  height: 600

  QtObject {
    id: shellStore
    function updateEntryInline(_id, _entry) {}
    function hide(_id) {}
  }

  QtObject {
    id: record
    property var renames: []
    property var deletes: []
    property var creates: []
    property var listing: ({})
    property string listingError: ""
    property int inFlight: 0
    property int mostInFlight: 0
    property int counted: 0
    function reset() { renames = []; deletes = []; creates = []; listing = {}; listingError = ""; inFlight = 0; mostInFlight = 0; counted = 0 }
  }

  Component {
    id: controlledClient
    QtObject {
      property var auth: null
      property string email: ""
      function handle() { return ({ aborted: false }) }
      function later(fn) { Qt.callLater(fn); return handle() }
      function listMessages() { return handle() }
      function getMessages() { return handle() }
      function getMessage() { return handle() }
      function trashMessage() { return handle() }
      function untrashMessage() { return handle() }
      function batchModify() { return handle() }
      function modifyMessage() { return handle() }
      function getLabels(callback) {
        var mine = record.listing[email] || []
        var refused = record.listingError
        record.listingError = ""
        return later(function() { callback(refused !== "" ? [] : mine, refused) })
      }
      function getLabelCounts(id, callback) {
        record.inFlight++
        if (record.inFlight > record.mostInFlight) record.mostInFlight = record.inFlight
        return later(function() {
          record.inFlight--
          record.counted++
          callback({ id: id, unread: 1, total: 1, threadsUnread: 1 }, "")
        })
      }
      function getProfile(callback) { return later(function() { callback({ email: email }, "") }) }
      function getSendAs(callback) { return later(function() { callback([], "") }) }
      function getAttachment() { return handle() }
      function saveDraft() { return handle() }
      function deleteDraft() { return handle() }
      function sendMessage() { return handle() }
      function createLabel(name, callback) {
        record.creates = record.creates.concat([email + ":" + name])
        return later(function() { callback(null, "") })
      }
      function renameLabel(id, name, callback) {
        record.renames = record.renames.concat([email + ":" + id + ">" + name])
        return later(function() { callback(null, "") })
      }
      function deleteLabel(id, callback) {
        record.deletes = record.deletes.concat([email + ":" + id])
        return later(function() { callback(null, "") })
      }
      function abortRequest(h) { if (h) h.aborted = true }
    }
  }

  Omamail.Service {
    id: mailService
    shell: shellStore
    manifest: ({ id: "omamail", __sourceDir: "/tmp/omamail-test" })
  }

  Omamail.App { id: app; service: mailService }

  TestCase {
    name: "LabelOwnership"
    when: windowShown

    function initTestCase() { BackendFixture.markReady(mailService) }

    readonly property string ada: "ada@example.com"
    readonly property string bob: "bob@example.com"
    readonly property string adaId: "imap:ada@example.com"
    readonly property string bobId: "imap:bob@example.com"

    function entry(email, monitored) {
      return {
        email: email, provider: "imap", clientId: "", clientSecret: "",
        imap: { imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 465,
          username: email, aliases: [], insecure: false },
        label: "", signature: "", monitored: monitored || []
      }
    }

    function folder(id) { return ({ id: id, name: id, rawName: id, delimiter: "/", unread: 0, system: false }) }

    function seed(entries, activeId) {
      var list = Accounts.emptyList()
      for (var i = 0; i < entries.length; i++) list = Accounts.add(list, entries[i])
      list = Accounts.setActive(list, activeId)
      mailService.activeIndex = -1
      mailService.accountList = list
      mailService.accountsLoaded = true
      wait(0)
      mailService.refreshCurrent()
      for (var h = 0; h < entries.length; h++) {
        var account = mailService.accountAt(h)
        verify(account !== null)
        account.clientOverride = controlledClient
        account.auth.toolsChecked = true
        account.auth.missingTools = []
        account.auth.passwordChecked = true
        account.auth.password = "test-password"
        tryCompare(account, "ready", true)
        // The stand-in says whose it is, so the record can tell the two apart.
        account.api.email = entries[h].email
        account.labels = [folder("Work"), folder("Work/2026"), folder("Receipts")]
      }
    }

    function popup(name) {
      function find(item) {
        if (item.objectName === name) return item
        var kids = item.children || []
        for (var i = 0; i < kids.length; i++) { var f = find(kids[i]); if (f) return f }
        return null
      }
      return find(app)
    }

    function switchTo(id) {
      mailService.accountList = Accounts.setActive(mailService.accountList, id)
      tryCompare(mailService, "activeAccountId", id)
    }

    function init() { record.reset(); app.resetNavigation() }

    // The menu opens for Ada. The window switches to Bob — straight through
    // the service, as a key would — and the popups close. The answers the
    // prompt and the confirmation would have given still name Ada, and
    // reach Ada's server alone.
    function test_a_change_goes_to_the_account_whose_menu_asked() {
      seed([entry(ada), entry(bob)], adaId)
      var menu = popup("label-menu")
      verify(menu !== null)
      app.openLabelMenu("Work", "Work", 10, 10)
      compare(menu.accountId, adaId)
      tryCompare(menu, "opened", true)
      switchTo(bobId)
      tryCompare(menu, "opened", false, 1000, "a switch closes the menu")
      app.labelNamed("rename", "Work", "Jobs", adaId)
      tryCompare(record, "renames", [ada + ":Work>Jobs"])
      app.confirmDelete({ kind: "label", labelId: "Work/2026", name: "Work/2026", accountId: adaId })
      tryCompare(record, "deletes", [ada + ":Work/2026"])
      app.labelNamed("create", "Receipts", "2026", adaId)
      tryCompare(record, "creates", [ada + ":Receipts/2026"])
      compare(mailService.activeAccountId, bobId, "Bob stayed open throughout")
      for (var i = 0; i < record.renames.length; i++) verify(record.renames[i].indexOf(bob) < 0)
    }

    // The account the menu was about is gone: nothing is sent anywhere, and
    // the open account says why.
    function test_a_change_for_a_removed_account_goes_nowhere() {
      seed([entry(ada), entry(bob)], bobId)
      compare(mailService.renameLabel("Work", "Jobs", "imap:gone@example.com"), false)
      compare(mailService.deleteLabel("Work", "imap:gone@example.com"), false)
      wait(20)
      compare(record.renames.length, 0)
      compare(record.deletes.length, 0)
      verify(mailService.accountAt(1).lastError.indexOf("no longer set up") >= 0, mailService.accountAt(1).lastError)
    }

    // A watch on Work/2026 follows the rename of Work to Jobs, into the
    // account's entry and the file; a watch on a deleted folder is dropped.
    function test_watched_ids_follow_a_rename_and_leave_with_a_delete() {
      seed([entry(ada, ["Work/2026", "Receipts"])], adaId)
      deepEqualIds(mailService.monitoredLabelIds, ["Work/2026", "Receipts"])
      record.listing[ada] = [folder("Jobs"), folder("Jobs/2026"), folder("Receipts")]
      verify(mailService.renameLabel("Work", "Jobs", adaId))
      tryCompare(record, "renames", [ada + ":Work>Jobs"])
      tryVerify(function() { return mailService.monitoredLabelIds.indexOf("Jobs/2026") >= 0 }, 1000)
      deepEqualIds(mailService.monitoredLabelIds, ["Jobs/2026", "Receipts"])
      deepEqualIds(Accounts.find(mailService.accountList, adaId).monitored, ["Jobs/2026", "Receipts"])
      verify(mailService.accountsWritePayload.indexOf("Jobs/2026") >= 0, "and it is on its way to disk")
      verify(mailService.accountsWritePayload.indexOf("Work/2026") < 0)

      record.listing[ada] = [folder("Jobs"), folder("Jobs/2026")]
      verify(mailService.deleteLabel("Receipts", adaId))
      tryCompare(record, "deletes", [ada + ":Receipts"])
      tryVerify(function() { return mailService.monitoredLabelIds.indexOf("Receipts") < 0 }, 1000)
      deepEqualIds(mailService.monitoredLabelIds, ["Jobs/2026"])
    }

    // A name the list already has is refused before it reaches the server.
    function test_a_name_already_taken_is_refused() {
      seed([entry(ada)], adaId)
      compare(mailService.renameLabel("Receipts", "Work", adaId), false)
      compare(mailService.createLabel("", "Work", adaId), false)
      compare(mailService.moveLabel("Receipts", "Work", adaId), true, "a name nobody has goes through")
      wait(20)
      compare(record.renames.length, 1)
      compare(record.creates.length, 0)
      verify(mailService.accountAt(0).lastError.indexOf("already a label named") >= 0
        || mailService.accountAt(0).lastError === "", mailService.accountAt(0).lastError)
    }

    // The listing after a rename fails once: the watch waits, and follows
    // with the listing that does land. Two changes before a listing are
    // both applied.
    function test_a_failed_listing_keeps_the_watch_waiting() {
      seed([entry(ada, ["Work/2026", "Receipts"])], adaId)
      record.listing[ada] = [folder("Jobs"), folder("Jobs/2026"), folder("Receipts")]
      record.listingError = "the server hung up"
      verify(mailService.renameLabel("Work", "Jobs", adaId))
      tryCompare(record, "renames", [ada + ":Work>Jobs"])
      tryVerify(function() { return mailService.monitoredLabelIds.indexOf("Jobs/2026") >= 0 }, 2000)
      deepEqualIds(mailService.monitoredLabelIds, ["Jobs/2026", "Receipts"])

      record.listing[ada] = [folder("Tasks"), folder("Tasks/2026")]
      var account = mailService.accountAt(0)
      account.labels = [folder("Jobs"), folder("Jobs/2026"), folder("Receipts")]
      verify(mailService.renameLabel("Jobs", "Tasks", adaId))
      verify(mailService.deleteLabel("Receipts", adaId))
      tryVerify(function() { return mailService.monitoredLabelIds.indexOf("Tasks/2026") >= 0 }, 2000)
      deepEqualIds(mailService.monitoredLabelIds, ["Tasks/2026"])
    }

    // A signed-out owner changes nothing, and says so.
    function test_a_signed_out_owner_changes_nothing() {
      seed([entry(ada), entry(bob)], adaId)
      var bobs = mailService.accountAt(1)
      bobs.auth.password = ""
      bobs.auth.passwordChecked = true
      bobs.clientOverride = null
      tryCompare(bobs, "ready", false)
      compare(mailService.renameLabel("Work", "Jobs", bobId), false)
      wait(20)
      compare(record.renames.length, 0)
      verify(bobs.lastError.indexOf("signed out") >= 0, bobs.lastError)
    }

    // Five watched folders are counted three at a time, and all five are.
    function test_the_counts_a_poll_asks_for_are_bounded() {
      seed([entry(ada, ["a", "b", "c", "d", "e"])], adaId)
      var account = mailService.accountAt(0)
      account.labels = [folder("a"), folder("b"), folder("c"), folder("d"), folder("e")]
      account.labelActions.refreshMonitored()
      tryVerify(function() { return record.counted === 5 }, 1000)
      verify(record.mostInFlight <= 3, "at most three at once: " + record.mostInFlight)
      verify(record.mostInFlight >= 2, "and more than one: " + record.mostInFlight)
      tryCompare(account.labelActions, "monitoredLoading", false)
    }

    function labelRow(path) {
      function find(item) {
        if (item.fullPath === path && item.selected !== undefined) return item
        var kids = item.children || []
        for (var i = 0; i < kids.length; i++) { var f = find(kids[i]); if (f) return f }
        return null
      }
      return find(app)
    }

    function test_context_target_stays_active_until_menu_closes() {
      seed([entry(ada), entry(bob)], adaId)
      var work = labelRow("Work")
      var receipts = labelRow("Receipts")
      verify(work !== null)
      verify(receipts !== null)
      compare(work.selected, false)
      var query = mailService.rawQuery
      work.menuRequested(10, 10)
      var menu = popup("label-menu")
      tryCompare(menu, "opened", true)
      compare(work.selected, true, "The row that opened the context menu must stay active")
      receipts.menuRequested(10, 10)
      compare(receipts.selected, true)
      compare(work.selected, false)
      compare(mailService.rawQuery, query)
      menu.close()
      tryCompare(menu, "opened", false)
      compare(receipts.selected, false)
      work.menuRequested(10, 10)
      tryCompare(menu, "opened", true)
      switchTo(bobId)
      tryCompare(menu, "opened", false)
      compare(labelRow("Work").selected, false)
    }
    function test_review_delete_keeps_surviving_child_watch() {
      seed([entry(ada, ["Work/2026", "Receipts"])], adaId)
      record.listing[ada] = [folder("Work/2026"), folder("Receipts")]
      verify(mailService.deleteLabel("Work", adaId))
      tryVerify(function() { return mailService.accountAt(0).labels.length === 2 }, 1000)
      deepEqualIds(mailService.monitoredLabelIds, ["Work/2026", "Receipts"])
    }
    function test_review_two_renames_keep_both_watches() {
      seed([entry(ada, ["Work", "Receipts"])], adaId)
      record.listing[ada] = [folder("Jobs"), folder("Jobs/2026"), folder("Bills")]
      verify(mailService.renameLabel("Work", "Jobs", adaId))
      verify(mailService.renameLabel("Receipts", "Bills", adaId))
      tryVerify(function() { return mailService.accountAt(0).labels[0].id === "Jobs" }, 1000)
      deepEqualIds(mailService.monitoredLabelIds, ["Jobs", "Bills"])
    }
    function deepEqualIds(actual, expected) {
      compare(JSON.stringify(actual), JSON.stringify(expected))
    }
  }
}
