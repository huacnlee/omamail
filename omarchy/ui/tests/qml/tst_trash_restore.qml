import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture
import "ModelFixture.js" as NativeModel
import "NativeIntentFixture.js" as NativeIntentFixture
import "../../account/Accounts.js" as Accounts
import "../../account/Unified.js" as Unified

// Restore in the trash and Move to Inbox in Archive, through the real Service,
// App and MailAccount, with the native intent engine deciding the optimistic
// change and a client the test controls recording what reaches the provider.
//
// HEY declares neither archive nor move, so a message in its Trash had no way
// out: the menu offered "Move to trash" again, `d` trashed it again, and the
// untrash every client implements was reachable from nothing. HEY's posting
// carries no TRASH label either, so the Trash listing itself says where it is.
//
// Move to Inbox in Archive comes from the same rule. Every control decides its
// verb over the rows its action will reach: a ticked row's menu or
// middle-click, `e` and `d` with rows ticked, and the reader on a ticked
// message all mean the selection, and the reader on a conversation member
// means the conversation's row.
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
    property var trashed: []
    property var untrashed: []
    property var modified: []
    function reset() { trashed = []; untrashed = []; modified = [] }
  }

  Component {
    id: controlledClient
    QtObject {
      property var auth: null
      property string email: ""
      function handle() { return ({ aborted: false }) }
      function later(fn) { Qt.callLater(fn); return handle() }
      function trashMessage(id, callback) {
        record.trashed = record.trashed.concat([String(id)])
        return later(function() { callback(null, "") })
      }
      function untrashMessage(id, callback) {
        record.untrashed = record.untrashed.concat([String(id)])
        return later(function() { callback(null, "") })
      }
      function batchModify(ids, add, remove, callback) {
        record.modified = record.modified.concat([{ ids: ids.slice().sort().join(","),
          add: add.join(","), remove: remove.join(",") }])
        return later(function() { callback(null, "") })
      }
      function modifyMessage(id, add, remove, callback) { return batchModify([id], add, remove, callback) }
      function listMessages() { return handle() }
      function getMessages() { return handle() }
      function getMessage() { return handle() }
      function getSummaries() { return handle() }
      function getLabels(callback) { return later(function() { callback([], "") }) }
      function getLabelCounts(id, callback) { return later(function() { callback({ id: id, unread: 0, total: 0, threadsUnread: 0 }, "") }) }
      function getProfile(callback) { return later(function() { callback({ email: email }, "") }) }
      function getSendAs(callback) { return later(function() { callback([], "") }) }
      function getAttachment() { return handle() }
      function saveDraft() { return handle() }
      function deleteDraft() { return handle() }
      function sendMessage() { return handle() }
      function createLabel() { return handle() }
      function renameLabel() { return handle() }
      function deleteLabel() { return handle() }
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
    name: "TrashRestore"
    when: windowShown

    function initTestCase() {
      // Every mailbox made here asks for its cached list. Unanswered, those
      // requests fill the backend's 64 slots and the actions under test wait
      // behind them.
      BackendFixture.install(mailService).answers = {"cache.queryRestore": null}
      NativeModel.install(mailService)
      NativeIntentFixture.install(mailService)
    }

    function entry(provider, email) {
      var value = { email: email, provider: provider, clientSecret: "", label: "", signature: "",
        clientId: provider === "outlook" ? "87654321-4321-4abc-9def-1234567890ab" : "" }
      if (provider === "imap") value.imap = { imapHost: "imap.example.com", imapPort: 993,
        smtpHost: "smtp.example.com", smtpPort: 465, username: email, aliases: [], insecure: false }
      if (provider === "jmap") value.jmap = { sessionUrl: "https://api.example.org/jmap/session",
        username: email, authScheme: "basic", accountId: "u1" }
      return value
    }

    // Ready an account the way each sign-in leaves it, with the recording client.
    function ready(account, provider) {
      account.clientOverride = controlledClient
      account.auth.toolsChecked = true
      account.auth.missingTools = []
      if (provider === "imap") {
        account.auth.passwordChecked = true
        account.auth.password = "test-password"
      } else if (provider === "jmap") {
        account.auth.secret = "app-password"
        account.auth.secretChecked = true
      } else if (provider === "gmail") {
        account.auth.credentials = ({ clientId: "123-test.apps.googleusercontent.com",
          clientSecret: "test", projectId: "test" })
        account.auth.refreshBusy = true
        account.auth.loggedIn = true
      } else {
        account.auth.loggedIn = true
      }
      tryCompare(account, "ready", true)
    }

    // Accounts on `mailboxKey`, holding `rows` each. A new address each time:
    // the native ledger is one process for the whole file, and an action a
    // replaced account left unsettled must not hold up the next one.
    property int seeded: 0
    function seedMany(providers, mailboxKey, rowsEach) {
      var list = Accounts.emptyList()
      var emails = []
      for (var i = 0; i < providers.length; i++) {
        seeded++
        emails.push("me" + seeded + "@example.com")
        list = Accounts.add(list, entry(providers[i], emails[i]))
      }
      mailService.setUnifiedMailboxes(false)
      mailService.activeIndex = -1
      mailService.accountList = list
      mailService.accountsLoaded = true
      wait(0)
      mailService.refreshCurrent()
      var accounts = []
      for (var h = 0; h < providers.length; h++) {
        var account = mailService.accountAt(h)
        verify(account !== null)
        ready(account, providers[h])
        // A host can outlive the account it held, so nothing a previous test
        // left on it is allowed to stand.
        account.searchQuery = ""
        account.rawQuery = ""
        account.rawLabelId = ""
        account.mailboxKey = mailboxKey
        account.messages = rowsEach[h]
        account.listLoaded = true
        accounts.push(account)
      }
      return accounts
    }

    function seed(provider, mailboxKey, rows) { return seedMany([provider], mailboxKey, [rows])[0] }

    // The same, merged: turning the merged view on moves every mailbox to the
    // merged view's mailbox, so the rows are put back after it has.
    function unified(providers, mailboxKey, rowsEach) {
      var accounts = seedMany(providers, mailboxKey, rowsEach)
      mailService.setUnifiedMailboxes(true)
      mailService.selectMailbox(mailboxKey)
      wait(0)
      for (var i = 0; i < accounts.length; i++) {
        accounts[i].mailboxKey = mailboxKey
        accounts[i].messages = rowsEach[i]
        accounts[i].listLoading = false
        accounts[i].listLoaded = true
      }
      tryVerify(function() { return mailService.messages.length === accounts.length })
      compare(mailService.mailboxKey, mailboxKey)
      return accounts
    }

    // A message with these labels, and the flags the summary derives from them.
    // A HEY posting in Trash has none: nothing in it says where it is.
    function message(id, labels) {
      var list = labels || []
      return ({ id: id, threadId: "", from: { email: "x@example.com", display: "X" }, subject: id,
        snippet: "", time: "", date: "", unread: false, starred: list.indexOf("STARRED") >= 0,
        inInbox: list.indexOf("INBOX") >= 0, inTrash: list.indexOf("TRASH") >= 0,
        inSpam: false, isSent: false, isDraft: false, labelIds: list })
    }

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

    // The archive or trash button under `item`, by the key its tooltip names
    // (`e`, `d`) rather than by a name the change gave it, so the same lookup
    // finds the button before the change and after.
    function slot(item, key) {
      return having(item, function(candidate) {
        return candidate.iconName !== undefined && candidate.visible
          && String(candidate.tooltipText || "").slice(-4) === " · " + key
      })
    }

    function reader() {
      var found = having(app, function(item) { return item.forceRichAnyway !== undefined })
      verify(found !== null)
      return found
    }

    // The row drawing `id`, found by the summary it was handed.
    function rowFor(id) {
      return having(app, function(item) {
        return item.summary !== undefined && item.trashRequested !== undefined
          && !!item.summary && item.summary.id === id
      })
    }

    // A popup's rows live under the overlay, not under the menu item, so they
    // are found in the list the menu's own cursor walks, by what they say.
    function menuRow(text) {
      var menu = named(app, "rowMenu")
      for (var i = 0; i < menu.menuRows.length; i++)
        if (menu.menuRows[i].visible && menu.menuRows[i].text === text) return menu.menuRows[i]
      return null
    }

    function ids(account) {
      return account.messages.map(function(message) { return message.id }).join(",")
    }

    function hintLabels() {
      var hints = named(app, "status-key-hints")
      verify(hints !== null)
      return hints.hints.map(function(hint) { return hint.key + " " + hint.label })
    }

    function tick(ids) {
      app.checkedAccountId = mailService.activeAccountId
      app.checkedIds = ids
      verify(app.selectionActive)
    }

    // The reader on `id`, in a window wide enough to keep the list beside it.
    function openReader(account, id, summary) {
      account.selectedId = id
      account.selectedMessage = summary
      app.pushEntry("reader", { id: id })
      wait(0)
      verify(!app.compact)
      verify(app.listOnScreen)
    }

    function init() {
      record.reset()
      app.checkedIds = []
      app.checkedAccountId = ""
      app.cursorId = ""
      app.resetNavigation()
      mailService.conversationProjection = ({ showsRail: false, stops: [], caption: "", navigation: {}, memberIds: [] })
      app.open()
    }

    function cleanup() {
      var menu = named(app, "rowMenu")
      if (menu) menu.close()
      app.close()
    }

    // ------------------------------------------------- Restore in the trash

    function test_hey_trash_row_button_restores() {
      var account = seed("hey", "trash", [message("1:2"), message("3:4")])
      compare(mailService.canArchive, false, "HEY has no archive")
      compare(mailService.canMoveToLabel, false, "and no move")
      var row = rowFor("1:2")
      verify(row !== null)
      app.cursorId = "1:2"
      tryCompare(row, "hot", true)
      var trash = slot(row, "d")
      verify(trash !== null && trash.visible)
      compare(trash.tooltipText, "Restore · d")
      compare(trash.iconName, "undo")
      trash.clicked()
      tryCompare(record, "untrashed", ["1:2"])
      compare(record.trashed, [], "a message in the trash is not trashed again")
      tryCompare(account, "actionPreparations", 0)
      compare(ids(account), "3:4", "the row leaves the Trash")
      tryCompare(mailService, "actionStatus", "Restored")
    }

    function test_hey_trash_key_restores() {
      var account = seed("hey", "trash", [message("1:2"), message("3:4")])
      app.cursorId = "1:2"
      app.runShortcut("trash", "d")
      tryCompare(record, "untrashed", ["1:2"])
      compare(record.trashed, [])
      tryCompare(account, "actionPreparations", 0)
      compare(ids(account), "3:4")
      compare(app.cursorId, "3:4", "the cursor takes the place of the row that left")
      verify(hintLabels().indexOf("d restore") >= 0, "the hint says what d does here: " + hintLabels())
    }

    function test_hey_selection_in_trash_restores_every_row() {
      var account = seed("hey", "trash", [message("1:2"), message("3:4"), message("5:6")])
      app.cursorId = "1:2"
      tick(["1:2", "5:6"])
      app.runShortcut("trash", "d")
      tryVerify(function() { return record.untrashed.length === 2 })
      compare(record.untrashed.slice().sort(), ["1:2", "5:6"])
      compare(record.trashed, [])
      tryCompare(account, "actionPreparations", 0)
      compare(ids(account), "3:4")
    }

    function test_hey_trash_menu_offers_restore_and_not_trash() {
      seed("hey", "trash", [message("1:2")])
      rowFor("1:2").menuRequested(100, 100)
      tryCompare(named(app, "rowMenu"), "opened", true)
      verify(menuRow("Move to trash") === null, "never Move to trash for a message in the trash")
      var restore = menuRow("Restore")
      verify(restore !== null)
      restore.activated()
      tryCompare(record, "untrashed", ["1:2"])
      compare(record.trashed, [])
    }

    function test_hey_reader_trash_button_restores() {
      var account = seed("hey", "trash", [message("1:2"), message("3:4")])
      app.cursorId = "1:2"
      openReader(account, "1:2", account.messages[0])
      var button = slot(reader(), "d")
      verify(button !== null)
      button.clicked()
      tryCompare(record, "untrashed", ["1:2"])
      compare(record.trashed, [])
      compare(button.tooltipText, "Restore · d")
    }

    // Untrash reaches each provider's client the same way.
    function test_trash_key_restores_on_every_provider_data() {
      return [
        { tag: "gmail", provider: "gmail", id: "g1" },
        { tag: "imap", provider: "imap", id: "1:Trash" },
        { tag: "outlook", provider: "outlook", id: "1:Deleted Items" },
        { tag: "jmap", provider: "jmap", id: "j1" }
      ]
    }

    function test_trash_key_restores_on_every_provider(data) {
      var account = seed(data.provider, "trash", [message(data.id, ["TRASH"]), message("other", ["TRASH"])])
      app.cursorId = data.id
      app.runShortcut("trash", "d")
      tryCompare(record, "untrashed", [data.id])
      compare(record.trashed, [])
      tryCompare(account, "actionPreparations", 0)
      compare(ids(account), "other")
    }

    // A merged Trash: each row goes to the mailbox that owns it, HEY's
    // unlabelled posting included.
    function test_unified_trash_restores_through_the_owning_mailbox() {
      var accounts = unified(["hey", "imap"], "trash", [[message("1:2")], [message("7:Trash", ["TRASH"])]])
      app.cursorId = Unified.unifiedId(accounts[0].accountId, "1:2")
      app.runShortcut("trash", "d")
      tryCompare(record, "untrashed", ["1:2"])
      compare(record.trashed, [])
      tryVerify(function() { return accounts[0].messages.length === 0 })
      compare(accounts[1].messages.length, 1, "the other mailbox's row stays")
      mailService.setUnifiedMailboxes(false)
    }

    // ----------------------------------------- where nothing should change

    // Outside the Trash `d` trashes, and a search started from the Trash
    // reaches the whole HEY account, so it is not the Trash.
    function test_hey_elsewhere_d_trashes() {
      var account = seed("hey", "inbox", [message("1:2", ["INBOX"])])
      app.cursorId = "1:2"
      app.runShortcut("trash", "d")
      tryCompare(record, "trashed", ["1:2"])
      compare(record.untrashed, [])
      verify(hintLabels().indexOf("d trash") >= 0)
      tryCompare(account, "actionPreparations", 0)

      record.reset()
      account.mailboxKey = "trash"
      account.searchQuery = "invoice"
      account.messages = [message("7:8", ["INBOX"])]
      app.cursorId = "7:8"
      app.runShortcut("trash", "d")
      tryCompare(record, "trashed", ["7:8"])
      compare(record.untrashed, [], "a search is not the Trash listing")
      account.searchQuery = ""
    }

    // `e` in the Inbox and in a folder of one's own still archives: on IMAP
    // every folder but the Inbox reads as archived, and that is worth keeping.
    function test_imap_e_archives_from_the_inbox_and_a_folder() {
      var account = seed("imap", "inbox", [message("1:INBOX", ["INBOX"])])
      app.cursorId = "1:INBOX"
      app.runShortcut("archive", "e")
      tryVerify(function() { return record.modified.length === 1 })
      compare(record.modified[0].remove, "INBOX")
      compare(record.modified[0].add, "")
      tryCompare(account, "actionPreparations", 0)

      record.reset()
      account.rawQuery = "folder:Receipts"
      account.messages = [message("3:Receipts")]
      app.cursorId = "3:Receipts"
      app.runShortcut("archive", "e")
      tryVerify(function() { return record.modified.length === 1 })
      compare(record.modified[0].ids, "3:Receipts")
      compare(record.modified[0].add, "", "a folder is not Archive: e archives")
      account.rawQuery = ""
    }

    // ------------------------------------------- Move to Inbox in Archive

    function test_imap_archive_row_button_moves_to_inbox() {
      var account = seed("imap", "archive", [message("1:Archive"), message("2:Archive")])
      var row = rowFor("1:Archive")
      verify(row !== null)
      app.cursorId = "1:Archive"
      tryCompare(row, "hot", true)
      var archive = slot(row, "e")
      verify(archive !== null && archive.visible)
      compare(archive.iconName, "inbox")
      compare(archive.tooltipText, "Move to Inbox · e")
      compare(slot(row, "d").tooltipText, "Move to trash · d", "the trash button is unchanged in Archive")
      archive.clicked()
      tryVerify(function() { return record.modified.length === 1 })
      compare(record.modified[0].ids, "1:Archive")
      compare(record.modified[0].add, "INBOX", "the existing unarchive: INBOX added")
      tryCompare(account, "actionPreparations", 0)
      compare(ids(account), "2:Archive", "on a folder provider the row leaves Archive")
    }

    function test_imap_archive_key_moves_to_inbox() {
      seed("imap", "archive", [message("1:Archive"), message("2:Archive")])
      app.cursorId = "1:Archive"
      app.runShortcut("archive", "e")
      tryVerify(function() { return record.modified.length === 1 })
      compare(record.modified[0].add, "INBOX")
      compare(record.modified[0].remove, "")
      verify(hintLabels().indexOf("e move to inbox") >= 0, "the hint says what e does here: " + hintLabels())
    }

    function test_imap_archive_reader_button_moves_to_inbox() {
      var account = seed("imap", "archive", [message("1:Archive"), message("2:Archive")])
      app.cursorId = "1:Archive"
      openReader(account, "1:Archive", account.messages[0])
      var archive = slot(reader(), "e")
      verify(archive !== null && archive.visible)
      archive.clicked()
      tryVerify(function() { return record.modified.length === 1 })
      compare(record.modified[0].ids, "1:Archive")
      compare(record.modified[0].add, "INBOX")
      compare(archive.tooltipText, "Move to Inbox · e")
    }

    function test_unified_archive_moves_to_inbox_through_the_owning_mailbox() {
      var accounts = unified(["imap", "imap"], "archive", [[message("1:Archive")], [message("1:Archive")]])
      app.cursorId = Unified.unifiedId(accounts[1].accountId, "1:Archive")
      app.runShortcut("archive", "e")
      tryVerify(function() { return record.modified.length === 1 })
      compare(record.modified[0].ids, "1:Archive")
      compare(record.modified[0].add, "INBOX")
      tryVerify(function() { return accounts[1].messages.length === 0 })
      compare(accounts[0].messages.length, 1, "the other mailbox's row stays")
      mailService.setUnifiedMailboxes(false)
    }

    // --------------------------------------- the rows the action reaches

    // Gmail's `in:anywhere` lists a message in the trash beside one in the
    // Inbox. With both ticked, every control that reaches the selection
    // trashes both, and says so: Restore would take a message that is not in
    // the trash "out" of it.
    function mixedGmailSelection() {
      var account = seed("gmail", "inbox", [message("t1", ["TRASH"]), message("i1", ["INBOX"])])
      account.searchQuery = "in:anywhere invoice"
      app.cursorId = "t1"
      tick(["t1", "i1"])
      return account
    }

    function test_reader_on_a_ticked_message_trashes_a_mixed_selection() {
      var account = mixedGmailSelection()
      openReader(account, "t1", account.messages[0])
      var button = slot(reader(), "d")
      verify(button !== null)
      button.clicked()
      tryVerify(function() { return record.trashed.length === 2 })
      compare(record.untrashed, [])
      compare(button.tooltipText, "Move to trash · d", "the reader's verb is the selection's")
      account.searchQuery = ""
    }

    function test_reader_on_a_ticked_message_restores_a_trashed_selection() {
      var account = seed("gmail", "trash", [message("t1", ["TRASH"]), message("t2", ["TRASH"]), message("t3", ["TRASH"])])
      app.cursorId = "t1"
      tick(["t1", "t2"])
      openReader(account, "t1", account.messages[0])
      var button = slot(reader(), "d")
      compare(button.tooltipText, "Restore · d")
      button.clicked()
      tryVerify(function() { return record.untrashed.length === 2 })
      compare(record.untrashed.slice().sort(), ["t1", "t2"])
      compare(record.trashed, [])
    }

    function test_menu_on_a_ticked_row_trashes_a_mixed_selection() {
      var account = mixedGmailSelection()
      rowFor("t1").menuRequested(100, 100)
      tryCompare(named(app, "rowMenu"), "opened", true)
      verify(menuRow("Restore") === null, "not every row it reaches is in the trash")
      var trash = menuRow("Move to trash")
      verify(trash !== null)
      trash.activated()
      tryVerify(function() { return record.trashed.length === 2 })
      compare(record.untrashed, [])
      account.searchQuery = ""
    }

    function test_d_trashes_a_mixed_selection() {
      var account = mixedGmailSelection()
      verify(hintLabels().indexOf("d trash") >= 0, "the hint names trash: " + hintLabels())
      app.runShortcut("trash", "d")
      tryVerify(function() { return record.trashed.length === 2 })
      compare(record.untrashed, [])
      account.searchQuery = ""
    }

    // A menu on a ticked row stars or unstars the whole selection, and says
    // which: Unstar only when every ticked row is starred.
    function test_menu_on_a_ticked_row_names_the_selections_star() {
      seed("gmail", "inbox", [message("s1", ["INBOX", "STARRED"]), message("s2", ["INBOX"])])
      app.cursorId = "s1"
      tick(["s1", "s2"])
      rowFor("s1").menuRequested(100, 100)
      tryCompare(named(app, "rowMenu"), "opened", true)
      verify(menuRow("Unstar") === null, "one of them is not starred")
      var star = menuRow("Star")
      verify(star !== null)
      star.activated()
      tryVerify(function() { return record.modified.length === 1 })
      compare(record.modified[0].ids, "s1,s2")
      compare(record.modified[0].add, "STARRED")
    }

    // JMAP lets a message be in the Inbox and Archive at once. Middle-click is
    // the archive button, and on a ticked row it means the selection.
    function test_middle_click_on_a_ticked_row_archives_a_mixed_selection() {
      seed("jmap", "archive", [message("a1"), message("a2", ["INBOX"])])
      app.cursorId = "a1"
      tick(["a1", "a2"])
      rowFor("a1").archiveRequested()
      tryVerify(function() { return record.modified.length === 1 })
      compare(record.modified[0].ids, "a1,a2")
      compare(record.modified[0].remove, "INBOX", "archived, not moved to the Inbox")
      compare(record.modified[0].add, "")
    }

    // A conversation listed in Archive, with `n` on a member that is in the
    // Inbox: `e` and the reader's button both act on the conversation's row,
    // so both move it to the Inbox, and the button says so.
    function test_reader_on_a_conversation_member_follows_the_row() {
      var row = message("m1")
      row.thread = { id: "c", count: 2, unread: false, flagged: false, memberIds: ["m1", "m2"] }
      var account = seed("jmap", "archive", [row])
      app.cursorId = "m1"
      openReader(account, "m2", message("m2", ["INBOX"]))
      // The rail as the backend projects it, once the projection asked for on
      // opening has landed.
      wait(100)
      mailService.conversationProjection = ({ showsRail: true, stops: [], caption: "",
        navigation: {}, memberIds: ["m1", "m2"] })
      wait(50)
      compare(mailService.conversationProjection.memberIds, ["m1", "m2"])
      var button = slot(reader(), "e")
      verify(button !== null && button.visible)
      compare(button.tooltipText, "Move to Inbox · e", "the button says what e does")
      button.clicked()
      tryVerify(function() { return record.modified.length === 1 })
      compare(record.modified[0].ids, "m1,m2", "the row's action reaches every member")
      compare(record.modified[0].add, "INBOX")
    }

    // With rows ticked, `d` reaches them, while the reader's buttons reach the
    // open message when it is not one of them. The button then names no key:
    // here `d` restores the ticked rows and the button trashes the open one.
    function test_reader_names_no_key_that_reaches_other_rows() {
      var account = seed("gmail", "inbox", [message("t1", ["TRASH"]), message("t2", ["TRASH"]), message("i1", ["INBOX"])])
      account.searchQuery = "in:anywhere invoice"
      app.cursorId = "i1"
      tick(["t1", "t2"])
      openReader(account, "i1", account.messages[2])
      var button = having(reader(), function(item) {
        return item.iconName !== undefined && item.visible && item.tooltipText === "Move to trash"
      })
      verify(button !== null, "the reader's trash button names no key")
      app.runShortcut("trash", "d")
      tryVerify(function() { return record.untrashed.length === 2 })
      compare(record.untrashed.slice().sort(), ["t1", "t2"], "d restores the ticked rows")
      compare(record.trashed, [])
      tryCompare(account, "actionPreparations", 0)
      record.reset()
      account.selectedId = "i1"
      account.selectedMessage = message("i1", ["INBOX"])
      button.clicked()
      tryCompare(record, "trashed", ["i1"])
      compare(record.untrashed, [])
      account.searchQuery = ""
    }

    // In a narrow window the reader replaces the list and the ticks are not
    // on screen, so App acts on the open message alone. The list must decide
    // with App's answer, not its own reading of the ticks: `d` and the
    // reader's button here act on the open message whatever is ticked.
    function compactReader(account, id, summary) {
      var window = having(app, function(item) { return item.title === "Omamail" })
      verify(window !== null)
      window.width = 600
      app.pushEntry("reader", { id: id })
      account.selectedId = id
      account.selectedMessage = summary
      wait(0)
      verify(app.compact)
      verify(!app.selectionActive, "the ticks are not on screen")
      return window
    }

    function test_compact_reader_d_acts_on_the_open_message() {
      var account = seed("gmail", "inbox", [message("t1", ["TRASH"]), message("t2", ["TRASH"]), message("i1", ["INBOX"])])
      account.searchQuery = "in:anywhere invoice"
      app.cursorId = "i1"
      app.checkedAccountId = mailService.activeAccountId
      app.checkedIds = ["t1", "t2"]
      var window = compactReader(account, "i1", account.messages[2])
      app.runShortcut("trash", "d")
      tryCompare(record, "trashed", ["i1"])
      compare(record.untrashed, [], "the ticked rows are not what d reaches here")
      window.width = 980
      account.searchQuery = ""
    }

    function test_compact_reader_button_acts_on_the_open_message() {
      var account = seed("gmail", "inbox", [message("t1", ["TRASH"]), message("i1", ["INBOX"])])
      account.searchQuery = "in:anywhere invoice"
      app.cursorId = "t1"
      app.checkedAccountId = mailService.activeAccountId
      app.checkedIds = ["t1", "i1"]
      var window = compactReader(account, "t1", account.messages[0])
      var button = slot(reader(), "d")
      verify(button !== null)
      compare(button.tooltipText, "Restore · d", "the open message alone is in the trash")
      button.clicked()
      tryCompare(record, "untrashed", ["t1"])
      compare(record.trashed, [])
      window.width = 980
      account.searchQuery = ""
    }

    // A message a notification opened over the Trash is not one of its rows,
    // so the listing says nothing about it: an Inbox message there is moved
    // to the trash, and the reader's button and `d` both say and do that.
    function test_a_message_opened_from_outside_the_trash_listing_is_trashed() {
      var account = seed("gmail", "trash", [message("t1", ["TRASH"])])
      var outside = message("n1", ["INBOX"])
      account.previewMessages = [outside]
      app.cursorId = "n1"
      openReader(account, "n1", outside)
      var button = slot(reader(), "d")
      verify(button !== null, "the button names d, which reaches the same message")
      compare(button.tooltipText, "Move to trash · d")
      app.runShortcut("trash", "d")
      tryCompare(record, "trashed", ["n1"])
      compare(record.untrashed, [])
      tryCompare(account, "actionPreparations", 0)
      record.reset()
      account.previewMessages = [outside]
      account.selectedId = "n1"
      account.selectedMessage = outside
      app.cursorId = "n1"
      button.clicked()
      tryCompare(record, "trashed", ["n1"])
      compare(record.untrashed, [])
    }

    // Hovering does not move the cursor, so a row names `d` only when `d`
    // reaches it: hovering a trashed row beside an Inbox cursor shows Restore
    // without the key, while `d` trashes the cursor's row.
    function test_a_row_names_d_only_when_d_reaches_it() {
      var account = mixedGmailSelection()
      app.checkedIds = []
      app.cursorId = "i1"
      var trashed = rowFor("t1")
      var restore = having(trashed, function(item) { return item.iconName === "undo" })
      verify(restore !== null)
      compare(restore.tooltipText, "Restore", "d does not reach a row the pointer is only resting on")
      compare(slot(rowFor("i1"), "d").tooltipText, "Move to trash · d")
      app.runShortcut("trash", "d")
      tryCompare(record, "trashed", ["i1"])
      compare(record.untrashed, [])
      account.searchQuery = ""
    }

    // A reload that takes the open message's row away moves the cursor to
    // another row: `d` now reaches that row, so the reader's button, which
    // still means the open message, names no key.
    function test_reader_names_no_key_once_the_cursor_moved_off_its_row() {
      var account = seed("gmail", "inbox", [message("r1", ["INBOX"]), message("r2", ["INBOX"])])
      app.cursorId = "r1"
      openReader(account, "r1", account.messages[0])
      compare(slot(reader(), "d").tooltipText, "Move to trash · d")
      account.messages = [message("r2", ["INBOX"])]
      app.cursorId = "r2"
      wait(0)
      var button = having(reader(), function(item) {
        return item.iconName === "trash" && item.visible
      })
      verify(button !== null)
      compare(button.tooltipText, "Move to trash", "d reaches r2 now, the button r1")
      app.runShortcut("trash", "d")
      tryCompare(record, "trashed", ["r2"])
    }

    // The empty reader lists the keys that do something here, and `e` and `d`
    // are listed as what they will do: Restore in the trash, Move to Inbox in
    // Archive, no `e` at all where there is no archive.
    function blankSlateLines() {
      var slate = having(app, function(item) { return item.keys !== undefined && item.showLegend !== undefined })
      verify(slate !== null)
      return slate.keys.map(function(line) { return line.key + " " + line.action })
    }

    function test_empty_reader_lists_what_e_and_d_do_here() {
      seed("hey", "trash", [message("1:2"), message("3:4")])
      var lines = blankSlateLines()
      verify(lines.indexOf("d Restore") >= 0, "in the trash: " + lines)
      verify(lines.indexOf("d Move to trash") < 0)
      verify(lines.indexOf("e Archive") < 0, "HEY has no archive: " + lines)
      verify(hintLabels().indexOf("d restore") >= 0, "the hint row agrees: " + hintLabels())

      seed("imap", "archive", [message("1:Archive"), message("2:Archive")])
      lines = blankSlateLines()
      verify(lines.indexOf("e Move to Inbox") >= 0, "in Archive: " + lines)
      verify(lines.indexOf("d Move to trash") >= 0)

      seed("imap", "inbox", [message("1:INBOX", ["INBOX"])])
      lines = blankSlateLines()
      verify(lines.indexOf("e Archive") >= 0, "in the Inbox: " + lines)
      verify(lines.indexOf("d Move to trash") >= 0)
    }
  }
}
