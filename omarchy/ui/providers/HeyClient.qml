import QtQuick

import "HeyCli.js" as Cli

// Presentation adapter. Rust owns HEY commands, parsing and network work.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property var auth
  property var backend: null
  property var messageResources: ({})

  property int inFlight: 0
  readonly property bool busy: inFlight > 0

  property string address: ""

  function newHandle() { return { aborted: false, children: [] } }
  function abortRequest(handle) {
    if (!handle) return
    handle.aborted = true
    var children = handle.children || []
    for (var i = 0; i < children.length; i++) abortRequest(children[i])
  }

  function usesBackend() {
    return backend && String(backend.executable || "") !== ""
  }

  function backendRead(method, params, callback, handle) {
    var account = auth ? String(auth.accountId || "") : ""
    var program = auth ? String(auth.heyPath || "") : ""
    if (!auth || !auth.loggedIn || (account === "" && method !== "hey.profile") || program === "") {
      Qt.callLater(function() {
        if (!handle.aborted) callback(null, "Sign in to the configured HEY account first")
      })
      return handle
    }
    if (account !== "") {
      params.accountId = account
      params.program = program
    }
    if (!usesBackend()) {
      Qt.callLater(function() { if (!handle.aborted) callback(null, "Mail backend unavailable") })
      return handle
    }
    root.inFlight++
    backend.call(method, params, function(result, error) {
      root.inFlight = Math.max(0, root.inFlight - 1)
      if (handle.aborted) return
      if (!auth || !auth.loggedIn || String(auth.accountId || "") !== account
          || String(auth.heyPath || "") !== program) {
        callback(null, "The HEY account changed during this request")
        return
      }
      var message = error ? Cli.redact(String(error.message || "HEY backend request failed")) : ""
      if (/sign in|not (logged|signed) in|unauthor/i.test(message)
          && typeof auth.reportAuthFailure === "function") auth.reportAuthFailure()
      callback(result, message)
    })
    return handle
  }

  function rememberResource(resource) {
    var next = {}
    for (var key in messageResources) next[key] = messageResources[key]
    next[String(resource.id)] = resource
    messageResources = next
  }

  function listMessages(query, maxResults, pageToken, callback, progress) {
    var handle = newHandle()
    if (usesBackend()) {
      return backendRead("hey.list", {
        query: String(query || ""), pageToken: String(pageToken || ""),
        pageSize: Math.max(1, Math.min(100, Number(maxResults) || 25))
      }, function(result, error) {
        if (!error && result && Array.isArray(result.messages)) {
          for (var i = 0; i < result.messages.length; i++)
            root.rememberResource(result.messages[i])
        }
        if (typeof callback === "function") callback(result, error)
      }, handle)
    }
    Qt.callLater(function() { if (!handle.aborted) callback(null, "Mail backend unavailable") })
    return handle
  }

  // The counted members of a conversation, for the reader's conversation rail.
  //
  // Always empty, and HEY is never asked: a HEY row already *is* a conversation
  // and carries no member ids, so its `thread` block reports a count of 0 —
  // unknown — and the rail draws nothing. The body on screen is the whole
  // conversation here, which is the thing the rail would otherwise be for.
  function getSummaries(ids, callback) {
    var handle = newHandle()
    Qt.callLater(function() {
      if (!root || handle.aborted || typeof callback !== "function") return
      callback([], "")
    })
    return handle
  }

  // A whole page with no round trips at all: the listing that produced these
  // ids carried every field a row needs, so this is the cache answering.
  //
  // Deferred rather than answered on the spot even though the answer is in
  // hand. Every caller is written against a callback that arrives later, and
  // running one partway through the function that started it is a re-entry the
  // Gmail client never produces.
  function getMessages(ids, full, callback, existingHandle, progress) {
    var handle = existingHandle || newHandle()
    var list = Array.isArray(ids) ? ids : []
    if (typeof callback !== "function") return handle

    if (full === true) {
      var results = new Array(list.length)
      var remaining = list.length
      var firstError = ""
      if (remaining === 0) {
        Qt.callLater(function() { if (root) callback([], "") })
        return handle
      }
      for (var i = 0; i < list.length; i++) {
        (function(index) {
          var child = root.getMessage(list[index], true, function(payload, error) {
            if (handle.aborted) return
            if (error && !firstError) firstError = error
            results[index] = payload
            if (payload && typeof progress === "function") progress([payload])
            remaining--
            if (remaining > 0) return
            var ordered = []
            for (var j = 0; j < results.length; j++) {
              if (results[j]) ordered.push(results[j])
            }
            callback(ordered, firstError)
          })
          handle.children.push(child)
        })(i)
      }
      return handle
    }

    Qt.callLater(function() {
      if (!root || handle.aborted) return
      var out = []
      for (var i = 0; i < list.length; i++) {
        if (root.usesBackend()) {
          var resource = root.messageResources[String(list[i])]
          if (resource) out.push(resource)
          continue
        }

      }
      if (out.length > 0 && typeof progress === "function") progress(out)
      callback(out, out.length > 0 || list.length === 0 ? ""
        : "Those messages are no longer in the mailbox")
    })
    return handle
  }

  function getMessage(id, full, callback) {
    var handle = newHandle()
    var messageId = String(id || "")

    if (usesBackend()) {
      if (full !== true) {
        Qt.callLater(function() {
          if (handle.aborted || typeof callback !== "function") return
          var known = root.messageResources[messageId]
          callback(known || null, known ? "" : "That message is no longer in the mailbox")
        })
        return handle
      }
      return backendRead("hey.read", { id: messageId }, function(result, error) {
        var known = root.messageResources[messageId]
        if (!error && result && known && Cli.draftIdOf(messageId) === "") {
          result.payload.headers = known.payload.headers.filter(function(header) {
            return String(header.name || "").toLowerCase() !== "content-type"
          }).concat(result.payload.headers || [])
          result.labelIds = known.labelIds
          result.internalDate = known.internalDate
          result.snippet = known.snippet
        }
        if (typeof callback === "function") callback(result, error)
      }, handle)
    }

    Qt.callLater(function() { if (!handle.aborted) callback(null, "Mail backend unavailable") })
    return handle
  }

  // HEY serves a thread's files through a command of its own, which saves them
  // to disk rather than handing over their octets. Nothing asks for one: the
  // composed payload declares no attachment parts, so the reader lists none and
  // the invitation reader never finds a part to fetch.
  function getAttachment(messageId, attachmentId, callback) {
    var handle = newHandle()
    if (typeof callback !== "function") return handle
    Qt.callLater(function() {
      if (!root || handle.aborted) return
      callback("", "HEY serves attachments through `hey attachments`, which this cannot read yet")
    })
    return handle
  }

  // HEY's labels, in the shape the sidebar reads them in. Counts are left at
  // zero: there is no command that answers one, and the sidebar is drawn before
  // anyone has asked for a number on it.
  function getLabels(callback) {
    return backendRead("hey.labels", {}, callback, newHandle())
  }
  function getProfile(callback) {
    return backendRead("hey.profile", {}, function(result, error) {
      if (result) root.address = String(result.email || "")
      if (typeof callback === "function") callback(result, error)
    }, newHandle())
  }

  // HEY sends as the address it is signed in as. Returned in the same shape as
  // Gmail's aliases so everything above the provider boundary stays neutral.
  function getSendAs(callback) {
    if (typeof callback !== "function") return newHandle()
    if (address !== "") {
      var known = address
      Qt.callLater(function() {
        if (!root) return
        callback([{ email: known, displayName: "", isPrimary: true, isDefault: true }], "")
      })
      return newHandle()
    }
    return getProfile(function(profile, error) {
      if (error || !profile || String(profile.email || "") === "") {
        callback([], error)
        return
      }
      callback([{ email: String(profile.email), displayName: "", isPrimary: true, isDefault: true }], "")
    })
  }

  // --------------------------------------------------------------- writes

  // `MailAccount` asks in Gmail's vocabulary whichever provider it holds, so
  // the label ids arrive here and become HEY's own verbs. A pair HEY has no
  // verb for is nothing to do rather than something close to it — the panel
  // already hides the buttons this provider does not declare.
  function modifyMessage(id, addLabelIds, removeLabelIds, callback) {
    return batchModify([id], addLabelIds, removeLabelIds, callback)
  }

  function batchModify(ids, addLabelIds, removeLabelIds, callback) {
    var verb = Cli.verbForLabels(addLabelIds, removeLabelIds)
    return act(verb, ids, callback)
  }

  // HEY's labels are HEY's own. The capability is off, so no button reaches
  // these; they exist so every client answers the same calls.
  function createLabel(name, callback) { return refuseLabelChange(callback) }
  function renameLabel(id, name, callback) { return refuseLabelChange(callback) }
  function deleteLabel(id, callback) { return refuseLabelChange(callback) }
  function refuseLabelChange(callback) {
    if (typeof callback === "function")
      Qt.callLater(function() { if (root) callback(null, "HEY labels are managed on HEY") })
    return newHandle()
  }

  // One id or a list of them. A HEY message id is `<posting>:<topic>`, and a
  // conversation's members all share the topic — so a list arriving from a row
  // that stands for a conversation can name the same posting more than once.
  // `Cli.actionCommand` already keeps each posting once, which is why the list
  // is handed straight to it rather than wrapped in another array.
  function trashMessage(id, callback) {
    return act("trash", Array.isArray(id) ? id : [id], callback)
  }

  function untrashMessage(id, callback) {
    return act("untrash", Array.isArray(id) ? id : [id], callback)
  }

  // One verb, however many threads: every HEY command takes a list of ids, so a
  // batch is one invocation rather than one per message.
  function act(verb, ids, callback) {
    var handle = newHandle()
    if (usesBackend()) {
      return backendRead("hey.act", { verb: String(verb || ""), ids: ids }, function(result, error) {
        if (!error) root.forget(verb, ids)
        if (typeof callback === "function") callback(null, error)
      }, handle)
    }
    Qt.callLater(function() { if (!handle.aborted) callback(null, "Mail backend unavailable") })
    return handle
  }

  // What this client believed about a thread, after it has been changed. Only
  // the seen state is kept here and only two verbs move it, so the row is
  // corrected rather than dropped: dropping it would leave the reader, which is
  // already open on that message, with no headers on the next redraw.
  function forget(verb, ids) {
    if (verb !== "markRead" && verb !== "markUnread") return
    var list = Array.isArray(ids) ? ids : [ids]
    var updated = {}
    for (var resourceId in messageResources) updated[resourceId] = messageResources[resourceId]
    for (var r = 0; r < list.length; r++) {
      var resource = updated[String(list[r])]
      if (!resource) continue
      var changed = Object.assign({}, resource)
      changed.labelIds = resource.labelIds.filter(function(label) { return label !== "UNREAD" })
      if (verb === "markUnread") changed.labelIds.push("UNREAD")
      updated[String(list[r])] = changed
    }
    messageResources = updated
  }

  // ----------------------------------------------------------------- send

  // `MailAccount` builds the same payload for every provider: a base64url `raw`
  // field, because that is what Gmail's send endpoint takes. HEY takes neither
  // a raw message nor, for a reply, a recipient list — it decides who a reply
  // goes to, which is the right answer and not one this plugin could improve
  // on. So the message is taken apart again and handed over as the fields the
  // command has.
  function messageParams(payload, draft) {
    var value = payload || {}
    var params = { raw: String(value.raw || ""), threadId: String(value.threadId || ""),
      attachments: Array.isArray(value.attachments) ? value.attachments : [] }
    if (draft) params.draftId = String(value.draftId || "")
    return params
  }
  function sendMessage(payload, callback) {
    return backendRead("hey.send", messageParams(payload, false), callback, newHandle())
  }
  function deleteDraft(messageId, callback) {
    Qt.callLater(function() { if (typeof callback === "function") callback(null, "HEY draft deletion is not supported by the installed client") })
    return newHandle()
  }
  function saveDraft(payload, callback) {
    return backendRead("hey.saveDraft", messageParams(payload, true), callback, newHandle())
  }
}
