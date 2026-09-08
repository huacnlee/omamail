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
    // Rows as a provider reports them, with the label the unread flag mirrors,
    // since an action recomputes the flags from the labels.
    function unreadRows() {
      return [
        { id: "one", labelIds: ["INBOX", "UNREAD"], unread: true, inInbox: true },
        { id: "two", labelIds: ["INBOX", "UNREAD"], unread: true, inInbox: true }
      ]
    }
    function keys(held) {
      var out = []
      for (var key in held) out.push(key)
      return out.sort()
    }
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
    // An edit ahead of another fails: only its own change comes off, and the
    // edit taken a keystroke later stays, whichever order the two were in.
    function test_failed_star_keeps_the_read_taken_after_it() {
      var account = ready()
      account.messages = unreadRows()
      verify(account.act("one", "star"))
      verify(account.act("one", "markRead"))
      compare(account.messages[0].starred, true)
      compare(account.messages[0].unread, false)
      account.api.finish("Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.messages[0].starred, false, "the star the server refused comes off")
      compare(account.messages[0].unread, false, "the read behind it stays")
      account.api.finish()
      compare(account.messages[0].starred, false)
      compare(account.messages[0].unread, false, "and the accepted read is what the row says")
      compare(account.pendingAction, "")
    }
    function test_failed_read_keeps_the_star_taken_after_it() {
      var account = ready()
      account.messages = unreadRows()
      verify(account.act("one", "markRead"))
      verify(account.act("one", "star"))
      account.api.finish("Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.messages[0].unread, true, "the read the server refused comes off")
      compare(account.messages[0].starred, true, "the star behind it stays")
      account.api.finish()
      compare(account.messages[0].unread, true)
      compare(account.messages[0].starred, true)
      compare(account.pendingAction, "")
    }
    // The rail's summary and the reader's copy follow the same rule.
    function test_failed_star_keeps_the_read_in_the_rail_and_the_reader() {
      var account = ready()
      account.messages = unreadRows()
      account.memberSummaries = ({ one: account.messages[0] })
      account.selectedId = "one"
      account.selectedMessage = account.messages[0]
      verify(account.act("one", "star"))
      verify(account.act("one", "markRead"))
      compare(account.selectedMessage.starred, true)
      compare(account.selectedMessage.unread, false)
      account.api.finish("Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.memberSummaries.one.starred, false)
      compare(account.memberSummaries.one.unread, false, "the rail keeps the read")
      compare(account.selectedMessage.starred, false)
      compare(account.selectedMessage.unread, false, "so does the reader")
      account.api.finish()
      compare(account.pendingAction, "")
    }
    // Two removals refused in turn come back in the order they left. The
    // second saw a list the first had already shortened, so its own snapshot
    // could not say where it belonged.
    function test_two_failed_removals_come_back_in_order() {
      var account = ready()
      verify(account.act("one", "trash"))
      verify(account.act("two", "trash"))
      compare(account.messages.length, 0)
      account.api.finish("Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.messages.map(function(m) { return m.id }), ["one"])
      account.api.finish("Synthetic failure")
      compare(account.messages.map(function(m) { return m.id }), ["one", "two"],
        "the second row goes back under the first, not above it")
      compare(account.pendingAction, "")
    }
    // A true repeat while another send holds the slot is coalesced into the
    // first send, and what the repeat held goes with it: an intent nobody
    // answers would be replayed over every failure after it.
    function test_coalesced_repeat_lets_go_of_what_it_held() {
      var account = ready()
      verify(account.act("two", "trash"))
      verify(account.act("one", "star"))
      verify(account.act("one", "star"))
      compare(account.queuedActions.length, 1, "the repeat was coalesced")
      compare(account.actionIntents.one.length, 1, "and holds nothing of its own")
      account.api.finish()
      tryVerify(function() { return account.api.calls.length === 2 })
      account.api.finish("Synthetic failure")
      verify(!account.messages[0].starred, "the star the server refused comes off")
      compare(keys(account.actionIntents), [], "nothing held once every send is answered")
      compare(keys(account.settledLists), [], "no list held once nothing is in flight")
    }
    // A conversation on screen: the row `R` and its member `a`, the reader on
    // `a`. Two rail actions on `a`, the first refused: the rail, the reader
    // and the row's block all say the same thing afterwards.
    function conversation(account) {
      var rep = { id: "R", labelIds: ["INBOX"], unread: true, inInbox: true,
        thread: { id: "T", memberIds: ["R", "a"], count: 2, unread: true, flagged: false } }
      var a = { id: "a", labelIds: ["INBOX", "UNREAD"], unread: true, inInbox: true }
      account.messages = [rep, unreadRows()[1]]
      account.memberSummaries = ({ R: rep, a: a })
      account.selectedThread = rep.thread
      account.selectedId = "a"
      account.selectedMessage = a
    }
    function test_failed_member_read_keeps_the_row_in_step_with_the_rail() {
      var account = ready()
      conversation(account)
      verify(account.act("a", "markRead", false, true))
      compare(account.messages[0].unread, false, "a read, so the block is read")
      verify(account.act("a", "star", false, true))
      compare(account.messages[0].starred, true)
      account.api.finish("Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.memberSummaries.a.unread, true, "the rail says a is unread again")
      compare(account.memberSummaries.a.starred, true, "and keeps the star")
      compare(account.selectedMessage.unread, true, "so does the reader")
      compare(account.messages[0].starred, true)
      compare(account.messages[0].unread, true, "and the row's block agrees with the rail")
      account.api.finish()
      compare(account.messages[0].unread, true, "still, once the star lands")
      compare(keys(account.actionIntents), [])
    }
    // The failure comes after the view has moved on. The row is not put into
    // the list now on screen, and nothing stays held.
    function test_failure_after_navigation_lets_go_of_what_it_held() {
      var account = ready()
      var home = account.cacheKey
      verify(account.act("one", "star"))
      account.rawQuery = "label:C"
      account.rawLabelId = "Label_C"
      verify(account.cacheKey !== home)
      account.messages = [{ id: "nine", labelIds: ["INBOX"], unread: false, inInbox: true }]
      account.api.finish("Synthetic failure")
      compare(account.messages.map(function(m) { return m.id }), ["nine"])
      compare(account.pendingAction, "")
      compare(keys(account.actionIntents), [])
      compare(keys(account.settledLists), [])
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
