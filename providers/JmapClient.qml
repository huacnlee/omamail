import QtQuick
import Quickshell.Io

import "JmapProtocol.js" as Jmap
import "../message/Message.js" as Mail

// Authenticated transport for a JMAP account.
//
// It holds no state about the mailbox — only about requests in flight and the
// session resource, which is a fact about the server rather than about what is
// on screen — so the service can cancel a page load without knowing how it was
// issued.
//
// Two things differ from `GmailApiClient.qml`, and both are the protocol
// rather than a preference:
//
//   - Every call is a POST of the same shape to one URL. There are no paths,
//     so nothing here builds one.
//   - A 200 is not success. The reply carries a result per method call, and
//     any of them may have failed on its own; `Jmap.methodError` reads that.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property var auth

  property int inFlight: 0
  readonly property bool busy: inFlight > 0

  // The session resource, once fetched. Null until the first request has been
  // made, because there is nothing to ask for before an account is signed in.
  property var session: null
  readonly property bool ready: !!session && session.ok === true

  // How long a request may hang before it is given up on.
  //
  // Qt's QML XMLHttpRequest has no `timeout` and no `ontimeout` — the
  // properties do not exist, and assigning one is worse than useless because
  // it reads back exactly what was written. A `Timer` calling `abort()` is the
  // whole of what is available. This is measured in `GmailApiClient.qml`; the
  // same engine is underneath here.
  readonly property int requestTimeoutMs: 30000

  // No `children` list, unlike `GmailApiClient`: that one fans a page out into
  // a metadata request per message and has to be able to abort the fan-out.
  // Every chain here is sequential and threads one handle through, so a list
  // of children would never be filled and would imply a cancellation shape
  // this client does not have.
  function newHandle() {
    return { aborted: false, timedOut: false, xhr: null, deadline: null }
  }

  // Stopped and destroyed together, because a Timer that outlives its request
  // is a timer that aborts the next one to reuse the object.
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
  }

  function parseJson(text) {
    try {
      return JSON.parse(String(text || ""))
    } catch (e) {
      return null
    }
  }

  // The one place an XHR is issued.
  // `callback(status, payload, error, raw)` — `raw` is the untouched response
  // text, because a downloaded message is RFC822 rather than JSON and parsing
  // it as JSON would throw the whole body away.
  function send(method, url, token, body, callback, handle, contentType) {
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
      root.inFlight = Math.max(0, root.inFlight - 1)

      var payload = root.parseJson(xhr.responseText)
      var ok = xhr.status >= 200 && xhr.status < 300
      if (!ok) {
        // An aborted request arrives here exactly as a failed one does:
        // `abort()` drives readyState to DONE with status 0. All the timeout
        // has to do is say which of the two silences this was.
        var failure = handle.timedOut
          ? "The server did not answer in time"
          : Jmap.responseError(xhr.status, payload, "The server could not be reached")
        if (typeof callback === "function") callback(xhr.status, payload, failure, "")
        return
      }
      if (typeof callback === "function") callback(xhr.status, payload, "", xhr.responseText)
    }

    xhr.open(String(method || "GET"), String(url))
    xhr.setRequestHeader("Authorization", "Bearer " + token)
    xhr.setRequestHeader("Accept", "application/json")

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
      // A blob upload is the message's own bytes under its own type; anything
      // else is a JMAP request, which is JSON.
      var raw = String(contentType || "")
      if (raw !== "") {
        xhr.setRequestHeader("Content-Type", raw)
        xhr.send(String(body))
      } else {
        xhr.setRequestHeader("Content-Type", "application/json")
        xhr.send(JSON.stringify(body))
      }
    } else {
      xhr.send()
    }
  }

  // ----------------------------------------------------------- the session

  // Fetched once and kept. It carries the account id every later call needs,
  // the URL they are posted to, and whether this server can send or push at
  // all — so a panel never offers a verb the token was not scoped for.
  //
  // `callback(session, error)`.
  function withSession(callback, existingHandle) {
    var handle = existingHandle || newHandle()
    if (root.ready) {
      if (typeof callback === "function") callback(root.session, "")
      return handle
    }

    auth.withToken(function(token, tokenError) {
      if (!root) return
      if (handle.aborted) return
      if (!token) {
        if (typeof callback === "function") callback(null, tokenError || "Not signed in")
        return
      }

      var url = Jmap.sessionUrl(auth.host)
      if (url === "") {
        if (typeof callback === "function") callback(null, "This mailbox has no server address")
        return
      }

      root.inFlight++
      root.send("GET", url, token, null, function(status, payload, error) {
        if (!root) return
        if (error) {
          if (typeof callback === "function") callback(null, error)
          return
        }
        var parsed = Jmap.parseSession(payload, auth.host)
        if (!parsed.ok) {
          if (typeof callback === "function") callback(null, parsed.error)
          return
        }
        root.session = parsed
        if (typeof callback === "function") callback(parsed, "")
      }, handle)
    })

    return handle
  }

  // Discards the cached session, so the next call fetches it again. Used when
  // a token is replaced: the account id and the scopes may both differ.
  function forgetSession() {
    root.session = null
    root.mailboxesKnown = false
    root.knownRoles = ({})
    root.knownNames = ({})
    root.knownMailboxes = []
  }

  // ------------------------------------------------------------ method calls

  // Posts an assembled request and hands back the whole body. A 200 whose
  // methodResponses contain a failed call is reported as that failure, because
  // every caller above would otherwise have to check for it and one of them
  // would forget.
  //
  // `callback(body, error)`.
  function call(request, callback, existingHandle) {
    var handle = existingHandle || newHandle()

    withSession(function(session, sessionError) {
      if (!root || handle.aborted) return
      if (!session) {
        if (typeof callback === "function") callback(null, sessionError)
        return
      }
      auth.withToken(function(token, tokenError) {
        if (!root || handle.aborted) return
        if (!token) {
          if (typeof callback === "function") callback(null, tokenError || "Not signed in")
          return
        }
        root.inFlight++
        root.send("POST", session.apiUrl, token, request, function(status, payload, error) {
          if (!root) return
          if (error) {
            // A token revoked between the session fetch and this call leaves a
            // cached session for an account we can no longer reach.
            if (status === 401) root.forgetSession()
            if (typeof callback === "function") callback(null, error)
            return
          }
          var failed = Jmap.methodError(payload)
          if (failed !== "") {
            if (typeof callback === "function") callback(null, failed)
            return
          }
          if (typeof callback === "function") callback(payload, "")
        }, handle)
      })
    }, handle)

    return handle
  }

  // ------------------------------------------------------------------ reads

  // Mailbox ids must be known before a query naming a role can become a
  // filter, and on a cold client they are not. This fetches them once; every
  // later page carries `Mailbox/get` along and keeps them current.
  //
  // `callback(error)`.
  function withMailboxes(callback, existingHandle) {
    var handle = existingHandle || newHandle()
    if (root.mailboxesKnown) {
      if (typeof callback === "function") callback("")
      return handle
    }
    withSession(function(session, sessionError) {
      if (!root || handle.aborted) return
      if (!session) {
        if (typeof callback === "function") callback(sessionError)
        return
      }
      root.call(Jmap.mailboxesRequest(session.accountId), function(body, error) {
        if (!root || handle.aborted) return
        if (error) {
          if (typeof callback === "function") callback(error)
          return
        }
        var boxes = Jmap.responseFor(body, "mailboxes")
        root.rememberMailboxes(boxes ? (boxes.payload.list || []) : [])
        if (typeof callback === "function") callback("")
      }, handle)
    }, handle)
    return handle
  }

  // A page of a mailbox: what mailboxes exist, which messages match, and the
  // headers of those messages — in one round trip, because the fetch names the
  // query's result rather than waiting for it.
  //
  // `callback(result, error)` where result is
  // `{ mailboxes, messages, total, position, state }`.
  function page(query, limit, position, callback, existingHandle) {
    var handle = existingHandle || newHandle()

    withMailboxes(function(mailboxError) {
      if (!root || handle.aborted) return
      if (mailboxError) {
        if (typeof callback === "function") callback(null, mailboxError)
        return
      }

      var parsed = Jmap.parseQuery(query)
      var filter = Jmap.filterFor(parsed, root.mailboxIndex())
      if (filter === null) {
        // A mailbox this account does not have is an empty list, not an error:
        // the sidebar offers Archive and Junk to every account, and a server
        // need not have either.
        if (typeof callback === "function")
          callback({ mailboxes: root.knownMailboxes, messages: [], total: 0,
                     position: 0, state: "" }, "")
        return
      }

      root.call(Jmap.pageRequest(root.session.accountId, filter, limit, position),
        function(body, error) {
          if (!root || handle.aborted) return
          if (error) {
            if (typeof callback === "function") callback(null, error)
            return
          }
          var boxes = Jmap.responseFor(body, "mailboxes")
          var matched = Jmap.responseFor(body, "query")
          var messages = Jmap.responseFor(body, "messages")
          if (boxes) root.rememberMailboxes(boxes.payload.list || [])
          if (typeof callback !== "function") return
          callback({
            mailboxes: root.knownMailboxes,
            messages: messages ? (messages.payload.list || []) : [],
            total: matched && typeof matched.payload.total === "number" ? matched.payload.total : 0,
            position: matched && typeof matched.payload.position === "number" ? matched.payload.position : 0,
            state: messages ? String(messages.payload.state || "") : ""
          }, "")
        }, handle)
    }, handle)

    return handle
  }

  // What changed since a state string, for the poll. The reply is small when
  // nothing has, which is what makes polling a stage rather than a placeholder.
  //
  // `callback({ created, updated, destroyed, newState, hasMore }, error)`.
  function changes(sinceState, callback, existingHandle) {
    var handle = existingHandle || newHandle()

    withSession(function(session, sessionError) {
      if (!root || handle.aborted) return
      if (!session) {
        if (typeof callback === "function") callback(null, sessionError)
        return
      }
      root.call(Jmap.changesRequest(session.accountId, sinceState),
        function(body, error) {
          if (!root || handle.aborted) return
          if (error) {
            if (typeof callback === "function") callback(null, error)
            return
          }
          var moved = Jmap.responseFor(body, "changes")
          var created = Jmap.responseFor(body, "created")
          if (typeof callback !== "function") return
          if (!moved) {
            callback(null, "The server did not say what had changed")
            return
          }
          callback({
            created: created ? (created.payload.list || []) : [],
            createdIds: moved.payload.created || [],
            updated: moved.payload.updated || [],
            destroyed: moved.payload.destroyed || [],
            newState: String(moved.payload.newState || ""),
            hasMore: moved.payload.hasMoreChanges === true
          }, "")
        }, handle)
    }, handle)

    return handle
  }

  // --------------------------------------------------------------- mailboxes

  // Mailbox ids by role and by name, which is what a query is resolved
  // against. Kept on the client rather than in the protocol module because it
  // is per-account state, and the protocol module is a pure library the node
  // tests load without a compositor.
  property var knownRoles: ({})
  property var knownNames: ({})
  property var knownMailboxes: []
  // Distinct from "knownMailboxes is empty": an account really can have no
  // mailbox with a role, and retrying the fetch on every page would be a round
  // trip per keystroke.
  property bool mailboxesKnown: false

  function mailboxIndex() {
    return { roles: root.knownRoles, names: root.knownNames }
  }

  function rememberMailboxes(list) {
    var roles = {}
    var names = {}
    var boxes = Array.isArray(list) ? list : []
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i] || {}
      var id = String(box.id || "")
      if (id === "") continue
      var role = String(box.role || "")
      if (role !== "") roles[role] = id
      var name = String(box.name || "")
      if (name !== "") names[name] = id
    }
    root.knownRoles = roles
    root.knownNames = names
    root.knownMailboxes = boxes
    root.mailboxesKnown = true
  }

  // ------------------------------------------------- the panel's interface
  //
  // From here down is the shape `GmailApiClient` wears and `ImapClient` copies:
  // `MailAccount` calls these without knowing which provider it holds.

  // Rows already fetched by the last page. `listMessages` hands the panel a
  // list of ids and the panel immediately asks for those same messages, so
  // without this the one round trip the page request saved would be spent
  // again on the very next call.
  // What this *account* cannot do, whatever the provider declares. The
  // provider states a ceiling; only the session knows whether this token was
  // scoped to send, and only the server knows whether it has an Archive
  // mailbox or a Junk one that learns.
  //
  // `MailAccount` reads it without asking which provider it holds: a client
  // that has no such property simply refuses nothing.
  readonly property var unsupported: {
    var out = []
    if (!root.ready) return out
    // A token minted without the submission scope would otherwise be offered a
    // Send button the server refuses.
    if (!root.session.canSend) out.push("send")
    // Moving to Junk teaches an arbitrary server nothing.
    if (!root.session.junkTrains) out.push("spam")
    // A server need not have somewhere to archive to.
    if (root.mailboxesKnown && !root.knownRoles["archive"]) out.push("archive")
    return out
  }

  property var rowCache: ({})

  function cacheRows(list) {
    var next = {}
    var entries = Array.isArray(list) ? list : []
    for (var i = 0; i < entries.length; i++) {
      var id = String(entries[i].id || "")
      if (id !== "") next[id] = entries[i]
    }
    root.rowCache = next
  }

  function rolesById() {
    var out = {}
    for (var role in root.knownRoles) {
      if (root.knownRoles.hasOwnProperty(role)) out[root.knownRoles[role]] = role
    }
    return out
  }

  function listMessages(query, maxResults, pageToken, callback, progress) {
    var limit = Math.max(1, Math.min(100, Math.floor(Number(maxResults)) || 25))
    var offset = Math.max(0, Math.floor(Number(pageToken)) || 0)

    return page(query, limit, offset, function(result, error) {
      if (typeof callback !== "function") return
      if (error) {
        callback(null, error)
        return
      }
      root.cacheRows(result.messages)
      var ids = []
      var threadIds = []
      for (var i = 0; i < result.messages.length; i++) {
        ids.push(String(result.messages[i].id || ""))
        threadIds.push(String(result.messages[i].threadId || ""))
      }
      var next = offset + ids.length
      callback({
        ids: ids,
        // Unlike IMAP, these are the server's own conversation ids rather than
        // an empty list the reader has to reconstruct from References.
        threadIds: threadIds,
        nextPageToken: ids.length > 0 && next < result.total ? String(next) : "",
        estimate: result.total
      }, "")
    })
  }

  // Headers come from the page that already fetched them; a body does not, and
  // is the raw message so `Message.parseRfc822` reads it exactly as it reads
  // IMAP's.
  function getMessages(ids, full, callback, existingHandle, progress) {
    var handle = existingHandle || newHandle()
    var wanted = Array.isArray(ids) ? ids : []
    if (wanted.length === 0) {
      if (typeof callback === "function") Qt.callLater(function() { callback([], "") })
      return handle
    }

    var missing = []
    for (var i = 0; i < wanted.length; i++) {
      if (!root.rowCache[wanted[i]]) missing.push(wanted[i])
    }

    function deliver(rows) {
      if (!root || handle.aborted) return
      if (typeof callback !== "function") return
      if (!full) {
        callback(Jmap.messagesFrom(rows, root.rolesById()), "")
        return
      }
      root.withBodies(rows, callback, handle, progress)
    }

    if (missing.length === 0) {
      var cached = []
      for (var j = 0; j < wanted.length; j++) cached.push(root.rowCache[wanted[j]])
      // Still asynchronous: a caller that got its answer before it had finished
      // setting itself up would be a different kind of bug on every provider.
      Qt.callLater(function() { deliver(cached) })
      return handle
    }

    withSession(function(session, sessionError) {
      if (!root || handle.aborted) return
      if (!session) {
        if (typeof callback === "function") callback(null, sessionError)
        return
      }
      root.call(Jmap.getRequest(session.accountId, wanted), function(body, error) {
        if (!root || handle.aborted) return
        if (error) {
          if (typeof callback === "function") callback(null, error)
          return
        }
        var found = Jmap.responseFor(body, "messages")
        var rows = found ? (found.payload.list || []) : []
        deliver(rows)
      }, handle)
    }, handle)

    return handle
  }

  // One download per message, which is what opening a message costs on IMAP
  // too. Fetched in sequence rather than at once: a thread of twenty is twenty
  // whole messages, and firing them together is how a home connection stalls.
  function withBodies(rows, callback, handle, progress) {
    var out = []
    var index = 0

    function next() {
      if (!root || handle.aborted) return
      if (index >= rows.length) {
        if (typeof callback === "function") callback(out, "")
        return
      }
      var row = rows[index]
      index++
      var url = Jmap.downloadUrlFor(root.session, row.blobId, "message/rfc822", "message.eml")
      if (url === "") {
        out.push(Jmap.messageFrom(row, root.rolesById()))
        next()
        return
      }
      auth.withToken(function(token, tokenError) {
        if (!root || handle.aborted) return
        if (!token) {
          if (typeof callback === "function") callback(null, tokenError || "Not signed in")
          return
        }
        root.inFlight++
        root.send("GET", url, token, null, function(status, payload, error, raw) {
          if (!root || handle.aborted) return
          if (error) {
            if (typeof callback === "function") callback(null, error)
            return
          }
          var message = Jmap.messageFrom(row, root.rolesById())
          // The raw message replaces the synthesised headers with the real
          // ones, and brings the parts, attachments and calendar entries with
          // it. The snippet JMAP already sent is kept: it is the server's own.
          var parsed = Mail.parseRfc822(String(raw || ""))
          if (parsed) message.payload = parsed
          out.push(message)
          if (typeof progress === "function") progress(out.length, rows.length)
          next()
        }, handle)
      })
    }

    next()
    return handle
  }

  function getMessage(id, full, callback) {
    return getMessages([id], full, function(list, error) {
      if (typeof callback !== "function") return
      if (error) callback(null, error)
      else callback(list && list.length > 0 ? list[0] : null, "")
    })
  }

  // The mailboxes, in the shape the sidebar reads labels in.
  //
  // This asks the server every time rather than serving `knownMailboxes`. The
  // ids in that cache are stable and worth keeping — a mailbox does not change
  // id — but the counts on it are a snapshot of whenever it was filled, and a
  // sidebar showing a number that stopped moving an hour ago is worse than one
  // that costs a round trip. `Mailbox/get` is a single cheap call.
  function getLabels(callback) {
    var handle = newHandle()
    withSession(function(session, sessionError) {
      if (!root || handle.aborted) return
      if (typeof callback !== "function") return
      if (!session) {
        callback([], sessionError)
        return
      }
      root.call(Jmap.mailboxesRequest(session.accountId), function(body, error) {
        if (!root || handle.aborted) return
        if (typeof callback !== "function") return
        if (error) {
          callback([], error)
          return
        }
        var found = Jmap.responseFor(body, "mailboxes")
        var boxes = found ? (found.payload.list || []) : []
        // Refreshes the id map too, so the two never disagree about what
        // exists.
        root.rememberMailboxes(boxes)
        var out = []
        for (var i = 0; i < boxes.length; i++) {
          var box = boxes[i] || {}
          out.push({
            id: String(box.id || ""),
            name: String(box.name || ""),
            rawName: String(box.name || ""),
            role: String(box.role || ""),
            unread: typeof box.unreadEmails === "number" ? box.unreadEmails : 0,
            total: typeof box.totalEmails === "number" ? box.totalEmails : 0
          })
        }
        callback(out, "")
      }, handle)
    }, handle)
    return handle
  }

  function getLabelCounts(labelId, callback) {
    return getLabels(function(list, error) {
      if (typeof callback !== "function") return
      if (error) {
        callback(null, error)
        return
      }
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === String(labelId)) {
          callback({ unread: list[i].unread, total: list[i].total }, "")
          return
        }
      }
      callback({ unread: 0, total: 0 }, "")
    })
  }

  // The session already names the account, so this costs nothing.
  function getProfile(callback) {
    return withSession(function(session, error) {
      if (typeof callback !== "function") return
      if (!session) {
        callback(null, error)
        return
      }
      callback({
        email: session.username,
        messagesTotal: 0,
        threadsTotal: 0,
        historyId: session.state
      }, "")
    })
  }

  // ----------------------------------------------------------------- writes

  function applyPlan(ids, plan, callback, existingHandle) {
    var handle = existingHandle || newHandle()
    // Checked before the empty test, because an unresolvable move looks
    // identical to an empty plan and must not be reported as done. Saying yes
    // here moves the row out of the list and notes "Archived" for a request no
    // server was ever sent.
    if (Jmap.planUnresolved(plan)) {
      if (typeof callback === "function") {
        var missing = Jmap.roleName(plan.moveRole)
        Qt.callLater(function() {
          callback(false, "This mailbox has no " + missing + " folder to move it to")
        })
      }
      return handle
    }
    if (Jmap.planIsEmpty(plan) || !Array.isArray(ids) || ids.length === 0) {
      if (typeof callback === "function") Qt.callLater(function() { callback(true, "") })
      return handle
    }
    withSession(function(session, sessionError) {
      if (!root || handle.aborted) return
      if (!session) {
        if (typeof callback === "function") callback(false, sessionError)
        return
      }
      root.call(Jmap.updateRequest(session.accountId, ids, plan), function(body, error) {
        if (!root || handle.aborted) return
        if (typeof callback !== "function") return
        if (error) {
          callback(false, error)
          return
        }
        var reply = Jmap.responseFor(body, "update")
        var failures = reply ? Jmap.setFailures(reply.payload) : []
        if (failures.length > 0) {
          // A batch can half succeed, so the count is the honest answer rather
          // than a flat failure that would put every row back.
          callback(false, failures.length + " of " + ids.length
            + " could not be changed: " + (failures[0].description || failures[0].type))
          return
        }
        // The rows we hold are now stale in exactly the way we just asked for.
        root.rowCache = ({})
        callback(true, "")
      }, handle)
    }, handle)
    return handle
  }

  function modifyMessage(id, addLabelIds, removeLabelIds, callback) {
    return batchModify([id], addLabelIds, removeLabelIds, callback)
  }

  function batchModify(ids, addLabelIds, removeLabelIds, callback) {
    var handle = newHandle()
    withMailboxes(function(error) {
      if (!root || handle.aborted) return
      if (error) {
        if (typeof callback === "function") callback(false, error)
        return
      }
      root.applyPlan(ids, Jmap.planFromLabels(addLabelIds, removeLabelIds, root.knownRoles),
        callback, handle)
    }, handle)
    return handle
  }

  function trashMessage(id, callback) {
    return batchModify([id], ["TRASH"], [], callback)
  }

  function untrashMessage(id, callback) {
    return batchModify([id], [], ["TRASH"], callback)
  }

  // An attachment is a blob like the message itself.
  // The handle is threaded into the fetch rather than kept beside it: a handle
  // that only guards the callback suppresses the answer while the request runs
  // on, so closing the reader would leave a message download and a blob fetch
  // in flight. `ImapClient.getAttachment` returns its `getMessage` handle for
  // the same reason.
  function getAttachment(messageId, attachmentId, callback) {
    var handle = newHandle()
    getMessages([messageId], true, function(list, error) {
      if (!root || handle.aborted) return
      var message = list && list.length > 0 ? list[0] : null
      if (error || !message) {
        if (typeof callback === "function") callback(null, error || "That message is no longer here")
        return
      }
      var part = Mail.partForAttachment(message.payload, attachmentId)
      if (typeof callback === "function")
        callback(part && part.body ? part.body.data : null,
          part ? "" : "That attachment is no longer on the message")
    }, handle)
    return handle
  }

  // ------------------------------------------------------------------ sending
  //
  // JMAP has no method that takes a finished message and sends it: a
  // submission names an `Email` the server already holds. So the raw message
  // the panel built is uploaded as a blob, imported into the account, and then
  // submitted — three round trips where SMTP takes one.
  //
  // Worth it for the same reason the read path downloads raw:
  // `Message.buildRawMessage` already produces a correct message, attachments
  // and alternatives included, and rebuilding that as a structured `Email`
  // would be a second implementation of MIME that could disagree with the
  // first.

  property var identities: []

  function withIdentities(callback, existingHandle) {
    var handle = existingHandle || newHandle()
    if (root.identities.length > 0) {
      if (typeof callback === "function") callback(root.identities, "")
      return handle
    }
    withSession(function(session, sessionError) {
      if (!root || handle.aborted) return
      if (!session) {
        if (typeof callback === "function") callback([], sessionError)
        return
      }
      if (!session.canSend) {
        if (typeof callback === "function")
          callback([], "This token was not given permission to send mail")
        return
      }
      root.call(Jmap.identitiesRequest(session.accountId), function(body, error) {
        if (!root || handle.aborted) return
        if (error) {
          if (typeof callback === "function") callback([], error)
          return
        }
        var found = Jmap.responseFor(body, "identities")
        root.identities = found ? (found.payload.list || []) : []
        if (typeof callback === "function") callback(root.identities, "")
      }, handle)
    }, handle)
    return handle
  }

  // The addresses this mailbox may send as, in the shape Gmail's endpoint
  // returns so nothing above the provider has to know the difference.
  function getSendAs(callback) {
    return withIdentities(function(list, error) {
      if (typeof callback !== "function") return
      if (error) {
        // Not a failure worth stopping on: a mailbox that cannot send still
        // shows the address it receives at.
        callback([{ email: root.session ? root.session.username : "", name: "",
                    isDefault: true, isPrimary: true }], "")
        return
      }
      callback(Jmap.identitiesFrom(list), "")
    })
  }

  // The message's own bytes, under their own type. The reply names the blob
  // every later call refers to.
  function uploadRaw(message, callback, handle) {
    var url = Jmap.uploadUrlFor(root.session)
    if (url === "") {
      if (typeof callback === "function") callback("", "This server does not accept uploads")
      return
    }
    auth.withToken(function(token, tokenError) {
      if (!root || handle.aborted) return
      if (!token) {
        if (typeof callback === "function") callback("", tokenError || "Not signed in")
        return
      }
      root.inFlight++
      root.send("POST", url, token, message, function(status, payload, error) {
        if (!root || handle.aborted) return
        if (typeof callback !== "function") return
        if (error) {
          callback("", error)
          return
        }
        var blobId = payload && payload.blobId ? String(payload.blobId) : ""
        callback(blobId, blobId === "" ? "The server did not accept the message" : "")
      }, handle, "message/rfc822")
    })
  }

  // Upload, then import into a mailbox. `callback(emailId, error)`.
  function importRaw(payload, mailboxRole, asDraft, callback, handle) {
    var raw = payload && payload.raw ? String(payload.raw) : ""
    if (raw === "") {
      if (typeof callback === "function") callback("", "There is nothing to send")
      return
    }
    var message = Mail.decodeBase64Url(raw)

    withMailboxes(function(mailboxError) {
      if (!root || handle.aborted) return
      if (mailboxError) {
        if (typeof callback === "function") callback("", mailboxError)
        return
      }
      root.uploadRaw(message, function(blobId, uploadError) {
        if (!root || handle.aborted) return
        if (uploadError) {
          if (typeof callback === "function") callback("", uploadError)
          return
        }
        // A server with no mailbox for this role still imports; the message
        // simply lands nowhere the sidebar names, which beats refusing to send.
        var box = String(root.knownRoles[mailboxRole] || "")
        root.call(Jmap.importRequest(root.session.accountId, blobId, box, asDraft),
          function(body, error) {
            if (!root || handle.aborted) return
            if (typeof callback !== "function") return
            if (error) {
              callback("", error)
              return
            }
            var reply = Jmap.responseFor(body, "import")
            var refused = reply ? Jmap.createError(reply.payload, "draft") : ""
            if (refused !== "") {
              callback("", refused)
              return
            }
            var emailId = reply ? Jmap.createdId(reply.payload, "draft") : ""
            callback(emailId, emailId === "" ? "The server did not keep the message" : "")
          }, handle)
      }, handle)
    }, handle)
  }

  function saveDraft(payload, callback) {
    var handle = newHandle()
    importRaw(payload, "drafts", true, function(emailId, error) {
      if (!root || handle.aborted) return
      if (error) {
        if (typeof callback === "function") callback(null, error)
        return
      }
      // A draft that replaced an earlier one leaves the earlier one behind
      // unless it is said so.
      var previous = payload && payload.draftId ? String(payload.draftId) : ""
      if (previous === "" || previous === emailId) {
        if (typeof callback === "function") callback({ id: emailId, draftId: emailId }, "")
        return
      }
      root.call(Jmap.destroyRequest(root.session.accountId, [previous]), function() {
        if (typeof callback === "function") callback({ id: emailId, draftId: emailId }, "")
      }, handle)
    }, handle)
    return handle
  }

  function sendMessage(payload, callback) {
    var handle = newHandle()

    withIdentities(function(list, identityError) {
      if (!root || handle.aborted) return
      if (identityError) {
        if (typeof callback === "function") callback(null, identityError)
        return
      }
      var identity = Jmap.pickIdentity(list, root.session ? root.session.username : "")
      if (!identity) {
        if (typeof callback === "function")
          callback(null, "This mailbox has no address it may send from")
        return
      }

      // Imported without `$draft`: the submission is what files it, and a send
      // that fails should not leave something looking like a draft nobody wrote.
      root.importRaw(payload, "drafts", false, function(emailId, importError) {
        if (!root || handle.aborted) return
        if (importError) {
          if (typeof callback === "function") callback(null, importError)
          return
        }
        var sent = String(root.knownRoles["sent"] || "")
        root.call(Jmap.submitRequest(root.session.accountId, identity.id, emailId, sent),
          function(body, error) {
            if (!root || handle.aborted) return
            if (typeof callback !== "function") return
            if (error) {
              callback(null, error)
              return
            }
            var reply = Jmap.responseFor(body, "submit")
            var refused = reply ? Jmap.createError(reply.payload, "send") : ""
            if (refused !== "") {
              callback(null, refused)
              return
            }
            // The sent copy is now somewhere the inbox listing does not know
            // about, and the draft it was is gone.
            root.rowCache = ({})
            var draftId = payload && payload.draftId ? String(payload.draftId) : ""
            if (draftId !== "") {
              root.call(Jmap.destroyRequest(root.session.accountId, [draftId]), function() {
                callback({ id: emailId, threadId: payload ? payload.threadId : "" }, "")
              }, handle)
              return
            }
            callback({ id: emailId, threadId: payload ? payload.threadId : "" }, "")
          }, handle)
      }, handle)
    }, handle)

    return handle
  }

  // A token is verified by using it: a server that answers the session
  // resource will answer everything else. Nothing is written to the keyring
  // before this comes back, so a mistyped token fails in the form rather than
  // silently later.
  function verifyCredentials(host, token, callback) {
    var handle = newHandle()
    var url = Jmap.sessionUrl(host)
    if (url === "") {
      if (typeof callback === "function")
        Qt.callLater(function() { callback(false, "That is not a server address") })
      return handle
    }
    root.inFlight++
    root.send("GET", url, token, null, function(status, payload, error) {
      if (!root) return
      if (typeof callback !== "function") return
      if (error) {
        callback(false, error)
        return
      }
      var parsed = Jmap.parseSession(payload, host)
      if (!parsed.ok) {
        callback(false, parsed.error)
        return
      }
      // Kept, so the first page after sign-in does not fetch it again.
      root.session = parsed
      callback(true, "")
    }, handle)
    return handle
  }

  Connections {
    target: root.auth
    function onVerifyRequested(host, token) {
      root.verifyCredentials(host, token, function(ok, error) {
        if (root.auth) root.auth.completeSignIn(ok, error)
      })
    }
  }

  // ------------------------------------------------------------------- push
  //
  // A held-open connection the server writes to when something moves. It does
  // not replace the panel's refresh timer — a server may offer no event source,
  // and a held connection drops — it only makes that timer's work happen sooner.
  //
  // `MailAccount` connects to this without knowing which provider it holds:
  // the clients that cannot push simply never emit it.
  signal mailboxChanged()

  property bool pushEnabled: true
  property int pushAttempts: 0
  property string pushRequest: ""
  readonly property bool pushing: pushStream.running

  function startPush() {
    if (!root.pushEnabled || !root.ready) return
    if (!root.session.canPush) return
    if (pushStream.running) return
    var url = Jmap.pushUrlFor(root.session, 300)
    if (url === "") return

    auth.withToken(function(token, tokenError) {
      if (!root || !root.pushEnabled) return
      if (!token) return
      if (pushStream.running) return
      // Both fields base64, so the line splits on spaces with no quoting rules
      // — the same shape every other script here reads.
      root.pushRequest = Qt.btoa(url) + " " + Qt.btoa(token)
      pushStream.command = [auth.pluginDir + "/scripts/jmap-push.sh"]
      pushStream.running = true
    })
  }

  function stopPush() {
    root.pushEnabled = false
    pushRetry.stop()
    if (pushStream.running) pushStream.running = false
  }

  function handlePushLine(line) {
    if (!root.ready) return
    var event = Jmap.pushChange(line, root.session.accountId)
    if (!event.changed) return
    // The rows we hold may no longer be what the mailbox contains.
    root.rowCache = ({})
    root.pushAttempts = 0
    root.mailboxChanged()
  }

  // Connect as soon as there is a session to connect with. `ready` turns true
  // once the first request has fetched one.
  onReadyChanged: if (root.ready) root.startPush()

  Process {
    id: pushStream
    stdinEnabled: true
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) { root.handlePushLine(line) }
    }
    stderr: StdioCollector { waitForEnd: true }
    onStarted: {
      write(root.pushRequest + "\n")
      root.pushRequest = ""
    }
    onExited: function(exitCode) {
      root.pushRequest = ""
      if (!root.pushEnabled) return
      // Every stream ends eventually; that is not a fault. Reconnect, backing
      // off so a server that is down is not dialled twice a second.
      root.pushAttempts = root.pushAttempts + 1
      pushRetry.interval = Jmap.pushBackoffMs(root.pushAttempts)
      pushRetry.start()
    }
  }

  Timer {
    id: pushRetry
    repeat: false
    onTriggered: root.startPush()
  }

  Component {
    id: deadlineComponent

    Timer {
      repeat: false
    }
  }
}
