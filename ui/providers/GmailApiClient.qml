import QtQuick

import "GmailApi.js" as Api

// Authenticated transport. It holds no state about the mailbox — only about
// requests in flight — so the service can cancel a page load without having to
// know anything about how it was issued.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property var auth
  property var backend: null
  property int backendEpoch: 0
  property string backendAccount: ""
  readonly property string backendIdentity: auth ? String(auth.accountId || "") : ""
  onBackendIdentityChanged: invalidateBackend()
  onAuthChanged: invalidateBackend()
  Connections {
    target: root.auth
    function onLoggedOut() { root.invalidateBackend() }
    function onLoggedInChanged() {
      if (!root.auth || !root.auth.loggedIn) root.invalidateBackend()
    }
  }
  Component.onDestruction: invalidateBackend()

  // Gmail's list endpoint returns ids only, so every page costs one list call
  // plus one metadata call per message. Those are fired together rather than
  // in sequence: 25 sequential round trips to Google is most of a second of
  // staring at an empty panel.
  property int inFlight: 0
  readonly property bool busy: inFlight > 0

  function newHandle() {
    return { aborted: false, children: [] }
  }

  function usesBackend() {
    return backend && String(backend.executable || "") !== ""
  }

  function invalidateBackend() {
    backendEpoch++
    var old = backendAccount
    backendAccount = ""
    // Cache eviction only: queued requests and external keyring credentials
    // are not revoked by this message. Epochs suppress stale UI delivery.
    if (old !== "" && usesBackend())
      backend.call("gmail.invalidate", { accountId: old }, function() {})
  }

  function backendError(error, method) {
    var code = String(error && error.message || "")
    if (code === "gmail_timeout" || code === "request_timed_out")
      return /^(gmail\.(modify|batchModify|createLabel|renameLabel|deleteLabel|trash|untrash|send|saveDraft|updateDraft|deleteDraft))$/.test(method)
        ? "Gmail did not answer in time. The submitted change may have completed."
        : "Gmail did not answer in time"
    if (code === "gmail_unauthorized" || code === "gmail_invalid_token")
      return "Gmail authorization expired. Sign in again."
    if (code === "gmail_forbidden") return "Gmail refused this request (HTTP 403). Check account permissions."
    if (code === "gmail_length_required") return "Gmail rejected the request format (HTTP 411)."
    if (code === "gmail_rate_limited") return "Gmail is receiving too many requests (HTTP 429). Try again later."
    if (code === "gmail_draft_missing") return "That draft is no longer in the mailbox"
    return "Gmail backend could not complete this request"
  }

  function backendRequest(method, params, callback) {
    var handle = newHandle()
    var account = auth ? String(auth.accountId || "") : ""
    if (!usesBackend() || !auth || !auth.loggedIn || account === "") {
      Qt.callLater(function() {
        if (!handle.aborted && typeof callback === "function")
          callback(null, !usesBackend() ? "Mail backend is unavailable" : "Sign in to the configured Gmail account first")
      })
      return handle
    }
    backendAccount = account
    var epoch = backendEpoch
    var session = auth
    params.accountId = account
    root.inFlight++
    var settled = false
    backend.call(method, params, function(result, error) {
      if (!root || settled) return
      settled = true
      root.inFlight = Math.max(0, root.inFlight - 1)
      if (handle.aborted || epoch !== root.backendEpoch || auth !== session
          || !auth.loggedIn || String(auth.accountId || "") !== account) return
      if (typeof callback === "function")
        callback(error ? null : result, error ? backendError(error, method) : "")
    })
    return handle
  }

  function abortRequest(handle) {
    if (!handle) return
    handle.aborted = true
    var children = handle.children || []
    for (var i = 0; i < children.length; i++) abortRequest(children[i])
    handle.children = []
  }

  // ---------------------------------------------------------------- reads

  function listMessages(query, maxResults, pageToken, callback, progress) {
    return backendRequest("gmail.list", {
      query: String(query || ""), pageToken: String(pageToken || ""),
      pageSize: Math.max(1, Math.min(100, Math.floor(Number(maxResults) || 25)))
    }, callback)

  }

  function getMessage(id, full, callback) {
    return backendRequest("gmail.read", {
      id: String(id || ""), full: !!full
    }, callback)

  }

  // The octets of a part Gmail described but did not send. Every part the
  // sender named comes back that way — an id, a type and a size — and the
  // reader asks for one of them: the invitation, whose file has to be read
  // before a meeting can be drawn or answered.
  function getAttachment(messageId, attachmentId, callback) {
    return backendRequest("gmail.attachment", {
      messageId: String(messageId || ""), attachmentId: String(attachmentId || "")
    }, function(payload, error) {
      if (typeof callback === "function")
        callback(error || !payload ? "" : String(payload.data || ""), error)
    })

  }

  // The counted members of a conversation, for the reader's conversation rail.
  //
  // Always empty, and Gmail is never asked: it declares `threads` — a
  // server-side thread id exists — but not `conversations`, so its listing is
  // one row per message and no row here carries member ids for a rail to draw.
  //
  // Deferred rather than answered on the spot even though the answer is in
  // hand: every caller in this interface is written against a callback that
  // arrives later, and running one partway through the function that started it
  // is a re-entry no other read produces.
  function getSummaries(ids, callback) {
    var handle = newHandle()
    Qt.callLater(function() {
      if (!root || handle.aborted || typeof callback !== "function") return
      callback([], "")
    })
    return handle
  }

  // Fetches every id at once and calls back once, with the results in the
  // order the ids were given rather than the order Google answered in. A list
  // search may also take `progress`, which receives the payloads as Google
  // answers so cached rows can be filled in without waiting for the slowest
  // request on the page. Answers close enough to share a frame are batched:
  // repainting and sorting the whole list once per one of 25 parallel replies
  // costs far more than the few milliseconds of extra latency reveal.
  function getMessages(ids, full, callback, existingHandle, progress) {
    var handle = existingHandle || newHandle()
    var list = Array.isArray(ids) ? ids : []
    var results = new Array(list.length)
    var remaining = list.length
    var firstError = ""
    var pendingProgress = []
    var progressTimer = null

    if (remaining === 0) {
      if (typeof callback === "function") callback([], "")
      return handle
    }

    function flushProgress() {
      if (progressTimer) {
        progressTimer.stop()
        progressTimer.destroy()
        progressTimer = null
      }
      if (handle.aborted || pendingProgress.length === 0) return
      var ready = pendingProgress
      pendingProgress = []
      if (typeof progress === "function") progress(ready)
    }

    function queueProgress(payload) {
      if (!payload || typeof progress !== "function") return
      pendingProgress.push(payload)
      if (progressTimer) return
      progressTimer = progressTimerComponent.createObject(root, { interval: 16 })
      if (!progressTimer) {
        flushProgress()
        return
      }
      progressTimer.triggered.connect(flushProgress)
      progressTimer.start()
    }

    function finish() {
      if (handle.aborted) return
      if (typeof callback !== "function") return
      flushProgress()
      var ordered = []
      for (var i = 0; i < results.length; i++) {
        if (results[i]) ordered.push(results[i])
      }
      // A partial page is still a failed page: hiding one failed request just
      // because another answered would let the caller keep a continuation
      // token beyond the missing row.
      callback(ordered, firstError)
    }

    for (var i = 0; i < list.length; i++) {
      (function(index) {
        var child = root.getMessage(list[index], full, function(payload, error) {
          if (handle.aborted) return
          if (error && !firstError) firstError = error
          results[index] = payload
          queueProgress(payload)
          remaining--
          if (remaining === 0) finish()
        })
        handle.children.push(child)
      })(i)
    }
    return handle
  }

  function getLabels(callback) {
    return backendRequest("gmail.labels", {}, function(result, error) {
      if (typeof callback === "function") callback(error ? [] : result, error)
    })

  }

  function getLabelCounts(labelId, callback) {
    return backendRequest("gmail.labelCounts", { id: String(labelId || "") }, callback)

  }

  function getProfile(callback) {
    // The native sign-in already verified this identity before storing its
    // grant. A new account has no registry ID until this callback identifies it.
    if (auth && auth.loggedIn && auth.signedInProfile) {
      var handle = newHandle()
      var session = auth
      var profile = Api.parseProfile(auth.signedInProfile)
      Qt.callLater(function() {
        if (!handle.aborted && root.auth === session && session.loggedIn)
          callback(profile, "")
      })
      return handle
    }
    return backendRequest("gmail.profile", {}, callback)

  }

  function getSendAs(callback) {
    return backendRequest("gmail.sendAs", {}, function(result, error) {
      if (typeof callback === "function") callback(error ? [] : result, error)
    })

  }

  // Mail operations and draft resolution are owned by the persistent backend.
  function modifyMessage(id, addLabelIds, removeLabelIds, callback) {
    return backendRequest("gmail.modify", { id: String(id || ""), addLabelIds: addLabelIds || [], removeLabelIds: removeLabelIds || [] }, callback)
  }
  function batchModify(ids, addLabelIds, removeLabelIds, callback) {
    return backendRequest("gmail.batchModify", { ids: ids || [], addLabelIds: addLabelIds || [], removeLabelIds: removeLabelIds || [] }, callback)
  }
  function createLabel(name, callback) {
    return backendRequest("gmail.createLabel", { name: String(name || "") }, callback)
  }
  function renameLabel(id, name, callback) {
    return backendRequest("gmail.renameLabel", { id: String(id || ""), name: String(name || "") }, callback)
  }
  function deleteLabel(id, callback) {
    return backendRequest("gmail.deleteLabel", { id: String(id || "") }, callback)
  }
  function trashMessage(id, callback) { return trashEach("gmail.trash", id, callback) }
  function untrashMessage(id, callback) { return trashEach("gmail.untrash", id, callback) }
  function trashEach(method, id, callback) {
    var list = Array.isArray(id) ? id : [id]
    var handle = newHandle()
    var remaining = list.length
    var firstError = ""
    if (!remaining) {
      Qt.callLater(function() { if (!handle.aborted && typeof callback === "function") callback(null, "") })
      return handle
    }
    for (var i = 0; i < list.length; i++) {
      handle.children.push(backendRequest(method, { id: String(list[i] || "") }, function(payload, error) {
        if (handle.aborted) return
        if (error && !firstError) firstError = error
        remaining--
        if (!remaining && typeof callback === "function") callback(payload, firstError)
      }))
    }
    return handle
  }
  Component {
    id: progressTimerComponent
    Timer { repeat: false }
  }
  function sendMessage(payload, callback) {
    return backendRequest("gmail.send", Api.sendBody(payload), callback)
  }
  function saveDraft(payload, callback) {
    var id = payload ? String(payload.draftId || "") : ""
    if (id !== "") return updateDraft(id, payload, callback)
    return backendRequest("gmail.saveDraft", Api.sendBody(payload), callback)
  }
  function updateDraft(messageId, payload, callback) {
    var params = Api.sendBody(payload)
    params.id = String(messageId || "")
    return backendRequest("gmail.updateDraft", params, callback)
  }
  function deleteDraft(messageId, callback) {
    return backendRequest("gmail.deleteDraft", { id: String(messageId || "") }, callback)
  }
}
