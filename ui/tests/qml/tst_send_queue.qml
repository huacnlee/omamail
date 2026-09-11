import QtQuick 2.15
import QtTest 1.3
import "../../account" as Account
Item {
  id: testRoot
  QtObject {
    id: backend
    property bool ready: true
    property var calls: []
    signal notification(string method, var params)
    function call(method, params, callback) {
      if (method === "outbox.snapshot" && !params.sendId) { callback({accountId: "me@example.org", revision: 0, entries: []}, null); return }
      calls = calls.concat([{method: method, params: params, callback: callback}])
    }
  }
  QtObject { id: auth; signal loggedOut() }
  QtObject {
    id: account
    property var backend: testRoot.parentBackend
    property var auth: testRoot.parentAuth
    property string accountId: "me@example.org"
    property string providerId: "gmail"
    property int undoSendSeconds: 10
    property bool sending: false
    property int sendSecondsRemaining: 0
    property var successes: []
    property var failures: []
    property var removed: []
    function reportSendSuccess(result, id) { successes = successes.concat([id]) }
    function reportSendFailure(message, id) { failures = failures.concat([id]) }
    function sentDraftRemoved(id) { removed = removed.concat([id]) }
    function note(message) {}
    function deliver(payload) { throw new Error("UI must never deliver mail") }
  }
  property var parentBackend: backend
  property var parentAuth: auth
  Account.SendQueue { id: queue; account: account }
  TestCase {
    name: "SendQueue"
    function init() {
      queue.parked = []; queue.submitted = ({}); queue.handled = ({}); queue.revision = -1
      queue.undoBusy = false; queue.undoPending = null; queue.uncertain = ({}); queue.serverEntries = []; queue.arm(); backend.calls = []
      account.successes = []; account.failures = []; account.removed = []; account.sending = false
    }
    function snapshot(revision, entries) { return {accountId: account.accountId, revision: revision, entries: entries} }
    function entry(id, state) { return {id: id, state: state, order: 1, queuedAt: Date.now(), dueAt: Date.now() + 10000} }
    function test_backend_owns_delay_and_actual_delivery() {
      verify(queue.park({raw: "private"}, "send1", 1))
      compare(backend.calls.length, 1); compare(backend.calls[0].method, "outbox.enqueue")
      compare(backend.calls[0].params.delaySeconds, 10)
      backend.calls[0].callback({snapshot: snapshot(1, [entry("send1", "queued")])}, null)
      queue.deliverDue()
      compare(backend.calls.length, 1, "reconciliation cannot start a send")
    }
    function test_undo_waits_for_authoritative_acknowledgement() {
      queue.apply(snapshot(1, [entry("send1", "queued")]))
      var undone = ""
      verify(queue.undoLatest(function(id) { undone = id }))
      compare(undone, ""); compare(backend.calls[0].method, "outbox.undo")
      backend.calls[0].callback({id:"send1",snapshot:snapshot(2,[entry("send1","cancelled")])},null)
      compare(undone,"send1");compare(queue.parked.length,0)
    }
    function test_undo_racing_delivery_does_not_restore_a_sent_draft() {
      queue.apply(snapshot(1,[entry("send1","queued")]))
      var undone="not called"
      verify(queue.undoLatest(function(id){undone=id}))
      backend.calls[0].callback(null,{message:"outbox_not_queued"})
      compare(undone,"not called")
      backend.calls[1].callback(snapshot(2,[entry("send1","sending")]),null)
      compare(undone,"");compare(account.failures.length,0)
    }
    function test_lost_undo_acknowledgement_recovers_only_confirmed_cancellation() {
      queue.apply(snapshot(1,[entry("send1","queued")]))
      var undone=""
      verify(queue.undoLatest(function(id){undone=id}))
      backend.calls[0].callback(null,{message:"Backend disconnected"})
      compare(undone,"")
      backend.calls[1].callback(snapshot(2,[entry("send1","cancelled")]),null)
      compare(undone,"send1")
    }
    function test_stale_snapshots_cannot_requeue_delivered_mail() {
      var sent=entry("send1","sent");sent.draftId="draft1";sent.result={draftRemoved:true}
      queue.apply(snapshot(3,[sent]));queue.apply(snapshot(2,[entry("send1","queued")]))
      compare(queue.parked.length,0);compare(account.successes.length,1);compare(account.removed[0],"draft1")
      queue.apply(snapshot(4,[sent]));compare(account.successes.length,1)
    }
    function test_lost_enqueue_acknowledgement_does_not_claim_failure_or_retry() {
      verify(queue.park({raw:"private"},"lost",1))
      backend.calls[0].callback(null,{message:"Backend disconnected"})
      compare(account.failures.length,0)
      compare(backend.calls[1].method,"outbox.snapshot")
      compare(backend.calls[1].params.sendId,"lost")
      backend.calls[1].callback(snapshot(2,[entry("lost","sent")]),null)
      compare(account.successes[0],"lost");compare(account.failures.length,0)
      compare(queue.parked.length,0)
    }
    function test_disconnected_enqueue_keeps_draft_parked_until_reconnect_receipt() {
      verify(queue.park({raw:"private"},"reconnect",1))
      backend.ready = false
      backend.calls[0].callback(null,{message:"Backend disconnected"})
      compare(backend.calls.length,1);compare(account.failures.length,0);compare(queue.parked.length,1)
      backend.ready = true
      compare(backend.calls[1].method,"outbox.snapshot")
      backend.calls[1].callback(snapshot(2,[entry("reconnect","unknown")]),null)
      compare(account.failures[0],"reconnect")
    }
    function test_missing_receipt_after_ack_loss_restores_only_after_snapshot() {
      verify(queue.park({raw:"private"},"missing",1))
      backend.calls[0].callback(null,{message:"Backend disconnected"})
      compare(account.failures.length,0)
      backend.calls[1].callback(snapshot(2,[]),null)
      compare(account.failures[0],"missing")
    }
    function test_signout_racing_delivery_reports_only_confirmed_cancelled_jobs() {
      queue.apply(snapshot(1,[entry("racing","queued"),entry("cancelled","queued")]))
      auth.loggedOut()
      backend.calls[0].callback({snapshot:snapshot(2,[entry("racing","sending"),entry("cancelled","cancelled")])},null)
      compare(account.failures.length,1);compare(account.failures[0],"cancelled");verify(account.sending)
    }
    function test_signout_abandons_queued_sends_in_backend() {
      queue.apply(snapshot(1,[entry("send1","queued")]))
      auth.loggedOut();compare(backend.calls[0].method,"outbox.abandon")
      backend.calls[0].callback({snapshot:snapshot(2,[entry("send1","cancelled")])},null)
      compare(account.failures[0],"send1")
    }
  }
}
