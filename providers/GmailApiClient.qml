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

  // Gmail's list endpoint returns ids only, so every page costs one list call
  // plus one metadata call per message. Those are fired together rather than
  // in sequence: 25 sequential round trips to Google is most of a second of
  // staring at an empty panel.
  property int inFlight: 0
  readonly property bool busy: inFlight > 0

  function newHandle() {
    return { aborted: false, xhr: null, children: [] }
  }

  function abortRequest(handle) {
    if (!handle) return
    handle.aborted = true
    if (handle.xhr && handle.xhr.abort) handle.xhr.abort()
    handle.xhr = null
    var children = handle.children || []
    for (var i = 0; i < children.length; i++) abortRequest(children[i])
    handle.children = []
  }

  function requestError(status, payload, xhr, fallback) {
    var error = Api.responseError(status, payload, fallback)
    if ((status === 429 || status === 403) && xhr && xhr.getResponseHeader)
      error += Api.rateLimitSuffix(xhr.getResponseHeader("Retry-After"))
    return error
  }

  function request(method, path, query, body, callback, retried, existingHandle) {
    var handle = existingHandle || newHandle()
    var url = Api.safeApiUrl(path)
    if (!url) {
      if (typeof callback === "function")
        callback(0, null, "Something went wrong while contacting Gmail", null)
      return handle
    }
    url = Api.appendQuery(url, query)

    if (retried !== true) root.inFlight++

    auth.withAccessToken(function(token, tokenError) {
      if (!root) return
      if (handle.aborted) {
        root.inFlight = Math.max(0, root.inFlight - 1)
        return
      }
      if (!token) {
        root.inFlight = Math.max(0, root.inFlight - 1)
        if (typeof callback === "function") callback(0, null, tokenError || "Not signed in", null)
        return
      }
      var xhr = new XMLHttpRequest()
      handle.xhr = xhr
      xhr.onreadystatechange = function() {
        if (xhr.readyState !== XMLHttpRequest.DONE) return
        // The account this client belongs to can be removed while a request is
        // still in the air; the reply then arrives for an object that is gone.
        if (!root) return
        if (handle.xhr === xhr) handle.xhr = null
        if (handle.aborted) {
          root.inFlight = Math.max(0, root.inFlight - 1)
          return
        }
        var payload = Api.parseJson(xhr.responseText, null)
        // One retry only, and only for 401: a token can expire between the
        // freshness check and the request reaching Google.
        if (xhr.status === 401 && retried !== true) {
          auth.invalidateAccessToken()
          root.request(method, path, query, body, callback, true, handle)
          return
        }
        root.inFlight = Math.max(0, root.inFlight - 1)
        var ok = xhr.status >= 200 && xhr.status < 300
        var error = ok ? "" : root.requestError(xhr.status, payload, xhr,
          "Gmail could not complete this request")
        if (typeof callback === "function") callback(xhr.status, payload, error, xhr)
      }
      xhr.open(String(method || "GET"), url)
      xhr.setRequestHeader("Authorization", "Bearer " + token)
      if (body !== undefined && body !== null) {
        xhr.setRequestHeader("Content-Type", "application/json")
        xhr.send(JSON.stringify(body))
      } else {
        xhr.send()
      }
    })
    return handle
  }

  // ---------------------------------------------------------------- reads

  function listMessages(query, maxResults, pageToken, callback) {
    return request("GET", Api.messagesPath(),
      Api.listQuery(query, maxResults, pageToken), null,
      function(status, payload, error) {
        if (typeof callback !== "function") return
        if (error) callback(null, error)
        else callback(Api.parseMessageList(payload), "")
      })
  }

  function getMessage(id, full, callback) {
    return request("GET", Api.messagePath(id),
      full ? Api.fullQuery() : Api.metadataQuery(), null,
      function(status, payload, error) {
        if (typeof callback !== "function") return
        callback(error ? null : payload, error)
      })
  }

  // The octets of a part Gmail described but did not send. Every part the
  // sender named comes back that way — an id, a type and a size — and the
  // reader asks for one of them: the invitation, whose file has to be read
  // before a meeting can be drawn or answered.
  function getAttachment(messageId, attachmentId, callback) {
    return request("GET", Api.attachmentPath(messageId, attachmentId), null, null,
      function(status, payload, error) {
        if (typeof callback !== "function") return
        callback(error || !payload ? "" : String(payload.data || ""), error)
      })
  }

  // Fetches every id at once and calls back once, with the results in the
  // order the ids were given rather than the order Google answered in.
  function getMessages(ids, full, callback, existingHandle) {
    var handle = existingHandle || newHandle()
    var list = Array.isArray(ids) ? ids : []
    var results = new Array(list.length)
    var remaining = list.length
    var firstError = ""

    if (remaining === 0) {
      if (typeof callback === "function") callback([], "")
      return handle
    }

    function finish() {
      if (handle.aborted) return
      if (typeof callback !== "function") return
      var ordered = []
      for (var i = 0; i < results.length; i++) {
        if (results[i]) ordered.push(results[i])
      }
      callback(ordered, ordered.length > 0 ? "" : firstError)
    }

    for (var i = 0; i < list.length; i++) {
      (function(index) {
        var child = root.getMessage(list[index], full, function(payload, error) {
          if (handle.aborted) return
          if (error && !firstError) firstError = error
          results[index] = payload
          remaining--
          if (remaining === 0) finish()
        })
        handle.children.push(child)
      })(i)
    }
    return handle
  }

  function getLabels(callback) {
    return request("GET", Api.labelsPath(), null, null,
      function(status, payload, error) {
        if (typeof callback !== "function") return
        callback(error ? [] : Api.parseLabels(payload), error)
      })
  }

  function getLabelCounts(labelId, callback) {
    return request("GET", Api.labelPath(labelId), null, null,
      function(status, payload, error) {
        if (typeof callback !== "function") return
        callback(error ? null : Api.parseLabelCounts(payload), error)
      })
  }

  function getProfile(callback) {
    return request("GET", Api.profilePath(), null, null,
      function(status, payload, error) {
        if (typeof callback !== "function") return
        callback(error ? null : Api.parseProfile(payload), error)
      })
  }

  function getSendAs(callback) {
    return request("GET", Api.sendAsPath(), null, null,
      function(status, payload, error) {
        if (typeof callback !== "function") return
        callback(error ? [] : Api.parseSendAs(payload), error)
      })
  }

  // --------------------------------------------------------------- writes

  function modifyMessage(id, addLabelIds, removeLabelIds, callback) {
    return request("POST", Api.modifyPath(id), null, {
      addLabelIds: Array.isArray(addLabelIds) ? addLabelIds : [],
      removeLabelIds: Array.isArray(removeLabelIds) ? removeLabelIds : []
    }, function(status, payload, error) {
      if (typeof callback === "function") callback(payload, error)
    })
  }

  function batchModify(ids, addLabelIds, removeLabelIds, callback) {
    return request("POST", Api.batchModifyPath(), null, {
      ids: Array.isArray(ids) ? ids : [],
      addLabelIds: Array.isArray(addLabelIds) ? addLabelIds : [],
      removeLabelIds: Array.isArray(removeLabelIds) ? removeLabelIds : []
    }, function(status, payload, error) {
      if (typeof callback === "function") callback(payload, error)
    })
  }

  function trashMessage(id, callback) {
    return request("POST", Api.trashPath(id), null, null,
      function(status, payload, error) {
        if (typeof callback === "function") callback(payload, error)
      })
  }

  function untrashMessage(id, callback) {
    return request("POST", Api.untrashPath(id), null, null,
      function(status, payload, error) {
        if (typeof callback === "function") callback(payload, error)
      })
  }

  function sendMessage(payload, callback) {
    return request("POST", Api.sendPath(), null, payload,
      function(status, body, error) {
        if (typeof callback === "function") callback(body, error)
      })
  }
}
