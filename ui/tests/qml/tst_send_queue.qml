import QtQuick 2.15
import QtTest 1.3
import "../../account" as Account

Item {
  QtObject {
    id: account
    property int undoSendSeconds: 10
    property bool sending: false
    property int sendSecondsRemaining: 0
    property var delivered: []
    function deliver(payload) {
      delivered = delivered.concat([payload])
      return true
    }
    function note(_message) {}
  }

  Account.SendQueue { id: queue; account: account }

  TestCase {
    name: "SendQueue"

    function init() {
      queue.parked = []
      queue.delayTimer.stop()
      queue.countdownTimer.stop()
      account.delivered = []
      account.sending = false
    }

    function cleanup() {
      queue.parked = []
      queue.arm()
    }

    function test_a_newer_due_send_cannot_overtake_the_oldest() {
      var now = Date.now()
      queue.parked = [
        { id: "older", payload: "older", dueAt: now + 30000, queuedAt: now, order: 1 },
        { id: "newer", payload: "newer", dueAt: now - 1, queuedAt: now + 1, order: 2 }
      ]

      compare(queue.deliverDue(), false)
      compare(account.delivered.length, 0)
      compare(queue.parked.length, 2)
      compare(queue.parked[0].id, "older")
    }
  }
}
