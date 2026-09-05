import QtQuick
import Quickshell
import Quickshell.Io

import "JmapProtocol.js" as Jmap
import "JmapThreads.js" as Threads
import "../message/Message.js" as Mail

// A JMAP mailbox, wearing the same interface `GmailApiClient` wears.
//
// The transport is `scripts/jmap-transport.sh`, which is curl. The protocol is
// `JmapProtocol.js`, with the collapsed list read in `JmapThreads.js`. This
// file is the part in between: which requests a given job becomes, in what
// order, and what to do when one of them fails.
//
// It signs the account in — discovery, the session GET under each scheme in
// turn, the four-step check — and it reads: the rail, the labels, the list, a
// page, a search, the counts, one message whole and the octets of a part. It
// writes, too: read, star, archive, trash, junk and their reverses, each one
// `Email/set` patch per message. It holds an event stream open for as long as
// the account is signed in, and reports what changes on it. And it sends: one
// upload of the raw message and one request that imports it, submits it under
// the chosen identity and destroys the draft it came from.
//
// ## Three things every read depends on, in this order
//
//   1. the *session*. Its API URL, its download template and its limits are
//      the server's answer rather than the account's settings, so it is held
//      in memory, kept in the account's cache file and refetched when neither
//      has one. A restart has neither until this runs.
//   2. the *mailbox list*, read once on first need. Every query gates on it
//      the way IMAP's gates on LIST: a filter needs the mailbox id a role
//      resolved to, and so does every label id on every row.
//   3. the *role map* over that list, which is what a rail row means on this
//      account. Rebuilt whenever the list is replaced, and with it `refusals`
//      and `absentMailboxes` — the two answers that take a button, a key hint
//      and a rail row away before anything reaches the server.
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
  // last read returned. Everything below is a binding over these two, so
  // replacing either is what moves the rail, the buttons and the key hints.
  property var session: null
  // The server and username the session above was read under, so a rewritten
  // settings object can be told from a different server. See `onSettingsChanged`.
  property string serverIdentity: ""
  property var mailboxList: []

  // The id every method call names. The session's own primary wins: it is the
  // session this request is being made against, and an account id written down
  // at sign-in is only ever the answer before one has arrived.
  readonly property string accountId: {
    var primary = Jmap.primaryAccountId(session)
    if (primary !== "") return primary
    return auth && auth.settings ? String(auth.settings.accountId || "") : ""
  }

  // Where every method call goes, read from the session rather than assumed:
  // on the reference account the session is on one host and this is on another.
  readonly property string apiUrl: Jmap.apiUrl(session)

  // What each rail row means on this account — a mailbox id per role, or "" for
  // a role this account has no mailbox for. Every filter and every label id is
  // read through it, so a page of fifty rows resolves six roles rather than
  // three hundred and a row cannot be labelled from a different answer than the
  // query that found it.
  readonly property var roles: Jmap.roleMap(mailboxList)

  // What this account withdraws from the provider's ceiling, and which rail
  // rows it has no mailbox for. Both null until the first `Mailbox/get`, and
  // with null the registry answers the ceiling — which is the right thing for a
  // button while the list is still on its way rather than a promise about a
  // mailbox nobody has looked for yet.
  readonly property var refusals: Jmap.refusals(session, accountId, mailboxList)
  readonly property var absentMailboxes: Jmap.absentMailboxes(mailboxList)

  // The newest state the server has reported per type, from every reply. Push
  // is the only reader: a change notification naming a state this client has
  // already been told is the echo of its own write.
  property var knownStates: ({})

  // ------------------------------------------------------------------ push
  //
  // The one thing this client does that no other provider's does: it is told
  // when the mailbox changed instead of asking. `JmapPush` at the bottom holds
  // the stream open and decides what an event means; these two properties are
  // the whole of what that costs this object's interface.
  //
  // `remoteChanged` is what the account wires to `loadLabels()` and
  // `refresh()`. Its argument is the plan — `{ mail, mailboxes }` — and it is
  // emitted once per connect as well as per event, because the server replays
  // nothing between connections.
  signal remoteChanged(var plan)

  // Whether the stream has heard the server within two ping intervals. Nothing
  // draws it yet; it is the input for a later "Live" beside "Synced".
  readonly property bool live: push.live

  function newHandle() {
    return { aborted: false, process: null, children: [], queueEntry: null }
  }

  function abortRequest(handle) {
    if (!handle) return
    handle.aborted = true
    // A request still waiting for a slot has no process to stop and must not
    // take one: withdrawing it is what stops an abandoned page from holding the
    // queue open behind the page that replaced it.
    // Either FIFO. A call and an upload wait in queues of their own, under
    // limits the session states separately, and a handle knows only that it
    // was waiting in one of them.
    if (handle.queueEntry) {
      if (callQueue && callQueue.withdraw(handle.queueEntry)) handle.queueEntry = null
      else if (uploadQueue && uploadQueue.withdraw(handle.queueEntry)) handle.queueEntry = null
    }
    if (handle.process) {
      handle.process.running = false
      handle.process = null
    }
    var children = handle.children || []
    for (var i = 0; i < children.length; i++) abortRequest(children[i])
    handle.children = []
  }

  // What a caller gets back, whichever way the request ended. Every public read
  // here answers through one of these, so an aborted handle calls back nothing
  // and a live one calls back exactly once.
  function hand(callback, value, error) {
    if (typeof callback === "function") callback(value, String(error || ""))
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
  //
  // `body` is text for every verb but `download`, whose answer is a blob and
  // stays base64 — including the problem document a failed one answers with,
  // which is why `downloadBlob` decodes that itself rather than the transport
  // decoding every megabyte of every attachment on the chance one failed.
  function request(verb, url, credential, extra, handle, callback) {
    var owner = handle || newHandle()
    var credentials = credential || { scheme: Jmap.AUTH_NONE, username: "", secret: "" }
    var fields = [field(url), field(credentials.scheme),
      field(credentials.username), field(credentials.secret)]
    if (extra !== undefined && extra !== null) fields.push(field(extra))

    var process = transportComponent.createObject(root, {
      command: [root.transport],
      requestLine: verb + " " + fields.join(" "),
      binaryBody: verb === "download"
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
      //
      // The same properties every later `Mailbox/get` asks for, so the list
      // sign-in leaves behind is the list the rail, the sidebar and the counts
      // can all be drawn from without a second read.
      var body = JSON.stringify({
        using: Jmap.USING_MAIL,
        methodCalls: [["Mailbox/get", {
          accountId: accountId, ids: null, properties: Jmap.MAILBOX_PROPERTIES
        }, "0"]]
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
        // Under the settings the account is about to be given — the URL that
        // answered and the username as typed — so the write that follows
        // sign-in reads as the same mailbox rather than a new one.
        root.serverIdentity = Jmap.serverIdentity({ sessionUrl: url, username: values.username })
        root.mailboxList = boxes
        // A sign-in that came back with mailboxes has already done the read
        // every query gates on. An empty answer is left unloaded so the first
        // query asks again rather than starting from nothing.
        root.mailboxesLoaded = boxes.length > 0
        root.knownStates = Jmap.recordStates(root.knownStates, responses)
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

  // Everything read off one server, dropped together. The rail falls back to
  // the provider's ceiling while it is empty, which is what `refusals` and
  // `absentMailboxes` answering null means.
  function forgetServer() {
    session = null
    serverIdentity = ""
    mailboxList = []
    mailboxesLoaded = false
    knownStates = ({})
    // Identities belong to the account on the server that answered, so they go
    // with it: a send under another server's identity id is one the new server
    // refuses, and the send-as menu would be offering addresses this mailbox
    // has never had.
    sendAsIdentities = []
    identitiesLoaded = false
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
    // session, the folders and every state read off them belong to the old one.
    //
    // Judged on the server and the username rather than on the object, because
    // the object is rebuilt whenever the account list is saved for any reason
    // — another mailbox named, one added — and sign-in itself rewrites it with
    // the account id and scheme it learned. Forgetting on every one of those
    // threw away the session sign-in had just read and every mailbox with it,
    // to be fetched again before the first list could be drawn.
    function onSettingsChanged() {
      var next = Jmap.serverIdentity(root.auth ? root.auth.settings : null)
      if (next === root.serverIdentity) return
      root.forgetServer()
    }
    // A deliberate sign-out is not a refused credential. Left standing, the
    // flag would draw the re-entry card over a mailbox nobody has offered a
    // secret to yet.
    function onLoggedOut() {
      root.credentialsRejected = false
      root.forgetServer()
    }
  }

  // ------------------------------------------------------------ the queue

  // One FIFO over every method call, at the concurrency the session named.
  // RFC 8620 lets a server refuse a request beyond `maxConcurrentRequests`, and
  // a page of rows plus a count plus a label read is easily more than four at
  // once — so the limit is honoured here rather than discovered as a refusal.
  //
  // Built once, at the first call after the session arrived, and never torn
  // down: a queue destroyed with entries waiting would strand their callbacks.
  // A mailbox pointed at another server keeps this one's limit, which is a
  // difference in pace and not in correctness.
  property var callQueue: null

  function queue() {
    if (!callQueue) {
      callQueue = Jmap.makeQueue(
        Jmap.sessionLimit(session, "maxConcurrentRequests", Jmap.DEFAULT_CONCURRENCY))
    }
    return callQueue
  }

  // One finished, so the next one starts. Called exactly once per admitted
  // entry, on every path out of it — including the ones that never reached
  // curl, because a slot held by a request that failed to start is a slot
  // nothing ever gives back.
  function releaseSlot() {
    if (!callQueue) return
    var next = callQueue.release()
    if (next) next.start()
  }

  // The second FIFO, for the one verb that sends a body rather than receiving
  // one. Its own limit because the session states its own: a 40 MB message on
  // a slow link would otherwise hold a `maxConcurrentRequests` slot for the
  // length of the upload while the rail, the counts and the list queued behind
  // it. Built at the first upload and never torn down, for the same reason the
  // call queue is not.
  property var uploadQueue: null

  function uploads() {
    if (!uploadQueue) {
      uploadQueue = Jmap.makeQueue(
        Jmap.sessionLimit(session, "maxConcurrentUpload", Jmap.DEFAULT_CONCURRENT_UPLOAD))
    }
    return uploadQueue
  }

  function releaseUploadSlot() {
    if (!uploadQueue) return
    var next = uploadQueue.release()
    if (next) next.start()
  }

  // ---------------------------------------------------------- the session

  property var sessionWaiters: []
  property bool sessionLoading: false

  function finishSessionWaiters(error) {
    sessionLoading = false
    var pending = sessionWaiters.slice()
    sessionWaiters = []
    for (var i = 0; i < pending.length; i++) pending[i](String(error || ""))
  }

  // The session object: memory, then the cache, then the server.
  //
  // A shell restart has neither of the first two. What the account carries is
  // the session URL, the scheme and the account id; the session itself — the
  // API URL, the download template, the limits, the state — is the server's
  // answer, so it lives beside the query results and is restored from there.
  // Without this read a signed-in mailbox would have nowhere to send its first
  // request after every restart.
  //
  // The cached copy is used as it stands, and is verified the way a fetched one
  // is. It is keyed on the URL it came from, so it cannot be another server's;
  // revalidating it against the server on every start would cost a round trip
  // before the first row every time, which is the cost this read exists to
  // avoid. A server that has moved its API URL since answers the first call
  // with a 404, and that is what `readCall` drops the session on.
  function ensureSession(callback) {
    if (session) {
      callback("")
      return
    }
    var url = auth && auth.settings ? String(auth.settings.sessionUrl || "") : ""
    if (url === "") {
      callback("Sign in to this mailbox first")
      return
    }
    if (cache && typeof cache.getSession === "function") {
      var entry = cache.getSession(url)
      if (entry && entry.session && Jmap.verifySession(entry.session).error === "") {
        root.session = entry.session
        root.serverIdentity = Jmap.serverIdentity(auth.settings)
        callback("")
        return
      }
    }

    var waiting = sessionWaiters.slice()
    waiting.push(callback)
    sessionWaiters = waiting
    if (sessionLoading) return
    sessionLoading = true

    auth.withCredentials(function(credential, error) {
      if (!root) return
      if (error || !credential) {
        root.finishSessionWaiters(error || "Sign in to this mailbox first")
        return
      }
      root.request("session", url, credential, null, null, function(reply) {
        if (!root) return
        if (reply.exit !== 0 || reply.status !== 200) {
          root.finishSessionWaiters(
            Jmap.transportError(reply.exit, reply.status, reply.body, reply.stderr, ""))
          return
        }
        // The same four-step check sign-in runs, because a session fetched now
        // is a session that may have changed: an account whose mail capability
        // or `receivedAt` sort has gone is one every list would fail on.
        var check = Jmap.verifySession(reply.body)
        if (check.error !== "") {
          root.finishSessionWaiters(check.error)
          return
        }
        root.session = Jmap.parseJson(reply.body)
        root.serverIdentity = Jmap.serverIdentity(auth.settings)
        root.credentialsRejected = false
        root.rememberSession(url, reply.body)
        root.finishSessionWaiters("")
      })
    })
  }

  // ------------------------------------------------------------ one call

  // One API POST, through the queue and the credential, with the three levels a
  // JMAP request fails at read in the right order.
  //
  // `callback(responses, error, errorType)`. The type is handed over beside the
  // sentence because `methodError` returning "" cannot be told from "no error",
  // and because one caller — the paging retry — has a branch for a particular
  // one.
  // `using` is the capability list this particular request needs, and it
  // defaults to core and mail because reading mail is what nearly every call
  // here is. The send request is the exception and passes `USING_SUBMISSION`;
  // a vendor URN never appears in either.
  function call(methodCalls, handle, callback, using) {
    var owner = handle || newHandle()
    var entry = { owner: owner }

    entry.start = function() {
      if (!root || owner.aborted) {
        if (root) root.releaseSlot()
        return
      }
      if (!root.auth) {
        root.releaseSlot()
        root.hand(callback, null, "Sign in to this mailbox first")
        return
      }
      if (root.apiUrl === "") {
        root.releaseSlot()
        root.hand(callback, null, "Sign in to this mailbox again")
        return
      }
      root.auth.withCredentials(function(credential, error) {
        if (!root) return
        if (owner.aborted) {
          root.releaseSlot()
          return
        }
        if (error || !credential) {
          root.releaseSlot()
          root.hand(callback, null, error || "Sign in to this mailbox first")
          return
        }
        var body = JSON.stringify({
          using: Array.isArray(using) ? using : Jmap.USING_MAIL,
          methodCalls: methodCalls
        })
        root.request("call", root.apiUrl, credential, body, owner, function(reply) {
          if (!root) return
          root.releaseSlot()
          if (owner.aborted) return
          root.readCall(reply, callback)
        })
      })
    }

    owner.queueEntry = entry
    if (queue().admit(entry)) entry.start()
    return owner
  }

  function readCall(reply, callback) {
    if (reply.exit !== 0 || reply.status !== 200) {
      // A method that failed comes back inside a 200 with an `error`
      // invocation, so a 404 from the API URL is not a missing message — it is
      // a URL that is no longer there, which is what a restored session whose
      // server has moved since looks like. Dropping it has the next read fetch
      // a fresh one rather than failing against the same stale address for as
      // long as the account is open.
      if (reply.status === 404) forgetServer()
      hand(callback, null,
        Jmap.transportError(reply.exit, reply.status, reply.body, reply.stderr, ""))
      return
    }
    var payload = Jmap.parseJson(reply.body)
    if (!payload) {
      hand(callback, null, "The server sent an answer this client could not read")
      return
    }
    // JMAP fails at two levels inside a 200. A request-level failure replaces
    // the whole document, so it is the absence of `methodResponses` that says
    // which of the two this is.
    var responses = payload.methodResponses
    if (!Array.isArray(responses)) {
      hand(callback, null, Jmap.requestError(payload))
      return
    }
    root.knownStates = Jmap.recordStates(root.knownStates, responses)
    var type = Jmap.methodErrorType(responses)
    if (typeof callback === "function")
      callback(responses, type !== "" ? Jmap.methodError(responses) : "", type)
  }

  // ------------------------------------------------------- the mailbox list

  property bool mailboxesLoaded: false
  property bool mailboxLoading: false
  property var mailboxWaiters: []

  function finishMailboxWaiters(error) {
    mailboxLoading = false
    var pending = mailboxWaiters.slice()
    mailboxWaiters = []
    for (var i = 0; i < pending.length; i++) pending[i](String(error || ""))
  }

  // Every query gates on this, the way IMAP's gates on LIST. Read once on first
  // need and kept, then replaced wholesale by every `getLabels` — which sign-in
  // and every refresh call, so a folder added on the server reaches the rail
  // without anything here watching for it.
  function ensureMailboxes(callback) {
    // The flag, not the list's length. A server that really does answer with no
    // mailboxes at all would otherwise be read again on every query for as long
    // as the account was open; one read and an honest refusal from every rail
    // row is the right answer to an account with nothing in it.
    if (mailboxesLoaded) {
      callback("")
      return
    }
    var waiting = mailboxWaiters.slice()
    waiting.push(callback)
    mailboxWaiters = waiting
    if (mailboxLoading) return
    mailboxLoading = true

    ensureSession(function(error) {
      if (!root) return
      if (error) {
        root.finishMailboxWaiters(error)
        return
      }
      root.readMailboxList(null, function(list, failure) {
        if (!root) return
        root.finishMailboxWaiters(failure)
      })
    })
  }

  // One `Mailbox/get`, with the properties the rail, the sidebar and the counts
  // are all read out of. Replacing the list is what recomputes the role map,
  // the refusals and the absent rows.
  function readMailboxList(handle, callback) {
    return call([["Mailbox/get", {
      accountId: root.accountId,
      ids: null,
      properties: Jmap.MAILBOX_PROPERTIES
    }, "0"]], handle, function(responses, error) {
      if (!root) return
      if (error) {
        callback([], error)
        return
      }
      var args = Jmap.responseArguments(responses, "Mailbox/get")
      var list = args && Array.isArray(args.list) ? args.list : []
      root.mailboxList = list
      root.mailboxesLoaded = true
      callback(list, "")

    })
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

  // ------------------------------------------------------------- the list

  // One page of ids, newest first.
  //
  //   { ids, threadIds, nextPageToken, estimate }
  //
  // One row per conversation: the query collapses threads, so an id here is a
  // representative and the estimate counts conversations. `threadIds` stays
  // empty — the block on each row's summary carries the thread id, and nothing
  // above the seam reads the parallel array.
  //
  // `progress` goes unused because one POST answers the whole page — there is
  // no partial result to paint early, the way IMAP's windowed search has.
  function listMessages(query, maxResults, pageToken, callback, progress) {
    var handle = newHandle()
    ensureMailboxes(function(error) {
      if (!root || handle.aborted) return
      if (error) {
        root.hand(callback, null, error)
        return
      }
      var parsed = Jmap.parseQuery(query)
      var filter = Jmap.filterFor(parsed, root.roles)
      // A rail row whose role resolves to nothing on this account. The row is
      // already gone from the sidebar and the button is already off; this is
      // the layer underneath both, for a mailbox deleted since the last read.
      if (!filter) {
        root.hand(callback, null, Jmap.queryError(parsed, root.roles))
        return
      }
      root.runQuery(filter, query, maxResults, pageToken, false, handle, callback)
    })
    return handle
  }

  // ------------------------------------------------------- conversations

  // Representative id to the `thread` block the page read composed for it, and
  // member id to the mailboxes that member sits in.
  //
  // Two maps rather than one because they answer two questions with different
  // lifetimes: a block belongs to one row in one view and is consumed by the
  // summary read a moment later, while a membership is a fact about a message
  // that an action on a conversation still needs long after its page has gone.
  //
  // Merged rather than replaced on each read. The unread badge runs a small
  // query of its own between a page's ids arriving and its summaries being
  // asked for, and replacing would drop the page's blocks on the floor.
  property var threadBlocks: ({})
  property var memberships: ({})

  // The query is carried alongside the filter because the counted-members rule
  // needs the *view*, not the request: the same thread counts different members
  // in the Junk view than it does in the Inbox.
  function runQuery(filter, query, maxResults, token, byPosition, handle, callback) {
    var child = call(Threads.listCalls(root.accountId, filter, maxResults, token, byPosition),
      null, function(responses, error, type) {
        if (!root || handle.aborted) return
        // The anchor moved or was deleted between pages — the one thing anchor
        // paging cannot survive, and the reason the token carries a position
        // beside it. One retry, by position, and never a second: a page that
        // cannot be found twice is a result that is changing faster than it can
        // be read.
        //
        // Checked before anything is read out of the reply: an `anchorNotFound`
        // answers with no `Email/query` invocation at all.
        if (type === "anchorNotFound" && byPosition !== true) {
          root.runQuery(filter, query, maxResults, token, true, handle, callback)
          return
        }
        var read = Threads.collapsedPage(responses, maxResults, root.roles, query, null)
        // The member read alone was refused, which on a page of long threads is
        // `requestTooLarge`: the other three calls answered and only the fourth
        // is owed. Fetching those members in chunks before the page is handed
        // over is what makes the page complete rather than a page of rows with
        // no blocks — and the error the refusal produced is not the page's,
        // which is why this branch comes before it.
        if (read.pending.length > 0) {
          root.readMembers(read.pending, handle, function(members, failure) {
            if (!root || handle.aborted) return
            if (failure) {
              root.hand(callback, null, failure)
              return
            }
            root.deliverPage(
              Threads.collapsedPage(responses, maxResults, root.roles, query, members),
              callback)
          })
          return
        }
        if (error) {
          root.hand(callback, null, error)
          return
        }
        root.deliverPage(read, callback)
      })
    handle.children.push(child)
  }

  function deliverPage(read, callback) {
    threadBlocks = Threads.mergedInto(threadBlocks, read.blocks, Threads.MAX_REMEMBERED)
    memberships = Threads.mergedInto(memberships, read.memberships, Threads.MAX_REMEMBERED)
    hand(callback, read.page, "")
  }

  // The members again, by id, in chunks no larger than the server will answer.
  // One `Email/get` per chunk, as the summary read does, and one failed chunk
  // fails the page: a row whose block counted only the members that arrived
  // would say the wrong thing about its conversation.
  function readMembers(ids, handle, callback) {
    var chunks = Jmap.chunked(ids,
      Jmap.sessionLimit(root.session, "maxObjectsInGet", Jmap.DEFAULT_OBJECTS_IN_GET))
    if (chunks.length === 0) {
      callback([], "")
      return
    }
    var members = []
    var remaining = chunks.length
    var firstError = ""

    for (var c = 0; c < chunks.length; c++) {
      (function(chunk) {
        var child = root.call([[
          "Email/get", Threads.memberGet(root.accountId, chunk), "0"
        ]], null, function(responses, failure) {
          if (!root || handle.aborted) return
          if (failure && firstError === "") firstError = failure
          var args = Jmap.responseArguments(responses, "Email/get")
          var list = args && Array.isArray(args.list) ? args.list : []
          for (var j = 0; j < list.length; j++) members.push(list[j])
          remaining = remaining - 1
          if (remaining === 0) callback(members, firstError)
        })
        handle.children.push(child)
      })(chunks[c])
    }
  }

  // The block the collapsed page read composed for this row, put on the
  // resource its summary is built from.
  //
  // A message read outside a collapsed page — a preview, the reader's own full
  // read — carries no block and reports a count of 0, which means unknown and
  // draws no badge. `Model.detailSummary` is what keeps a row that had one from
  // losing it to a full read that did not.
  function withThreadBlock(message) {
    var block = threadBlocks[message.id]
    if (block) message.thread = block
    return message
  }

  // The counted members of a conversation, for the rail beside the reader.
  //
  // One `Email/get` with the list-read properties, chunked at the limit — which
  // is `getMessages` exactly, with one difference that is the whole reason this
  // is its own name rather than a second caller of that one: **no thread
  // block**. A block belongs to a row and speaks for the whole conversation, so
  // a member that happens to be some row's representative would come back
  // carrying its conversation's unread and flagged marks, and the rail would
  // draw a stop that is bold because a *different* message in the thread is.
  // A stop is one message and must tell the truth about that message.
  //
  // The other three clients answer with an empty list. Gmail declares `threads`
  // but not `conversations`, so no row it serves carries member ids at all;
  // HEY's rows already are conversations and report a count of 0, which is
  // unknown; IMAP declares neither. Nothing above the seam has to know that —
  // it asks, and an empty answer is a rail with nothing to add.
  function getSummaries(ids, callback) {
    var handle = newHandle()
    var wanted = []
    var source = Array.isArray(ids) ? ids : []
    for (var i = 0; i < source.length; i++) {
      var id = String(source[i] || "")
      if (id !== "") wanted.push(id)
    }
    if (wanted.length === 0) {
      hand(callback, [], "")
      return handle
    }

    ensureMailboxes(function(error) {
      if (!root || handle.aborted) return
      if (error) {
        root.hand(callback, [], error)
        return
      }
      var chunks = Jmap.chunked(wanted,
        Jmap.sessionLimit(root.session, "maxObjectsInGet", Jmap.DEFAULT_OBJECTS_IN_GET))
      var byId = {}
      var remaining = chunks.length
      var firstError = ""

      for (var c = 0; c < chunks.length; c++) {
        (function(chunk) {
          var child = root.call([[
            "Email/get", Jmap.emailGet(root.accountId, chunk, false), "0"
          ]], null, function(responses, failure) {
            if (!root || handle.aborted) return
            if (failure && firstError === "") firstError = failure
            var args = Jmap.responseArguments(responses, "Email/get")
            var list = args && Array.isArray(args.list) ? args.list : []
            for (var j = 0; j < list.length; j++) {
              var message = Jmap.toMessage(list[j], root.roles)
              if (message.id !== "") byId[message.id] = message
            }
            remaining = remaining - 1
            if (remaining > 0) return
            var ordered = []
            for (var k = 0; k < wanted.length; k++) {
              if (byId[wanted[k]]) ordered.push(byId[wanted[k]])
            }
            // A member the read did not answer for is simply not a stop the
            // rail can fill in. Unlike a page, a partial answer here is worth
            // keeping: the stops that arrived settle and the rest stay
            // skeletons, which is what they already were.
            root.hand(callback, ordered, ordered.length > 0 ? "" : firstError)
          })
          handle.children.push(child)
        })(chunks[c])
      }
    })
    return handle
  }

  // The rows behind those ids, in the order they were asked for.
  //
  // `full` is ignored here: a full read is one message, and `getMessage` is
  // where a body structure and its values are asked for. Every row goes through
  // the same composer, so a list row and a preview row are the same shape.
  function getMessages(ids, full, callback, existingHandle, progress) {
    var handle = existingHandle || newHandle()
    var wanted = []
    var source = Array.isArray(ids) ? ids : []
    for (var i = 0; i < source.length; i++) {
      var id = String(source[i] || "")
      if (id !== "") wanted.push(id)
    }
    if (wanted.length === 0) {
      hand(callback, [], "")
      return handle
    }

    ensureMailboxes(function(error) {
      if (!root || handle.aborted) return
      if (error) {
        root.hand(callback, [], error)
        return
      }
      var chunks = Jmap.chunked(wanted,
        Jmap.sessionLimit(root.session, "maxObjectsInGet", Jmap.DEFAULT_OBJECTS_IN_GET))
      var byId = {}
      var remaining = chunks.length
      var firstError = ""

      function finish() {
        if (!root || handle.aborted) return
        var ordered = []
        for (var k = 0; k < wanted.length; k++) {
          if (byId[wanted[k]]) ordered.push(byId[wanted[k]])
        }
        // A partial page is still a failed page: hiding one failed chunk
        // because another answered would let the caller keep a continuation
        // token beyond the missing row.
        root.hand(callback, ordered, firstError)
      }

      for (var c = 0; c < chunks.length; c++) {
        (function(chunk) {
          var child = root.call([[
            "Email/get", Jmap.emailGet(root.accountId, chunk, false), "0"
          ]], null, function(responses, failure) {
            if (!root || handle.aborted) return
            if (failure && firstError === "") firstError = failure
            var args = Jmap.responseArguments(responses, "Email/get")
            var list = args && Array.isArray(args.list) ? args.list : []
            var painted = []
            for (var j = 0; j < list.length; j++) {
              var message = root.withThreadBlock(Jmap.toMessage(list[j], root.roles))
              if (message.id === "") continue
              byId[message.id] = message
              painted.push(message)
            }
            if (painted.length > 0 && typeof progress === "function") progress(painted)
            remaining = remaining - 1
            if (remaining === 0) finish()
          })
          handle.children.push(child)
        })(chunks[c])
      }
    })
    return handle
  }

  // One message, whole: the headers, the MIME tree and the text of the parts
  // that are text.
  //
  // A read that is not full is the list row again, through the same composer,
  // so a preview and a row cannot disagree about the same message. A full read
  // is one `Email/get` and, only when the server truncated something, one
  // download per truncated part before the callback fires — the reader is
  // handed a message that is finished or it is handed an error, never a body
  // that fills in a moment later underneath it.
  function getMessage(id, full, callback) {
    var messageId = String(id || "")
    if (full !== true) {
      return getMessages([messageId], false, function(messages, error) {
        if (typeof callback !== "function") return
        if (error || messages.length === 0)
          callback(null, error || "That message is no longer in the mailbox")
        else callback(messages[0], "")
      })
    }

    var handle = newHandle()
    if (messageId === "") {
      hand(callback, null, "That message is no longer in the mailbox")
      return handle
    }
    ensureMailboxes(function(error) {
      if (!root || handle.aborted) return
      if (error) {
        root.hand(callback, null, error)
        return
      }
      var child = root.call([[
        "Email/get", Jmap.emailGet(root.accountId, [messageId], true), "0"
      ]], null, function(responses, failure) {
        if (!root || handle.aborted) return
        if (failure) {
          root.hand(callback, null, failure)
          return
        }
        var args = Jmap.responseArguments(responses, "Email/get")
        var list = args && Array.isArray(args.list) ? args.list : []
        // `notFound` rather than an error: a message deleted between the list
        // and the open is the ordinary race, and the sentence the panel shows
        // for it is the same one every other provider gives.
        if (list.length === 0) {
          root.hand(callback, null, "That message is no longer in the mailbox")
          return
        }
        var email = list[0]
        var message = root.withThreadBlock(Jmap.toMessage(email, root.roles, true))
        root.fillTruncated(message, Jmap.truncatedParts(email), handle, function() {
          if (!root || handle.aborted) return
          root.hand(callback, message, "")
        })
      })
      handle.children.push(child)
    })
    return handle
  }

  // The parts the server sent short, fetched whole and put back before the
  // message is delivered.
  //
  // A part that could not be fetched keeps the text the server did send. A
  // truncated body still reads; refusing to open the message over the tail of
  // one part would lose the whole of it to save the end — and the one failure
  // that is not a network problem, a part past the blob ceiling, is a part
  // nothing could have delivered anyway.
  function fillTruncated(message, parts, handle, done) {
    var pending = Array.isArray(parts) ? parts : []
    var wanted = []
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].size <= Jmap.MAX_BLOB_BYTES) wanted.push(pending[i])
    }
    if (wanted.length === 0) {
      done()
      return
    }
    var remaining = wanted.length
    for (var j = 0; j < wanted.length; j++) {
      (function(part) {
        var child = root.downloadBlob(part.blobId, null, function(data, error) {
          if (!root || handle.aborted) return
          if (!error && data !== "") Jmap.substitutePart(message.payload, part, data)
          remaining = remaining - 1
          if (remaining === 0) done()
        })
        handle.children.push(child)
      })(wanted[j])
    }
  }

  // The octets of a part the message described but did not carry — the
  // invitation the calendar card is drawn from, the file the reader opens, the
  // attachment a forward re-encodes.
  //
  // `messageId` goes unused, and that is the shape of the thing rather than an
  // oversight: a JMAP attachment id is the part's `blobId`, which addresses the
  // blob on the account without reference to the message it happened to arrive
  // in. Nothing here re-reads the message to find it.
  function getAttachment(messageId, attachmentId, callback) {
    return downloadBlob(attachmentId, null, callback)
  }

  // One GET on the session's own download template, uncapped by the call queue
  // because a blob is not a method call and a 20 MB download holding one of
  // four API slots would stall the list behind it.
  //
  // The answer is base64 as the transport encoded it, which is what every
  // consumer of an attachment already accepts: `Message.base64ToBytes` reads
  // both alphabets, `Message.mimeBase64` re-wraps either for a forward, and
  // `open-attachment.py` decodes either. Re-encoding 20 MB into the URL-safe
  // alphabet to say the same thing would be the one expensive step in the path.
  function downloadBlob(blobId, existingHandle, callback) {
    var handle = existingHandle || newHandle()
    var blob = String(blobId || "")
    if (blob === "") {
      hand(callback, "", "That attachment is not in the message")
      return handle
    }
    ensureSession(function(error) {
      if (!root || handle.aborted) return
      if (error) {
        root.hand(callback, "", error)
        return
      }
      // The name and the type are placeholders on purpose: they are the last
      // two path and query values of somebody else's URL template, the octets
      // are what is wanted, and the real filename is already on the part.
      var url = Jmap.downloadUrl(Jmap.downloadTemplate(root.session),
        root.accountId, blob, "attachment", "application/octet-stream")
      if (url === "") {
        root.hand(callback, "", "Sign in to this mailbox again")
        return
      }
      if (!root.auth) {
        root.hand(callback, "", "Sign in to this mailbox first")
        return
      }
      root.auth.withCredentials(function(credential, failure) {
        if (!root || handle.aborted) return
        if (failure || !credential) {
          root.hand(callback, "", failure || "Sign in to this mailbox first")
          return
        }
        root.request("download", url, credential, null, handle, function(reply) {
          if (!root || handle.aborted) return
          if (reply.exit !== 0 || reply.status !== 200) {
            // curl exit 63 is the 20 MB ceiling the script fixes, and its
            // sentence is written for somebody who just clicked an attachment.
            // The body of a download crosses as base64 because it is bytes;
            // the one answer that is not bytes is the problem document a
            // failure carries, and it is small enough to read here.
            root.hand(callback, "", Jmap.transportError(reply.exit, reply.status,
              Mail.bytesToUtf8(Mail.base64ToBytes(reply.body)), reply.stderr, ""))
            return
          }
          root.hand(callback, String(reply.body || ""), "")
        })
      })
    })
    return handle
  }

  // The server's own folders, in the shape the sidebar reads Gmail's labels in.
  //
  // A fresh `Mailbox/get` every time, which is the mailbox list's whole refresh
  // path: sign-in and every refresh call this, so a folder created, renamed or
  // deleted on the server reaches the rail, the role map and the refusals
  // together rather than one of them at a time.
  function getLabels(callback) {
    var handle = newHandle()
    ensureSession(function(error) {
      if (!root || handle.aborted) return
      if (error) {
        root.hand(callback, [], error)
        return
      }
      root.readMailboxList(handle, function(list, failure) {
        if (!root || handle.aborted) return
        if (failure) {
          root.hand(callback, [], failure)
          return
        }
        root.hand(callback, Jmap.mailboxLabels(list, root.roles), "")
      })
    })
    return handle
  }

  function getLabelCounts(labelId, callback) {
    var handle = newHandle()
    var id = String(labelId || "")
    if (id === "") {
      hand(callback, { id: "", unread: 0, total: 0, threadsUnread: 0 }, "")
      return handle
    }
    ensureSession(function(error) {
      if (!root || handle.aborted) return
      if (error) {
        root.hand(callback, null, error)
        return
      }
      root.call([["Mailbox/get", {
        accountId: root.accountId,
        ids: [id],
        properties: Jmap.MAILBOX_PROPERTIES
      }, "0"]], handle, function(responses, failure) {
        if (!root || handle.aborted) return
        if (failure) {
          root.hand(callback, null, failure)
          return
        }
        var args = Jmap.responseArguments(responses, "Mailbox/get")
        var list = args && Array.isArray(args.list) ? args.list : []
        root.hand(callback, list.length > 0 ? Jmap.labelCounts(list[0])
          : { id: id, unread: 0, total: 0, threadsUnread: 0 }, "")
      })
    })
    return handle
  }

  // -------------------------------------------------------------- actions
  //
  // Every action is one `Email/set` patch per message, built by the protocol
  // library out of the Gmail label ids `MailAccount` speaks. The callback is
  // `(null, "")` on success and `(null, <sentence>)` otherwise — the contract
  // the other three clients keep — so the account's optimistic update and the
  // restore behind it need no branch for this provider.

  function modifyMessage(id, addLabelIds, removeLabelIds, callback) {
    return batchModify([id], addLabelIds, removeLabelIds, callback)
  }

  function batchModify(ids, addLabelIds, removeLabelIds, callback) {
    var handle = newHandle()
    // The role map is what a label id means on this account, so an action gates
    // on the mailbox list exactly as a query does.
    ensureMailboxes(function(error) {
      if (!root || handle.aborted) return
      if (error) {
        root.hand(callback, null, error)
        return
      }
      // One patch per message, grouped: an action on a conversation row arrives
      // here as every counted member, and where each member sits decides
      // whether archiving or reporting it as spam reaches it at all. The
      // membership map is the last list read's answer to that, and a member it
      // does not name gets the plain single-message patch.
      var plan = Threads.patchPlan(ids, addLabelIds, removeLabelIds,
        root.roles, root.memberships)
      // A destination role this account has no mailbox for. The button is
      // already gone and `MailAccount.act` already refuses the key; this is the
      // layer underneath both, for a request that reached the client anyway —
      // an account whose Archive folder was deleted since the last read. It
      // fails *before* a request rather than after one, so the row goes back
      // and nothing on the server was touched.
      if (typeof plan === "string") {
        root.hand(callback, null, plan)
        return
      }
      root.applyPlan(plan, root.namedCount(ids) > 1, callback, handle)
    })
    return handle
  }

  // How many distinct messages an action named, which is what decides whether a
  // `notFound` is the answer or a member somebody else deleted.
  function namedCount(ids) {
    var source = Array.isArray(ids) ? ids : [ids]
    var seen = []
    for (var i = 0; i < source.length; i++) {
      var id = String(source[i] || "")
      if (id !== "" && seen.indexOf(id) < 0) seen.push(id)
    }
    return seen.length
  }

  // One patch over one id or many, `maxObjectsInSet` at a time.
  //
  // The chunks go one after another rather than together: the queue would admit
  // four of them at once and a "mark all read" over a long page is exactly the
  // request that would sit on `maxConcurrentRequests` while the rest of the
  // panel waited behind it. A chunk that fails stops the rest — the account
  // restores the whole list on any error, so sending the remainder would only
  // widen the gap between what the screen says and what the server holds.
  function applyPatch(ids, patch, callback, existingHandle) {
    return applyPlan([{ ids: Array.isArray(ids) ? ids : [ids], patch: patch }],
      namedCount(ids) > 1, callback, existingHandle)
  }

  // The same, for a plan whose groups do not share one patch — an action on a
  // conversation, where a member outside the Inbox is moved differently or not
  // at all. Every group's chunks join the one sequence, so the request count is
  // still what the page costs rather than what the conversation is long.
  //
  // `tolerateNotFound` is the whole action's, not the group's: a batch that
  // grouped down to one id is still a batch, and a message somebody else
  // deleted is not a failure of "mark these read".
  function applyPlan(plan, tolerateNotFound, callback, existingHandle) {
    var handle = existingHandle || newHandle()
    var groups = Array.isArray(plan) ? plan : []
    var limit = Jmap.sessionLimit(root.session, "maxObjectsInSet",
      Jmap.DEFAULT_OBJECTS_IN_SET)
    var chunks = []
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g] || {}
      if (Jmap.patchIsEmpty(group.patch)) continue
      var wanted = []
      var source = Array.isArray(group.ids) ? group.ids : []
      for (var i = 0; i < source.length; i++) {
        var id = String(source[i] || "")
        if (id !== "" && wanted.indexOf(id) < 0) wanted.push(id)
      }
      var parts = Jmap.chunked(wanted, limit)
      for (var c = 0; c < parts.length; c++) chunks.push({ ids: parts[c], patch: group.patch })
    }
    if (chunks.length === 0) {
      hand(callback, null, "")
      return handle
    }

    var index = 0

    function next() {
      if (!root || handle.aborted) return
      if (index >= chunks.length) {
        root.hand(callback, null, "")
        return
      }
      var chunk = chunks[index]
      index = index + 1
      var child = root.call([[
        "Email/set", Jmap.emailSet(root.accountId, chunk.ids, chunk.patch), "0"
      ]], null, function(responses, failure) {
        if (!root || handle.aborted) return
        if (failure) {
          root.hand(callback, null, failure)
          return
        }
        var refused = Jmap.notUpdatedError(
          Jmap.responseArguments(responses, "Email/set"), tolerateNotFound)
        if (refused !== "") {
          root.hand(callback, null, refused)
          return
        }
        next()
      })
      handle.children.push(child)
    }

    next()
    return handle
  }

  // One id or an array of them, as every client's trash takes. A whole
  // `mailboxIds` replace, so the message is in Trash and nowhere else, which is
  // what the after-action rule already assumes about a thrown-away message.
  function trashMessage(id, callback) {
    return batchModify(Array.isArray(id) ? id : [id], ["TRASH"], [], callback)
  }

  // The reverse, and it goes to the Inbox: JMAP keeps no record of where a
  // trashed message came from, so there is no previous mailbox to restore it
  // to. `ImapClient.untrashMessage` moves to INBOX for the same reason.
  function untrashMessage(id, callback) {
    return batchModify(Array.isArray(id) ? id : [id], [], ["TRASH"], callback)
  }

  // ------------------------------------------------------------------ send
  //
  // Compose, reply, reply-all, forward, the RSVP and the unsubscribe mail all
  // arrive here as the same payload every provider takes: `raw`, base64url of
  // the bytes `Message.buildRawMessage` produced, and `draftId`, the draft the
  // compose window was opened from or "".
  //
  // The bytes are never re-made. They go to the upload endpoint as they are
  // and come back as a blob id, and `Email/import` turns that into the Email
  // the submission sends — which is what keeps the direction twin, the
  // calendar reply and every nested boundary exactly as the composer wrote
  // them, and lets the server thread a reply by its own References header.
  //
  // Undo send is not here. `message/Outbox.js` holds the payload for up to a
  // minute and nothing reaches the wire before that timer fires; the server's
  // own hold is a submission extension one of the two target servers offers,
  // and moving undo into the provider seam for one of them would be a worse
  // trade than the timer already made.

  // The identities this account may write from, read once and kept. They are
  // the send-as menu and they are also where a send finds the `identityId`
  // `EmailSubmission/set` will not go without, which is why one read serves
  // both rather than the menu being a thing the send hopes somebody loaded.
  // Dropped with the session: another server's identities are another
  // mailbox's.
  property var sendAsIdentities: []
  property bool identitiesLoaded: false
  property bool identityLoading: false
  property var identityWaiters: []

  function finishIdentityWaiters(error) {
    identityLoading = false
    var pending = identityWaiters.slice()
    identityWaiters = []
    for (var i = 0; i < pending.length; i++) pending[i](String(error || ""))
  }

  // `Identity/get` for every id, under the submission capability — `Identity`
  // is that capability's object, and asking for it under core and mail alone
  // is `unknownMethod` on a server that has it.
  function ensureIdentities(callback) {
    if (identitiesLoaded) {
      callback("")
      return
    }
    var waiting = identityWaiters.slice()
    waiting.push(callback)
    identityWaiters = waiting
    if (identityLoading) return
    identityLoading = true

    ensureSession(function(error) {
      if (!root) return
      if (error) {
        root.finishIdentityWaiters(error)
        return
      }
      // An account the session says cannot submit has no identities to read,
      // and asking for them under a capability the server does not publish is
      // `unknownCapability` every time. An empty list is the whole truth about
      // such a mailbox rather than a failure to report: `refusals` has already
      // taken the compose button away, and the account falls back to its own
      // address for the From line it still has to draw somewhere.
      if (!Jmap.hasSubmission(root.session, root.accountId)) {
        root.sendAsIdentities = []
        root.identitiesLoaded = true
        root.finishIdentityWaiters("")
        return
      }
      root.call([["Identity/get", { accountId: root.accountId, ids: null }, "0"]], null,
        function(responses, failure) {
          if (!root) return
          if (failure) {
            root.finishIdentityWaiters(failure)
            return
          }
          var args = Jmap.responseArguments(responses, "Identity/get")
          var list = args && Array.isArray(args.list) ? args.list : []
          root.sendAsIdentities = Jmap.identityAliases(list, root.email)
          root.identitiesLoaded = true
          root.finishIdentityWaiters("")
        }, Jmap.USING_SUBMISSION)
    })
  }

  // The server's identities in the alias shape every composer reads. Identities
  // are never created here: the reference server refuses an address the account
  // is not configured for, and inventing one would be this client claiming an
  // address on the user's behalf.
  function getSendAs(callback) {
    var handle = newHandle()
    ensureIdentities(function(error) {
      if (!root || handle.aborted) return
      if (error) {
        root.hand(callback, [], error)
        return
      }
      root.hand(callback, root.sendAsIdentities, "")
    })
    return handle
  }

  // The raw message to the session's own upload endpoint, through the upload
  // queue and the credential. `callback(blobId, error)`.
  //
  // The bytes go to the transport as a base64 field and reach curl from a file
  // in its own private directory, so a fifty-megabyte message never passes
  // through the process table and never sits on disk unprotected.
  function uploadMessage(message, handle, callback) {
    var owner = handle || newHandle()
    var entry = { owner: owner }

    entry.start = function() {
      if (!root || owner.aborted) {
        if (root) root.releaseUploadSlot()
        return
      }
      var url = Jmap.uploadUrl(Jmap.uploadTemplate(root.session), root.accountId)
      if (url === "") {
        root.releaseUploadSlot()
        root.hand(callback, "", "Sign in to this mailbox again")
        return
      }
      if (!root.auth) {
        root.releaseUploadSlot()
        root.hand(callback, "", "Sign in to this mailbox first")
        return
      }
      root.auth.withCredentials(function(credential, error) {
        if (!root) return
        if (owner.aborted) {
          root.releaseUploadSlot()
          return
        }
        if (error || !credential) {
          root.releaseUploadSlot()
          root.hand(callback, "", error || "Sign in to this mailbox first")
          return
        }
        root.request("upload", url, credential, message, owner, function(reply) {
          if (!root) return
          root.releaseUploadSlot()
          if (owner.aborted) return
          // RFC 8620 answers an upload with 201; a server that says 200 has
          // still taken it, and the blob id is what either answer is read for.
          if (reply.exit !== 0 || (reply.status !== 200 && reply.status !== 201)) {
            root.hand(callback, "",
              Jmap.transportError(reply.exit, reply.status, reply.body, reply.stderr, ""))
            return
          }
          var blobId = Jmap.uploadedBlobId(reply.body)
          if (blobId === "") {
            root.hand(callback, "", "The server sent an answer this client could not read")
            return
          }
          root.hand(callback, blobId, "")
        })
      })
    }

    owner.queueEntry = entry
    if (uploads().admit(entry)) entry.start()
    return owner
  }

  // One upload and one API request. The callback is `({}, "")` on success and
  // `(null, <sentence>)` otherwise, which is the contract the other three
  // clients keep, so the account's "Sent" notice needs no branch for this
  // provider.
  function sendMessage(payload, callback) {
    var handle = newHandle()
    var raw = payload && payload.raw ? String(payload.raw) : ""
    if (raw === "") {
      hand(callback, null, "There is nothing to send")
      return handle
    }
    var draftId = payload ? String(payload.draftId || "") : ""

    // The role map is what Sent and Drafts mean on this account, so a send
    // gates on the mailbox list exactly as a query does.
    ensureMailboxes(function(error) {
      if (!root || handle.aborted) return
      if (error) {
        root.hand(callback, null, error)
        return
      }
      // Before any request: a message the server would refuse for size, and an
      // account with nowhere to put the copy. The size is arithmetic on the
      // base64, not a second decode of the whole message.
      var refusal = Jmap.sendGuard(root.session, root.roles, Jmap.base64ByteLength(raw))
      if (refusal !== "") {
        root.hand(callback, null, refusal)
        return
      }
      root.ensureIdentities(function(identityError) {
        if (!root || handle.aborted) return
        if (identityError) {
          root.hand(callback, null, identityError)
          return
        }
        var message = Mail.decodeBase64Url(raw)
        // The From this message was actually written with, read off the
        // header block rather than by parsing the whole message: an
        // attachment is megabytes and the address is in the first few
        // hundred bytes.
        var identityId = Jmap.identityFor(root.sendAsIdentities,
          Jmap.messageHeader(message, "From"))
        root.uploadMessage(message, handle, function(blobId, uploadError) {
          if (!root || handle.aborted) return
          if (uploadError) {
            root.hand(callback, null, uploadError)
            return
          }
          root.submitMessage(blobId, identityId, draftId, handle, callback)
        })
      })
    })
    return handle
  }

  // Import, submit and destroy the stale draft, in one request under the
  // submission capability.
  function submitMessage(blobId, identityId, draftId, handle, callback) {
    var child = call(Jmap.sendRequest(accountId, blobId, identityId, roles, draftId), null,
      function(responses, failure) {
        if (!root || handle.aborted) return
        // The import is read first, even when the call reported an error. A
        // submission naming a creation id that was never created comes back as
        // a *method* error about an unresolved reference, and reporting that
        // would tell the user the server had a problem rather than that it
        // could not read the message.
        var imported = Jmap.responseArguments(responses, "Email/import")
        var refusedImport = Jmap.notCreatedEntry(imported, Jmap.CREATE_EMAIL)
        if (refusedImport) {
          root.hand(callback, null, Jmap.submissionError(refusedImport))
          return
        }
        if (failure) {
          root.hand(callback, null, failure)
          return
        }
        var refusedSend = Jmap.notCreatedEntry(
          Jmap.responseArguments(responses, "EmailSubmission/set"), Jmap.CREATE_SUBMISSION)
        if (!refusedSend) {
          root.hand(callback, {}, "")
          return
        }
        // A refused submission leaves its import standing and nothing else
        // will remove it: left there it is a duplicate draft on the next
        // refresh. The compose window still holds the text through its own
        // recovery path, so this destroys the copy rather than the message.
        root.discardImport(Jmap.createdId(imported, Jmap.CREATE_EMAIL))
        root.hand(callback, null, Jmap.submissionError(refusedSend))
      }, Jmap.USING_SUBMISSION)
    handle.children.push(child)
  }

  // Deliberately not a child of the send's handle. It is the cleanup after a
  // failure the caller has already been told about, and aborting the send —
  // which is what closing the compose window does — would leave the copy it
  // exists to remove.
  function discardImport(emailId) {
    if (String(emailId || "") === "") return
    call(Jmap.destroyRequest(accountId, [emailId]), null, function() {})
  }

  // The same upload and one request: import the new copy, destroy the old.
  //
  // An Email is immutable apart from its keywords and its mailboxes, so a
  // saved draft is always a new id — as it is on IMAP, where the save is an
  // APPEND and a delete. The callback is `({ saved, draftId, warning }, "")`;
  // an old copy that would not go is the warning, because the draft was saved
  // either way.
  function saveDraft(payload, callback) {
    var handle = newHandle()
    var raw = payload && payload.raw ? String(payload.raw) : ""
    if (raw === "") {
      hand(callback, null, "There is no draft to save")
      return handle
    }
    var draftId = payload ? String(payload.draftId || "") : ""

    ensureMailboxes(function(error) {
      if (!root || handle.aborted) return
      if (error) {
        root.hand(callback, null, error)
        return
      }
      var refusal = Jmap.saveGuard(root.session, root.roles, Jmap.base64ByteLength(raw))
      if (refusal !== "") {
        root.hand(callback, null, refusal)
        return
      }
      root.uploadMessage(Mail.decodeBase64Url(raw), handle, function(blobId, uploadError) {
        if (!root || handle.aborted) return
        if (uploadError) {
          root.hand(callback, null, uploadError)
          return
        }
        var child = root.call(Jmap.saveRequest(root.accountId, blobId, root.roles, draftId),
          null, function(responses, failure) {
            if (!root || handle.aborted) return
            var imported = Jmap.responseArguments(responses, "Email/import")
            var refused = Jmap.notCreatedEntry(imported, Jmap.CREATE_EMAIL)
            if (refused) {
              root.hand(callback, null,
                Jmap.submissionError(refused, "The draft could not be saved"))
              return
            }
            if (failure) {
              root.hand(callback, null, failure)
              return
            }
            var result = Jmap.draftSaveResult(Jmap.responseArguments(responses, "Email/set"))
            // The id the compose window would reopen on, and the one a second
            // save destroys. A draft that was never on the server before has
            // no old copy to remove and the same answer either way.
            result.draftId = Jmap.createdId(imported, Jmap.CREATE_EMAIL)
            root.hand(callback, result, "")
          })
        handle.children.push(child)
      })
    })
    return handle
  }

  // One process per request, created and destroyed around it. The cost of
  // starting one is well under the cost of the TLS handshake it wraps, and a
  // pool would have to be drained on every abort.
  Component {
    id: transportComponent

    Process {
      id: transportProcess

      property string requestLine: ""
      // Whether this verb's answer is bytes rather than text. A blob is the one
      // that is: decoding it here would run 20 MB through `bytesToUtf8` in the
      // process that draws the desktop, and — worse — would not survive it,
      // because a byte sequence that is not valid UTF-8 does not come back out
      // of a JavaScript string the way it went in. It stays base64 all the way
      // to the caller, which is the alphabet every consumer of an attachment
      // already reads.
      property bool binaryBody: false
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
          transportProcess.binaryBody ? String(lines[2] || "")
            : Mail.bytesToUtf8(Mail.base64ToBytes(lines[2])),
          Mail.bytesToUtf8(Mail.base64ToBytes(lines[3])))
      }
    }
  }

  // One stream for this account, built here because the client is what knows
  // the session, the credential and the states already seen — and kept out of
  // this file because a connection held open for an hour has a lifecycle, and
  // nothing else here does.
  JmapPush {
    id: push

    client: root
    onRemoteChanged: function(plan) { root.remoteChanged(plan) }
    // The same flag a 401 on any request raises, from the one place a stream
    // can learn it. A successful `verifyCredentials` clears it, and clearing it
    // is what lets the stream start again.
    onSecretRejected: root.credentialsRejected = true
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
