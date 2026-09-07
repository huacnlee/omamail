import QtQuick
import QtTest
import "../../account" as Account

Item {
  Component {
    id: accountFactory
    Account.MailAccount {
      pluginDir: "/unused-queue-fixture"
      accountId: "synthetic@example.com"
      configuredEmail: accountId
      function refreshCounts() {}
      function loadMessages() {}
      function rememberList() {}
      function loadProfile() {}
      function loadSendAs() {}
    }
  }
  // Replace only the provider through its existing Loader. Queueing, optimistic
  // edits, completion and rollback all belong to the real MailAccount.
  Component {
    id: apiFactory
    QtObject {
      property var calls: []
      property var completion: null
      function modifyMessage(id, add, remove, callback) {
        calls = calls.concat([{ id: id, add: add, remove: remove }])
        completion = callback
      }
      function trashMessage(id, callback) {
        calls = calls.concat([{ id: id, action: "trash" }])
        completion = callback
      }
      function finish(error) {
        var callback = completion
        completion = null
        callback({}, error || "")
      }
    }
  }
  TestCase {
    name: "QueuedActions"
    function ready() {
      var account = createTemporaryObject(accountFactory, parent)
      verify(account !== null)
      wait(1)
      var original = account.api
      var installed = false
      for (var i = 0; i < account.children.length; i++) {
        var child = account.children[i]
        if (child.item === original) {
          child.sourceComponent = apiFactory
          installed = true
          break
        }
      }
      verify(installed)
      account.auth.credentials = ({ clientId: "123-test.apps.googleusercontent.com",
        clientSecret: "synthetic", projectId: "test" })
      account.auth.toolsChecked = true
      account.auth.missingTools = []
      account.auth.loggedIn = true
      account.auth.refreshBusy = true
      tryCompare(account, "ready", true)
      account.messages = [
        { id: "one", labelIds: ["INBOX", "Label_A"], unread: true, inInbox: true },
        { id: "two", labelIds: ["INBOX", "Label_A"], unread: true, inInbox: true }
      ]
      return account
    }
    function test_move_keeps_source_label_after_navigation() {
      var account = ready()
      account.rawQuery = "label:A"
      account.rawLabelId = "Label_A"
      verify(account.act("one", "star"))
      verify(account.act("two", "label:Label_B"))
      account.rawQuery = "label:C"
      account.rawLabelId = "Label_C"
      account.messages = []
      account.api.finish()
      tryCompare(account.api, "calls", [
        { id: "one", add: ["STARRED"], remove: [] },
        { id: "two", add: ["Label_B"], remove: ["INBOX", "Label_A"] }
      ])
    }
    function test_read_unread_read_keeps_final_intent() {
      var account = ready()
      verify(account.act("one", "star"))
      verify(account.act("two", "markRead"))
      verify(account.act("two", "markUnread"))
      verify(account.act("two", "markRead"))
      account.api.finish()
      tryVerify(function() { return account.api.calls.length === 2 })
      account.api.finish()
      tryVerify(function() { return account.api.calls.length === 3 })
      account.api.finish()
      tryVerify(function() { return account.api.calls.length === 4 })
      compare(account.api.calls[3].remove, ["UNREAD"])
      account.api.finish()
      compare(account.messages[1].unread, false)
    }
    function test_same_query_search_keeps_original_label_context() {
      var account = ready()
      account.selectLabel("A", "Label_A")
      account.messages = [
        { id: "one", labelIds: ["Label_A"], unread: false },
        { id: "two", labelIds: ["Label_A"], unread: false }
      ]
      verify(account.act("one", "star"))
      verify(account.act("two", "label:Label_B"))
      var query = account.cacheKey
      account.search("label:A")
      compare(account.cacheKey, query)
      account.messages = [{ id: "two", labelIds: ["Label_A"], unread: false }]
      account.api.finish()
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.api.calls[1].remove, ["INBOX", "Label_A"])
    }
    function test_second_press_on_a_departed_row_is_refused() {
      var account = ready()
      verify(account.act("one", "trash"))
      verify(account.act("two", "trash"))
      compare(account.messages.length, 0,
        "the second row leaves at the keystroke, not when the first answers")
      verify(!account.act("two", "trash"), "a row that has already left is nothing to act on")
      compare(account.api.calls.length, 1)
      account.api.finish()
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.api.calls[1], { id: "two", action: "trash" })
      account.api.finish()
      wait(1)
      compare(account.api.calls.length, 2)
      compare(account.messages.length, 0)
    }
    function test_explicit_read_follows_queued_quiet_read() {
      var account = ready()
      account.mailboxKey = "unread"
      account.selectedId = "two"
      verify(account.act("one", "star"))
      verify(account.act("two", "markRead", true))
      compare(account.messages.length, 2, "a quiet read keeps the open row")
      verify(account.act("two", "markRead", false))
      compare(account.messages.length, 1, "An explicit action must remove the unread row")
      compare(account.selectedId, "")
      account.api.finish()
      compare(account.api.calls.length, 2, "the quiet read goes out first")
      account.api.finish()
      compare(account.api.calls.length, 3, "the explicit read is its own send")
      compare(account.api.calls[2].id, "two")
    }
    // Rows queued behind a failure may be gone by the time it fails.
    function test_failure_restores_row_beside_its_surviving_neighbour() {
      var account = ready()
      account.messages = [
        { id: "one", labelIds: ["INBOX"], unread: true, inInbox: true },
        { id: "two", labelIds: ["INBOX"], unread: true, inInbox: true },
        { id: "three", labelIds: ["INBOX"], unread: true, inInbox: true }
      ]
      verify(account.act("two", "trash"))
      verify(account.act("one", "trash"))
      compare(account.messages.length, 1)
      account.api.finish("Synthetic failure")
      compare(account.api.calls.length, 2, "the failure sent the next queued action before restoring")
      compare(account.messages.map(function(m) { return m.id }), ["two", "three"],
        "the failed row goes back above the neighbour that is still listed")
      account.api.finish()
      compare(account.messages.map(function(m) { return m.id }), ["two", "three"])
      compare(account.pendingAction, "")
    }
    function test_failure_restores_first_row_before_next_action() {
      var account = ready()
      verify(account.act("one", "trash"))
      verify(account.act("two", "trash"))
      account.api.finish("Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.messages.length, 1)
      compare(account.messages[0].id, "one")
      account.api.finish()
      compare(account.pendingAction, "")
    }
  }
}
