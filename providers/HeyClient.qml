import QtQuick
import Quickshell
import Quickshell.Io

import "HeyCli.js" as Cli
import "../message/Message.js" as Mail

// A HEY mailbox, wearing the same interface `GmailApiClient` wears.
//
// Every method here has a counterpart there with the same name, the same
// arguments and the same callback shape, and all three clients hand back
// Gmail's message resource — a headers array, a MIME tree, part bodies in
// base64url. That is the whole trick: `MailAccount` drives any of them without
// asking which it holds, and the list, the reader, the cache and the actions
// never learn that a third kind of mail service exists.
//
// The transport is a process: `hey`, asked for `--json`. The commands are
// `HeyCli.js`. This file is the part in between — which invocation a given
// request becomes, and how HEY's answer is rebuilt as a message.
//
// One difference from the other two is worth stating, because it shapes the
// rest of the file: **HEY is thread-shaped, and there is no RFC 822 anywhere.**
// A row is a posting, a body is a conversation, and neither arrives as a
// message with headers — so this client composes the resource rather than
// parsing one. The consequence is that the list read is the only place a row's
// subject, sender and date exist, which is why they are kept here between
// calls.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property var auth

  property int inFlight: 0
  readonly property bool busy: inFlight > 0

  // What the last listings said about each thread, keyed by message id.
  //
  // HEY answers a box with everything a row needs and a thread with the
  // conversation alone: there is no command that reads one thread's subject,
  // sender and date. So a listing's rows are kept, and opening a message joins
  // its body to the row that produced it. What survives a restart is
  // `Model.detailSummary`'s business rather than this cache's — it keeps the
  // list's own copy of a header the detail read did not carry.
  property var rows: ({})

  // The address `hey accounts list` reported, read once and reused: the profile
  // and the send-as list are the same question asked twice.
  property string address: ""

  function newHandle() {
    return { aborted: false, process: null, children: [] }
  }

  function abortRequest(handle) {
    if (!handle) return
    handle.aborted = true
    if (handle.process) {
      // Killing the command is what makes switching mailboxes mid-load instant
      // rather than something that waits for a fetch nobody wants.
      handle.process.running = false
      handle.process = null
    }
    var children = handle.children || []
    for (var i = 0; i < children.length; i++) abortRequest(children[i])
    handle.children = []
  }

  // ------------------------------------------------------------- transport

  // One invocation, one answer. `hey` holds the token and refreshes it itself,
  // so unlike the other two clients there is no credential to fetch first and
  // nothing to retry on a 401: a command that failed because the session ended
  // tells the auth object to look again, and the user is asked to sign in.
  function run(args, stdinText, callback, existingHandle) {
    var handle = existingHandle || newHandle()
    var list = withoutDroppedFlags(args)
    if (list.length === 0) {
      if (typeof callback === "function") callback("", "")
      return handle
    }

    var program = auth ? String(auth.heyPath || "") : ""
    if (program === "") {
      if (typeof callback === "function")
        callback("", "The HEY CLI is not installed")
      return handle
    }

    root.inFlight++
    var process = commandComponent.createObject(root, {
      command: [program].concat(list),
      // The body of a message crosses on stdin, so it never reaches the process
      // table and nothing has to be escaped on the way.
      input: String(stdinText || "")
    })
    if (!process) {
      root.inFlight = Math.max(0, root.inFlight - 1)
      if (typeof callback === "function") callback("", "Could not start the HEY CLI")
      return handle
    }

    handle.process = process
    process.finished.connect(function(status, out, err) {
      if (!root) return
      if (handle.process === process) handle.process = null
      process.destroy()
      root.inFlight = Math.max(0, root.inFlight - 1)
      if (handle.aborted) return
      if (typeof callback !== "function") return

      // An HTML document is a success by definition — `--html` writes markup or
      // it writes nothing — so it is recognised before the envelope is looked
      // for, which would not find one in it.
      if (status === 0 && Cli.isHtmlDocument(out)) {
        callback(out, "")
        return
      }
      var answer = Cli.payload(out)
      if (status === 0 && answer.ok) {
        callback(out, "")
        return
      }
      // A flag this plugin asks for that the installed `hey` has never heard
      // of. Cobra refuses the whole command for one, so the flag is dropped and
      // the command asked again — and remembered, so the round trip is paid
      // once per session rather than once per read. The retry terminates
      // because it only happens when the flag was in the command that just
      // ran, and each one removes it.
      var missing = Cli.unknownFlag(out === "" ? err : out)
      if (missing !== "" && Cli.isDroppableFlag(missing) && Cli.hasFlag(list, missing)) {
        root.dropFlag(missing)
        root.run(list, stdinText, callback, handle)
        return
      }

      var message = Cli.commandError(status, out, err, "HEY could not complete this request")
      // A session that ended looks like any other refusal from here, so the
      // auth object is asked to check rather than told what happened.
      if (/sign in|not (logged|signed) in|unauthor/i.test(message) && auth
          && typeof auth.reportAuthFailure === "function")
        auth.reportAuthFailure()
      callback("", message)
    })
    process.running = true
    return handle
  }

  // Flags the installed `hey` refused as unknown, which is how a release older
  // than this plugin announces itself. Every one of them is optional and
  // boolean by construction — see `HeyCli.threadCommand` — so dropping one
  // costs a reading rather than a command.
  property var droppedFlags: ({})

  function withoutDroppedFlags(args) {
    var out = Array.isArray(args) ? args.slice() : []
    for (var flag in droppedFlags) out = Cli.withoutFlag(out, flag)
    return out
  }

  function dropFlag(flag) {
    var next = {}
    for (var key in droppedFlags) next[key] = true
    next[String(flag)] = true
    droppedFlags = next
  }

  // ----------------------------------------------------------- the rows

  function remember(row) {
    if (!row || row.id === "") return
    var next = {}
    for (var key in rows) next[key] = rows[key]
    next[row.id] = row
    rows = next
  }

  function rowFor(id) {
    var key = String(id || "")
    return rows[key] ? rows[key] : null
  }

  // A posting and a body, as Gmail's message resource. This is the seam the
  // whole provider turns on: past this point nothing can tell the services
  // apart.
  //
  // The headers are composed rather than parsed, because HEY never served any.
  // Only the four the panel reads are written; inventing a Message-ID or a
  // References line would be inventing a threading answer HEY already has.
  function toMessage(id, row, body) {
    var known = row || {}
    var headers = []
    var from = known.from || { name: "", email: "" }
    if (from.name !== "" || from.email !== "")
      headers.push({ name: "From", value: Mail.addressHeader(from.email, from.name) })
    var recipients = Array.isArray(known.to) ? known.to : []
    var addressed = []
    for (var i = 0; i < recipients.length; i++) {
      addressed.push(Mail.addressHeader(recipients[i].email, recipients[i].name))
    }
    if (addressed.length > 0) headers.push({ name: "To", value: addressed.join(", ") })
    var copied = Array.isArray(known.cc) ? known.cc : []
    var copiedHeaders = []
    for (var c = 0; c < copied.length; c++)
      copiedHeaders.push(Mail.addressHeader(copied[c].email, copied[c].name))
    if (copiedHeaders.length > 0) headers.push({ name: "Cc", value: copiedHeaders.join(", ") })
    var hidden = Array.isArray(known.bcc) ? known.bcc : []
    var hiddenHeaders = []
    for (var b = 0; b < hidden.length; b++)
      hiddenHeaders.push(Mail.addressHeader(hidden[b].email, hidden[b].name))
    if (hiddenHeaders.length > 0) headers.push({ name: "Bcc", value: hiddenHeaders.join(", ") })
    if (String(known.subject || "") !== "")
      headers.push({ name: "Subject", value: String(known.subject) })
    if (String(known.date || "") !== "")
      headers.push({ name: "Date", value: String(known.date) })

    var html = body ? String(body.html || "") : ""
    var text = body ? String(body.text || "") : ""
    var payload = {
      mimeType: html !== "" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      headers: headers,
      body: { size: html !== "" ? html.length : text.length,
        data: Mail.encodeBase64Url(html !== "" ? html : text) },
      parts: []
    }

    // Unseen is the absence of a seen, and the only label HEY answers for. The
    // Imbox is the inbox; everything else is a box of its own, which nothing
    // above here has a name for.
    var labels = []
    if (!known.seen) labels.push("UNREAD")
    if (String(known.box || "") === "imbox") labels.push("INBOX")
    if (known.isDraft === true) labels.push("DRAFT")

    var date = String(known.date || "")
    var stamp = date === "" ? 0 : Date.parse(date)
    return {
      id: String(id || ""),
      // HEY's own conversation id, which is what makes a thread a thread here.
      threadId: known.isDraft === true ? "" : Cli.topicIdOf(id),
      labelIds: labels,
      internalDate: isFinite(stamp) && stamp > 0 ? String(stamp) : "",
      sizeEstimate: payload.body.size,
      payload: payload,
      snippet: String(known.snippet || "")
    }
  }

  // ---------------------------------------------------------------- reads

  function listMessages(query, maxResults, pageToken, callback, progress) {
    var handle = newHandle()
    var parsed = Cli.parseQuery(query)

    run(Cli.listCommand(parsed, maxResults, pageToken), "", function(text, error) {
      if (handle.aborted) return
      if (typeof callback !== "function") return
      if (error) {
        callback(null, error)
        return
      }
      var answer = Cli.payload(text)
      if (!answer.ok) {
        callback(null, answer.error)
        return
      }
      var found = parsed.kind === "drafts"
        ? Cli.parseDraftListing(answer.data)
        : Cli.filterRows(parsed, Cli.parseListing(answer.data))
      // One of HEY's pages was read; the size the user configured decides how
      // much of it this request gets, and the token says where to carry on —
      // further into this page, or on to HEY's next one.
      var pageData = parsed.kind === "drafts"
        ? ({ next_page: Cli.envelopeNextPage(text) }) : answer.data
      var page = Cli.pageOf(parsed, pageData, found, maxResults, pageToken)
      var ids = []
      for (var i = 0; i < page.rows.length; i++) {
        root.remember(page.rows[i])
        ids.push(page.rows[i].id)
      }
      callback({
        ids: ids,
        // The thread ids are in the message ids already; nothing upstream reads
        // this list for any provider.
        threadIds: [],
        nextPageToken: page.nextPageToken,
        // What the mailbox holds, as far as one read can say. A box index
        // serves no total, so this is what was read rather than a number HEY
        // never gave — `Model.resultSummary` says "so far" when the two agree.
        // For the unread query it is the whole point: the count of unseen
        // postings in the scan is what the badge shows.
        estimate: page.total
      }, "")
    }, handle)
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
        var row = root.rowFor(list[i])
        if (row) out.push(root.toMessage(list[i], row, null))
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
    var row = rowFor(messageId)

    if (full !== true) {
      if (typeof callback !== "function") return handle
      Qt.callLater(function() {
        if (!root || handle.aborted) return
        if (!row) callback(null, "That message is no longer in the mailbox")
        else callback(root.toMessage(messageId, row, null), "")
      })
      return handle
    }

    var draftId = Cli.draftIdOf(messageId)
    var command = draftId !== ""
      ? Cli.draftShowCommand(messageId) : Cli.threadCommand(messageId)
    if (command.length === 0) {
      if (typeof callback === "function") {
        Qt.callLater(function() {
          if (root && !handle.aborted) callback(null, "That message has no thread to read")
        })
      }
      return handle
    }

    run(command, "", function(text, error) {
      if (handle.aborted) return
      if (typeof callback !== "function") return
      if (error) {
        callback(null, error)
        return
      }
      if (draftId !== "") {
        var draftAnswer = Cli.payload(text)
        if (!draftAnswer.ok) {
          callback(null, draftAnswer.error)
          return
        }
        var draft = Cli.parseDraft(draftAnswer.data)
        root.remember(draft)
        callback(root.toMessage(messageId, draft, ({ text: draft.body, html: "" })), "")
        return
      }
      var thread = Cli.parseThread(text)
      if (thread.error) {
        callback(null, thread.error)
        return
      }
      // The row may be unknown: a message opened from the disk cache before its
      // list had loaded has no listing behind it in this process. The body is
      // still the body, and the headers it cannot supply are the ones
      // `Model.detailSummary` keeps from the row the list already drew.
      callback(root.toMessage(messageId, root.rowFor(messageId), thread), "")
    }, handle)
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
    return run(Cli.labelsCommand(), "", function(text, error) {
      if (typeof callback !== "function") return
      if (error) {
        callback([], error)
        return
      }
      var answer = Cli.payload(text)
      callback(answer.ok ? Cli.parseLabels(answer.data) : [], answer.ok ? "" : answer.error)
    })
  }

  function getLabelCounts(labelId, callback) {
    if (typeof callback !== "function") return newHandle()
    var id = String(labelId || "")
    Qt.callLater(function() {
      if (!root) return
      callback({ id: id, unread: 0, total: 0, threadsUnread: 0 }, "")
    })
    return newHandle()
  }

  // Which address this mailbox is. `hey accounts list` reports the identities
  // linked to the signed-in HEY account; the first real one is who this is.
  function getProfile(callback) {
    return run(Cli.accountsCommand(), "", function(text, error) {
      if (typeof callback !== "function") return
      if (error) {
        callback(null, error)
        return
      }
      var answer = Cli.payload(text)
      if (!answer.ok) {
        callback(null, answer.error)
        return
      }
      root.address = Cli.parseAccountAddress(answer.data)
      callback({
        email: root.address,
        messagesTotal: 0,
        threadsTotal: 0,
        historyId: ""
      }, "")
    })
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

  function trashMessage(id, callback) {
    return act("trash", [id], callback)
  }

  function untrashMessage(id, callback) {
    return act("untrash", [id], callback)
  }

  // One verb, however many threads: every HEY command takes a list of ids, so a
  // batch is one invocation rather than one per message.
  function act(verb, ids, callback) {
    var handle = newHandle()
    var command = Cli.actionCommand(verb, ids)
    if (command.length === 0) {
      if (typeof callback === "function") {
        Qt.callLater(function() { if (root) callback(null, "") })
      }
      return handle
    }
    run(command, "", function(text, error) {
      if (handle.aborted) return
      if (!error) root.forget(verb, ids)
      if (typeof callback === "function") callback(null, error)
    }, handle)
    return handle
  }

  // What this client believed about a thread, after it has been changed. Only
  // the seen state is kept here and only two verbs move it, so the row is
  // corrected rather than dropped: dropping it would leave the reader, which is
  // already open on that message, with no headers on the next redraw.
  function forget(verb, ids) {
    if (verb !== "markRead" && verb !== "markUnread") return
    var list = Array.isArray(ids) ? ids : [ids]
    var next = {}
    for (var key in rows) next[key] = rows[key]
    for (var i = 0; i < list.length; i++) {
      var row = next[String(list[i])]
      if (!row) continue
      var copy = {}
      for (var field in row) copy[field] = row[field]
      copy.seen = verb === "markRead"
      next[String(list[i])] = copy
    }
    rows = next
  }

  // ----------------------------------------------------------------- send

  // `MailAccount` builds the same payload for every provider: a base64url `raw`
  // field, because that is what Gmail's send endpoint takes. HEY takes neither
  // a raw message nor, for a reply, a recipient list — it decides who a reply
  // goes to, which is the right answer and not one this plugin could improve
  // on. So the message is taken apart again and handed over as the fields the
  // command has.
  function sendMessage(payload, callback) {
    var handle = newHandle()
    var raw = payload && payload.raw ? String(payload.raw) : ""
    if (raw === "") {
      if (typeof callback === "function") callback(null, "There is nothing to send")
      return handle
    }

    var parsed = Mail.parseRfc822(Mail.decodeBase64Url(raw))
    var body = Mail.extractBody(parsed).text
    var files = payload && Array.isArray(payload.attachments) ? payload.attachments : []
    if (body === "" && files.length === 0) {
      if (typeof callback === "function") callback(null, "Write something before sending")
      return handle
    }

    // A reply names its thread and nothing else. HEY answers the same people it
    // would have in its own web app, which is what `hey reply` exists to do.
    var threadId = payload && payload.threadId ? Cli.topicIdOf(String(payload.threadId)) : ""
    if (threadId === "" && payload && payload.threadId)
      threadId = String(payload.threadId)

    var command = Cli.composeCommand({
      threadId: threadId,
      to: Mail.headerFrom(parsed.headers, "To"),
      cc: Mail.headerFrom(parsed.headers, "Cc"),
      bcc: Mail.headerFrom(parsed.headers, "Bcc"),
      subject: Mail.decodeHeaderValue(Mail.headerFrom(parsed.headers, "Subject")),
      attachments: files
    })
    if (command.length === 0) {
      if (typeof callback === "function") callback(null, "Add a recipient first")
      return handle
    }

    run(command, body, function(text, error) {
      if (handle.aborted) return
      if (typeof callback === "function") callback(error ? null : {}, error)
    }, handle)
    return handle
  }

  function saveDraft(payload, callback) {
    var handle = newHandle()
    var raw = payload && payload.raw ? String(payload.raw) : ""
    if (raw === "") {
      if (typeof callback === "function") callback(null, "There is no draft to save")
      return handle
    }

    var parsed = Mail.parseRfc822(Mail.decodeBase64Url(raw))
    var body = Mail.extractBody(parsed).text
    var files = payload && Array.isArray(payload.attachments) ? payload.attachments : []
    var threadId = payload && payload.threadId ? Cli.topicIdOf(String(payload.threadId)) : ""
    if (threadId === "" && payload && payload.threadId)
      threadId = String(payload.threadId)

    var fields = {
      threadId: threadId,
      to: Mail.headerFrom(parsed.headers, "To"),
      cc: Mail.headerFrom(parsed.headers, "Cc"),
      bcc: Mail.headerFrom(parsed.headers, "Bcc"),
      subject: Mail.decodeHeaderValue(Mail.headerFrom(parsed.headers, "Subject")),
      body: body,
      attachments: files
    }
    var draftId = payload ? String(payload.draftId || "") : ""
    var command = draftId === ""
      ? Cli.draftCommand(fields) : Cli.draftEditCommand(draftId, fields)
    run(command, draftId === "" ? body : "", function(text, error) {
      if (handle.aborted) return
      var answer = error ? null : Cli.payload(text)
      if (typeof callback === "function") callback(error ? null : (answer ? answer.data : {}), error)
    }, handle)
    return handle
  }

  // One process per request, created and destroyed around it. Requests here are
  // few and each is a whole page or a whole thread, so the cost of starting a
  // process is well under the cost of the round trip it wraps.
  Component {
    id: commandComponent

    Process {
      id: commandProcess

      property string input: ""
      signal finished(int status, string out, string err)

      stdinEnabled: true
      stdout: StdioCollector { waitForEnd: true }
      stderr: StdioCollector { waitForEnd: true }

      onStarted: {
        // Written whether or not there is anything to write: `hey compose`
        // reads the body from stdin when no -m was given, and a stdin that is
        // never closed is a command that waits forever.
        write(commandProcess.input)
        commandProcess.input = ""
        stdinEnabled = false
      }

      onExited: function(exitCode) {
        commandProcess.finished(exitCode,
          String(commandProcess.stdout.text || ""),
          String(commandProcess.stderr.text || ""))
      }
    }
  }
}
