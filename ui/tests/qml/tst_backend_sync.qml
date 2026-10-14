import QtQuick
import QtTest
import "../../account" as Accounts

Item {
  QtObject {
    id: backend
    property bool ready: true
    property var calls: []
    property var pendingStop: null
    property bool failWatch: false
    property bool deferWatch: false
    property var pendingWatches: []
    signal notification(string method, var params)
    function call(method, params, callback) {
      calls = calls.concat([{method:method, params:params}])
      if (method === "mail.unwatch") pendingStop = callback
      else if (method === "mail.watch" && deferWatch) pendingWatches = pendingWatches.concat([callback])
      else callback(null, method === "mail.watch" && failWatch ? {message:"temporary"} : null)
    }
  }
  Accounts.BackendSync {
    id: sync
    backend: backend
    accountId: "a@example.org"
    query: "is:unread"
  }
  SignalSpy { id: updates; target: sync; signalName: "updated" }
  TestCase {
    name: "BackendSync"
    when: windowShown
    function init() {
      sync.enabled = false
      sync.reconcile()
      if (backend.pendingStop) { var done = backend.pendingStop; backend.pendingStop = null; done() }
      backend.ready = true
      backend.calls = []
      backend.failWatch = false
      backend.deferWatch = false
      backend.pendingWatches = []
      sync.accountId = "a@example.org"
      sync.intervalSec = 120
      sync.pageSize = 25
      updates.clear()
      wait(10)
    }
    function test_registers_without_a_window_and_deduplicates_events() {
      sync.enabled = true
      tryVerify(function() { return backend.calls.length > 0 })
      compare(backend.calls[0].method, "mail.watch")
      backend.notification("mail.updated", {accountId:"a@example.org",sequence:1,estimate:2,messages:[],error:""})
      compare(updates.count, 1)
      backend.notification("mail.updated", {accountId:"a@example.org",sequence:1})
      backend.notification("mail.updated", {accountId:"other@example.org",sequence:9})
      compare(updates.count, 1)
      sync.check()
      compare(backend.calls[backend.calls.length - 1].method, "mail.check")
    }
    function test_disabling_and_reenabling_waits_for_unwatch() {
      sync.enabled = true
      sync.reconcile()
      sync.enabled = false
      sync.reconcile()
      compare(backend.calls[backend.calls.length - 1].method, "mail.unwatch")
      var count = backend.calls.length
      sync.enabled = true
      sync.reconcile()
      compare(backend.calls.length, count)
      var done = backend.pendingStop
      backend.pendingStop = null
      done()
      tryCompare(backend, "calls", backend.calls.concat([{method:"mail.watch",params:{accountId:"a@example.org",query:"is:unread",intervalSec:120,pageSize:25}}]))
    }
    function test_disconnect_drops_registration_and_reconnects() {
      sync.enabled = true
      sync.reconcile()
      backend.ready = false
      compare(sync.registeredAccount, "")
      backend.ready = true
      compare(backend.calls[backend.calls.length - 1].method, "mail.watch")
    }
    function test_page_size_updates_native_prefetch_without_unwatch_race() {
      sync.enabled = true
      sync.reconcile()
      compare(backend.calls[backend.calls.length - 1].params.pageSize, 25)
      var count = backend.calls.length
      sync.pageSize = 50
      tryVerify(function() { return backend.calls.length > count })
      compare(backend.calls.length, count + 1)
      compare(backend.calls[backend.calls.length - 1].method, "mail.watch")
      compare(backend.calls[backend.calls.length - 1].params.pageSize, 50)
    }
    function test_failed_registration_can_be_retried() {
      backend.failWatch = true
      sync.enabled = true
      sync.reconcile()
      compare(sync.registrationKey, "")
      backend.failWatch = false
      sync.check()
      compare(backend.calls[backend.calls.length - 2].method, "mail.watch")
      compare(backend.calls[backend.calls.length - 1].method, "mail.check")
      verify(sync.registrationKey !== "")
    }
    function answerWatch(index, error) {
      var answer = backend.pendingWatches[index]
      answer(error ? null : {accountId:"a@example.org",sequence:index + 1,estimate:0,messages:[],error:""}, error || null)
    }
    function test_check_waits_for_the_watch_to_answer() {
      backend.deferWatch = true
      sync.enabled = true
      sync.check()
      compare(backend.calls.length, 1)
      compare(backend.calls[0].method, "mail.watch")
      compare(backend.pendingWatches.length, 1)
      answerWatch(0)
      sync.check()
      compare(backend.calls.length, 2)
      compare(backend.calls[1].method, "mail.check")
    }
    function test_check_waits_for_a_reconnected_backend_to_register() {
      sync.enabled = true
      sync.reconcile()
      backend.deferWatch = true
      backend.ready = false
      backend.ready = true
      var count = backend.calls.length
      compare(backend.calls[count - 1].method, "mail.watch")
      sync.check()
      compare(backend.calls.length, count)
      answerWatch(0)
      sync.check()
      compare(backend.calls.length, count + 1)
      compare(backend.calls[count].method, "mail.check")
    }
    function test_superseded_watch_answer_does_not_allow_checks() {
      backend.deferWatch = true
      sync.enabled = true
      sync.reconcile()
      sync.pageSize = 50
      sync.reconcile()
      compare(backend.pendingWatches.length, 2)
      answerWatch(0)
      var count = backend.calls.length
      sync.check()
      compare(backend.calls.length, count)
      answerWatch(1)
      sync.check()
      compare(backend.calls.length, count + 1)
      compare(backend.calls[count].method, "mail.check")
    }
    function test_failed_pending_watch_registers_again_instead_of_checking() {
      backend.deferWatch = true
      sync.enabled = true
      sync.reconcile()
      answerWatch(0, {message:"temporary"})
      var count = backend.calls.length
      sync.check()
      compare(backend.calls.length, count + 1)
      compare(backend.calls[count].method, "mail.watch")
    }
  }
}
