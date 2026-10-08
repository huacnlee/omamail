import QtQuick

// "Mark all read..." for one mailbox. The backend marks at most one page of
// Unread per call, so a deep mailbox takes many calls; this repeats the step
// until Unread is empty and reports the running total after each one.
//
// It stops, and says why, on anything that is not progress: a stall (the
// backend confirmed nothing, so the same page would come back forever), an
// error, the step limit, or the host no longer being this mailbox. The list
// and counts reload once at the end rather than after every step.
QtObject {
  id: root

  required property var account
  // About 20,000 messages at the backend's 100 per step. A run that reaches
  // it says so, and running it again carries on where it stopped.
  property int stepLimit: 200
  property bool running: false

  function run(onProgress, onDone) {
    if (running || !account || !account.ready || !account.backend) return false
    running = true
    var mailbox = account.accountId
    var total = { marked: 0, failed: 0, stalled: false, limited: false, error: "" }
    var steps = 0

    function finish(reload) {
      running = false
      if (reload && total.marked > 0) account.refresh()
      if (onDone) onDone(total)
    }
    function stillHere() { return account.ready && account.accountId === mailbox }
    function next() {
      if (!stillHere()) { finish(false); return }
      if (steps >= stepLimit) { total.limited = true; finish(true); return }
      steps++
      account.backend.call("mail.clearUnread", { account: mailbox, execute: true }, function(result, error) {
        if (error) {
          var code = error.message !== undefined ? String(error.message) : String(error)
          // The provider client owns the wording of its backend's errors.
          var api = account.api
          if (code === "mail_clear_unread_stalled") total.stalled = true
          else total.error = api && typeof api.backendError === "function"
            ? String(api.backendError(error, "mail.clearUnread")) : code
          finish(stillHere())
          return
        }
        if (!result || result.done === true) { finish(stillHere()); return }
        total.marked += Math.max(0, Math.floor(Number(result.marked)) || 0)
        total.failed += Math.max(0, Math.floor(Number(result.failed)) || 0)
        if (onProgress) onProgress(total.marked)
        next()
      })
    }
    next()
    return true
  }
}
