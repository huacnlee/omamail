import QtQuick

import "../account/Aliases.js" as Aliases
import "ExchangeProtocol.js" as Exchange

// Presentation adapter: the credential, the connection, the sign-in method, EWS,
// MIME conversion and every mutation belong to Rust. This turns a call from
// `MailAccount` into one `exchange.*` request and the answer back into the shape
// that call expects. A request names the account and nothing that could
// authenticate or redirect it; only the sign-in check carries a password.
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

  // The saved password is not usable: the server refused it or the keyring no
  // longer has it. The setup page asks for it again, and nothing more is sent
  // until it is. A sign-in whose password the keyring has taken, a sign-out or
  // another server clears it.
  property bool credentialsRejected: false

  // What the last check taught: the capabilities this account gives back to the
  // provider's ceiling, and the rail rows whose folder the server lacks.
  property var refusals: null
  property var absentMailboxes: null
  property bool learned: false
  property bool learning: false

  property int epoch: 0
  property int sequence: 0
  property string tokenPrefix: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)
  property var verification: null

  function newHandle() {
    return { aborted: false, children: [], requestToken: "", accountId: "" }
  }

  function abortRequest(handle) {
    if (!handle) return
    handle.aborted = true
    if (handle.requestToken && backend && backend.ready)
      backend.call("exchange.cancel", { accountId: handle.accountId,
        requestToken: handle.requestToken }, function() {})
    handle.requestToken = ""
    var children = handle.children || []
    for (var i = 0; i < children.length; i++) abortRequest(children[i])
  }

  // An answer that needs no request, given on the next tick like the others.
  function answerLater(callback, result, error) {
    var handle = newHandle()
    Qt.callLater(function() {
      if (root && !handle.aborted && typeof callback === "function") callback(result, error)
    })
    return handle
  }

  function nativeRequest(method, params, callback, existingHandle) {
    var handle = existingHandle || newHandle()
    if (handle.aborted) return handle
    var owner = auth
    var account = String(owner.accountId || "")
    var problem = credentialsRejected ? Exchange.sentence("exchange_unauthorized")
      : !backend || !backend.ready ? "Mail backend is unavailable"
      : account === "" || owner.loggedIn !== true ? "Not signed in" : ""
    if (problem !== "") {
      if (typeof callback === "function") callback(null, problem)
      return handle
    }
    var request = Object.assign({}, params, { accountId: account })
    // The requests that can be long are the ones the backend accepts a token on.
    if (["exchange.list", "exchange.messages", "exchange.verify"].indexOf(method) >= 0) {
      request.requestToken = tokenPrefix + ":" + String(++sequence)
      handle.requestToken = request.requestToken
      handle.accountId = account
    }
    var generation = epoch
    inFlight++
    backend.call(method, request, function(result, failure) {
      if (!root) return
      root.inFlight = Math.max(0, root.inFlight - 1)
      handle.requestToken = ""
      if (handle.aborted || generation !== root.epoch) return
      if (failure && Exchange.needsPassword(failure)) root.credentialsRejected = true
      if (typeof callback === "function")
        callback(failure ? null : result, failure ? Exchange.sentence(failure) : "", failure)
    })
    return handle
  }

  function listMessages(query, maxResults, pageToken, callback, progress) {
    var limit = Math.max(1, Math.min(100, Math.floor(Number(maxResults)) || 25))
    return nativeRequest("exchange.list", { query: String(query || ""), limit: limit,
      pageToken: String(pageToken || "") }, function(result, error, failure) {
      if (error) {
        // A typed search the backend cannot send arrives as JSON-RPC's own invalid-params error.
        var empty = /^\s*text:/i.test(String(query)) && Exchange.errorCode(failure) === "Invalid params"
        callback(null, empty ? "That search has nothing the server can look for" : error)
        return
      }
      var page = result.page
      if (typeof progress === "function" && page.ids.length > 0) progress({ ids: page.ids, threadIds: [],
        nextPageToken: page.nextPageToken, estimate: page.estimate })
      callback(page, result.warning ? "The mailbox search could not be completed" : "")
    })
  }

  // A listing is never collapsed into conversations, so there are no members to
  // ask for; it still has to answer.
  function getSummaries(ids, callback) {
    return answerLater(callback, [], "")
  }

  // At most a listing page's worth of ids to a request, one after another, which
  // is as many as the backend takes.
  function getMessages(ids, full, callback, existingHandle, progress) {
    var handle = existingHandle || newHandle()
    var wanted = Array.isArray(ids) ? ids : []
    var messages = []
    var incomplete = false
    function next(offset) {
      if (offset >= wanted.length) {
        callback(messages, incomplete ? "Some messages could not be loaded" : "")
        return
      }
      nativeRequest("exchange.messages", { ids: wanted.slice(offset, offset + 100), full: full === true },
        function(result, error) {
          if (error) { callback(messages, error); return }
          messages = messages.concat(result.messages)
          if (result.messages.length > 0 && typeof progress === "function") progress(result.messages)
          if (result.warning || result.continuation) incomplete = true
          next(offset + 100)
        }, handle)
    }
    if (wanted.length === 0) Qt.callLater(function() { if (root && !handle.aborted) next(0) })
    else next(0)
    return handle
  }

  function getAttachment(messageId, attachmentId, callback) {
    return nativeRequest("exchange.attachment", { messageId: String(messageId),
      attachmentId: String(attachmentId) }, function(result, error) {
      callback(error ? "" : result.data, error)
    })
  }

  // No folders of the user's own: the mailboxes are the roles the registry draws.
  function getLabels(callback) {
    return answerLater(callback, [], "")
  }

  function getProfile(callback) {
    return answerLater(callback, { email: root.email, messagesTotal: 0, threadsTotal: 0, historyId: "" }, "")
  }

  // The mailbox's own address is the only identity there is.
  function getSendAs(callback) {
    return answerLater(callback, Aliases.sendAsList(root.email, null), "")
  }

  function modifyMessage(id, addLabelIds, removeLabelIds, callback) {
    return batchModify([id], addLabelIds, removeLabelIds, callback)
  }

  function batchModify(ids, addLabelIds, removeLabelIds, callback) {
    return change("exchange.modify", { ids: strings(ids), addLabelIds: strings(addLabelIds),
      removeLabelIds: strings(removeLabelIds) }, callback)
  }

  function trashMessage(id, callback) { return gather("exchange.trash", id, callback) }
  function untrashMessage(id, callback) { return gather("exchange.untrash", id, callback) }

  // The window trashes a selection one row at a time. Asked in the same moment,
  // the rows go as one batch: a request each would wait its turn on the account,
  // and the later ones would run out of time doing it. Each caller is answered
  // for its own ids, and only for the mailbox it asked of: an ask made before
  // the mailbox changed or was signed out is not sent.
  property var gathered: ({})

  function gather(method, id, callback) {
    var handle = newHandle()
    if (!gathered[method]) {
      gathered[method] = []
      Qt.callLater(function() { if (root) root.flush(method) })
    }
    gathered[method].push({ ids: strings(id), callback: callback, handle: handle,
      accountId: String(auth && auth.accountId || ""), epoch: epoch })
    return handle
  }

  function flush(method) {
    var asks = gathered[method] || []
    delete gathered[method]
    var account = String(auth && auth.accountId || "")
    var kept = []
    var ids = []
    for (var i = 0; i < asks.length; i++) {
      var each = asks[i]
      if (each.handle.aborted) continue
      if (each.accountId !== account || each.epoch !== epoch) {
        tell(each, null, "Account changed")
        continue
      }
      kept.push(each)
      for (var k = 0; k < each.ids.length; k++)
        if (ids.indexOf(each.ids[k]) < 0) ids.push(each.ids[k])
    }
    if (kept.length === 0) return
    change(method, { ids: ids }, function(result, error, failedIds) {
      for (var j = 0; j < kept.length; j++) {
        var ask = kept[j]
        if (ask.handle.aborted) continue
        var failed = !error ? [] : failedIds === undefined ? ask.ids
          : ask.ids.filter(function(one) { return failedIds.indexOf(one) >= 0 })
        if (failed.length === 0) tell(ask, { succeededIds: ask.ids, failedIds: [], error: null }, "")
        else tell(ask, result, error, failedIds === undefined ? undefined : failed)
      }
    })
  }

  // One caller's answer; a caller that throws does not leave the others unanswered.
  function tell(ask, result, error, failed) {
    if (typeof ask.callback !== "function") return
    try {
      if (failed === undefined) ask.callback(result, error)
      else ask.callback(result, error, failed)
    } catch (e) { /* consumers own their callback errors */ }
  }

  // One id or a list of them, as a list of strings.
  function strings(value) {
    return [].concat(value === undefined || value === null ? [] : value).map(String)
  }

  // A change names every id as done or not. What was not done is a failure, and
  // its ids go back as a third argument so the list restores exactly those rows;
  // a failure naming none is the whole request's.
  //
  // At most 100 ids to a request, one request after another, each answered on
  // its own: the backend begins a write only in the first seconds of a call, so
  // the later part of a large batch sent as one would come back unwritten from a
  // server that is merely slow. A request that fails as a whole ends the batch,
  // and every id it had not reached is a failure too. So does one in which every
  // id failed, for a reason other than being gone: the next would meet the same
  // thing, as `write::apply` reasons within a request. The answer names only the
  // first id's reason, which stands for them all.
  function change(method, params, callback) {
    var ids = params.ids
    var handle = newHandle()
    var merged = { succeededIds: [], failedIds: [], error: null }
    var said = ""
    function answer() {
      var failed = merged.failedIds
      if (failed.length === 0 && said === "") { callback(merged, ""); return }
      callback(merged, said !== "" ? said : "The server did not apply this change to every message",
        failed.length > 0 ? failed : undefined)
    }
    function next(offset) {
      var rest = ids.slice(offset)
      nativeRequest(method, Object.assign({}, params, { ids: ids.slice(offset, offset + 100) }),
        function(result, error, failure) {
          if (error && offset === 0) { callback(null, error); return }
          var failed = error ? [] : result.failedIds || []
          var code = error ? Exchange.errorCode(failure) : result.error ? String(result.error) : ""
          if (Exchange.needsPassword(code)) root.credentialsRejected = true
          // Refused as a whole: it names nothing it was asked as done.
          var whole = !!error || (code !== "" && failed.length === 0)
          if (whole && offset === 0) { callback(result, Exchange.sentence(code), undefined); return }
          var stop = whole || (code !== "" && code !== "exchange_message_not_found"
            && ids.slice(offset, offset + 100).every(function(id) { return failed.indexOf(id) >= 0 }))
          if (said === "" && (error || code !== "")) {
            said = error || Exchange.sentence(code)
            merged.error = code || null
          }
          if (!error) merged.succeededIds = merged.succeededIds.concat(result.succeededIds || [])
          merged.failedIds = merged.failedIds.concat(stop ? rest : failed)
          if (stop || offset + 100 >= ids.length) answer()
          else next(offset + 100)
        }, handle)
    }
    next(0)
    return handle
  }

  // Filed in the server's Drafts; the draft it was opened from goes once the new
  // one is there.
  function saveDraft(payload, callback) {
    return nativeRequest("exchange.saveDraft", { raw: String(payload && payload.raw || ""),
      draftId: String(payload && payload.draftId || "") }, callback)
  }

  function deleteDraft(messageId, callback) {
    return nativeRequest("exchange.deleteDraft", { id: String(messageId || "") }, callback)
  }

  function sendMessage(payload, callback) {
    return nativeRequest("exchange.send", { raw: String(payload && payload.raw || "") }, callback)
  }

  function apply(result) {
    refusals = Exchange.refusals(result)
    absentMailboxes = Exchange.absentMailboxes(result)
    learned = true
  }

  // The sign-in check. The password is in the call because nothing is stored yet.
  function verifyCredentials(settings, address, secret, callback) {
    var handle = newHandle()
    if (!backend || !backend.ready) {
      callback(null, "Mail backend is unavailable")
      return handle
    }
    var generation = epoch
    handle.requestToken = tokenPrefix + ":" + String(++sequence)
    handle.accountId = String(auth.accountId || "")
    verification = handle
    inFlight++
    backend.call("exchange.verify", { address: address, settings: settings, secret: secret,
      requestToken: handle.requestToken }, function(result, failure) {
      if (!root) return
      root.inFlight = Math.max(0, root.inFlight - 1)
      if (handle.aborted || generation !== root.epoch) return
      root.verification = null
      handle.requestToken = ""
      if (failure || !result || result.ok !== true) {
        callback(null, Exchange.sentence(failure, true))
        return
      }
      root.apply(result)
      callback(result, "")
    })
    return handle
  }

  // Everything learned is about one server and one login. What is still in the
  // air is dropped, and a check being made is abandoned: its answer will never
  // come, so the sign-in waiting for it is told to stop.
  function forget() {
    var checking = verification
    abortRequest(verification)
    verification = null
    if (checking && auth && typeof auth.cancelLogin === "function") auth.cancelLogin()
    epoch++
    credentialsRejected = false
    refusals = null
    absentMailboxes = null
    learned = false
    learning = false
  }

  // Which folders the server has and which abilities it withdraws, asked of a
  // mailbox that was signed in already; a failed check is asked again.
  function learn() {
    if (learning) return
    learning = true
    nativeRequest("exchange.verify", {}, function(result, error) {
      root.learning = false
      if (!error && result.ok === true) root.apply(result)
    })
  }

  Connections {
    target: root.auth
    // A mailbox changing provider leaves this object holding the old auth for a frame.
    ignoreUnknownSignals: true
    function onVerifyRequested(settings, address, secret) {
      var owner = root.auth
      root.verifyCredentials(settings, address, secret, function(result, error) {
        if (root.auth === owner) owner.completeSignIn(!error, result, error)
      })
    }
    function onServerKeyChanged() { root.forget() }
    // Not when the check answers: until the keyring has the new password the
    // backend would still send the one the server refused.
    function onLoginSucceeded() { root.credentialsRejected = false }
    function onAccountIdChanged() { root.forget() }
    function onLoggedOut() { root.forget() }
  }

  Timer {
    interval: 60000
    repeat: true
    triggeredOnStart: true
    running: !!root.auth && root.auth.loggedIn === true && !root.learned && !root.credentialsRejected
    onTriggered: root.learn()
  }
}
