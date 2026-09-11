import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "../../account/Accounts.js" as Accounts

// The batch's two boundaries, driven against a client the test controls.
//
// Ownership: an IMAP id is a UID and a folder, unique only inside one
// account, so ticks made in one mailbox must never be dispatched through
// another — however the switch reached the service. Reconciliation: one
// request per message answers per message, so a refusal on one row must
// put back that row and no other, and a whole-batch refusal must read the
// list again rather than restore rows the server may have changed.
Item {
  width: 900
  height: 600

  QtObject {
    id: shellStore
    function updateEntryInline(_id, _entry) {}
    function hide(_id) {}
  }

  // Every call the account makes, recorded by the account's address. Trash
  // and untrash answer per id, one refused; batchModify answers as a whole.
  QtObject {
    id: record
    property var trashed: []
    property var untrashed: []
    property var batches: []
    property int lists: 0
    property string refuse: ""
    property bool refuseBatch: false
    function reset() { trashed = []; untrashed = []; batches = []; lists = 0; refuse = ""; refuseBatch = false }
  }

  Component {
    id: controlledClient
    QtObject {
      property var auth: null
      property string email: ""
      function handle() { return ({ aborted: false }) }
      function later(fn) { Qt.callLater(fn); return handle() }
      function trashMessage(id, callback) {
        var mine = record.trashed.slice(); mine.push(String(id)); record.trashed = mine
        var refused = String(id) === record.refuse
        return later(function() { callback(null, refused ? "the server refused this one" : "") })
      }
      function untrashMessage(id, callback) {
        var mine = record.untrashed.slice(); mine.push(String(id)); record.untrashed = mine
        var refused = String(id) === record.refuse
        return later(function() { callback(null, refused ? "the server refused this one" : "") })
      }
      function batchModify(ids, add, remove, callback) {
        var mine = record.batches.slice(); mine.push(ids.join(",")); record.batches = mine
        var refused = record.refuseBatch
        return later(function() { callback(null, refused ? "the batch was refused" : "") })
      }
      function modifyMessage(id, add, remove, callback) { return batchModify([id], add, remove, callback) }
      function listMessages() { record.lists = record.lists + 1; return handle() }
      function getMessages() { return handle() }
      function getMessage() { return handle() }
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
    name: "BatchActions"
    when: windowShown

    readonly property string ada: "ada@example.com"
    readonly property string bob: "bob@example.com"

    function entry(email) {
      return {
        email: email, provider: "imap", clientId: "", clientSecret: "",
        imap: { imapHost: "imap.example.com", imapPort: 993, smtpHost: "smtp.example.com", smtpPort: 465,
          username: email, aliases: [], insecure: false },
        label: "", signature: ""
      }
    }

    function row(id) {
      return ({ id: id, threadId: "", from: { email: "x@example.com", display: "X" }, subject: id,
        snippet: "", time: "", date: "", unread: false, starred: false, inInbox: true, labelIds: ["INBOX"] })
    }

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
        account.listLoaded = true
      }
    }

    function init() {
      record.reset()
      app.checkedIds = []
      app.checkedAccountId = ""
      app.resetNavigation()
    }

    function having(item, accept) {
      if (accept(item)) return item
      var children = item.children || []
      for (var i = 0; i < children.length; i++) {
        var found = having(children[i], accept)
        if (found) return found
      }
      return null
    }

    function test_pane_widths_leave_room_for_the_reader_data() {
      return [
        { tag: "sidebar-first", sidebarFirst: true, collapsed: false },
        { tag: "list-first", sidebarFirst: false, collapsed: false },
        { tag: "collapsed-sidebar", sidebarFirst: true, collapsed: true }
      ]
    }

    function test_pane_widths_leave_room_for_the_reader(data) {
      seed([entry(ada)], "imap:" + ada)
      var account = mailService.accountAt(0)
      account.messages = [row("1:INBOX")]
      account.selectedId = "1:INBOX"
      account.selectedMessage = account.messages[0]
      app.open()
      app.pushEntry("reader", { id: account.selectedId })
      var window = having(app, function(item) { return item.title === "Omamail" })
      var reader = having(app, function(item) { return item.forceRichAnyway !== undefined })
      verify(window !== null && reader !== null)
      window.width = 980
      mailService.setSidebarCollapsed(data.collapsed)
      app.sidebarWidth = 0
      app.listWidth = 0
      if (data.sidebarFirst) {
        app.sidebarWidth = 360
        wait(0)
        app.listWidth = 4000
      } else {
        app.listWidth = 4000
        wait(0)
        app.sidebarWidth = 360
      }
      wait(0)
      verify(reader.width >= 200, "wide reader remains usable: " + reader.width)
      app.persistPaneWidths()
      app.close()
      app.open()
      app.pushEntry("reader", { id: account.selectedId })
      compare(app.listWidth, 4000, "clamping does not overwrite the saved preference")
      for (var i = 0; i < 4; i++) {
        window.width = [760, 759, 980, 1400][i]
        wait(0)
        verify(reader.width >= 200, "reader survives resize to " + window.width + ": " + reader.width)
      }
      app.close()
      window.width = 980
      mailService.setSidebarCollapsed(false)
      app.sidebarWidth = 0
      app.listWidth = 0
      app.persistPaneWidths()
    }

    function test_reader_star_uses_the_visible_selection_data() {
      return [
        { tag: "checked-open-message", checked: true, outside: false, compact: false, starred: false, expected: "1:INBOX,2:INBOX" },
        { tag: "unstar-checked-messages", checked: true, outside: false, compact: false, starred: true, expected: "1:INBOX,2:INBOX" },
        { tag: "open-message-outside-selection", checked: true, outside: true, compact: false, starred: false, expected: "3:INBOX" },
        { tag: "compact-reader-hides-selection", checked: true, outside: false, compact: true, starred: false, expected: "1:INBOX" },
        { tag: "no-selection", checked: false, outside: false, compact: false, starred: false, expected: "1:INBOX" }
      ]
    }

    function test_selection_toggles_and_shift_clears_a_range() {
      seed([entry(ada)], "imap:" + ada)
      var account = mailService.accountAt(0)
      account.messages = [row("1:INBOX"), row("2:INBOX"), row("3:INBOX")]
      app.open()
      app.cursorId = "1:INBOX"
      app.runShortcut("toggleCheck", "Space")
      compare(app.checkedIds.join(","), "1:INBOX")
      app.runShortcut("toggleCheck", "Space")
      compare(app.checkedIds.length, 0)
      app.checkRange("3:INBOX")
      compare(app.checkedIds.join(","), "1:INBOX,2:INBOX,3:INBOX")
      app.checkRange("1:INBOX")
      compare(app.checkedIds.length, 0)
      app.close()
    }

    function test_ctrl_click_toggles_without_opening_data() {
      return [{ tag: "list", reading: false }, { tag: "reader", reading: true }]
    }

    function test_ctrl_temporarily_replaces_actions_with_checkboxes() {
      seed([entry(ada)], "imap:" + ada)
      var account = mailService.accountAt(0)
      account.messages = [row("1:INBOX")]
      app.open()
      app.cursorId = "1:INBOX"
      var keyboard = having(app, function(item) { return item.ctrlDown !== undefined })
      verify(keyboard !== null)
      keyboard.parkKeyboard()
      wait(20)
      var target = having(app, function(item) {
        return item.summary && item.summary.id === "1:INBOX"
          && item.checkToggled !== undefined
      })
      verify(target !== null)
      var check = findChild(target, "message-check")
      var star = having(target, function(item) { return item.iconName === "star" })
      verify(check !== null && star !== null)
      compare(check.visible, false)
      compare(star.visible, true)
      keyPress(Qt.Key_Control)
      tryCompare(check, "visible", true)
      compare(star.visible, false)
      keyRelease(Qt.Key_Control)
      tryCompare(check, "visible", false)
      compare(star.visible, true)
      mouseClick(target, 32, target.height / 2, Qt.LeftButton, Qt.ControlModifier)
      compare(check.visible, true, "selection mode survives releasing Ctrl")
      compare(star.visible, false)
      mouseClick(check, check.width / 2, check.height / 2)
      compare(check.visible, false, "clearing the last check restores actions")
      compare(star.visible, true)
      app.close()
    }

    function test_ctrl_click_toggles_without_opening(data) {
      seed([entry(ada)], "imap:" + ada)
      var account = mailService.accountAt(0)
      account.messages = [row("1:INBOX"), row("2:INBOX")]
      app.open()
      if (data.reading) {
        account.selectedId = "1:INBOX"
        app.pushEntry("reader", { id: account.selectedId })
      }
      app.toggleCheck("1:INBOX")
      wait(0)
      var target = having(app, function(item) {
        return item.summary && item.summary.id === "2:INBOX"
          && item.checkToggled !== undefined
      })
      verify(target !== null)
      var opened = account.selectedId
      var view = app.currentView
      mouseClick(target, 32, target.height / 2, Qt.LeftButton, Qt.ControlModifier)
      compare(app.checkedIds.join(","), "1:INBOX,2:INBOX")
      compare(account.selectedId, opened)
      compare(app.currentView, view)
      mouseClick(target, 32, target.height / 2, Qt.LeftButton, Qt.ControlModifier)
      compare(app.checkedIds.join(","), "1:INBOX")
      compare(account.selectedId, opened)
      compare(app.currentView, view)
      app.close()
    }

    function test_reader_star_uses_the_visible_selection(data) {
      seed([entry(ada)], "imap:" + ada)
      var account = mailService.accountAt(0)
      var messages = [row("1:INBOX"), row("2:INBOX"), row("3:INBOX")]
      for (var i = 0; i < messages.length; i++) messages[i].starred = data.starred
      account.messages = messages
      account.selectedId = data.outside ? "3:INBOX" : "1:INBOX"
      account.selectedMessage = messages[data.outside ? 2 : 0]
      app.open()
      var window = having(app, function(item) { return item.title === "Omamail" })
      verify(window !== null)
      window.width = data.compact ? 600 : 980
      app.pushEntry("reader", { id: account.selectedId })
      if (data.checked) {
        verify(app.toggleCheck("1:INBOX"))
        verify(app.toggleCheck("2:INBOX"))
      }
      compare(app.selectionActive, data.checked && !data.compact)
      var cursorBefore = app.cursorId
      var reader = having(app, function(item) { return item.forceRichAnyway !== undefined })
      verify(reader !== null)
      var star = having(reader, function(item) { return item.iconName === "star" })
      verify(star !== null)
      wait(0)
      mouseClick(star, star.width / 2, star.height / 2)
      tryCompare(record, "batches", [data.expected])
      compare(app.cursorId, cursorBefore, "starring does not move the list cursor")
      var acted = data.expected.split(",")
      for (var j = 0; j < messages.length; j++) {
        var changed = acted.indexOf(messages[j].id) >= 0
        compare(account.messages[j].starred, changed ? !data.starred : data.starred)
      }
      app.close()
      window.width = 980
    }

    // Ada and Bob both hold 42:INBOX. Ticked in Ada's list, the id must not
    // become a trash request through Bob's client, whether the switch came
    // through the window or straight to the service.
    function test_ticks_do_not_cross_an_account_switch() {
      seed([entry(ada), entry(bob)], "imap:" + ada)
      mailService.accountAt(0).messages = [row("42:INBOX"), row("43:INBOX")]
      mailService.accountAt(1).messages = [row("42:INBOX")]
      app.cursorId = "42:INBOX"
      verify(app.toggleCheck("42:INBOX"))
      compare(app.checkedIds.length, 1)

      verify(app.switchAccount(1))
      compare(mailService.activeAccountId, "imap:" + bob)
      compare(app.checkedIds.length, 0, "the switch dropped the ticks")
      compare(app.cursorId, "", "and the cursor, which is an id of Ada's too")
      app.runShortcut("trash", "d")
      wait(30)
      compare(record.trashed.length, 0, "nothing was trashed through Bob")

      // And a switch the window did not make.
      verify(mailService.switchToIndex(0))
      app.cursorId = "42:INBOX"
      verify(app.toggleCheck("42:INBOX"))
      verify(mailService.switchToIndex(1))
      wait(30)
      compare(app.checkedIds.length, 0, "a switch at the service drops them too")
      app.checkedIds = ["42:INBOX"]
      app.checkedAccountId = "imap:" + ada
      compare(app.actOnChecked("trash"), false, "ticks owned by another mailbox build no batch")
      compare(record.trashed.length, 0)
    }

    // One request per message: the refused row comes back where it was; the
    // accepted one stays gone; the note says which.
    function test_a_partly_refused_trash_restores_only_the_refused_rows() {
      seed([entry(ada)], "imap:" + ada)
      var account = mailService.accountAt(0)
      account.messages = [row("1:INBOX"), row("2:INBOX"), row("3:INBOX")]
      record.refuse = "2:INBOX"
      app.cursorId = "1:INBOX"
      verify(app.toggleCheck("1:INBOX"))
      verify(app.toggleCheck("2:INBOX"))
      app.runShortcut("trash", "d")
      compare(account.messages.length, 1, "both rows left optimistically")
      tryCompare(record, "trashed", ["1:INBOX", "2:INBOX"])
      tryVerify(function() { return account.messages.length === 2 }, 1000)
      compare(account.messages.map(function(m) { return m.id }), ["2:INBOX", "3:INBOX"],
        "the refused row is back in its place; the accepted one is gone")
      verify(account.lastError.indexOf("1 of 2") >= 0, "the note counts the refusal: " + account.lastError)
    }

    // The refused row is back, but the accepted one is gone, so the page
    // token the optimistic update cleared cannot simply come back: the page
    // is read again from the server, which is what makes older mail
    // reachable after a partial refusal.
    function test_a_partly_refused_trash_reads_the_page_again() {
      seed([entry(ada)], "imap:" + ada)
      var account = mailService.accountAt(0)
      account.messages = [row("1:INBOX"), row("2:INBOX"), row("3:INBOX")]
      account.nextPageToken = "older-page"
      record.refuse = "2:INBOX"
      app.cursorId = "1:INBOX"
      verify(app.toggleCheck("1:INBOX"))
      verify(app.toggleCheck("2:INBOX"))
      var listsBefore = record.lists
      app.runShortcut("trash", "d")
      compare(account.hasMore, false, "the optimistic page has no token")
      tryCompare(record, "trashed", ["1:INBOX", "2:INBOX"])
      tryVerify(function() { return account.messages.length === 2 }, 1000)
      tryVerify(function() { return record.lists > listsBefore }, 1000)
      compare(account.messages.map(function(m) { return m.id }), ["2:INBOX", "3:INBOX"],
        "the restored rows stay on screen while the server answers")
      verify(account.listLoading, "the page is being read again")
      verify(account.lastError.indexOf("1 of 2") >= 0, "the note is up while the page is read: " + account.lastError)
    }

    // A refresh asked for while the batch is in flight waits for it, and
    // runs once the refused rows are back rather than being forgotten —
    // the partial refusal, which has its own completion path, included.
    function test_a_refresh_waiting_on_a_partly_refused_batch_runs_after_it() {
      seed([entry(ada)], "imap:" + ada)
      var account = mailService.accountAt(0)
      account.messages = [row("1:INBOX"), row("2:INBOX"), row("3:INBOX")]
      record.refuse = "2:INBOX"
      app.cursorId = "1:INBOX"
      verify(app.toggleCheck("1:INBOX"))
      verify(app.toggleCheck("2:INBOX"))
      var listsBefore = record.lists
      app.runShortcut("trash", "d")
      compare(account.pendingAction, "trash")
      account.loadMessages(false, true, "")
      compare(record.lists, listsBefore, "the refresh waits on the action")
      verify(account.deferredListLoad !== null, "and is remembered")
      tryCompare(record, "trashed", ["1:INBOX", "2:INBOX"])
      tryVerify(function() { return account.pendingAction === "" }, 1000)
      tryVerify(function() { return record.lists > listsBefore }, 1000)
      compare(account.deferredListLoad, null, "the waiting refresh ran")
      compare(account.messages.map(function(m) { return m.id }), ["2:INBOX", "3:INBOX"],
        "with the refused row back and the accepted one gone")
      verify(account.lastError.indexOf("1 of 2") >= 0, account.lastError)
    }

    // The same, for a batch that finishes as a whole: the refresh waits and runs.
    function test_a_refresh_waiting_on_a_batch_runs_after_it() {
      seed([entry(ada)], "imap:" + ada)
      var account = mailService.accountAt(0)
      account.messages = [row("1:INBOX"), row("2:INBOX")]
      app.cursorId = "1:INBOX"
      verify(app.toggleCheck("1:INBOX"))
      verify(app.toggleCheck("2:INBOX"))
      var listsBefore = record.lists
      app.runShortcut("markRead", "I")
      compare(account.pendingAction, "markRead")
      account.loadMessages(false, true, "")
      compare(record.lists, listsBefore, "the refresh waits on the action")
      tryVerify(function() { return account.pendingAction === "" }, 1000)
      tryVerify(function() { return record.lists > listsBefore }, 1000)
      compare(account.deferredListLoad, null, "the waiting refresh ran")
    }

    // A whole-batch refusal from a client that answers with one word is not
    // proof that nothing changed: the list is read again from the server.
    function test_a_refused_batch_reads_the_list_again() {
      seed([entry(ada)], "imap:" + ada)
      var account = mailService.accountAt(0)
      account.messages = [row("1:INBOX"), row("2:INBOX")]
      record.refuseBatch = true
      app.cursorId = "1:INBOX"
      verify(app.toggleCheck("1:INBOX"))
      verify(app.toggleCheck("2:INBOX"))
      var listsBefore = record.lists
      app.runShortcut("archive", "e")
      tryCompare(record, "batches", ["1:INBOX,2:INBOX"])
      tryVerify(function() { return record.lists > listsBefore }, 1000)
    }
  }
}
