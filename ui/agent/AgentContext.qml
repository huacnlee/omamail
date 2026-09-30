import QtQuick

// The editor supplies selection snapshots; Rust reads and prepares the context.
// Mail stays scoped to the captured account and launches no job until complete.
Item {
  id: root
  required property var service
  required property var runner
  property bool busy: false
  property string error: ""
  property int serial: 0
  property var handle: null
  property string requestId: ""
  property string accountId: ""

  function finishError(text) {
    serial++
    busy = false
    deadline.stop()
    error = String(text || "Could not prepare mail for AI")
    if (requestId !== "" && service && service.backend)
      service.backend.call("agent.contextCancel", {accountId:accountId,requestId:requestId}, function() {})
    requestId = ""
    if (handle && typeof handle.cancel === "function") handle.cancel()
    handle = null
  }

  function selectedSummary(owner, id) {
    var rows = owner.messages || []
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i]
    if (owner.memberSummaries && owner.memberSummaries[id]) return owner.memberSummaries[id]
    return owner.selectedId === id ? owner.selectedMessage : null
  }

  function request(owner, ids, prompt, draftFields, envelope, continuation) {
    if (busy || runner.starting) { error = "AI is still starting. Try again shortly."; return false }
    error = ""
    if (!owner || !Array.isArray(ids) || ids.length === 0 || ids.length > 20) {
      error = "Select between 1 and 20 messages from one mailbox."; return false
    }
    if (String(prompt || "").trim() === "") return false
    if (!service || !service.backend || !service.backend.ready) {
      error = "Mail backend unavailable"; return false
    }
    var summaries = []
    for (var i = 0; i < ids.length; i++) {
      var summary = selectedSummary(owner, ids[i])
      // The native read resolves IDs within this account, independently of the
      // visible folder. A recovered reply need not have a loaded list row.
      summaries.push(summary || {id: String(ids[i])})
    }
    var token = ++serial
    var selected = typeof runner.selection === "function" ? runner.selection() : null
    var capturedOwner = String(owner.accountId || "")
    if (draftFields && String(draftFields.accountId || "") !== capturedOwner) {
      error = "Draft belongs to another mailbox."; return false
    }
    var modern = Number(service.backend.apiVersion) >= 6
    if (!modern) envelope = null
    var replyText = envelope && owner.selectedBody ? String(owner.selectedBody.text || "") : ""
    accountId = capturedOwner
    requestId = "context-" + Date.now() + "-" + token
    busy = true
    deadline.restart()
    handle = service.backend.call("agent.context", {accountId:capturedOwner,
      requestId:requestId, ids:ids, summaries:summaries,
      folder:String(owner.mailboxKey || ""), prompt:String(prompt)}, function(result, failure) {
      if (token !== root.serial) return
      if (!owner || root.service.findAccount(capturedOwner) !== owner) {
        root.finishError("That mailbox is no longer set up."); return
      }
      if (failure || !result || !result.payload) {
        // Missing/offline original mail must not strand a valid recovered
        // draft or an existing conversation. Keep its captured draft/context;
        // never turn a size-limit refusal into a smaller, misleading request.
        if (failure && failure.message !== "agent_context_too_large" && (draftFields || continuation)) {
          launch(continuation || {draftFields: draftFields, ask: prompt,
            account: String(owner.accountEmail || ""), accountId: capturedOwner})
          return
        }
        root.finishError(failure && failure.message === "agent_context_too_large"
          ? "These messages are too large. Select fewer messages."
          : "Could not prepare mail for AI. Try again.")
        return
      }
      if (String(result.payload.accountId || "") !== capturedOwner) {
        root.finishError("Mail context does not belong to this mailbox."); return
      }
      function launch(payload) {
        if (token !== root.serial) return
        if (!owner || root.service.findAccount(capturedOwner) !== owner) {
          root.finishError("That mailbox is no longer set up."); return
        }
        root.busy = false
        root.deadlineStop()
        root.requestId = ""
        root.handle = null
        var started = continuation || payload.draftFields ? root.runner.start(payload, false, selected) : root.runner.start(JSON.stringify(payload), false, selected)
        if (!started) root.error = root.runner.lastError
      }
      if (continuation) {
        var next = JSON.parse(JSON.stringify(continuation))
        if (modern) {
          next.mailUpdate = {accountId: capturedOwner, messageId: String(result.payload.messageId), message: String(result.payload.message)}
          if (result.payload.threadMessages) next.mailUpdate.threadMessages = result.payload.threadMessages
          if (result.payload.threadContext) next.mailUpdate.threadContext = result.payload.threadContext
        }
        launch(next)
        return
      }
      if (envelope) result.payload.envelope = envelope
      if (draftFields) {
        if (String(draftFields.accountId) !== capturedOwner) { root.finishError("Draft belongs to another mailbox."); return }
        result.payload.draftKey = String(draftFields.draftKey)
        result.payload.draft = {from: String(draftFields.from || ""), to: String(draftFields.to || ""),
          subject: String(draftFields.subject || ""), body: String(draftFields.body || "")}
        if (modern) {
          result.payload.draft.cc = String(draftFields.cc || "")
          result.payload.draft.bcc = String(draftFields.bcc || "")
          if (draftFields.envelope) result.payload.envelope = draftFields.envelope
        }
      }
      if (envelope && !draftFields) {
        root.handle = root.service.backend.call("message.composeText", {
          summary: summaries[0], body: replyText, signature: String(envelope.body || "")
        }, function(prepared, failure) {
          if (token !== root.serial) return
          if (failure || !prepared) { root.finishError("Could not prepare the reply text."); return }
          result.payload.envelope.replyQuote = String(prepared.quote || "")
          result.payload.envelope.subject = String(prepared.replySubject || "")
          launch(result.payload)
        })
      } else launch(result.payload)
    })
    return true
  }

  function deadlineStop() { deadline.stop() }
  Timer {
    id: deadline
    interval: 60000
    onTriggered: root.finishError("Reading mail for AI timed out. Try again.")
  }
  Component.onDestruction: {
    if (busy) finishError("Cancelled")
  }
}
