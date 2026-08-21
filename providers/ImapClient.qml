import QtQuick
import Quickshell
import Quickshell.Io

import "ImapProtocol.js" as Imap
import "../message/Message.js" as Mail

// An IMAP mailbox, wearing the same interface `GmailApiClient` wears.
//
// Every method here has a counterpart there with the same name, the same
// arguments and the same callback shape, and both hand back Gmail's message
// resource — a headers array, a MIME tree, part bodies in base64url. That is
// the whole trick: `MailAccount` drives either one without asking which it
// holds, and the list, the reader, the cache and the actions never learn that
// a second kind of mail service exists.
//
// The transport is `scripts/mail-transport.sh`, which is curl. The protocol is
// `Imap.js`. This file is the part in between: which commands a given request
// becomes, in what order, and what to do when one of them fails.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property var auth
  required property string email

  property int inFlight: 0
  readonly property bool busy: inFlight > 0

  readonly property string transport: auth ? auth.pluginDir + "/scripts/mail-transport.sh" : ""

  // What the server said its folders are, learned once per session with a
  // single LIST. Everything that names a folder goes through here: "\\Sent" is
  // "Sent Items" on Exchange and "[Gmail]/Sent Mail" on Gmail, and a client
  // that guessed would create folders rather than find them.
  property var folders: []
  property var special: ({})
  property bool foldersLoaded: false
  property bool foldersLoading: false
  property var folderWaiters: []

  // What the server said it can do, asked for alongside the folder listing so
  // it costs nothing extra. Only one answer is acted on: a server with MOVE
  // archives in one command, and one without it needs three.
  property var serverCapabilities: []

  function newHandle() {
    return { aborted: false, process: null, children: [] }
  }

  function abortRequest(handle) {
    if (!handle) return
    handle.aborted = true
    if (handle.process) {
      // Killing the transport is what makes switching mailboxes mid-load
      // instant rather than something that waits for a fetch nobody wants.
      handle.process.running = false
      handle.process = null
    }
    var children = handle.children || []
    for (var i = 0; i < children.length; i++) abortRequest(children[i])
    handle.children = []
  }

  // ------------------------------------------------------------- transport

  // One invocation, one connection, however many commands. curl reuses the
  // connection across the sections the script emits, so a search followed by a
  // fetch of what it found costs one TLS handshake and one LOGIN rather than
  // two of each.
  function run(folder, commands, callback, existingHandle) {
    var handle = existingHandle || newHandle()
    var list = Array.isArray(commands) ? commands : [commands]
    var wanted = []
    for (var i = 0; i < list.length; i++) {
      if (String(list[i] || "") !== "") wanted.push(String(list[i]))
    }
    if (wanted.length === 0) {
      if (typeof callback === "function") callback("", "")
      return handle
    }

    root.inFlight++
    auth.withCredentials(function(credentials, credentialError) {
      if (!root) return
      if (handle.aborted) {
        root.inFlight = Math.max(0, root.inFlight - 1)
        return
      }
      if (!credentials) {
        root.inFlight = Math.max(0, root.inFlight - 1)
        if (typeof callback === "function") callback("", credentialError || "Not signed in")
        return
      }

      var url = Imap.imapUrl(auth.settings, folder)
      if (url === "") {
        root.inFlight = Math.max(0, root.inFlight - 1)
        if (typeof callback === "function")
          callback("", "This mailbox has no usable server address")
        return
      }

      // Every field crosses base64-encoded, so a password containing a quote,
      // a space or a backslash needs no escaping anywhere along the way — and
      // none of it reaches the process table.
      var fields = [Mail.encodeBase64(url), Mail.encodeBase64(credentials)]
      for (var j = 0; j < wanted.length; j++) fields.push(Mail.encodeBase64(wanted[j]))

      var process = transportComponent.createObject(root, {
        command: [root.transport],
        requestLine: "imap " + fields.join(" ")
      })
      if (!process) {
        root.inFlight = Math.max(0, root.inFlight - 1)
        if (typeof callback === "function") callback("", "Could not start the mail transport")
        return
      }
      handle.process = process
      process.finished.connect(function(status, out, err) {
        if (!root) return
        if (handle.process === process) handle.process = null
        process.destroy()
        if (handle.aborted) {
          root.inFlight = Math.max(0, root.inFlight - 1)
          return
        }
        root.inFlight = Math.max(0, root.inFlight - 1)
        if (typeof callback !== "function") return

        var text = Imap.decodeResponse(out, Mail.base64ToBytes, Mail.bytesToLatin1)
        var detail = Imap.decodeResponse(err, Mail.base64ToBytes, Mail.bytesToLatin1)
        if (status !== 0) {
          callback("", Imap.responseError(status, detail, ""))
          return
        }
        // curl exits 0 for a command the server refused, so the tagged
        // completion is checked separately — a NO is a failure the user has to
        // be told about, not an empty result.
        if (Imap.isFailure(text)) {
          callback("", Imap.responseError(0, Imap.failureDetail(text), ""))
          return
        }
        callback(text, "")
      })
      process.running = true
    })
    return handle
  }

  // ------------------------------------------------------------- folders

  // Learned once, then reused. Everything that needs a folder name waits on
  // this rather than racing it, or the first list load would ask for "\\Sent".
  function ensureFolders(callback) {
    if (foldersLoaded) {
      if (typeof callback === "function") callback("")
      return
    }
    if (typeof callback === "function") {
      var next = folderWaiters.slice()
      next.push(callback)
      folderWaiters = next
    }
    if (foldersLoading) return
    foldersLoading = true

    // No folder in the URL: both of these are asked of the server rather than
    // of a mailbox, and they share the one connection.
    run("", [Imap.capabilityCommand(), Imap.listCommand()], function(text, error) {
      root.foldersLoading = false
      if (!error) {
        root.adoptServerAnswer(text)
        root.foldersLoaded = true
      }
      var waiting = root.folderWaiters.slice()
      root.folderWaiters = []
      for (var i = 0; i < waiting.length; i++) waiting[i](error)
    })
  }

  function folderFor(name) {
    return Imap.resolveFolder(name, special)
  }

  // The one place the server's own description of itself is taken in, so the
  // sign-in and the first list load cannot disagree about what it supports.
  function adoptServerAnswer(text) {
    var listed = Imap.parseList(text)
    if (listed.length > 0) {
      folders = listed
      special = Imap.specialFolders(listed)
    }
    var capabilities = Imap.parseCapabilities(text)
    if (capabilities.length > 0) serverCapabilities = capabilities
  }

  // ---------------------------------------------------------------- reads

  // IMAP has no page token: SEARCH answers with every matching UID at once. So
  // the "token" is an offset into that answer, and the count it reports is
  // exact rather than the estimate Gmail returns.
  //
  // Newest first, which is the order the list is read in and the reverse of the
  // order UIDs are assigned in.
  function listMessages(query, maxResults, pageToken, callback) {
    var handle = newHandle()
    var parsed = Imap.parseQuery(query)
    var limit = Math.max(1, Math.min(100, Math.floor(Number(maxResults)) || 25))
    var offset = Math.max(0, Math.floor(Number(pageToken)) || 0)

    ensureFolders(function(folderError) {
      if (handle.aborted) return
      if (folderError) {
        if (typeof callback === "function") callback(null, folderError)
        return
      }
      var folder = root.folderFor(parsed.folder)
      root.run(folder, [Imap.searchCommand(Imap.normalizeCriteria(parsed.criteria))],
        function(text, error) {
          if (handle.aborted) return
          if (typeof callback !== "function") return
          if (error) {
            callback(null, error)
            return
          }
          var uids = Imap.parseSearch(text)
          // Ascending from the server; the newest message has the highest UID.
          uids.reverse()
          var page = uids.slice(offset, offset + limit)
          var ids = []
          for (var i = 0; i < page.length; i++) ids.push(Imap.messageId(page[i], folder))
          callback({
            ids: ids,
            // IMAP has no server-side conversation id. Threading falls back to
            // References, which is what every other IMAP client does.
            threadIds: [],
            nextPageToken: offset + limit < uids.length ? String(offset + limit) : "",
            estimate: uids.length
          }, "")
        }, handle)
    })
    return handle
  }

  // A whole page in one round trip. Gmail costs one request per message here;
  // IMAP fetches the lot with a single UID FETCH, which is the one place this
  // provider is comfortably faster than the other.
  function getMessages(ids, full, callback, existingHandle) {
    var handle = existingHandle || newHandle()
    var groups = Imap.groupByFolder(ids)
    if (groups.length === 0) {
      if (typeof callback === "function") callback([], "")
      return handle
    }

    var results = []
    var remaining = groups.length
    var firstError = ""

    function finish() {
      if (handle.aborted) return
      if (typeof callback !== "function") return
      // Back into the order the caller asked for, rather than the order the
      // folders answered in: the list is sorted by the search, not by us.
      var byId = {}
      for (var i = 0; i < results.length; i++) byId[results[i].id] = results[i]
      var ordered = []
      var list = Array.isArray(ids) ? ids : []
      for (var j = 0; j < list.length; j++) {
        if (byId[list[j]]) ordered.push(byId[list[j]])
      }
      callback(ordered, ordered.length > 0 ? "" : firstError)
    }

    for (var g = 0; g < groups.length; g++) {
      (function(group) {
        // Headers for a list row, the whole message for a reader. Both are one
        // command for the whole group, which is where this provider is
        // comfortably faster than Gmail's one-request-per-message.
        var command = full
          ? Imap.fullFetchCommand(group.uids)
          : Imap.summaryFetchCommand(group.uids)

        var child = root.run(group.folder, [command], function(text, error) {
          if (handle.aborted) return
          if (error && !firstError) firstError = error
          if (!error) {
            var fetched = Imap.parseFetch(text)
            for (var i = 0; i < fetched.length; i++)
              results.push(root.toMessage(fetched[i], group.folder, full))
          }
          remaining--
          if (remaining === 0) finish()
        })
        handle.children.push(child)
      })(groups[g])
    }
    return handle
  }

  function getMessage(id, full, callback) {
    return getMessages([id], full, function(messages, error) {
      if (typeof callback !== "function") return
      if (error || messages.length === 0) callback(null, error || "That message is no longer in the mailbox")
      else callback(messages[0], "")
    })
  }

  // The same call Gmail answers with a second request. Here there is nothing
  // to fetch that was not fetched already: this client is handed the whole
  // message and `parseRfc822` decodes every part of it on the way in, so an
  // attachment id is a part path into a message that is already complete.
  function getAttachment(messageId, attachmentId, callback) {
    return getMessage(messageId, true, function(message, error) {
      if (typeof callback !== "function") return
      if (error || !message) {
        callback("", error || "That message is no longer in the mailbox")
        return
      }
      var part = Mail.partForAttachment(message.payload, attachmentId)
      if (!part) {
        callback("", "That attachment is not in the message")
        return
      }
      callback(part.body ? String(part.body.data || "") : "", "")
    })
  }

  // One FETCH result, as a Gmail message resource. This is the seam the whole
  // provider turns on: past this point nothing can tell the two services apart.
  function toMessage(entry, folder, full) {
    var payload = Mail.parseRfc822(entry.raw)
    var message = {
      id: Imap.messageId(entry.uid, folder),
      // No conversation id, so a message is its own thread. The reader groups
      // by References rather than by this.
      threadId: Imap.messageId(entry.uid, folder),
      labelIds: Imap.labelIdsFor(entry.flags, folder, special),
      internalDate: entry.internalDate,
      sizeEstimate: entry.size,
      payload: payload,
      // Gmail sends a snippet with every list row; IMAP has no equivalent, so
      // one is made from the body when the body is here. A list row is fetched
      // headers-only, so it has none — which is what Thunderbird shows too.
      snippet: full ? Mail.buildSnippet(Mail.extractBody(payload).text) : ""
    }
    return message
  }

  // The folders, in the shape the sidebar reads labels in. Counts are left at
  // zero rather than fetched: a STATUS per folder is one round trip each, and
  // the sidebar is drawn before anyone has asked for a number on it.
  function getLabels(callback) {
    ensureFolders(function(error) {
      if (typeof callback !== "function") return
      if (error) {
        callback([], error)
        return
      }
      var out = []
      for (var i = 0; i < root.folders.length; i++) {
        var folder = root.folders[i]
        if (!folder.selectable) continue
        out.push({
          id: folder.name,
          name: folder.name,
          rawName: folder.name,
          // "system" means the mailbox row already offers it, so the sidebar
          // lists only the rest below. Judged on SPECIAL-USE rather than on the
          // structural flags every server sends on every folder.
          system: Imap.isSpecialFolder(folder, root.special),
          unread: 0,
          total: 0,
          threadsUnread: 0
        })
      }
      callback(out, "")
    })
  }

  function getLabelCounts(labelId, callback) {
    return run("", [Imap.statusCommand(folderFor(labelId))], function(text, error) {
      if (typeof callback !== "function") return
      if (error) {
        callback(null, error)
        return
      }
      var status = Imap.parseStatus(text)
      callback({
        id: String(labelId || ""),
        unread: status.unseen,
        total: status.messages,
        threadsUnread: status.unseen
      }, "")
    })
  }

  // There is no profile endpoint, and nothing to ask for: the address is what
  // the user typed when they added the mailbox.
  //
  // Deferred rather than answered on the spot even though the answer is already
  // in hand. Every caller is written against a callback that arrives later —
  // `loadProfile` emits `accountIdentified` from inside it, which has the
  // service rebuild the account list — and running that partway through the
  // function that started it is a re-entry the Gmail client never produces.
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

  // IMAP has no send-as settings endpoint. Its one sender is the mailbox
  // address the user configured, returned in the same shape as Gmail aliases
  // so everything above the provider boundary can stay provider-neutral.
  function getSendAs(callback) {
    if (typeof callback !== "function") return newHandle()
    var address = String(root.email || "")
    Qt.callLater(function() {
      if (!root) return
      callback(address === "" ? [] : [{
        email: address,
        displayName: "",
        isPrimary: true,
        isDefault: true
      }], "")
    })
    return newHandle()
  }

  // --------------------------------------------------------------- writes

  // `MailAccount` asks in Gmail's vocabulary whichever provider it holds, so
  // the label ids arrive here and become flags — or a move, for the two that
  // Gmail expresses as a label and IMAP cannot.
  function modifyMessage(id, addLabelIds, removeLabelIds, callback) {
    return batchModify([id], addLabelIds, removeLabelIds, callback)
  }

  function batchModify(ids, addLabelIds, removeLabelIds, callback) {
    var handle = newHandle()
    ensureFolders(function(folderError) {
      if (handle.aborted) return
      if (folderError) {
        if (typeof callback === "function") callback(null, folderError)
        return
      }
      var plan = Imap.flagPlanForLabels(addLabelIds, removeLabelIds, root.special)
      root.applyPlan(ids, plan, callback, handle)
    })
    return handle
  }

  // Flags first, then the move. In that order because a move invalidates the
  // UIDs it moved — the message is a new UID in the destination folder — so a
  // STORE afterwards would name messages that are no longer there.
  function applyPlan(ids, plan, callback, existingHandle) {
    var handle = existingHandle || newHandle()
    var groups = Imap.groupByFolder(ids)
    if (groups.length === 0) {
      if (typeof callback === "function") callback(null, "")
      return handle
    }

    var remaining = groups.length
    var firstError = ""

    for (var g = 0; g < groups.length; g++) {
      (function(group) {
        var commands = Imap.storeCommand(group.uids, plan.add, plan.remove)
        if (typeof commands === "string") commands = commands === "" ? [] : [commands]

        if (plan.move !== "" && plan.move !== group.folder) {
          // MOVE where the server has it; otherwise COPY, mark \Deleted, and
          // expunge only what was named. Plain EXPUNGE would remove every
          // \Deleted message in the folder, including ones another client
          // marked — somebody else's mail disappearing because this one
          // archived.
          if (Imap.hasCapability(root.serverCapabilities, "MOVE")) {
            commands = commands.concat([Imap.moveCommand(group.uids, plan.move)])
          } else {
            commands = commands.concat([
              Imap.copyCommand(group.uids, plan.move),
              "UID STORE " + Imap.sequenceSet(group.uids) + " +FLAGS.SILENT (\\Deleted)",
              Imap.expungeCommand(group.uids)
            ])
          }
        }

        if (commands.length === 0) {
          remaining--
          if (remaining === 0 && typeof callback === "function") callback(null, firstError)
          return
        }

        var child = root.run(group.folder, commands, function(text, error) {
          if (handle.aborted) return
          if (error && !firstError) firstError = error
          remaining--
          if (remaining === 0 && typeof callback === "function") callback(null, firstError)
        })
        handle.children.push(child)
      })(groups[g])
    }
    return handle
  }

  function trashMessage(id, callback) {
    var handle = newHandle()
    ensureFolders(function(folderError) {
      if (handle.aborted) return
      if (folderError) {
        if (typeof callback === "function") callback(null, folderError)
        return
      }
      var trash = root.special["\\trash"] || ""
      if (trash === "") {
        if (typeof callback === "function")
          callback(null, "This server has no Trash folder to move the message to")
        return
      }
      root.applyPlan([id], { add: [], remove: [], move: trash }, callback, handle)
    })
    return handle
  }

  function untrashMessage(id, callback) {
    var handle = newHandle()
    ensureFolders(function(folderError) {
      if (handle.aborted) return
      if (folderError) {
        if (typeof callback === "function") callback(null, folderError)
        return
      }
      root.applyPlan([id], { add: [], remove: ["\\Deleted"], move: "INBOX" }, callback, handle)
    })
    return handle
  }

  // ----------------------------------------------------------------- send

  // `MailAccount` builds the same payload for either provider: a base64url
  // `raw` field, because that is what Gmail's send endpoint takes. SMTP wants
  // the message itself and the envelope separately, so it is decoded back and
  // the addresses are read off the headers it was built from.
  function sendMessage(payload, callback) {
    var handle = newHandle()
    var raw = payload && payload.raw ? String(payload.raw) : ""
    if (raw === "") {
      if (typeof callback === "function") callback(null, "There is nothing to send")
      return handle
    }

    var message = Mail.decodeBase64Url(raw)
    var settings = auth ? auth.settings : null
    var smtp = Imap.smtpUrl(settings)
    if (smtp === "") {
      if (typeof callback === "function")
        callback(null, "This mailbox has no SMTP server set, so it cannot send")
      return handle
    }

    // The envelope is read from the message this client just built, so it can
    // never name a recipient the headers do not.
    var parsed = Mail.parseRfc822(message)
    var recipients = []
    var headerNames = ["To", "Cc", "Bcc"]
    for (var i = 0; i < headerNames.length; i++) {
      var addresses = Mail.parseAddressList(Mail.headerFrom(parsed.headers, headerNames[i]))
      for (var j = 0; j < addresses.length; j++) {
        if (addresses[j].email !== "" && recipients.indexOf(addresses[j].email) < 0)
          recipients.push(addresses[j].email)
      }
    }
    if (recipients.length === 0) {
      if (typeof callback === "function") callback(null, "Add a recipient first")
      return handle
    }

    root.inFlight++
    auth.withCredentials(function(credentials, credentialError) {
      if (!root) return
      if (!credentials) {
        root.inFlight = Math.max(0, root.inFlight - 1)
        if (typeof callback === "function") callback(null, credentialError || "Not signed in")
        return
      }
      var sender = settings ? String(settings.username || "") : ""
      var fields = [Mail.encodeBase64(smtp), Mail.encodeBase64(credentials),
        Mail.encodeBase64(sender), Mail.encodeBase64(message)]
      for (var k = 0; k < recipients.length; k++) fields.push(Mail.encodeBase64(recipients[k]))

      var process = transportComponent.createObject(root, {
        command: [root.transport],
        requestLine: "smtp " + fields.join(" ")
      })
      if (!process) {
        root.inFlight = Math.max(0, root.inFlight - 1)
        if (typeof callback === "function") callback(null, "Could not start the mail transport")
        return
      }
      handle.process = process
      process.finished.connect(function(status, out, err) {
        if (!root) return
        handle.process = null
        process.destroy()
        root.inFlight = Math.max(0, root.inFlight - 1)
        if (typeof callback !== "function") return
        if (status !== 0) {
          var detail = Imap.decodeResponse(err, Mail.base64ToBytes, Mail.bytesToLatin1)
          callback(null, Imap.responseError(status, detail, "The message could not be sent"))
          return
        }
        callback({}, "")
      })
      process.running = true
    })
    return handle
  }

  // Verifies a password by using it: a mailbox that answers a folder listing is
  // one that will answer everything else. The alternative — writing the
  // password down and finding out later — leaves the user on a panel that says
  // it is signed in and never loads.
  function verifyCredentials(settings, credentials, callback) {
    var url = Imap.imapUrl(settings, "")
    if (url === "") {
      if (typeof callback === "function") callback(false, "This mailbox has no usable server address")
      return
    }
    var fields = [Mail.encodeBase64(url), Mail.encodeBase64(credentials),
      Mail.encodeBase64(Imap.capabilityCommand()), Mail.encodeBase64(Imap.listCommand())]
    var process = transportComponent.createObject(root, {
      command: [root.transport],
      requestLine: "imap " + fields.join(" ")
    })
    if (!process) {
      if (typeof callback === "function") callback(false, "Could not start the mail transport")
      return
    }
    process.finished.connect(function(status, out, err) {
      if (!root) return
      process.destroy()
      if (typeof callback !== "function") return
      var text = Imap.decodeResponse(out, Mail.base64ToBytes, Mail.bytesToLatin1)
      var detail = Imap.decodeResponse(err, Mail.base64ToBytes, Mail.bytesToLatin1)
      if (status !== 0) {
        callback(false, Imap.responseError(status, detail, ""))
        return
      }
      if (Imap.isFailure(text)) {
        callback(false, Imap.responseError(0, Imap.failureDetail(text), ""))
        return
      }
      // The sign-in already learned the folders and the capabilities, so the
      // session starts with them rather than spending a second connection
      // asking again.
      root.adoptServerAnswer(text)
      root.foldersLoaded = root.folders.length > 0
      callback(true, "")
    })
    process.running = true
  }

  Connections {
    target: root.auth
    function onVerifyRequested(settings, credentials) {
      root.verifyCredentials(settings, credentials, function(ok, error) {
        if (root.auth) root.auth.completeSignIn(ok, error)
      })
    }
    // A mailbox whose server settings changed is a different mailbox: the
    // folder map belongs to the old one.
    function onSettingsChanged() {
      root.foldersLoaded = false
      root.folders = []
      root.special = ({})
    }
  }

  // One process per request, created and destroyed around it. A pool would be
  // the obvious alternative, but requests here are few and batched — a whole
  // page of messages is one FETCH — so the cost of starting a process is well
  // under the cost of the TLS handshake it wraps.
  Component {
    id: transportComponent

    Process {
      id: transportProcess

      property string requestLine: ""
      signal finished(int status, string out, string err)

      stdinEnabled: true
      stdout: StdioCollector { waitForEnd: true }
      stderr: StdioCollector { waitForEnd: true }

      onStarted: {
        // One line, because Quickshell's Process.write() never closes stdin and
        // the script would wait forever for an EOF that does not come.
        write(requestLine + "\n")
        requestLine = ""
      }

      onExited: function(exitCode) {
        // Three lines: curl's exit code, base64 stdout, base64 stderr. A
        // script that failed before curl ran emits none of them, which is what
        // the length check catches.
        var lines = String(stdout.text || "").split("\n")
        if (exitCode !== 0 && lines.length < 3) {
          transportProcess.finished(exitCode === 0 ? 1 : exitCode, "", "")
          return
        }
        var status = Math.floor(Number(lines[0]))
        transportProcess.finished(isFinite(status) ? status : 1,
          lines.length > 1 ? lines[1] : "",
          lines.length > 2 ? lines[2] : "")
      }
    }
  }
}
