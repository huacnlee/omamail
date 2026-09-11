import QtQuick 2.15
import QtTest 1.3
import "../.." as Omamail
import "BackendFixture.js" as BackendFixture
import "NativeIntentFixture.js" as NativeIntentFixture
import "../../account/Accounts.js" as Accounts

// Moving a message to a label — archived under it on Gmail, into the folder
// on IMAP — is reached three ways that all open the same picker: `v`, the
// reader's button, and the row menu. The picker draws the labels as the
// rail does, a child under its parent, and narrows to typed letters.
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
    property var modified: []
    property var labels: []
    function reset() { modified = [] }
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
      function trashMessage(id, callback) { return later(function() { callback(null, "") }) }
      function untrashMessage(id, callback) { return later(function() { callback(null, "") }) }
      function modifyMessage(id, add, remove, callback) { return batchModify([id], add, remove, callback) }
      function batchModify(ids, add, remove, callback) {
        record.modified = record.modified.concat([ids.join(",") + " +" + (add || []).join(",") + " -" + (remove || []).join(",")])
        return later(function() { callback(null, "") })
      }
      function getLabels(callback) { return later(function() { callback(record.labels, "") }) }
      function getLabelCounts(id, callback) { return later(function() { callback({ id: id, unread: 0, total: 0 }, "") }) }
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
    name: "MoveToLabel"
    when: windowShown

    function initTestCase() { BackendFixture.markReady(mailService); NativeIntentFixture.install(mailService) }

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
    function folder(id) { return ({ id: id, name: id, rawName: id, delimiter: "/", unread: 0, system: false }) }
    function named(item, name) {
      if (item.objectName === name) return item
      var kids = item.children || []
      for (var i = 0; i < kids.length; i++) { var f = named(kids[i], name); if (f) return f }
      return null
    }

    function seed() {
      var list = Accounts.emptyList()
      list = Accounts.add(list, entry("ada@example.com"))
      list = Accounts.setActive(list, "imap:ada@example.com")
      mailService.activeIndex = -1
      mailService.accountList = list
      mailService.accountsLoaded = true
      wait(0)
      mailService.refreshCurrent()
      var account = mailService.accountAt(0)
      account.clientOverride = controlledClient
      account.auth.toolsChecked = true
      account.auth.missingTools = []
      account.auth.passwordChecked = true
      account.auth.password = "test-password"
      tryCompare(account, "ready", true)
      account.listLoaded = true
      account.labels = [folder("Work/2026"), folder("Receipts"), folder("Work")]
      record.labels = account.labels
      account.messages = [row("1:INBOX"), row("2:INBOX")]
      return account
    }

    function init() { record.reset(); app.checkedIds = []; app.resetNavigation() }

    function test_v_opens_the_tree_and_typing_narrows_it() {
      seed()
      var picker = named(app, "label-picker")
      verify(picker !== null)
      app.cursorId = "1:INBOX"
      app.runShortcut("moveToLabel", "v")
      tryCompare(picker, "opened", true)
      compare(picker.matchingLabels.map(function(l) { return l.id + "@" + l.depth }), ["Receipts@0", "Work@0", "Work/2026@1"],
        "the tree, a child stepped in under its parent")
      keyClick(Qt.Key_2); keyClick(Qt.Key_0); keyClick(Qt.Key_2); keyClick(Qt.Key_6)
      compare(picker.matchingLabels.length, 1)
      keyClick(Qt.Key_Return)
      tryCompare(picker, "opened", false)
      tryVerify(function() { return record.modified.length === 1 }, 1000)
      verify(record.modified[0].indexOf("1:INBOX") === 0, record.modified[0])
      verify(record.modified[0].indexOf("+Work/2026") > 0, "moved under the label chosen: " + record.modified[0])
    }

    // Opened from a row menu on a message outside the ticks, the move is
    // that message's alone, the way Archive there is; from the keyboard,
    // the ticks win.
    function test_a_menu_on_an_unticked_row_moves_that_row_alone() {
      seed()
      var picker = named(app, "label-picker")
      var menu = named(app, "rowMenu")
      app.cursorId = "1:INBOX"
      verify(app.toggleCheck("1:INBOX"))
      menu.actionRequested("moveToLabel", "2:INBOX")
      tryCompare(picker, "opened", true)
      compare(app.labelPickerOnlyCursor, true)
      picker.searchQuery = "rec"
      picker.cursorIndex = 0
      picker.chooseCursor()
      tryVerify(function() { return record.modified.length === 1 }, 1000)
      compare(record.modified[0].indexOf("2:INBOX +Receipts"), 0, record.modified[0])
      verify(record.modified[0].indexOf("1:INBOX") < 0, "the ticked row stays")
      record.reset()
      app.cursorId = "2:INBOX"
      app.runShortcut("moveToLabel", "v")
      tryCompare(picker, "opened", true)
      compare(app.labelPickerOnlyCursor, false)
      picker.searchQuery = "rec"
      picker.cursorIndex = 0
      picker.chooseCursor()
      tryVerify(function() { return record.modified.length === 1 }, 1000)
      compare(record.modified[0].indexOf("1:INBOX +Receipts"), 0, "from the keyboard the ticks win: " + record.modified[0])
    }

    function test_the_row_menu_opens_the_picker_for_its_row() {
      seed()
      var picker = named(app, "label-picker")
      var menu = named(app, "rowMenu")
      verify(menu !== null)
      menu.actionRequested("moveToLabel", "2:INBOX")
      tryCompare(picker, "opened", true)
      compare(app.cursorId, "2:INBOX", "the picker is about the row the menu was over")
      keyClick(Qt.Key_Escape)
      tryCompare(picker, "opened", false)
    }

    function test_the_readers_button_opens_the_picker_for_the_open_message() {
      var account = seed()
      account.selectedId = "2:INBOX"
      account.selectedMessage = row("2:INBOX")
      var picker = named(app, "label-picker")
      var button = named(app, "reader-move-button")
      verify(button !== null, "the reader has a move button")
      button.clicked()
      tryCompare(picker, "opened", true)
      compare(app.cursorId, "2:INBOX")
      keyClick(Qt.Key_Escape)
      tryCompare(picker, "opened", false)
    }
  }
}
