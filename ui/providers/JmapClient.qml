import QtQuick
import "JmapProtocol.js" as Jmap

// Presentation adapter: all credentials, sessions, HTTP, query planning,
// MIME conversion, conversation membership and mutations belong to Rust.
Item {
  id: root
  visible: false
  width: 0
  height: 0
  required property var auth
  property var backend: null
  property string email: ""
  property var cache: null
  property int inFlight: 0
  readonly property bool busy: inFlight > 0
  property bool credentialsRejected: false
  property var session: null
  property var mailboxList: []
  property var knownStates: ({})
  property string serverIdentity: ""
  property bool mailboxesLoaded: false
  property int sequence: 0
  property int epoch: 0
  property var verificationHandle: null
  readonly property string accountId: Jmap.primaryAccountId(session)
  readonly property var roles: Jmap.roleMap(mailboxList)
  readonly property var refusals: Jmap.refusals(session, accountId, mailboxList)
  readonly property var absentMailboxes: Jmap.absentMailboxes(mailboxList)
  signal remoteChanged(var plan)

  function newHandle() { return { aborted: false, requestId: "", children: [] } }
  function abortRequest(handle) {
    if (!handle || handle.aborted) return
    handle.aborted = true
    if (handle.requestId && backend && backend.ready)
      backend.call("jmap.cancel", { requestId: handle.requestId }, function() {})
    var children = handle.children || []
    for (var i = 0; i < children.length; i++) abortRequest(children[i])
  }
  function applyState(state) {
    if (!state) return
    session = state.session || null
    mailboxList = state.mailboxes || []
    knownStates = state.knownStates || {}
    mailboxesLoaded = true
    serverIdentity = Jmap.serverIdentity(auth ? auth.settings : null)
  }
  function sentence(error) {
    var code = error ? String(error.message || "") : ""
    if (code === "jmap_unauthorized" || code === "credential_missing") return "Sign in to this mailbox again"
    if (code === "jmap_missing_mailbox") return "The destination mailbox is unavailable"
    if (code === "jmap_message_not_found") return "That message is no longer in the mailbox"
    if (code === "jmap_request_too_large") return "This request is larger than the server accepts"
    if (code === "jmap_submission_unconfirmed") return "The server did not confirm sending. Check Sent before trying again"
    if (code === "jmap_send_unavailable") return "This account cannot send mail"
    if (code === "jmap_spam_unavailable") return "This server is not known to learn from its Junk mailbox"
    if (code === "jmap_timeout" || code === "request_timed_out") return "The mail server took too long to answer"
    return "The mail server could not complete this request"
  }
  function nativeRequest(method, params, callback, existingHandle) {
    var handle = existingHandle || newHandle()
    if (handle.aborted) return handle
    if (credentialsRejected) {
      if (typeof callback === "function") callback(null, "Sign in to this mailbox again")
      return handle
    }
    if (!backend || !backend.ready) {
      if (typeof callback === "function") callback(null, "Mail backend unavailable")
      return handle
    }
    var account = auth ? String(auth.accountId || "") : ""
    var generation = epoch
    var requestId = "jmap-" + account + "-" + Date.now() + "-" + (++sequence)
    handle.requestId = requestId
    var request = Object.assign({}, params || {}, { accountId: account, requestId: requestId })
    inFlight++
    backend.call(method, request, function(result, error) {
      if (!root) return
      root.inFlight = Math.max(0, root.inFlight - 1)
      handle.requestId = ""
      if (handle.aborted || generation !== root.epoch) return
      if (error) {
        var code = String(error.message || "")
        if (code === "jmap_unauthorized" || code === "credential_missing") root.credentialsRejected = true
      } else if (result) root.applyState(result.state)
      if (typeof callback === "function") callback(error || !result ? null : result.data, error ? root.sentence(error) : "")
    })
    return handle
  }
  function forgetServer() {
    abortRequest(verificationHandle)
    verificationHandle = null
    epoch++
    session = null
    mailboxList = []
    knownStates = ({})
    mailboxesLoaded = false
    serverIdentity = ""
    if (backend && backend.ready && auth && auth.accountId)
      backend.call("jmap.invalidate", { accountId: String(auth.accountId) }, function() {})
  }
  function announce(step) { if (auth && typeof auth.reportProgress === "function") auth.reportProgress(step) }
  function verifyCredentials(settings, address, secret, callback) {
    var handle = newHandle()
    if (!backend || !backend.ready) {
      if (typeof callback === "function") callback(null, "Mail backend unavailable", false)
      return handle
    }
    announce(1)
    var generation = epoch
    var owner = auth
    handle.requestId = "jmap-verify-" + Date.now() + "-" + (++sequence)
    verificationHandle = handle
    var values = settings || {}
    backend.call("jmap.verify", { requestId: handle.requestId, settings: values, address: String(address || ""), secret: String(secret || "") },
      function(result, error) {
        if (!root || handle.aborted || generation !== root.epoch || owner !== root.auth) return
        root.verificationHandle = null
        handle.requestId = ""
        root.announce(0)
        if (error || !result) {
          var code = error ? String(error.message || "") : ""
          if (code === "jmap_unauthorized") root.credentialsRejected = true
          var message = code === "jmap_unauthorized" ? "The server rejected that app password or API token"
            : code === "jmap_discovery_failed" ? "No JMAP server answered. Enter the server yourself"
            : code === "jmap_no_mailbox" ? "The server has no mailbox for this account"
            : code === "jmap_unsupported_sort" ? "The server cannot sort mail by date, which this client needs"
            : "Could not verify this JMAP mailbox"
          if (typeof callback === "function") callback(null, message, code === "jmap_discovery_failed" || code === "jmap_invalid_url")
          return
        }
        root.session = result.session
        root.serverIdentity = Jmap.serverIdentity({ sessionUrl: result.sessionUrl, username: values.username })
        root.mailboxList = result.mailboxes || []
        root.mailboxesLoaded = root.mailboxList.length > 0
        root.credentialsRejected = false
        if (typeof callback === "function") callback(result, "", false)
      })
    return handle
  }
  function ensureSession(callback) { return nativeRequest("jmap.session", {}, function(result, error) { if (typeof callback === "function") callback(error) }) }
  function ensureMailboxes(callback) { return ensureSession(callback) }
  function getProfile(callback) { return nativeRequest("jmap.profile", {}, callback) }
  function listMessages(query, maxResults, pageToken, callback, progress) { return nativeRequest("jmap.list", { query: String(query || ""), maxResults: Number(maxResults) || 25, pageToken: String(pageToken || "") }, callback) }
  function getSummaries(ids, callback) { return nativeRequest("jmap.messages", { ids: ids || [], withBlocks: false }, callback) }
  function getMessages(ids, full, callback, existingHandle, progress) {
    return nativeRequest("jmap.messages", { ids: ids || [], withBlocks: true }, function(messages, error) {
      if (!error && typeof progress === "function") progress(messages || [])
      if (typeof callback === "function") callback(messages || [], error)
    }, existingHandle)
  }
  function getMessage(id, full, callback) { return nativeRequest("jmap.read", { id: String(id || ""), full: full === true }, callback) }
  function getAttachment(messageId, attachmentId, callback) { return nativeRequest("jmap.attachment", { attachmentId: String(attachmentId || "") }, callback) }
  function getLabels(callback) { return nativeRequest("jmap.labels", {}, callback) }
  function getLabelCounts(id, callback) { return nativeRequest("jmap.labelCounts", { id: String(id || "") }, callback) }
  function modifyMessage(id, added, removed, callback) { return batchModify([id], added, removed, callback) }
  function batchModify(ids, added, removed, callback) { return nativeRequest("jmap.batchModify", { ids: ids || [], addLabelIds: added || [], removeLabelIds: removed || [] }, callback) }
  function trashMessage(ids, callback) { return nativeRequest("jmap.trash", { ids: Array.isArray(ids) ? ids : [ids] }, callback) }
  function untrashMessage(ids, callback) { return nativeRequest("jmap.untrash", { ids: Array.isArray(ids) ? ids : [ids] }, callback) }
  function getSendAs(callback) { return nativeRequest("jmap.sendAs", {}, callback) }
  function sendMessage(payload, callback) { return nativeRequest("jmap.send", payload || {}, callback) }
  function saveDraft(payload, callback) { return nativeRequest("jmap.saveDraft", payload || {}, callback) }

  Connections {
    target: root.auth
    function onVerifyRequested(settings, address, secret) {
      root.verifyCredentials(settings, address, secret, function(result, error, needsServer) {
        if (root.auth) root.auth.completeSignIn(!error, result, error, needsServer)
      })
    }
    function onSettingsChanged() {
      if (Jmap.serverIdentity(root.auth ? root.auth.settings : null) !== root.serverIdentity) root.forgetServer()
    }
    function onLoggedOut() { root.credentialsRejected = false; root.forgetServer() }
  }
  JmapPush {
    client: root
    onRemoteChanged: function(plan) { root.remoteChanged(plan) }
    onSecretRejected: root.credentialsRejected = true
  }
}
