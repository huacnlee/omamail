import QtQuick
import QtTest
import "../../account" as Account
import "NativeIntentFixture.js" as NativeIntentFixture

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
      // Answered oldest first: a batch trash sends one request per row at
      // once, and each is answered on its own.
      property var completions: []
      function modifyMessage(id, add, remove, callback) {
        calls = calls.concat([{ id: id, add: add, remove: remove }])
        completions = completions.concat([callback])
      }
      function batchModify(ids, add, remove, callback) {
        calls = calls.concat([{ ids: ids, add: add, remove: remove }])
        completions = completions.concat([callback])
      }
      function trashMessage(id, callback) {
        calls = calls.concat([{ id: id, action: "trash" }])
        completions = completions.concat([callback])
      }
      function finish(error) {
        var callback = completions[0]
        completions = completions.slice(1)
        callback({}, error || "")
      }
    }
  }
  TestCase {
    name: "QueuedActions"
    property int serial: 0
    function settled(account) {
      wait(1)
      tryVerify(function() { return account.backend.pending.length === 0 })
    }
    function act(account, id, action, quiet, memberOnly) {
      var accepted = account.act(id, action, quiet, memberOnly)
      settled(account)
      return accepted
    }
    function finish(account, error) { account.api.finish(error); settled(account) }
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
      account.backend = NativeIntentFixture.backend(account)
      account.accountId = "synthetic" + (++serial) + "@example.com"
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
      verify(act(account,"one", "star"))
      verify(act(account,"two", "label:Label_B"))
      account.rawQuery = "label:C"
      account.rawLabelId = "Label_C"
      account.messages = []
      finish(account)
      tryCompare(account.api, "calls", [
        { id: "one", add: ["STARRED"], remove: [] },
        { id: "two", add: ["Label_B"], remove: ["INBOX", "Label_A"] }
      ])
    }
    function test_read_unread_read_keeps_final_intent() {
      var account = ready()
      verify(act(account,"one", "star"))
      verify(act(account,"two", "markRead"))
      verify(act(account,"two", "markUnread"))
      verify(act(account,"two", "markRead"))
      finish(account)
      tryVerify(function() { return account.api.calls.length === 2 })
      finish(account)
      tryVerify(function() { return account.api.calls.length === 3 })
      finish(account)
      tryVerify(function() { return account.api.calls.length === 4 })
      compare(account.api.calls[3].remove, ["UNREAD"])
      finish(account)
      compare(account.messages[1].unread, false)
    }
    function test_same_query_search_keeps_original_label_context() {
      var account = ready()
      account.selectLabel("A", "Label_A")
      tryCompare(account, "rawLabelId", "Label_A")
      account.messages = [
        { id: "one", labelIds: ["Label_A"], unread: false },
        { id: "two", labelIds: ["Label_A"], unread: false }
      ]
      verify(act(account,"one", "star"))
      verify(act(account,"two", "label:Label_B"))
      var query = account.cacheKey
      account.search("label:A")
      compare(account.cacheKey, query, "native query preparation keeps the current action context")
      tryCompare(account, "searchRaw", "label:A")
      compare(account.cacheKey, query)
      account.messages = [{ id: "two", labelIds: ["Label_A"], unread: false }]
      finish(account)
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.api.calls[1].remove, ["INBOX", "Label_A"])
    }
    function test_second_press_on_a_departed_row_is_refused() {
      var account = ready()
      verify(act(account,"one", "trash"))
      verify(act(account,"two", "trash"))
      compare(account.messages.length, 0,
        "the second row leaves at the keystroke, not when the first answers")
      verify(act(account,"two", "trash"), "The backend accepts the queued validation request")
      compare(account.api.calls.length, 1)
      finish(account)
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.api.calls[1], { id: "two", action: "trash" })
      finish(account)
      wait(1)
      compare(account.api.calls.length, 2)
      compare(account.messages.length, 0)
    }
    function test_explicit_read_follows_queued_quiet_read() {
      var account = ready()
      account.mailboxKey = "unread"
      account.selectedId = "two"
      verify(act(account,"one", "star"))
      verify(act(account,"two", "markRead", true))
      compare(account.messages.length, 2, "a quiet read keeps the open row")
      verify(act(account,"two", "markRead", false))
      compare(account.messages.length, 1, "An explicit action must remove the unread row")
      compare(account.selectedId, "")
      finish(account)
      compare(account.api.calls.length, 2, "the quiet read goes out first")
      finish(account)
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
      verify(act(account,"two", "trash"))
      verify(act(account,"one", "trash"))
      compare(account.messages.length, 1)
      finish(account,"Synthetic failure")
      compare(account.api.calls.length, 2, "the failure sent the next queued action before restoring")
      compare(account.messages.map(function(m) { return m.id }), ["two", "three"],
        "the failed row goes back above the neighbour that is still listed")
      finish(account)
      compare(account.messages.map(function(m) { return m.id }), ["two", "three"])
      compare(account.pendingAction, "")
    }
    // An edit ahead of another fails: only its own change comes off, and the
    // edit taken a keystroke later stays, whichever order the two were in.
    function test_failed_star_keeps_the_read_taken_after_it() {
      var account = ready()
      account.messages = unreadRows()
      verify(act(account,"one", "star"))
      verify(act(account,"one", "markRead"))
      compare(account.messages[0].starred, true)
      compare(account.messages[0].unread, false)
      finish(account,"Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.messages[0].starred, false, "the star the server refused comes off")
      compare(account.messages[0].unread, false, "the read behind it stays")
      finish(account)
      compare(account.messages[0].starred, false)
      compare(account.messages[0].unread, false, "and the accepted read is what the row says")
      compare(account.pendingAction, "")
    }
    function test_failed_read_keeps_the_star_taken_after_it() {
      var account = ready()
      account.messages = unreadRows()
      verify(act(account,"one", "markRead"))
      verify(act(account,"one", "star"))
      finish(account,"Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.messages[0].unread, true, "the read the server refused comes off")
      compare(account.messages[0].starred, true, "the star behind it stays")
      finish(account)
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
      verify(act(account,"one", "star"))
      verify(act(account,"one", "markRead"))
      compare(account.selectedMessage.starred, true)
      compare(account.selectedMessage.unread, false)
      finish(account,"Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.memberSummaries.one.starred, false)
      compare(account.memberSummaries.one.unread, false, "the rail keeps the read")
      compare(account.selectedMessage.starred, false)
      compare(account.selectedMessage.unread, false, "so does the reader")
      finish(account)
      compare(account.pendingAction, "")
    }
    // Two removals refused in turn come back in the order they left. The
    // second saw a list the first had already shortened, so its own snapshot
    // could not say where it belonged.
    function test_two_failed_removals_come_back_in_order() {
      var account = ready()
      verify(act(account,"one", "trash"))
      verify(act(account,"two", "trash"))
      compare(account.messages.length, 0)
      finish(account,"Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.messages.map(function(m) { return m.id }), ["one"])
      finish(account,"Synthetic failure")
      compare(account.messages.map(function(m) { return m.id }), ["one", "two"],
        "the second row goes back under the first, not above it")
      compare(account.pendingAction, "")
    }
    // A true repeat while another send holds the slot is coalesced into the
    // first send, and what the repeat held goes with it: an intent nobody
    // answers would be replayed over every failure after it.
    function test_coalesced_repeat_lets_go_of_what_it_held() {
      var account = ready()
      verify(act(account,"two", "trash"))
      verify(act(account,"one", "star"))
      verify(act(account,"one", "star"))
      compare(account.queuedActions.length, 1, "the repeat was coalesced")
      finish(account)
      tryVerify(function() { return account.api.calls.length === 2 })
      finish(account,"Synthetic failure")
      verify(!account.messages[0].starred, "the star the server refused comes off")
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
      verify(act(account,"a", "markRead", false, true))
      compare(account.messages[0].unread, false, "a read, so the block is read")
      verify(act(account,"a", "star", false, true))
      compare(account.messages[0].starred, true)
      finish(account,"Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.memberSummaries.a.unread, true, "the rail says a is unread again")
      compare(account.memberSummaries.a.starred, true, "and keeps the star")
      compare(account.selectedMessage.unread, true, "so does the reader")
      compare(account.messages[0].starred, true)
      compare(account.messages[0].unread, true, "and the row's block agrees with the rail")
      finish(account)
      compare(account.messages[0].unread, true, "still, once the star lands")
    }
    // The failure comes after the view has moved on. The row is not put into
    // the list now on screen, and nothing stays held.
    function test_failure_after_navigation_lets_go_of_what_it_held() {
      var account = ready()
      var home = account.cacheKey
      verify(act(account,"one", "star"))
      account.rawQuery = "label:C"
      account.rawLabelId = "Label_C"
      verify(account.cacheKey !== home)
      account.messages = [{ id: "nine", labelIds: ["INBOX"], unread: false, inInbox: true }]
      finish(account,"Synthetic failure")
      compare(account.messages.map(function(m) { return m.id }), ["nine"])
      compare(account.pendingAction, "")
    }
    function ids(list) { return list.map(function(m) { return m.id }) }
    // Mark-all holds an intent per row like any edit, so a refusal takes off
    // only what it changed: the star pressed while the server was deciding
    // stays, where a snapshot of the list put back would have lost it.
    function test_refused_mark_all_keeps_the_star_taken_after_it() {
      var account = ready()
      account.messages = unreadRows()
      verify(account.markAllRead()); settled(account)
      compare(account.messages[0].unread, false)
      verify(act(account,"one", "star"))
      compare(account.queuedActions.length, 1, "the star waits for the slot")
      finish(account,"Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.messages[0].unread, true, "the read the server refused comes off")
      compare(account.messages[0].starred, true, "the star behind it stays")
      compare(account.messages[1].unread, true)
      finish(account)
      compare(account.messages[0].unread, true)
      compare(account.messages[0].starred, true, "and the accepted star is what the row says")
      compare(account.pendingAction, "")
    }
    // In the Unread view every row leaves at once, and a refusal puts them
    // all back in the order they held.
    function test_refused_mark_all_puts_the_unread_view_back_in_order() {
      var account = ready()
      account.mailboxKey = "unread"
      account.messages = unreadRows().concat([
        { id: "three", labelIds: ["INBOX", "UNREAD"], unread: true, inInbox: true }])
      verify(account.markAllRead()); settled(account)
      compare(account.messages.length, 0)
      finish(account,"Synthetic failure")
      compare(ids(account.messages), ["one", "two", "three"])
      compare(account.messages[1].unread, true)
    }
    // Two removals refused after the view has moved on repair the cached
    // copy of the query they were taken on — rebased, not replaced: the list
    // the second edit saw had already lost the row the first refusal put back.
    function test_refusals_after_navigation_repair_the_cached_list_in_order() {
      var account = ready()
      var home = account.cacheKey
      verify(act(account,"one", "trash"))
      verify(act(account,"two", "trash"))
      // What `rememberList` wrote after the second keystroke.
      var cachedQueries = {}
      account.cache.backend = {ready:true,call:function(method, params, callback) {
        if(method === "cache.queryPut") cachedQueries[params.key] = params.page
        callback({generation:1}, "")
      }}
      account.cache.loaded = true
      account.cache.putQuery(home, ({ summaries: [], estimate: 0, nextPageToken: "" }))
      account.rawQuery = "label:C"
      account.rawLabelId = "Label_C"
      verify(account.cacheKey !== home)
      account.messages = [{ id: "nine", labelIds: ["INBOX"], unread: false, inInbox: true }]
      finish(account,"Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(ids(cachedQueries[home].summaries), ["one"])
      finish(account,"Synthetic failure")
      compare(ids(cachedQueries[home].summaries), ["one", "two"],
        "the second refusal keeps the row the first put back")
      compare(ids(account.messages), ["nine"], "and the view on screen is untouched")
    }
    // The batch is one more producer on the same queue: taken while a send
    // holds the slot, its rows leave now and its send goes out when the slot
    // frees, in the callback that freed it.
    function test_batch_queued_behind_an_action_sends_when_the_slot_frees() {
      var account = ready()
      verify(act(account,"one", "star"))
      verify(account.actMany(["two"], "trash")); settled(account)
      compare(ids(account.messages), ["one"], "the batch's row leaves at the keystroke")
      compare(account.api.calls.length, 1, "and its send waits")
      finish(account)
      compare(account.api.calls.length, 2, "the star's answer sent the batch")
      compare(account.api.calls[1], { id: "two", action: "trash" })
      finish(account)
      compare(account.pendingAction, "")
    }
    // And one more completion that drains it: an action taken behind a batch
    // is sent when the batch answers.
    function test_action_queued_behind_a_batch_sends_when_the_slot_frees() {
      var account = ready()
      verify(account.actMany(["one"], "markRead")); settled(account)
      verify(act(account,"two", "star"))
      compare(account.messages[1].starred, true)
      compare(account.api.calls.length, 1, "the star waits behind the batch")
      finish(account)
      compare(account.api.calls.length, 2, "the batch's answer sent the star")
      compare(account.api.calls[1].id, "two")
      finish(account)
      compare(account.pendingAction, "")
      compare(account.messages[0].unread, false)
      compare(account.messages[1].starred, true)
    }
    // A queued batch answered per row: the refused row goes back where the
    // settled order says, beside rows that left before and after it.
    function test_refused_row_of_a_queued_batch_goes_back_in_order() {
      var account = ready()
      account.messages = unreadRows().concat([
        { id: "three", labelIds: ["INBOX", "UNREAD"], unread: true, inInbox: true }])
      verify(act(account,"one", "trash"))
      verify(account.actMany(["two", "three"], "trash")); settled(account)
      compare(account.messages.length, 0)
      finish(account)
      compare(account.api.calls.length, 3, "one request per row of the batch")
      finish(account,"Synthetic failure")
      finish(account)
      compare(ids(account.messages), ["two"], "the refused row is back; the accepted ones are gone")
      verify(account.lastError.indexOf("1 of 2") >= 0, account.lastError)
      compare(account.pendingAction, "")
    }
    // A batch refused as a whole takes off its own edits and no other: the
    // star pressed on one of its rows while it was in flight stays.
    function test_refused_batch_keeps_the_edit_taken_after_it() {
      var account = ready()
      account.messages = unreadRows()
      verify(account.actMany(["one", "two"], "markRead")); settled(account)
      verify(act(account,"one", "star"))
      compare(account.messages[0].unread, false)
      compare(account.messages[0].starred, true)
      finish(account,"Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.messages[0].unread, true, "the read the server refused comes off")
      compare(account.messages[0].starred, true, "the star behind it stays")
      compare(account.messages[1].unread, true)
      finish(account)
      compare(account.messages[0].starred, true)
    }
    function test_failure_restores_first_row_before_next_action() {
      var account = ready()
      verify(act(account,"one", "trash"))
      verify(act(account,"two", "trash"))
      finish(account,"Synthetic failure")
      tryVerify(function() { return account.api.calls.length === 2 })
      compare(account.messages.length, 1)
      compare(account.messages[0].id, "one")
      finish(account)
      compare(account.pendingAction, "")
    }
  }
}
