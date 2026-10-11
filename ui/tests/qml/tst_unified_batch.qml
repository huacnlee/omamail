import QtQuick
import QtTest
import "../../account" as Account
import "../../account/Unified.js" as Unified

Item {
  QtObject {
    id: service
    property bool unified: true
    property string activeAccountId: "a@example.org"
    property string mailboxKey: "inbox"
    property string rawQuery: ""
    property var messages: []
    property var hosts: ({})
    property string actionStatus: ""
    function findAccount(id) { return hosts[id] || null }
    function note(text) { actionStatus = text }
  }
  QtObject { id: app; property var checkedIds: [] }
  Account.UnifiedBatchAction { id: batch; service: service }
  Account.UnifiedBatchSelection { id: selection; app: app; service: service }
  TestCase {
    name: "UnifiedBatchCompletion"
    property var calls: []
    property var replies: ({})
    property var completed: []
    function key(account, id) { return Unified.unifiedId(account + "@example.org", id) }
    function host(account, accepts) {
      return {configuredEmail: account + "@example.org",
        actionLabel: function(action) { return action === "trash" ? "Moved to trash" : "Marked read" },
        actMany: function(ids, action, callback) {
          calls = calls.concat([{account: account, ids: ids.slice(), action: action}])
          if (!accepts) return false
          replies[account] = callback
          return true
        }}
    }
    function init() {
      service.unified = true
      service.activeAccountId = "a@example.org"
      service.mailboxKey = "inbox"
      service.rawQuery = ""
      service.messages = []
      service.actionStatus = ""
      service.hosts = {"a@example.org": host("a", true), "b@example.org": host("b", true)}
      calls = []; replies = ({}); completed = []; app.checkedIds = []; selection.pending = []
    }
    function run(ids) { return batch.run(ids, "trash", function(result) { completed.push(result) }) }
    function test_success_waits_for_every_account_and_reports_the_whole_selection() {
      verify(run([key("a", "42:INBOX"), key("b", "42:Sent Items"), key("a", "43:INBOX")]))
      compare(calls.length, 2)
      compare(calls[0].ids, ["42:INBOX", "43:INBOX"])
      compare(calls[1].ids, ["42:Sent Items"])
      replies.b({failedIds: []})
      compare(service.actionStatus, "")
      compare(completed.length, 0)
      replies.a({failedIds: []})
      compare(completed.length, 1)
      compare(completed[0].failedIds, [])
      verify(service.actionStatus.indexOf("3 of 3 selected across 2 mailboxes") >= 0)
      verify(service.actionStatus.indexOf("a@example.org: 2 completed, 0 failed") >= 0)
      verify(service.actionStatus.indexOf("b@example.org: 1 completed, 0 failed") >= 0)
      replies.a({failedIds: ["42:INBOX"]})
      compare(completed.length, 1, "duplicate completion cannot change the result")
    }
    function test_failure_keeps_account_identity_and_ignores_unrequested_rows() {
      verify(run([key("a", "42:INBOX"), key("b", "42:INBOX")]))
      replies.a({failedIds: ["42:INBOX", "42:INBOX", "other", key("b", "42:INBOX")]})
      replies.b({failedIds: []})
      compare(completed[0].failedIds, [key("a", "42:INBOX")])
      verify(service.actionStatus.indexOf("1 of 2 selected") >= 0)
      verify(service.actionStatus.indexOf("a@example.org: 0 completed, 1 failed") >= 0)
    }
    function test_signed_out_or_missing_account_is_counted_without_guessing_a_host() {
      service.hosts = {"a@example.org": host("a", false)}
      compare(run([key("a", "42:INBOX"), key("b", "42:INBOX")]), false)
      compare(calls.length, 1)
      compare(completed[0].failedIds, [key("a", "42:INBOX"), key("b", "42:INBOX")])
      verify(service.actionStatus.indexOf("0 of 2 selected") >= 0)
    }
    function test_mailbox_change_does_not_show_an_old_batch_note() {
      verify(run([key("a", "42:INBOX")]))
      service.mailboxKey = "unread"
      replies.a({failedIds: []})
      compare(service.actionStatus, "")
      compare(completed.length, 1)
    }
    function test_failed_checks_wait_for_rollback_then_leave_user_selection_alone() {
      var failed = key("a", "42:INBOX")
      var scope = selection.scope
      selection.restore([failed], scope)
      compare(app.checkedIds, [])
      compare(selection.pending, [failed])
      service.messages = [{id: failed}]
      tryCompare(app, "checkedIds", [failed])
      compare(selection.pending, [])
      app.checkedIds = []
      service.messages = [{id: failed}, {id: key("b", "1:INBOX")}]
      wait(0)
      compare(app.checkedIds, [], "later reloads cannot recheck a row the user unchecked")
    }
    function test_failed_checks_never_cross_a_query_or_account_change() {
      var scope = selection.scope
      selection.restore([key("a", "42:INBOX")], scope)
      service.rawQuery = "different search"
      compare(selection.pending, [])
      service.messages = [{id: key("a", "42:INBOX")}]
      selection.restore([key("a", "42:INBOX")], scope)
      wait(0)
      compare(app.checkedIds, [])
    }
    function test_turning_unified_off_and_on_invalidates_old_completions() {
      var scope = selection.scope
      var failed = key("a", "42:INBOX")
      verify(run([failed]))
      selection.restore([failed], scope)
      service.unified = false
      compare(selection.pending, [])
      service.unified = true
      service.messages = [{id: failed}]
      replies.a({failedIds: ["42:INBOX"]})
      selection.restore([failed], scope)
      wait(0)
      compare(app.checkedIds, [])
      compare(service.actionStatus, "")
      compare(batch.status, "")
      compare(batch.error, "")
    }
  }
}
