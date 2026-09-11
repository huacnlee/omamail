import QtQuick
import "Agent.js" as Agent
import "../account/Model.js" as Model
import "../message/Message.js" as Mail

// Read through the owning provider before handing mail to system AI. This
// never changes selection or marks mail read. A request retains its owner.
Item {
  id: root
  required property var service
  required property var runner
  property bool busy: false
  property string error: ""
  property int serial: 0
  property var handles: []

  function finishError(text) {
    serial++
    busy = false
    deadline.stop()
    error = String(text || "Could not prepare mail for AI")
    var pending = handles
    handles = []
    for (var i = 0; i < pending.length; i++) {
      if (pending[i] && typeof pending[i].cancel === "function") pending[i].cancel()
    }
  }

  function request(owner, ids, prompt) {
    if (busy || runner.starting) { error = "AI is still starting. Try again shortly."; return false }
    error = ""
    if (!owner || !owner.api || !Array.isArray(ids) || ids.length === 0 || ids.length > 20) {
      error = "Select between 1 and 20 messages from one mailbox."; return false
    }
    if (String(prompt || "").trim() === "") return false
    var summaries = []
    for (var i = 0; i < ids.length; i++) {
      var summary = Model.messageById(owner.messages, [], ids[i])
      if (!summary && owner.memberSummaries) summary = owner.memberSummaries[ids[i]]
      if (!summary && owner.selectedId === ids[i]) summary = owner.selectedMessage
      if (!summary) { error = "That message is no longer available."; return false }
      summaries.push(summary)
    }
    var token = ++serial
    var capturedOwner = owner.accountId
    var folder = owner.mailboxKey
    var rows = []
    var next = 0
    var totalChars = 0
    busy = true
    handles = []
    deadline.restart()
    function readNext() {
      if (token !== root.serial) return
      if (!owner || root.service.findAccount(capturedOwner) !== owner) {
        root.finishError("That mailbox is no longer set up."); return
      }
      if (next === ids.length) {
        root.busy = false
        root.deadlineStop()
        root.handles = []
        var line = rows.length === 1
          ? Agent.payload(rows[0], rows[0].bodyText, owner.accountEmail,
            Agent.folderOf(ids[0], folder, owner.providerId), prompt, capturedOwner)
          : Agent.selectionPayload(rows, owner.accountEmail, folder, prompt, capturedOwner)
        if (!root.runner.start(line)) root.error = root.runner.lastError
        return
      }
      var at = next++
      var handle = owner.api.getMessage(ids[at], true, function(payload, failure) {
        if (token !== root.serial) return
        if (failure || !payload) { root.finishError(failure || "Could not read that message."); return }
        var row = Model.detailSummary(summaries[at], Mail.summarize(payload, new Date()))
        row.id = ids[at]
        row.bodyText = Mail.extractBody(payload.payload).text
        totalChars += Agent.messageText(row, row.bodyText).length
        if (totalChars > 200000) { root.finishError("These messages are too large. Select fewer messages."); return }
        rows.push(row)
        readNext()
      })
      if (handle && root.busy) root.handles = root.handles.concat([handle])
    }
    readNext()
    return true
  }

  function deadlineStop() { deadline.stop() }
  Timer {
    id: deadline
    interval: 60000
    onTriggered: root.finishError("Reading mail for AI timed out. Try again.")
  }
}
