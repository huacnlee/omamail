import QtQuick
import QtTest
import "../../account" as Account

// One account's "Mark all read..." run: repeat the backend step until the
// Unread mailbox is empty, and stop cleanly on everything else.
Item {
  width: 200
  height: 100

  QtObject {
    id: backend
    // Each answer is {result: {...}} or {error: "message"}, taken in order.
    property var answers: []
    property var calls: []
    property var onCall: null
    function call(method, params, callback) {
      calls = calls.concat([{ method: method, params: params }])
      var answer = answers.length > 0 ? answers[0] : { result: { done: true, marked: 0, failed: 0 } }
      answers = answers.slice(1)
      Qt.callLater(function() {
        if (onCall) onCall(calls.length)
        if (answer.error !== undefined) callback(null, { code: -32000, message: answer.error })
        else callback(answer.result, "")
      })
    }
  }

  QtObject {
    id: account
    property bool ready: true
    property string accountId: "gmail:ada@example.org"
    property var backend: backend
    // The provider client, which owns the wording of its backend's errors.
    property var api: null
    property int refreshes: 0
    function refresh() { refreshes++ }
  }

  QtObject {
    id: translator
    function backendError(error, method) {
      return error.message === "gmail_rate_limited" && method === "mail.clearUnread"
        ? "Gmail is rate limiting this account. Wait a moment, then try again." : "unexpected"
    }
  }

  QtObject {
    id: sentenceOnly
    function sentence(error) {
      return error.message === "jmap_timeout" ? "The mail server took too long to answer" : "unexpected"
    }
  }

  Account.ClearUnread {
    id: run
    account: account
  }

  TestCase {
    name: "ClearUnread"
    when: windowShown

    property var progress: []
    property var outcome: null

    function step(marked, failed) { return { result: { done: false, marked: marked, failed: failed || 0 } } }
    function done() { return { result: { done: true, marked: 0, failed: 0 } } }

    function init() {
      backend.answers = []
      backend.calls = []
      backend.onCall = null
      account.ready = true
      account.accountId = "gmail:ada@example.org"
      account.refreshes = 0
      account.api = null
      run.stepLimit = 200
      progress = []
      outcome = null
    }
    function start() {
      return run.run(function(marked) { progress = progress.concat([marked]) },
        function(result) { outcome = result })
    }
    function finish() { tryVerify(function() { return outcome !== null }, 2000, "the run ends") }

    function test_runs_until_done() {
      backend.answers = [step(100), step(40), done()]
      verify(start())
      verify(run.running)
      finish()
      compare(backend.calls.length, 3)
      compare(backend.calls[0].method, "mail.clearUnread")
      compare(JSON.stringify(backend.calls[0].params), JSON.stringify({ account: "gmail:ada@example.org", execute: true }))
      compare(JSON.stringify(progress), JSON.stringify([100, 140]))
      compare(outcome.marked, 140)
      compare(outcome.error, "")
      compare(account.refreshes, 1, "one reload at the end, not one per step")
      verify(!run.running)
    }

    function test_failed_targets_are_reported() {
      backend.answers = [step(90, 10), done()]
      start()
      finish()
      compare(outcome.marked, 90)
      compare(outcome.failed, 10)
    }

    function test_stall_stops_the_run() {
      backend.answers = [step(100), { error: "mail_clear_unread_stalled" }, step(5)]
      start()
      finish()
      compare(backend.calls.length, 2)
      compare(outcome.marked, 100)
      compare(outcome.stalled, true)
      compare(outcome.error, "")
      compare(account.refreshes, 1)
    }

    function test_error_keeps_the_count() {
      backend.answers = [step(100), { error: "Backend stopped" }]
      start()
      finish()
      compare(outcome.marked, 100)
      compare(outcome.error, "Backend stopped")
      compare(account.refreshes, 1)
    }

    function test_error_uses_the_provider_wording() {
      account.api = translator
      backend.answers = [step(100), { error: "gmail_rate_limited" }]
      start()
      finish()
      compare(outcome.error, "Gmail is rate limiting this account. Wait a moment, then try again.")
    }

    function test_error_uses_the_client_sentence_when_there_is_no_backend_error() {
      account.api = sentenceOnly
      backend.answers = [{ error: "jmap_timeout" }]
      start()
      finish()
      compare(outcome.error, "The mail server took too long to answer")
    }

    function test_error_without_client_wording_is_still_readable() {
      backend.answers = [{ error: "mail_action_target_limit" }]
      start()
      finish()
      compare(outcome.error, "a conversation has more messages than one step can mark")
    }

    function test_step_limit() {
      run.stepLimit = 3
      backend.answers = [step(1), step(1), step(1), step(1)]
      start()
      finish()
      compare(backend.calls.length, 3)
      compare(outcome.marked, 3)
      compare(outcome.limited, true)
    }

    function test_account_change_stops_after_the_current_step() {
      backend.answers = [step(100), step(100)]
      backend.onCall = function(count) { if (count === 1) account.accountId = "gmail:other@example.org" }
      start()
      finish()
      compare(backend.calls.length, 1)
      compare(outcome.marked, 100)
      compare(account.refreshes, 0, "the host now shows another mailbox")
    }

    function test_signed_out_mid_run_stops() {
      backend.answers = [step(100), step(100)]
      backend.onCall = function(count) { if (count === 1) account.ready = false }
      start()
      finish()
      compare(backend.calls.length, 1)
      compare(outcome.marked, 100)
    }

    function test_second_start_is_ignored() {
      backend.answers = [step(100), done()]
      verify(start())
      verify(!run.run(function() {}, function() {}), "a run in progress refuses another")
      finish()
      compare(backend.calls.length, 2)
    }

    function test_not_ready_refuses() {
      account.ready = false
      verify(!start())
      wait(10)
      compare(backend.calls.length, 0)
      compare(outcome, null)
    }
  }
}
