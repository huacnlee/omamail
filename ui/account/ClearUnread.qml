import QtQuick
import "Model.js" as Model

// "Mark all read..." for one mailbox: every unread message in its Inbox. The
// backend marks at most one page of them per call, so a deep Inbox takes many
// calls; this repeats the step until none is left and reports the running
// total after each one.
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

  // How many messages a run would mark: the Inbox's unread count, read from
  // the provider's mailbox counter, past 500 too. Calls back with a number,
  // or null when no exact count is available.
  function countInbox(callback) {
    var api = account ? account.api : null
    var provider = account ? String(account.providerId || "") : ""
    function answer(result, error) {
      callback(!error && result && result.unread !== undefined
        ? Math.max(0, Math.floor(Number(result.unread)) || 0) : null)
    }
    if (api && typeof api.getLabelCounts === "function") {
      if (provider !== "jmap") {
        api.getLabelCounts("INBOX", answer)
        return
      }
      // JMAP names mailboxes by opaque ids; the Inbox is the one by role.
      var boxes = api.mailboxList || []
      for (var i = 0; i < boxes.length; i++) {
        if (boxes[i] && boxes[i].role === "inbox") {
          api.getLabelCounts(String(boxes[i].id), answer)
          return
        }
      }
      Qt.callLater(function() { callback(null) })
      return
    }
    // HEY has no mailbox counter. Its unread count is the size of the whole
    // `box:imbox unseen` listing, which is the Imbox's unread messages.
    var unread = account ? Math.max(0, Math.floor(Number(account.inboxUnread)) || 0) : 0
    Qt.callLater(function() { callback(unread) })
  }

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
          // The provider client owns the wording of its backend's errors:
          // Gmail and IMAP name it backendError, JMAP sentence, HEY has none.
          var api = account.api
          if (code === "mail_clear_unread_stalled") total.stalled = true
          else if (api && typeof api.backendError === "function")
            total.error = String(api.backendError(error, "mail.clearUnread"))
          else if (api && typeof api.sentence === "function") total.error = String(api.sentence(error))
          else total.error = Model.clearUnreadErrorText(code)
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
