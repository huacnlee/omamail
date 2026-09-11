import QtQuick
import "../message/Outbox.js" as Outbox

// The sends parked for their undo window, oldest first. One parked send used
// to be all there was, and a second was refused — but a reply written while
// the last one is still counting down is the ordinary way a morning's mail
// gets answered, and the undo window is what makes the refusal likely rather
// than rare. Each send waits its own moment here and goes when it comes.
//
// One at a time on the wire: a send in flight holds the rest until it
// answers, so the account's single `sending` slot still means what it says
// and a provider sees the messages in the order they were written. One timer
// serves the lot — it waits for whichever is due first — and the countdown
// shown is the newest's, since that is the send Undo would take back.
//
// Beside the account rather than in it, which is at its size ceiling.
QtObject {
  id: queue

  required property var account

  // Each entry is { id, payload, dueAt, queuedAt, order }. `order` is the
  // service's count across every account, so "the newest" has one answer
  // when two accounts park a send in the same millisecond.
  property var parked: []
  readonly property var latest: parked.length > 0 ? parked[parked.length - 1] : null
  // Names sends this account parked, when nothing else named them.
  property int serial: 0

  function park(payload, id, order) {
    var now = Date.now()
    var queued = Outbox.schedule(payload, now, account.undoSendSeconds)
    // No undo window and nothing ahead of it: it goes now, as it always did.
    // Behind another send it waits its turn like any other.
    if (!queued && !account.sending && parked.length === 0) return account.deliver(payload)
    var next = parked.slice()
    next.push({
      id: String(id || ""), payload: payload, dueAt: queued ? queued.dueAt : now,
      queuedAt: now, order: Math.floor(Number(order)) || 0
    })
    parked = next
    arm()
    account.note(parked.length === 1 ? "Message queued" : parked.length + " messages queued")
    return true
  }

  // The timer waits for whichever send is due first; the countdown is the
  // newest's, which is the one the toast is offering to take back.
  function arm() {
    if (parked.length === 0) {
      delayTimer.stop()
      countdownTimer.stop()
      account.sendSecondsRemaining = 0
      return
    }
    var due = parked[0].dueAt
    delayTimer.interval = Math.max(1, due - Date.now())
    delayTimer.restart()
    if (!countdownTimer.running) countdownTimer.restart()
    account.sendSecondsRemaining = Outbox.remainingSeconds(latest.dueAt, Date.now())
  }

  // The parked send whose moment has come, oldest first and one at a time.
  function deliverDue() {
    if (account.sending || parked.length === 0) return false
    var now = Date.now()
    if (parked[0].dueAt > now) {
      arm()
      return false
    }
    var next = parked.slice()
    var entry = next.shift()
    parked = next
    arm()
    if (account.deliver(entry.payload)) return true
    // A send refused on the spot has reported itself; the next is not held
    // back by it.
    Qt.callLater(queue.deliverDue)
    return false
  }

  function deliverAll() {
    if (parked.length === 0) return false
    var next = parked.slice()
    for (var i = 0; i < next.length; i++) next[i].dueAt = 0
    parked = next
    return deliverDue()
  }

  // The newest, because the send just asked for is the one a second thought
  // is about. Answers with its name so the composer restores that draft.
  function undoLatest() {
    if (parked.length === 0) return ""
    var next = parked.slice()
    var entry = next.pop()
    parked = next
    arm()
    account.note("Send undone")
    return entry.id
  }

  // Everything parked is let go — the account is leaving — and the names are
  // handed back so the composer can put those drafts in front of the writer.
  function abandon() {
    var ids = []
    for (var i = 0; i < parked.length; i++) ids.push(parked[i].id)
    parked = []
    arm()
    return ids
  }

  readonly property Timer delayTimer: Timer {
    repeat: false
    onTriggered: queue.deliverDue()
  }

  readonly property Timer countdownTimer: Timer {
    interval: 250
    repeat: true
    onTriggered: {
      if (queue.parked.length === 0) {
        stop()
        return
      }
      queue.account.sendSecondsRemaining = Outbox.remainingSeconds(
        queue.latest.dueAt, Date.now())
    }
  }
}
