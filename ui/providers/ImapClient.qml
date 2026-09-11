import QtQuick

import "../account/Aliases.js" as Aliases

Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property var auth
  required property string email
  property var backend: null

  property int inFlight: 0
  readonly property bool busy: inFlight > 0

  readonly property bool oauthTransport: !!auth && String(auth.authMode || "") === "oauth2"

  property var nativeLabels: []
  property int nativeRequestGeneration: 0
  property string nativeRequestPrefix: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
  property var folders: []
  property var special: ({})
  property bool foldersLoaded: false
  property bool foldersLoading: false
  property int foldersGeneration: 0
  property var folderWaiters: []

  property var serverCapabilities: []

  function newHandle() {
    return { aborted: false, children: [], requestToken: "", accountId: "" }
  }

  function abortRequest(handle) {
    if (!handle) return
    handle.aborted = true
    if (handle.requestToken && backend && backend.ready)
      backend.call("imap.cancel", { accountId: handle.accountId,
        requestToken: handle.requestToken }, function() {})
    var children = handle.children || []
    for (var i = 0; i < children.length; i++) abortRequest(children[i])
    handle.children = []
  }

  function backendError(error) {
    var code = String(error && error.message || "")
    if (code === "smtp_delivery_unknown") return "The server did not confirm delivery. Check Sent before sending again."
    if (code === "mail_auth_failed" || code === "auth_signed_out") return "The server rejected the sign-in. Sign in again."
    if (code === "mail_tls_failed") return "The mail server's secure connection could not be verified"
    if (code === "request_timed_out") return "The mail server did not answer in time"
    if (code === "imap_folder_unavailable") return "This server did not report the requested folder"
    return "Mail request failed"
  }

  function nativeRequest(method, params, callback, existingHandle, suppliedSettings, suppliedCredential) {
    var handle = existingHandle || newHandle()
    if (!backend || !backend.ready) {
      if (typeof callback === "function") callback(null, "Mail backend is unavailable")
      return handle
    }
    var read = ["imap.folders", "imap.list", "imap.listContinue", "imap.messages",
      "imap.count", "imap.attachment"].indexOf(method) >= 0
    if (read) {
      if (!params.requestToken) params.requestToken = nativeRequestPrefix + ":" + String(++nativeRequestGeneration)
      handle.requestToken = params.requestToken
      handle.accountId = suppliedCredential !== undefined ? "" : String(auth.accountId || "")
    }
    root.inFlight++
    var owner = auth
    var account = String(owner.accountId || "")
    var settingsSnapshot = JSON.stringify(owner.settings)
    function current() {
      return owner === auth && String(owner.accountId || "") === account
        && JSON.stringify(owner.settings) === settingsSnapshot
    }
    function perform(credential, error) {
      if (handle.aborted || !current() || error
          || (suppliedCredential !== undefined ? !credential : account === "")) {
        root.inFlight = Math.max(0, root.inFlight - 1)
        if (!handle.aborted && typeof callback === "function") callback(null, error || "Not signed in")
        return
      }
      if (suppliedCredential !== undefined) {
        params.settings = suppliedSettings || auth.settings
        params.credential = credential
        params.oauth = root.oauthTransport
      } else params.accountId = account
      backend.call(method, params, function(result, failure) {
        root.inFlight = Math.max(0, root.inFlight - 1)
        if (handle.aborted || !current()) return
        if (typeof callback === "function") callback(result, failure ? root.backendError(failure) : "")
      })
    }
    if (suppliedCredential !== undefined) perform(suppliedCredential, "")
    else perform("", "")
    return handle
  }

  function ensureFolders(callback) {
    if (foldersLoaded) { if (typeof callback === "function") callback(""); return }
    if (typeof callback === "function") folderWaiters = folderWaiters.concat([callback])
    if (foldersLoading) return
    foldersLoading = true
    var generation = foldersGeneration
    nativeRequest("imap.folders", { refresh: true }, function(result, error) {
      root.foldersLoading = false
      if (generation !== root.foldersGeneration) { root.ensureFolders(); return }
      if (!error) {
        root.folders = result.folders
        root.special = result.special
        root.serverCapabilities = result.capabilities
        root.nativeLabels = result.labels
        root.foldersLoaded = true
      }
      var waiting = root.folderWaiters
      root.folderWaiters = []
      for (var i = 0; i < waiting.length; i++) waiting[i](error)
    })
  }

  readonly property int streamedSummaryBatch: 5
  readonly property int streamedSummaryConcurrency: 2

  function listMessages(query, maxResults, pageToken, callback, progress) {
    var handle = newHandle()
    var params = { query: String(query || ""), limit: maxResults,
      pageToken: String(pageToken || ""), progressive: typeof progress === "function",
      requestToken: nativeRequestPrefix + ":" + String(++nativeRequestGeneration) }
    var emitted = {}
    function next(method) {
      nativeRequest(method, params, function(result, error) {
        if (error) { if (typeof callback === "function") callback(null, error); return }
        var page = result.page
        if (typeof progress === "function") {
          var ids = []
          for (var i = 0; i < page.ids.length; i++) {
            if (!emitted[page.ids[i]]) { emitted[page.ids[i]] = true; ids.push(page.ids[i]) }
          }
          if (ids.length > 0) progress({ ids: ids, threadIds: [],
            nextPageToken: page.nextPageToken, estimate: page.estimate })
        }
        if (result.continuation) {
          params.continuation = result.continuation
          next("imap.listContinue")
        } else if (typeof callback === "function") callback(page,
          result.warning ? "The mailbox search could not be completed" : "")
      }, handle)
    }
    next("imap.list")
    return handle
  }

  function getSummaries(ids, callback) {
    var handle = newHandle()
    Qt.callLater(function() {
      if (!root || handle.aborted || typeof callback !== "function") return
      callback([], "")
    })
    return handle
  }

  function getMessages(ids, full, callback, existingHandle, progress) {
    var handle = existingHandle || newHandle()
    var params = { ids: ids, full: full === true,
      progressive: typeof progress === "function" && full !== true,
      requestToken: nativeRequestPrefix + ":" + String(++nativeRequestGeneration) }
    var messages = []
    function next() {
      nativeRequest("imap.messages", params, function(result, error) {
        if (error) { if (typeof callback === "function") callback(messages, error); return }
        messages = messages.concat(result.messages)
        if (result.messages.length > 0 && typeof progress === "function") progress(result.messages)
        if (result.continuation && !result.warning) {
          params.continuation = result.continuation
          next()
        } else if (typeof callback === "function") callback(messages,
          result.warning ? "Some messages could not be loaded" : "")
      }, handle)
    }
    next()
    return handle
  }

  function getMessage(id, full, callback) {
    return getMessages([id], full, function(messages, error) {
      if (typeof callback !== "function") return
      if (error || messages.length === 0) callback(null, error || "That message is no longer in the mailbox")
      else callback(messages[0], "")
    })
  }

  function getAttachment(messageId, attachmentId, callback) {
    return nativeRequest("imap.attachment", { messageId: messageId, attachmentId: attachmentId },
      function(result, error) { if (typeof callback === "function") callback(error ? "" : result.data, error) })
  }

  function getLabels(callback) {
    ensureFolders(function(error) {
      if (typeof callback === "function") callback(error ? [] : root.nativeLabels, error)
    })
  }

  function getLabelCounts(labelId, callback) {
    return nativeRequest("imap.count", { labelId: String(labelId || "") }, callback)
  }

  function getProfile(callback) {
    if (typeof callback !== "function") return newHandle()
    var settings = auth ? auth.settings : null
    var username = settings ? String(settings.username || "") : ""
    Qt.callLater(function() {
      if (!root) return
      callback({
        email: root.email || username,
        messagesTotal: 0,
        threadsTotal: 0,
        historyId: ""
      }, "")
    })
    return newHandle()
  }

  function getSendAs(callback) {
    if (typeof callback !== "function") return newHandle()
    var address = String(root.email || "")
    var configured = auth && auth.settings ? auth.settings.aliases : null
    Qt.callLater(function() {
      if (!root) return
      callback(Aliases.sendAsList(address, configured), "")
    })
    return newHandle()
  }

  function modifyMessage(id, addLabelIds, removeLabelIds, callback) {
    return batchModify([id], addLabelIds, removeLabelIds, callback)
  }

  function batchModify(ids, addLabelIds, removeLabelIds, callback) {
    return nativeRequest("imap.modify", { ids: ids, addLabelIds: addLabelIds,
      removeLabelIds: removeLabelIds }, callback)
  }

  function createLabel(name, callback) {
    return changeFolder("imap.createFolder", { name: name }, callback)
  }

  function renameLabel(id, name, callback) {
    return changeFolder("imap.renameFolder", { id: id, name: name }, callback)
  }

  function deleteLabel(id, callback) {
    return changeFolder("imap.deleteFolder", { id: id }, callback)
  }

  function changeFolder(method, params, callback) {
    return nativeRequest(method, params, function(result, error) {
      if (!error) { root.foldersGeneration++; root.foldersLoaded = false }
      if (typeof callback === "function") callback(result, error)
    })
  }

  function trashMessage(id, callback) {
    return nativeRequest("imap.trash", { ids: Array.isArray(id) ? id : [id] }, callback)
  }

  function untrashMessage(id, callback) {
    return nativeRequest("imap.untrash", { ids: Array.isArray(id) ? id : [id] }, callback)
  }

  function saveDraft(payload, callback) {
    return nativeRequest("imap.saveDraft", { raw: String(payload && payload.raw || ""),
      draftId: String(payload && payload.draftId || "") }, callback)
  }

  function deleteDraft(messageId, callback) {
    return nativeRequest("imap.deleteDraft", { id: messageId }, callback)
  }

  function sendMessage(payload, callback) {
    return nativeRequest("imap.send", { raw: String(payload && payload.raw || "") }, callback)
  }

  function sendViaGraph(raw, callback, handle) {
    if (!auth || !backend || !backend.ready) {
      if (typeof callback === "function") callback(null, "Mail backend is unavailable")
      return handle
    }
    var owner = auth
    var account = String(owner.accountId || "")
    var session = typeof owner.sessionContext === "function" ? owner.sessionContext() : null
    root.inFlight++
    backend.call("outlook.graphSend", { accountId: account, raw: raw }, function(result, error) {
      root.inFlight = Math.max(0, root.inFlight - 1)
      if (handle.aborted) return
      var current = owner === auth && String(owner.accountId || "") === account
        && (!session || typeof owner.isCurrent !== "function" || owner.isCurrent(session))
      if (typeof callback === "function") callback(error || !current ? null : ({ sent: true, warning: "" }),
        error || !current ? "The message could not be sent through Microsoft Graph" : "")
    })
    return handle
  }

  function verifyCredentials(settings, credentials, callback) {
    nativeRequest("imap.folders", { refresh: true }, function(result, error) {
      if (!error) {
        root.folders = result.folders
        root.special = result.special
        root.serverCapabilities = result.capabilities
        root.nativeLabels = result.labels
        root.foldersLoaded = true
      }
      callback(!error, error)
    }, null, settings, credentials)
  }

  Connections {
    target: root.auth
    function onVerifyRequested(settings, credentials) {
      var owner = root.auth
      var generation = root.oauthTransport ? owner.sessionGeneration : undefined
      root.verifyCredentials(settings, credentials, function(ok, error) {
        if (root.auth === owner) owner.completeSignIn(ok, error, generation)
      })
    }
    function onSettingsChanged() {
      root.foldersLoaded = false
      root.folders = []
      root.special = ({})
    }
  }

}
