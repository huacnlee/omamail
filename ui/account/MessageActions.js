.pragma library

// Asked of the mailbox that owns the row rather than of the visible one: in
// a merged list `e` and `s` reach `act` for a message whose provider may not
// have the verb, and the refusal has to name that provider.
function refuseUnavailableAction(service, action, id) {
  var host = id === undefined ? service.current : service.hostForId(id)
  if (!host) host = service.current
  return host ? host.refuseUnavailableAction(action) : true
}
function act(service, id, action, quiet, memberOnly) {
  var host = service.hostForId(id)
  return host ? host.act(service.sourceIdFor(id), action, quiet, memberOnly) : false
}
function toggleStar(service, id) {
  var host = service.hostForId(id)
  if (host) host.toggleStar(service.sourceIdFor(id))
}
// Saving one message out as a file. The owning mailbox does the work; the
// capability is the provider's ceiling and the backend method together.
function canExportEmlFor(service, id) {
  if (!service.backendCanExportEml) return false
  var host = (id === undefined || id === "") ? service.current : service.hostForId(id)
  return !!host && host.canExportEml
}
// The mailbox that owns a message id. A merged id carries its owner; a bare
// native id belongs to the mailbox on screen. The message menu captures this
// when it opens, so a later account switch cannot re-route the action.
function accountForMessage(service, id) {
  var host = service.hostForId(id)
  return host ? String(host.accountId || "") : ""
}
// The dispatch boundary every export entry point goes through. `accountId`
// and `id` are the owning mailbox and that mailbox's own name for the
// message, captured by a caller that must keep them across an account
// switch. A non-unified view refuses when the captured mailbox is no longer
// the one on screen: 42:INBOX is a different message in the next account.
function exportEmlFor(service, accountId, id) {
  var target = String(id || "")
  if (target === "") return false
  if (!service.backendCanExportEml) {
    service.fail("Saving .eml needs a newer Omamail backend")
    return false
  }
  var owner = service.findAccount(String(accountId || ""))
  if (!owner) {
    service.fail("That mailbox is no longer set up, so nothing was saved")
    return false
  }
  if (!service.unified && owner !== service.current) {
    service.fail("That message is no longer on screen, so nothing was saved")
    return false
  }
  if (!owner.ready) {
    owner.fail("Sign in before saving a message as .eml")
    return false
  }
  if (!owner.canExportEml) {
    owner.fail("This mailbox cannot save messages as .eml")
    return false
  }
  return owner.exportEml(target)
}
function exportEml(service, id) {
  if (!canExportEmlFor(service, id)) {
    service.fail("This mailbox cannot save messages as .eml")
    return false
  }
  var host = service.hostForId(id)
  if (!host) return false
  return exportEmlFor(service, host.accountId, service.sourceIdFor(id))
}
// Save as .eml from the keyboard: the reader's open message, else the list's
// cursor row. Resolved here so App.qml stays a one-line case like the rest.
function exportFromView(service, view, cursorId) {
  var id = view === "reader" && service.selectedId !== "" ? service.selectedId : cursorId
  return String(id || "") === "" ? false : exportEml(service, id)
}
function markAllRead(service) {
  if (!service.unified) {
    if (service.current) service.current.markAllRead()
    return
  }
  service.eachHost(function(host) { host.markAllRead() })
}
// Several ticked rows at once. A merged list draws rows from several
// mailboxes, and a batch is one mailbox's request, so it is refused there
// the way a move is: the rule every unavailable action follows.
function actMany(service, ids, action) {
  if (service.unified) {
    service.fail("Acting on several messages needs one mailbox on screen")
    return false
  }
  return service.current ? service.current.actMany(ids, action) : false
}

// What the status line says once the file exists. The backend answers with
// the full path it created, which can carry a " (2)" the subject did not, so
// the name comes first and the folder after it, as an attachment save does.
function exportSavedNotice(result) {
  var path = String(result && result.path || "")
  var at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
  var name = String(result && result.filename || "") || path.substring(at + 1)
  return at > 0 ? "Saved " + name + " to " + path.substring(0, at) : "Saved " + (name || "the message as .eml")
}

// The backend refuses with a code; the status line says what happened.
var EXPORT_ERRORS = {
  mail_export_too_large: "This message is larger than 25 MB, so it was not saved",
  mail_export_message_missing: "That message is no longer on the server",
  mail_export_in_flight: "Already saving a message as .eml",
  mail_export_write_failed: "Could not write the .eml file to Downloads",
  mail_auth_failed: "The server rejected the sign-in. Sign in again.",
  auth_signed_out: "The server rejected the sign-in. Sign in again.",
  request_timed_out: "The mail server did not answer in time, so nothing was saved",
  request_cancelled: "Saving the message as .eml was cancelled",
  backend_needs_update: "Saving .eml needs a newer Omamail backend"
}
function exportErrorText(error) {
  var code = String(error && error.message || error || "")
  return EXPORT_ERRORS.hasOwnProperty(code) ? EXPORT_ERRORS[code] : "Could not save the message as .eml"
}

// API 7 introduced export. Keep the fixed revision and advertised method
// checks after release, and refuse a handshake that is not ready.
function backendCanExportEml(backend) {
  var info = backend ? backend.protocolInfo : null
  return !!backend && backend.ready === true && !!info && info.apiVersion >= 7
    && Array.isArray(info.methods) && info.methods.indexOf("mail.exportEml") >= 0
}

// The shortcut sheet offers only actions the connected mailbox can honor.
function hiddenBindings(service, view, cursorId) {
  var hidden = service && service.hasAgent === false
    ? ["askAgent", "assistantSend", "assistantChooseCommand", "assistantCommandNext", "assistantCommandPrevious"] : []
  var id = view === "reader" && service && service.selectedId !== "" ? service.selectedId : cursorId
  if (!service || !service.canExportEmlFor(id)) hidden.push("exportEml")
  return hidden
}
