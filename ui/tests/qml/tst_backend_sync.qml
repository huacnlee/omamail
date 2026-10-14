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
      calls = calls.concat([ready ? {method:method, params:params} : {method:method, params:params, refused:true}])
      if (!ready) { callback(null, {message:"Backend unavailable"}); return }
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
  Component {
    id: syncComponent
    Accounts.BackendSync { accountId: "b@example.org"; query: "is:unread" }
  }
  SignalSpy { id: updates; target: sync; signalName: "updated" }
  TestCase {
    name: "BackendSync"
    when: windowShown
    function init() {
      sync.enabled = false
      sync.reconcile()
      var waiting = backend.pendingWatches
      backend.pendingWatches = []
      // A test that failed early leaves its watch unanswered; settle it here
      // without charging a throw to the next test.
      for (var i = 0; i < waiting.length; i++) {
        try { if (waiting[i]) waiting[i](null, {message:"reset"}) } catch (failure) {}
      }
      if (backend.pendingStop) { var done = backend.pendingStop; backend.pendingStop = null; done() }
      backend.ready = true
      backend.calls = []
      backend.failWatch = false
      backend.deferWatch = false
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
      backend.pendingWatches[index] = null
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
    function test_settings_changed_during_a_watch_wait_for_its_answer() {
      backend.deferWatch = true
      sync.enabled = true
      sync.reconcile()
      sync.pageSize = 50
      sync.reconcile()
      sync.pageSize = 25
      sync.reconcile()
      sync.pageSize = 50
      sync.reconcile()
      compare(backend.calls.length, 1)
      answerWatch(0)
      var count = backend.calls.length
      sync.check()
      compare(backend.calls.length, count + 1)
      compare(backend.calls[count].method, "mail.watch")
      compare(backend.calls[count].params.pageSize, 50)
      answerWatch(1)
      sync.check()
      compare(backend.calls.length, count + 2)
      compare(backend.calls[count + 1].method, "mail.check")
    }
    function test_settings_changed_during_a_watch_apply_after_it() {
      backend.deferWatch = true
      sync.enabled = true
      sync.reconcile()
      sync.pageSize = 50
      wait(0)
      compare(backend.calls.length, 1)
      answerWatch(0)
      compare(updates.count, 0)
      tryVerify(function() { return backend.pendingWatches.length === 2 })
      compare(backend.calls[1].params.pageSize, 50)
    }
    function test_failed_watch_for_changed_settings_registers_them_at_once() {
      backend.deferWatch = true
      sync.enabled = true
      sync.reconcile()
      sync.pageSize = 50
      wait(0)
      answerWatch(0, {message:"temporary"})
      tryVerify(function() { return backend.pendingWatches.length === 2 }, 1000)
      compare(backend.calls[1].params.pageSize, 50)
    }
    function test_reconnect_during_a_watch_ignores_its_answer() {
      backend.deferWatch = true
      sync.enabled = true
      sync.reconcile()
      backend.ready = false
      backend.ready = true
      wait(0)
      compare(backend.calls.length, 1)
      answerWatch(0)
      compare(updates.count, 0)
      tryVerify(function() { return backend.pendingWatches.length === 2 })
      sync.check()
      compare(backend.calls[backend.calls.length - 1].method, "mail.watch")
    }
    function test_backend_failure_releases_a_deferred_unwatch() {
      backend.deferWatch = true
      sync.enabled = true
      sync.reconcile()
      sync.enabled = false
      sync.reconcile()
      verify(sync.unregistering)
      backend.ready = false
      answerWatch(0, {message:"Backend unavailable"})
      verify(!sync.unregistering)
      compare(backend.calls.length, 2)
      compare(backend.calls[1].method, "mail.unwatch")
      verify(backend.calls[1].refused)
      backend.ready = true
      sync.enabled = true
      tryVerify(function() { return backend.pendingWatches.length === 2 })
    }
    function test_disabling_during_a_watch_unwatches_after_its_answer() {
      backend.deferWatch = true
      sync.enabled = true
      sync.reconcile()
      sync.enabled = false
      sync.reconcile()
      compare(backend.calls.length, 1)
      answerWatch(0)
      compare(backend.calls.length, 2)
      compare(backend.calls[1].method, "mail.unwatch")
      compare(backend.calls[1].params.accountId, "a@example.org")
      sync.enabled = true
      sync.reconcile()
      compare(backend.calls.length, 2)
      var done = backend.pendingStop
      backend.pendingStop = null
      done()
      tryVerify(function() { return backend.pendingWatches.length === 2 })
    }
    function test_destroyed_during_a_watch_still_unwatches() {
      backend.deferWatch = true
      var item = syncComponent.createObject(null, {backend: backend, enabled: true})
      item.reconcile()
      compare(backend.calls.length, 1)
      item.destroy()
      wait(0)
      compare(backend.calls.length, 1)
      answerWatch(0)
      compare(backend.calls.length, 2)
      compare(backend.calls[1].method, "mail.unwatch")
      compare(backend.calls[1].params.accountId, "b@example.org")
      var done = backend.pendingStop
      backend.pendingStop = null
      done()
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
