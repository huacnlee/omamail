import QtQuick

import "../account/Aliases.js" as Aliases
import "M365Protocol.js" as M365

// Presentation adapter: the sign-in, Microsoft Graph, MIME conversion and every
// mutation belong to Rust. This turns a call from `MailAccount` into one `m365.*`
// request and the answer back into the shape that call expects.
//
// A request names the account and carries nothing that could authenticate it. One
// the backend answers as signed out is the sign-in having gone: the auth object
// is told once. One made while the auth object is checking the sign-in waits for
// that check: it is sent if the check passes and answered as signed out if not.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property var auth
  property var backend: null
  property string email: ""

  property int inFlight: 0
  readonly property bool busy: inFlight > 0
  // Bumped when a session ends, so a reply from the one before is dropped.
  property int epoch: 0
  property int sequence: 0
  readonly property string tokenPrefix: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
  // `[method, params, callback, handle, accountId]` of the requests waiting for the check.
  property var waiting: []

  // What the last check taught: the capabilities this account gives back to the
  // provider's ceiling and the rail rows whose folder it lacks. Null until a
  // check has answered, which leaves the ceiling and every row as they are.
  readonly property var refusals: M365.refusals(auth ? auth.checked : null)
  readonly property var absentMailboxes: M365.absentMailboxes(auth ? auth.checked : null)

  function newHandle() { return { aborted: false, children: [], tokens: [], accountId: "" } }

  // A handle can have several requests in the air (a search's listing and the
  // rows read for it), each cancelled by its own token.
  function abortRequest(handle) {
    if (!handle || handle.aborted) return
    handle.aborted = true
    var tokens = handle.tokens || []
    for (var i = 0; i < tokens.length; i++) {
      if (backend && backend.ready)
        backend.call("m365.cancel", { accountId: handle.accountId, requestToken: tokens[i] }, function() {})
    }
    handle.tokens = []
    var children = handle.children || []
    for (var j = 0; j < children.length; j++) abortRequest(children[j])
  }

  function nativeRequest(method, params, callback, existingHandle) {
    var handle = existingHandle || newHandle()
    if (handle.aborted) return handle
    if (checking()) {
      waiting = waiting.concat([[method, params, callback, handle, String(auth.accountId || "")]])
      return handle
    }
    var owner = auth
    var account = owner ? String(owner.accountId || "") : ""
    var problem = owner && owner.loggedIn === true ? M365.backendProblem(backend) : M365.sentence("m365_signed_out")
    if (problem !== "") {
      if (typeof callback === "function") callback(null, problem)
      return handle
    }
    var request = Object.assign({}, params, { accountId: account })
    // Only the requests that can be long take a token, and the backend refuses a
    // field it does not know.
    var token = ""
    if (method === "m365.list" || method === "m365.messages") {
      token = tokenPrefix + ":" + String(++sequence)
      request.requestToken = token
      handle.tokens = (handle.tokens || []).concat([token])
      handle.accountId = account
    }
    var generation = epoch
    inFlight++
    backend.call(method, request, function(result, failure) {
      if (!root) return
      root.inFlight = Math.max(0, root.inFlight - 1)
      if (token !== "") handle.tokens = handle.tokens.filter(function(held) { return held !== token })
      var live = owner === root.auth && String(owner.accountId || "") === account && generation === root.epoch
      if (live && failure && M365.isSignedOut(failure)) root.signedOut()
      if (handle.aborted || !live) return
      if (typeof callback === "function")
        callback(failure ? null : result, failure ? M365.requestSentence(method, request, failure) : "")
    })
    return handle
  }

  function checking() {
    return !!auth && auth.loggedIn !== true && (auth.restoring === true || auth.signInStage === "checking")
  }

  // Called a tick after the auth object changes, when its state is whole again.
  function release() {
    if (checking() || waiting.length === 0) return
    var held = waiting
    waiting = []
    for (var i = 0; i < held.length; i++) {
      // Asked of the mailbox that was being checked, never of the one after it.
      if (held[i][4] === String(auth ? auth.accountId || "" : "")) nativeRequest(held[i][0], held[i][1], held[i][2], held[i][3])
      else if (!held[i][3].aborted && typeof held[i][2] === "function") held[i][2](null, M365.sentence("m365_signed_out"))
    }
  }

  function signedOut() {
    if (auth && typeof auth.noteSignedOut === "function") auth.noteSignedOut()
  }

  // An answer that needs no request, given on the next tick like the others.
  function answerLater(callback, result, error) {
    var handle = newHandle()
    Qt.callLater(function() {
      if (root && !handle.aborted && typeof callback === "function") callback(result, error)
    })
    return handle
  }

  function listMessages(query, maxResults, pageToken, callback) {
    var limit = Math.floor(Number(maxResults))
    return nativeRequest("m365.list", { query: String(query || ""),
      limit: limit >= 1 ? Math.min(limit, 100) : 25, pageToken: String(pageToken || "") },
      function(result, error) {
        var page = result ? result.page : null
        if (!error && (!page || !Array.isArray(page.ids))) error = M365.sentence("")
        if (typeof callback !== "function") return
        if (error) { callback(null, error); return }
        callback({ ids: page.ids, threadIds: [], nextPageToken: String(page.nextPageToken || ""),
          estimate: Math.max(0, Math.floor(Number(page.estimate)) || 0) },
          result.warning ? "The mailbox search could not be completed" : "")
      })
  }

  // A listing is never collapsed into conversations, so there are no members.
  function getSummaries(ids, callback) { return answerLater(callback, [], "") }

  function getMessages(ids, full, callback, existingHandle) {
    if (!Array.isArray(ids) || ids.length === 0) return answerLater(callback, [], "")
    return nativeRequest("m365.messages", { ids: ids, full: full === true }, function(result, error) {
      if (typeof callback !== "function") return
      var messages = result && Array.isArray(result.messages) ? result.messages : []
      var partial = !!result && (!!result.warning || !!result.continuation)
      callback(messages, error || (partial ? "Some messages could not be loaded" : ""))
    }, existingHandle)
  }

  function getAttachment(messageId, attachmentId, callback) {
    return nativeRequest("m365.attachment", { messageId: String(messageId || ""),
      attachmentId: String(attachmentId || "") }, function(result, error) {
        if (typeof callback === "function") callback(error || !result ? "" : String(result.data || ""), error)
      })
  }

  // No folders of the user's own: the rail is the roles the registry draws.
  function getLabels(callback) {
    if (typeof callback === "function") callback([], "")
    return newHandle()
  }

  function getProfile(callback) {
    return answerLater(callback, { email: String(email || ""), messagesTotal: 0, threadsTotal: 0, historyId: "" }, "")
  }

  // The mailbox's own address and nothing else: there is no list of identities.
  function getSendAs(callback) {
    return answerLater(callback, Aliases.sendAsList(String(email || "").trim(), []), "")
  }

  function modifyMessage(id, addLabelIds, removeLabelIds, callback) {
    return batchModify([id], addLabelIds, removeLabelIds, callback)
  }

  function batchModify(ids, addLabelIds, removeLabelIds, callback) {
    return changeMessages("m365.modify", { ids: ids, addLabelIds: addLabelIds, removeLabelIds: removeLabelIds }, callback)
  }

  function trashMessage(ids, callback) {
    return changeMessages("m365.trash", { ids: Array.isArray(ids) ? ids : [ids] }, callback)
  }

  function untrashMessage(ids, callback) {
    return changeMessages("m365.untrash", { ids: Array.isArray(ids) ? ids : [ids] }, callback)
  }

  // A change names every id as done or not. Anything not done is a failure, and
  // the failed ids go back as a third argument so the list restores exactly
  // those rows; a failure naming none is the whole request's.
  function changeMessages(method, params, callback) {
    return nativeRequest(method, params, function(result, error) {
      if (typeof callback !== "function") return
      var failed = result && Array.isArray(result.failedIds) ? result.failedIds : []
      var code = result && result.error ? String(result.error) : ""
      if (error || (failed.length === 0 && code === "")) { callback(error ? null : result, error); return }
      if (M365.isSignedOut(code)) root.signedOut()
      callback(result, code !== "" ? M365.sentence(code) : "Microsoft 365 did not apply this change to every message",
        failed.length > 0 ? failed : undefined)
    })
  }

  function saveDraft(payload, callback) {
    return nativeRequest("m365.saveDraft", { raw: String(payload && payload.raw || ""),
      draftId: String(payload && payload.draftId || "") }, callback)
  }

  function deleteDraft(messageId, callback) {
    return nativeRequest("m365.deleteDraft", { id: String(messageId || "") }, callback)
  }

  function sendMessage(payload, callback) {
    return nativeRequest("m365.send", { raw: String(payload && payload.raw || "") }, callback)
  }

  Connections {
    target: root.auth
    ignoreUnknownSignals: true
    function onLoggedOut() {
      root.epoch++
      if (root.backend && root.backend.ready && root.auth && root.auth.accountId)
        root.backend.call("m365.invalidate", { accountId: String(root.auth.accountId) }, function() {})
    }
    function onLoggedInChanged() { Qt.callLater(root.release) }
    function onRestoringChanged() { Qt.callLater(root.release) }
    function onSignInStageChanged() { Qt.callLater(root.release) }
  }
}
