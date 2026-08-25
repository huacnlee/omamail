import QtQuick

import "JmapApi.js" as Api

// Authenticated JMAP transport. The session document is the authority for
// every endpoint after its initial GET, including regional API and download
// hosts. Mailbox roles are learned once and every list page is then one JMAP
// POST containing Email/query plus a back-referenced Email/get.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property var auth
  property string email: ""

  property int inFlight: 0
  readonly property bool busy: inFlight > 0
  readonly property int requestTimeoutMs: 30000

  property var sessionInfo: null
  property var mailboxes: []
  property bool mailboxesLoaded: false
  property var messageCache: ({})
  // This branch intentionally remains a reader even if given a broader token.
  readonly property bool readOnly: true

  function canCapability(name) {
    var capability = String(name || "")
    if (capability === "labels") return !!sessionInfo && sessionInfo.canLabels === true
    if (capability === "send" || capability === "spam" || capability === "archive"
        || capability === "star" || capability === "batch") return false
    return true
  }

  function newHandle() {
    return { aborted: false, timedOut: false, xhr: null, deadline: null, children: [] }
  }

  function clearDeadline(handle) {
    if (!handle || !handle.deadline) return
    handle.deadline.stop()
    handle.deadline.destroy()
    handle.deadline = null
  }

  function abortRequest(handle) {
    if (!handle) return
    handle.aborted = true
    clearDeadline(handle)
    if (handle.xhr && handle.xhr.abort) handle.xhr.abort()
    handle.xhr = null
    var children = handle.children || []
    for (var i = 0; i < children.length; i++) abortRequest(children[i])
    handle.children = []
  }

  function requestUrl(handle, method, url, token, body, binary, callback) {
    if (!handle || handle.aborted) return handle
    if (!Api.isHttpsUrl(url)) {
      if (typeof callback === "function")
        callback(0, null, "The JMAP server provided an unsafe address")
      return handle
    }

    root.inFlight++
    handle.timedOut = false
    var xhr = new XMLHttpRequest()
    handle.xhr = xhr
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== XMLHttpRequest.DONE) return
      if (!root) return
      if (handle.xhr === xhr) handle.xhr = null
      root.clearDeadline(handle)
      root.inFlight = Math.max(0, root.inFlight - 1)
      if (handle.aborted) return

      var ok = xhr.status >= 200 && xhr.status < 300
      var payload = binary === true ? xhr.response : Api.parseJson(xhr.responseText, null)
      if (xhr.status === 401 && root.auth && root.auth.invalidateAccessToken)
        root.auth.invalidateAccessToken()
      var error = ok ? "" : (handle.timedOut
        ? "The JMAP server did not answer in time"
        : Api.responseError(xhr.status, payload, "The JMAP server could not complete this request"))
      if (typeof callback === "function") callback(xhr.status, payload, error)
    }

    xhr.open(String(method || "GET"), String(url))
    xhr.setRequestHeader("Authorization", "Bearer " + String(token || ""))
    if (body !== null && body !== undefined)
      xhr.setRequestHeader("Content-Type", "application/json")
    if (binary === true) xhr.responseType = "arraybuffer"

    var deadline = deadlineComponent.createObject(root, { interval: requestTimeoutMs })
    handle.deadline = deadline
    deadline.triggered.connect(function() {
      if (!root || handle.aborted || handle.xhr !== xhr) return
      handle.timedOut = true
      xhr.abort()
    })
    deadline.start()
    xhr.send(body === null || body === undefined ? null : JSON.stringify(body))
    return handle
  }

  function adoptSession(payload) {
    var checked = Api.validateSession(payload)
    if (!checked.ok) return checked.error
    sessionInfo = checked
    mailboxes = []
    mailboxesLoaded = false
    messageCache = ({})
    return ""
  }

  function fetchSessionWithToken(handle, token, callback) {
    return requestUrl(handle, "GET", Api.SESSION_URL, token, null, false,
      function(status, payload, error) {
        if (error) {
          if (typeof callback === "function") callback(null, error)
          return
        }
        var sessionError = root.adoptSession(payload)
        if (typeof callback === "function")
          callback(sessionError === "" ? root.sessionInfo : null, sessionError)
      })
  }

  function ensureSession(handle, callback) {
    if (sessionInfo) {
      if (typeof callback === "function") callback(sessionInfo, "")
      return handle
    }
    auth.withAccessToken(function(token, tokenError) {
      if (!root || handle.aborted) return
      if (!token) {
        if (typeof callback === "function") callback(null, tokenError || "Not signed in")
        return
      }
      root.fetchSessionWithToken(handle, token, callback)
    })
    return handle
  }

  function postWithToken(handle, token, calls, callback) {
    if (!sessionInfo || !Api.isHttpsUrl(sessionInfo.apiUrl)) {
      if (typeof callback === "function") callback(null, "The JMAP session is not ready")
      return handle
    }
    return requestUrl(handle, "POST", sessionInfo.apiUrl, token,
      Api.methodRequest(calls), false, function(status, payload, error) {
        if (typeof callback === "function") callback(error ? null : payload, error)
      })
  }

  function post(handle, calls, callback) {
    ensureSession(handle, function(session, sessionError) {
      if (!root || handle.aborted) return
      if (!session) {
        if (typeof callback === "function") callback(null, sessionError)
        return
      }
      auth.withAccessToken(function(token, tokenError) {
        if (!root || handle.aborted) return
        if (!token) {
          if (typeof callback === "function") callback(null, tokenError || "Not signed in")
          return
        }
        root.postWithToken(handle, token, calls, callback)
      })
    })
    return handle
  }

  function fetchMailboxesWithToken(handle, token, callback) {
    return postWithToken(handle, token,
      [Api.mailboxGetCall(sessionInfo.accountId, "mailboxes")],
      function(payload, error) {
        if (error) {
          if (typeof callback === "function") callback([], error)
          return
        }
        var methodError = Api.methodError(payload)
        var values = methodError ? [] : Api.parseMailboxList(payload)
        if (!methodError && values.length === 0)
          methodError = "This JMAP account has no mailboxes"
        if (!methodError) {
          root.mailboxes = values
          root.mailboxesLoaded = true
        }
        if (typeof callback === "function") callback(values, methodError)
      })
  }

  function ensureMailboxes(handle, callback) {
    if (mailboxesLoaded) {
      if (typeof callback === "function") callback(mailboxes, "")
      return handle
    }
    ensureSession(handle, function(session, sessionError) {
      if (!root || handle.aborted) return
      if (!session) {
        if (typeof callback === "function") callback([], sessionError)
        return
      }
      auth.withAccessToken(function(token, tokenError) {
        if (!root || handle.aborted) return
        if (!token) {
          if (typeof callback === "function") callback([], tokenError || "Not signed in")
          return
        }
        root.fetchMailboxesWithToken(handle, token, callback)
      })
    })
    return handle
  }

  function verifyToken(token, callback) {
    var handle = newHandle()
    fetchSessionWithToken(handle, token, function(session, sessionError) {
      if (!root || handle.aborted) return
      if (!session) {
        if (typeof callback === "function") callback(false, sessionError)
        return
      }
      root.fetchMailboxesWithToken(handle, token, function(values, mailboxError) {
        if (typeof callback === "function") callback(!mailboxError, mailboxError)
      })
    })
    return handle
  }

  // ---------------------------------------------------------------- reads

  function remember(messages) {
    var next = {}
    for (var key in messageCache) next[key] = messageCache[key]
    var list = Array.isArray(messages) ? messages : []
    for (var i = 0; i < list.length; i++) {
      var message = list[i] || {}
      if (message.id) next[String(message.id)] = message
    }
    messageCache = next
  }

  function listMessages(query, maxResults, pageToken, callback) {
    var handle = newHandle()
    var limit = Math.max(1, Math.min(100, Math.floor(Number(maxResults)) || 25))
    ensureMailboxes(handle, function(values, mailboxError) {
      if (!root || handle.aborted) return
      if (mailboxError) {
        if (typeof callback === "function") callback(null, mailboxError)
        return
      }
      var planned = Api.filterForQuery(query, values)
      if (!planned.ok) {
        if (typeof callback === "function") callback(null, planned.error)
        return
      }
      root.post(handle, Api.listCalls(root.sessionInfo.accountId,
        planned.filter, limit, pageToken), function(payload, error) {
          if (error) {
            if (typeof callback === "function") callback(null, error)
            return
          }
          var parsed = Api.parseListPage(payload, root.mailboxes, limit)
          if (!parsed.error) root.remember(parsed.messages)
          if (typeof callback === "function") callback(parsed.page, parsed.error)
        })
    })
    return handle
  }

  function cachedMessages(ids) {
    var list = Array.isArray(ids) ? ids : []
    var out = []
    for (var i = 0; i < list.length; i++) {
      var found = messageCache[String(list[i])]
      if (!found) return null
      out.push(found)
    }
    return out
  }

  function getMessages(ids, full, callback, existingHandle) {
    var handle = existingHandle || newHandle()
    var list = Array.isArray(ids) ? ids : []
    var cached = full === true ? null : cachedMessages(list)
    if (cached) {
      Qt.callLater(function() {
        if (!root || handle.aborted || typeof callback !== "function") return
        callback(cached, "")
      })
      return handle
    }
    ensureMailboxes(handle, function(values, mailboxError) {
      if (!root || handle.aborted) return
      if (mailboxError) {
        if (typeof callback === "function") callback([], mailboxError)
        return
      }
      root.post(handle, [Api.emailGetCall(root.sessionInfo.accountId, list,
        full === true, "messages")], function(payload, error) {
          if (error) {
            if (typeof callback === "function") callback([], error)
            return
          }
          var parsed = Api.parseMessages(payload, root.mailboxes, "messages")
          if (!parsed.error) root.remember(parsed.messages)
          if (typeof callback === "function") callback(parsed.messages, parsed.error)
        })
    })
    return handle
  }

  function getMessage(id, full, callback) {
    return getMessages([String(id || "")], full, function(messages, error) {
      if (typeof callback !== "function") return
      if (error || messages.length === 0)
        callback(null, error || "That message is no longer in the mailbox")
      else callback(messages[0], "")
    })
  }

  function getAttachment(messageId, attachmentId, callback) {
    var handle = newHandle()
    ensureSession(handle, function(session, sessionError) {
      if (!root || handle.aborted) return
      if (!session || !session.downloadUrl) {
        if (typeof callback === "function")
          callback("", sessionError || "This JMAP server did not provide an attachment address")
        return
      }
      var url = Api.downloadAddress(session.downloadUrl, session.accountId,
        attachmentId, "attachment", "application/octet-stream")
      auth.withAccessToken(function(token, tokenError) {
        if (!root || handle.aborted) return
        if (!token || !url) {
          if (typeof callback === "function")
            callback("", tokenError || "That attachment is not available")
          return
        }
        root.requestUrl(handle, "GET", url, token, null, true,
          function(status, payload, error) {
            if (error || !payload) {
              if (typeof callback === "function") callback("", error || "That attachment could not be loaded")
              return
            }
            var bytes = new Uint8Array(payload)
            if (typeof callback === "function") callback(Api.base64UrlBytes(bytes), "")
          })
      })
    })
    return handle
  }

  function getLabels(callback) {
    var handle = newHandle()
    ensureMailboxes(handle, function(values, error) {
      if (typeof callback === "function")
        callback(error ? [] : Api.labelsFromMailboxes(values), error)
    })
    return handle
  }

  function getLabelCounts(labelId, callback) {
    var handle = newHandle()
    ensureMailboxes(handle, function(values, error) {
      if (typeof callback !== "function") return
      var counts = error ? null : Api.labelCounts(values, labelId)
      callback(counts, error || (counts ? "" : "That mailbox is no longer available"))
    })
    return handle
  }

  function getProfile(callback) {
    var handle = newHandle()
    ensureSession(handle, function(session, error) {
      if (typeof callback !== "function") return
      callback(error ? null : {
        email: root.email || String(session.name || ""),
        messagesTotal: 0,
        threadsTotal: 0,
        historyId: String(session.state || "")
      }, error)
    })
    return handle
  }

  function getSendAs(callback) {
    var handle = newHandle()
    Qt.callLater(function() {
      if (!root || handle.aborted || typeof callback !== "function") return
      callback(root.email === "" ? [] : [{
        email: root.email, displayName: "", isPrimary: true, isDefault: true
      }], "")
    })
    return handle
  }

  function sendMessage(payload, callback) {
    var handle = newHandle()
    if (typeof callback === "function")
      callback(null, "Sending over JMAP is not available in this version")
    return handle
  }

  Connections {
    target: root.auth
    function onVerifyRequested(token) {
      root.verifyToken(token, function(ok, error) {
        if (root.auth) root.auth.completeSignIn(ok, error)
      })
    }
  }

  Component {
    id: deadlineComponent
    Timer { repeat: false }
  }
}
