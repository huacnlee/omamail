import QtQuick
import Quickshell
import Quickshell.Io

import "JmapProtocol.js" as Jmap
import "../message/Message.js" as Mail

// A JMAP mailbox, wearing the same interface `GmailApiClient` wears.
//
// At this point in the build it does one thing and does it completely: it
// signs the account in. Discovery, the session GET under each scheme in turn,
// the four-step check and the one `Mailbox/get` that proves the API URL all
// live here, because all of them are requests and requests are this object's
// half of the provider pair. Everything else — the list, the reader, the
// actions, the push and the send — is a stub the following tickets fill, and
// each of them answers an empty result rather than pretending to fail.
//
// The transport is `scripts/jmap-transport.sh`, which is curl. The protocol is
// `JmapProtocol.js`. This file is the part in between: which requests a given
// job becomes, in what order, and what to do when one of them fails.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property var auth
  property string email: ""

  // Where the session object is kept between runs, which is the account's own
  // cache file — the same place its query results live. Optional so the object
  // still builds without one.
  property var cache: null

  property int inFlight: 0
  readonly property bool busy: inFlight > 0

  readonly property string transport: auth ? auth.pluginDir + "/scripts/jmap-transport.sh" : ""
  readonly property string srvLookup: auth ? auth.pluginDir + "/scripts/jmap-srv.sh" : ""

  // Raised by any 401 and cleared by a successful `verifyCredentials`. Nothing
  // else sets it: the secret is a static app password or API token, so a 401
  // is a credential that was revoked rather than one that expired, and there
  // is nothing to refresh and nothing to retry. The setup page draws the
  // re-entry card from this.
  property bool credentialsRejected: false

  // The session object this account is working from, and the mailboxes the
  // sign-in read. Held for the tickets that build the list on them.
  property var session: null
  property var mailboxList: []

  function newHandle() {
    return { aborted: false, process: null, children: [] }
  }

  function abortRequest(handle) {
    if (!handle) return
    handle.aborted = true
    if (handle.process) {
      handle.process.running = false
      handle.process = null
    }
    var children = handle.children || []
    for (var i = 0; i < children.length; i++) abortRequest(children[i])
    handle.children = []
  }

  // ------------------------------------------------------------- transport

  // An empty value crosses as "-": base64 of the empty string is the empty
  // string, and a space-separated line cannot carry one. The `none` scheme is
  // what needs it — discovery's well-known GET has no username and no secret.
  function field(value) {
    var text = String(value === undefined || value === null ? "" : value)
    return text === "" ? "-" : Mail.encodeBase64(text)
  }

  // One request, one curl process. The credential is three fields rather than
  // one string because the script builds the `Authorization` value itself —
  // there is no place in this file where one is assembled.
  //
  // The callback takes the whole reply: `{ exit, status, redirect, body,
  // stderr }`. Every caller here has its own opinion about what a status
  // means, so none of them is imposed at this level.
  function request(verb, url, credential, extra, handle, callback) {
    var owner = handle || newHandle()
    var credentials = credential || { scheme: Jmap.AUTH_NONE, username: "", secret: "" }
    var fields = [field(url), field(credentials.scheme),
      field(credentials.username), field(credentials.secret)]
    if (extra !== undefined && extra !== null) fields.push(field(extra))

    var process = transportComponent.createObject(root, {
      command: [root.transport],
      requestLine: verb + " " + fields.join(" ")
    })
    if (!process) {
      if (typeof callback === "function")
        callback({ exit: 1, status: 0, redirect: "", body: "", stderr: "" },
          "Could not start the mail transport")
      return owner
    }

    root.inFlight++
    owner.process = process
    process.finished.connect(function(exit, status, redirect, body, stderr) {
      if (!root) return
      if (owner.process === process) owner.process = null
      process.destroy()
      root.inFlight = Math.max(0, root.inFlight - 1)
      if (owner.aborted || typeof callback !== "function") return
      // A 401 is the one status this object records rather than only reports
      // — but only where a credential was actually sent. Discovery's
      // well-known GET carries none and is *expected* to be refused, and
      // reading that as a rejected app password would draw the re-entry card
      // over a server the user has not been asked about yet.
      if (status === 401 && credentials.scheme !== Jmap.AUTH_NONE)
        root.credentialsRejected = true
      callback({ exit: exit, status: status, redirect: redirect, body: body, stderr: stderr }, "")
    })
    process.running = true
    return owner
  }

  // ------------------------------------------------------------- sign-in

  // The three lines the setup page draws while the check runs, named here
  // because this is what is actually happening rather than what the page
  // guesses is.
  function announce(step) {
    if (auth) auth.progressStep = step
  }

  // Verifies an app password or an API token by using it, which is the only
  // way to find out. Four steps:
  //
  //   1. find the server — a typed one wins outright, otherwise the SRV record
  //      for the address's domain and then the domain's own well-known URL,
  //      each fetched without a credential and followed one redirect hop
  //   2. the session GET with Basic and, only on a 401, once more with Bearer
  //   3. `Jmap.verifySession` on the 200: core and mail, a mail-capable
  //      primary account, and a `receivedAt` sort
  //   4. one `Mailbox/get`, which is the request that proves the API URL
  //
  // The callback takes `(result, error)`. `result` is what the account has to
  // write down — the URL that answered, the scheme that worked and the account
  // id every later request names — plus what the page says about sending.
  function verifyCredentials(settings, address, secret, callback) {
    var values = settings || {}
    var handle = newHandle()
    var username = String(values.username || "") !== ""
      ? String(values.username) : String(address || "")

    // `needsServer` is the one refusal the page acts on rather than only
    // prints: nothing answered for the domain, so the server field is the way
    // forward and the disclosure opens on it.
    function done(result, error, needsServer) {
      announce(0)
      if (typeof callback === "function") callback(result, error, needsServer === true)
    }

    announce(1)
    var plan = Jmap.discoveryPlan(address, values.sessionUrl)
    if (plan.error !== "") {
      // The one refusal the plan can answer is about the server that was
      // written down, so the field holding it is the way forward.
      done(null, plan.error, true)
      return handle
    }
    if (plan.steps.length === 0) {
      done(null, "Add the email address for this mailbox")
      return handle
    }

    // A credential goes to the URL the user typed and to the URLs read out of
    // the session fetched with it. Every step below the typed one therefore
    // finds its candidate unauthenticated first.
    function credential(scheme) {
      return { scheme: scheme, username: username, secret: String(secret || "") }
    }

    // One unauthenticated GET, and at most one redirect hop taken from the
    // reply rather than by curl. A 200 means the session is served here; a 401
    // means it is served here and wants the credential, which is the answer
    // the reference hosted server gives. Anything else is not a JMAP server.
    function probe(url, hops, found) {
      request("session", url, null, null, handle, function(reply) {
        if (handle.aborted) return
        if (reply.exit !== 0) {
          found("")
          return
        }
        var hop = Jmap.redirectHop(reply.status, reply.redirect)
        if (hop !== "" && hops > 0) {
          probe(hop, hops - 1, found)
          return
        }
        found(reply.status === 200 || reply.status === 401 ? url : "")
      })
    }

    // Basic first, Bearer only on a 401. Two requests with two credentials
    // from this page and nowhere else — it is a detection, not a retry, and
    // the rule that a 401 retries nothing is unchanged for everything after
    // sign-in.
    function attempt(url, order, next) {
      announce(2)
      request("session", url, credential(Jmap.AUTH_SCHEME_ORDER[order]), null, handle,
        function(reply) {
          if (handle.aborted) return
          if (reply.exit !== 0) {
            // A server that never answered says nothing about the credential,
            // so a discovered candidate gives way to the next step and a typed
            // one reports what happened.
            if (next) next()
            else done(null, Jmap.transportError(reply.exit, reply.status, reply.body, reply.stderr, ""))
            return
          }
          if (reply.status === 401) {
            if (order + 1 < Jmap.AUTH_SCHEME_ORDER.length) {
              attempt(url, order + 1, next)
              return
            }
            done(null, "The server rejected that app password or API token")
            return
          }
          if (reply.status !== 200) {
            if (next) next()
            else done(null, Jmap.transportError(reply.exit, reply.status, reply.body, reply.stderr, ""))
            return
          }
          // The server answered as a server. Whatever is wrong from here is
          // wrong about this account rather than about which URL was tried,
          // so it is reported rather than walked past.
          var check = Jmap.verifySession(reply.body)
          if (check.error !== "") {
            done(null, check.error)
            return
          }
          readMailboxes(url, Jmap.AUTH_SCHEME_ORDER[order], reply.body, check.accountId, done)
        })
    }

    function readMailboxes(url, scheme, sessionText, accountId, finish) {
      announce(3)
      var api = Jmap.apiUrl(sessionText)
      if (api === "") {
        finish(null, "The server answered, but not as a JMAP mail server")
        return
      }
      // Core and mail, and never a vendor capability: what this request needs
      // is exactly what every list will need.
      var body = JSON.stringify({
        using: [Jmap.CAPABILITY_CORE, Jmap.CAPABILITY_MAIL],
        methodCalls: [["Mailbox/get", { accountId: accountId, ids: null }, "0"]]
      })
      request("call", api, credential(scheme), body, handle, function(reply) {
        if (handle.aborted) return
        if (reply.exit !== 0 || reply.status !== 200) {
          finish(null, Jmap.transportError(reply.exit, reply.status, reply.body, reply.stderr, ""))
          return
        }
        var payload = Jmap.parseJson(reply.body)
        if (!payload) {
          finish(null, "The server sent an answer this client could not read")
          return
        }
        // JMAP fails at two levels inside a 200. A request-level failure
        // replaces the whole document, so it is the absence of
        // `methodResponses` that says which of the two this is — asking
        // `requestError` about a successful response would invent one.
        var responses = payload.methodResponses
        if (!Array.isArray(responses)) {
          finish(null, Jmap.requestError(payload))
          return
        }
        // `methodError` returning "" cannot be told from "no error", so the
        // type is what the branch is written on.
        if (Jmap.methodErrorType(responses) !== "") {
          finish(null, Jmap.methodError(responses))
          return
        }
        var first = responses.length > 0 ? responses[0] : null
        var boxes = first && first[1] && Array.isArray(first[1].list) ? first[1].list : []

        root.session = Jmap.parseJson(sessionText)
        root.mailboxList = boxes
        root.credentialsRejected = false
        rememberSession(url, sessionText)
        finish({
          sessionUrl: url,
          authScheme: scheme,
          accountId: accountId,
          canSend: Jmap.hasSubmission(sessionText),
          mailboxCount: boxes.length
        }, "")
      })
    }

    function walk(index) {
      if (handle.aborted) return
      if (index >= plan.steps.length) {
        done(null, Jmap.discoveryFailure(plan.domain), true)
        return
      }
      var step = plan.steps[index]
      // A typed server wins outright: somebody who filled that field in is
      // answering a discovery that already failed, and walking the domain
      // again afterwards would only fail again more slowly.
      if (step.kind === Jmap.STEP_TYPED) {
        attempt(step.url, 0, null)
        return
      }
      function afterCandidate(candidate) {
        if (candidate === "") walk(index + 1)
        else attempt(candidate, 0, function() { walk(index + 1) })
      }
      if (step.kind === Jmap.STEP_SRV) {
        lookupSrv(plan.domain, handle, function(url) {
          if (handle.aborted) return
          if (url === "") walk(index + 1)
          else probe(url, 1, afterCandidate)
        })
        return
      }
      probe(step.url, 1, afterCandidate)
    }

    walk(0)
    return handle
  }

  // The `_jmap._tcp` record, through a script that tries resolvectl and then
  // dig. Neither is a required tool and no answer is simply no record, so a
  // failure here is a step that found nothing rather than an error worth
  // showing anybody.
  function lookupSrv(domain, handle, callback) {
    var process = srvComponent.createObject(root, { command: [root.srvLookup, String(domain || "")] })
    if (!process) {
      callback("")
      return
    }
    handle.process = process
    process.finished.connect(function(text) {
      if (!root) return
      if (handle.process === process) handle.process = null
      process.destroy()
      if (handle.aborted) return
      callback(Jmap.parseSrv(text).url)
    })
    process.running = true
  }

  // Beside the query cache, keyed on the URL it came from and the state the
  // server stamped on it. A cache miss costs one round trip; a cache hit from
  // the wrong server would cost a credential, which is why the URL is part of
  // the key.
  function rememberSession(url, sessionText) {
    if (!cache || typeof cache.putSession !== "function") return
    var parsed = Jmap.parseJson(sessionText)
    if (!parsed) return
    cache.putSession(url, Jmap.sessionState(sessionText), parsed)
  }

  Connections {
    target: root.auth
    function onVerifyRequested(settings, address, secret) {
      root.verifyCredentials(settings, address, secret, function(result, error, needsServer) {
        if (root.auth) root.auth.completeSignIn(!error, result, error, needsServer)
      })
    }
    // A mailbox pointed at a different server is a different mailbox: the
    // session and the folders belong to the old one.
    function onSettingsChanged() {
      root.session = null
      root.mailboxList = []
    }
    // A deliberate sign-out is not a refused credential. Left standing, the
    // flag would draw the re-entry card over a mailbox nobody has offered a
    // secret to yet.
    function onLoggedOut() {
      root.credentialsRejected = false
      root.session = null
      root.mailboxList = []
    }
  }

  // ---------------------------------------------------------------- reads

  // There is no profile endpoint, and nothing to ask for: the address is what
  // the user typed when they added the mailbox.
  //
  // Deferred rather than answered on the spot even though the answer is in
  // hand — every caller is written against a callback that arrives later, and
  // `loadProfile` emits `accountIdentified` from inside it.
  function getProfile(callback) {
    if (typeof callback !== "function") return newHandle()
    Qt.callLater(function() {
      if (!root) return
      callback({
        email: root.email,
        messagesTotal: 0,
        threadsTotal: 0,
        historyId: ""
      }, "")
    })
    return newHandle()
  }

  // ------------------------------------------------------------- to follow
  //
  // The rest of the interface, answering the empty result rather than an
  // error: an account that has just signed in has a working session and no
  // list yet, and "this failed" is not what that is. Each of these is filled
  // in by the ticket that owns it — the query and the list, the reader, the
  // actions, the send — and none of them is a button the panel draws until it
  // is.

  function answer(callback, value) {
    if (typeof callback !== "function") return newHandle()
    Qt.callLater(function() {
      if (!root) return
      callback(value, "")
    })
    return newHandle()
  }

  function listMessages(query, maxResults, pageToken, callback, progress) {
    return answer(callback, { ids: [], threadIds: [], nextPageToken: "", estimate: 0 })
  }

  function getMessages(ids, full, callback, existingHandle, progress) {
    return answer(callback, [])
  }

  function getMessage(id, full, callback) {
    return answer(callback, null)
  }

  function getAttachment(messageId, attachmentId, callback) {
    return answer(callback, null)
  }

  function getLabels(callback) {
    return answer(callback, [])
  }

  function getLabelCounts(labelId, callback) {
    return answer(callback, { unread: 0, total: 0, threadsUnread: 0 })
  }

  function getSendAs(callback) {
    return answer(callback, [])
  }

  function modifyMessage(id, addLabelIds, removeLabelIds, callback) {
    return answer(callback, null)
  }

  function batchModify(ids, addLabelIds, removeLabelIds, callback) {
    return answer(callback, null)
  }

  function trashMessage(id, callback) {
    return answer(callback, null)
  }

  function untrashMessage(id, callback) {
    return answer(callback, null)
  }

  function sendMessage(payload, callback) {
    return answer(callback, null)
  }

  function saveDraft(payload, callback) {
    return answer(callback, null)
  }

  // One process per request, created and destroyed around it. The cost of
  // starting one is well under the cost of the TLS handshake it wraps, and a
  // pool would have to be drained on every abort.
  Component {
    id: transportComponent

    Process {
      id: transportProcess

      property string requestLine: ""
      signal finished(int exit, int status, string redirect, string body, string stderr)

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
        var lines = String(stdout.text || "").split("\n")
        // Fewer than four lines is the script refusing before curl ran: it
        // says why on its own stderr rather than in a reply it never built.
        if (lines.length < 4) {
          transportProcess.finished(exitCode === 0 ? 1 : exitCode, 0, "", "",
            String(stderr.text || ""))
          return
        }
        var exit = Math.floor(Number(lines[0]))
        // The status line is the code and, after it, whatever curl reported as
        // the redirect URL — which is written by the server and therefore only
        // ever read through `Jmap.redirectHop`.
        var parts = String(lines[1] || "").split(" ")
        var status = Math.floor(Number(parts[0]))
        transportProcess.finished(isFinite(exit) ? exit : 1,
          isFinite(status) ? status : 0,
          parts.length > 1 ? parts[1] : "",
          Mail.bytesToUtf8(Mail.base64ToBytes(lines[2])),
          Mail.bytesToUtf8(Mail.base64ToBytes(lines[3])))
      }
    }
  }

  Component {
    id: srvComponent

    Process {
      id: srvProcess

      signal finished(string text)

      stdout: StdioCollector { id: srvOutput; waitForEnd: true }
      stderr: StdioCollector { waitForEnd: true }

      onExited: function(exitCode) {
        srvProcess.finished(exitCode === 0 ? String(srvOutput.text || "") : "")
      }
    }
  }
}
