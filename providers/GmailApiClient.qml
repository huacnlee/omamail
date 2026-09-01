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

  // How long a request may hang before it is given up on.
  //
  // Qt's QML XMLHttpRequest has **no** `timeout` and **no** `ontimeout` — the
  // properties simply do not exist, and assigning one is worse than useless
  // because it reads back exactly what was written, so the obvious fix looks
  // like it works. A `Timer` calling `abort()` is the whole of what is
  // available. Measured, both halves: `"timeout" in xhr` is false, and a
  // request against a socket that accepts and never answers was still hanging
  // after eight seconds.
  //
  // Thirty seconds because this is a mail API on somebody's home connection,
  // not a local service — long enough that a slow answer is waited for, and
  // well inside the two-minute poll so a hung request is gone before the next
  // one is due.
  readonly property int requestTimeoutMs: 30000

  function newHandle() {
    return { aborted: false, timedOut: false, xhr: null, deadline: null, children: [] }
  }

  // Stopped and destroyed together, because a Timer that outlives its request
  // is a timer that aborts the *next* one to reuse the object.
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
        root.clearDeadline(handle)
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
        // A request the deadline gave up on arrives here exactly as a failed
        // one does — `abort()` drives readyState to DONE with status 0, which
        // is measured rather than assumed. So the timeout costs no second
        // decrement and no second callback; all it needs is to say which of
        // the two silences this was.
        var error = ok ? "" : (handle.timedOut
          ? "Gmail did not answer in time"
          : root.requestError(xhr.status, payload, xhr,
            "Gmail could not complete this request"))
        if (typeof callback === "function") callback(xhr.status, payload, error, xhr)
      }
      xhr.open(String(method || "GET"), url)
      xhr.setRequestHeader("Authorization", "Bearer " + token)
      // Armed around the send rather than around the whole call: everything
      // before this was local, and the wait being bounded is the wait on the
      // network.
      root.clearDeadline(handle)
      handle.deadline = deadlineComponent.createObject(root, { interval: root.requestTimeoutMs })
      if (handle.deadline) {
        handle.deadline.triggered.connect(function() {
          if (!root || handle.aborted) return
          handle.timedOut = true
          if (handle.xhr && handle.xhr.abort) handle.xhr.abort()
        })
        handle.deadline.start()
      }
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

  function listMessages(query, maxResults, pageToken, callback, progress) {
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

  // One Timer per request in flight, created and destroyed around it. A single
  // shared one cannot work: requests here are fired together — a page of
  // messages is one list call plus one metadata call each — and they finish in
  // whatever order Google answers.
  Component {
    id: deadlineComponent

    Timer {
      repeat: false
    }
  }

  Component {
    id: progressTimerComponent

    Timer {
      repeat: false
    }
  }

  function sendMessage(payload, callback) {
    return request("POST", Api.sendPath(), null, Api.sendBody(payload),
      function(status, body, error) {
        if (typeof callback === "function") callback(body, error)
      })
  }

  function saveDraft(payload, callback) {
    var messageId = payload ? String(payload.draftId || "") : ""
    if (messageId !== "") return updateDraft(messageId, payload, callback)
    return request("POST", Api.draftsPath(), null, Api.draftBody(payload),
      function(status, body, error) {
        if (typeof callback === "function") callback(body, error)
      })
  }

  // The message list names Gmail's message id. The update endpoint names its
  // enclosing draft resource, so resolve that immutable id before replacing it.
  function updateDraft(messageId, payload, callback) {
    var handle = newHandle()

    function find(pageToken) {
      root.request("GET", Api.draftsPath(), Api.draftListQuery(pageToken), null,
        function(status, body, error) {
          if (handle.aborted) return
          if (error) {
            if (typeof callback === "function") callback(null, error)
            return
          }
          var draftId = Api.draftIdForMessage(body, messageId)
          if (draftId !== "") {
            root.request("PUT", Api.draftPath(draftId), null, Api.draftBody(payload),
              function(updateStatus, saved, updateError) {
                if (typeof callback === "function") callback(saved, updateError)
              }, false, handle)
            return
          }
          var next = String(body && body.nextPageToken || "")
          if (next !== "") {
            find(next)
            return
          }
          if (typeof callback === "function")
            callback(null, "That draft is no longer in the mailbox")
        }, false, handle)
    }

    find("")
    return handle
  }
}
