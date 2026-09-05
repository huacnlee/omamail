import QtQuick
import Quickshell
import Quickshell.Io

import "JmapProtocol.js" as Jmap
import "../message/Message.js" as Mail

// A JMAP mailbox, wearing the same interface `GmailApiClient` wears.
//
// The transport is `scripts/jmap-transport.sh`, which is curl. The protocol is
// `JmapProtocol.js`. This file is the part in between: which requests a given
// job becomes, in what order, and what to do when one of them fails.
//
// It signs the account in — discovery, the session GET under each scheme in
// turn, the four-step check — and it reads: the rail, the labels, the list, a
// page, a search and the counts. The reader, the actions, the push and the
// send are stubs the following tickets fill, and each answers an empty result
// rather than pretending to fail.
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
  // (ticket 09) is the only reader: a change notification naming a state this
  // client has already been told is the echo of its own write.
  property var knownStates: ({})

  function newHandle() {
    return { aborted: false, process: null, children: [], queueEntry: null }
  }

  function abortRequest(handle) {
    if (!handle) return
    handle.aborted = true
    // A request still waiting for a slot has no process to stop and must not
    // take one: withdrawing it is what stops an abandoned page from holding the
    // queue open behind the page that replaced it.
    if (handle.queueEntry && callQueue) {
      if (callQueue.withdraw(handle.queueEntry)) handle.queueEntry = null
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
    mailboxList = []
    mailboxesLoaded = false
    knownStates = ({})
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
    function onSettingsChanged() {
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
  function call(methodCalls, handle, callback) {
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
        var body = JSON.stringify({ using: Jmap.USING_MAIL, methodCalls: methodCalls })
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
  // `threadIds` is empty: the query runs uncollapsed here and a row is a
  // message, which ticket 11 changes. `progress` goes unused because one POST
  // answers the whole page — there is no partial result to paint early, the way
  // IMAP's windowed search has.
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
      root.runQuery(filter, maxResults, pageToken, false, handle, callback)
    })
    return handle
  }

  function runQuery(filter, maxResults, token, byPosition, handle, callback) {
    var child = call([["Email/query",
      Jmap.emailQuery(root.accountId, filter, maxResults, token, byPosition), "0"]],
      null, function(responses, error, type) {
        if (!root || handle.aborted) return
        // The anchor moved or was deleted between pages — the one thing anchor
        // paging cannot survive, and the reason the token carries a position
        // beside it. One retry, by position, and never a second: a page that
        // cannot be found twice is a result that is changing faster than it can
        // be read.
        if (type === "anchorNotFound" && byPosition !== true) {
          root.runQuery(filter, maxResults, token, true, handle, callback)
          return
        }
        if (error) {
          root.hand(callback, null, error)
          return
        }
        root.hand(callback,
          Jmap.queryPage(Jmap.responseArguments(responses, "Email/query"), maxResults), "")
      })
    handle.children.push(child)
  }

  // The rows behind those ids, in the order they were asked for.
  //
  // `full` is ignored here: a full read is `bodyStructure` and body values, and
  // it belongs to the ticket that builds the reader. Every row goes through the
  // same composer, so a list row and a preview row are the same shape.
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
          var child = root.call([["Email/get", {
            accountId: root.accountId,
            ids: chunk,
            properties: Jmap.LIST_PROPERTIES
          }, "0"]], null, function(responses, failure) {
            if (!root || handle.aborted) return
            if (failure && firstError === "") firstError = failure
            var args = Jmap.responseArguments(responses, "Email/get")
            var list = args && Array.isArray(args.list) ? args.list : []
            var painted = []
            for (var j = 0; j < list.length; j++) {
              var message = Jmap.toMessage(list[j], root.roles)
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

  function getMessage(id, full, callback) {
    return answer(callback, null)
  }

  function getAttachment(messageId, attachmentId, callback) {
    return answer(callback, null)
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

  // ------------------------------------------------------------- to follow
  //
  // The rest of the interface, answering the empty result rather than an
  // error: an account that has just signed in has a working session and
  // nothing written yet, and "this failed" is not what that is. Each of these
  // is filled in by the ticket that owns it — the reader, the actions, the
  // send — and none of them is a button the panel draws until it is.

  function answer(callback, value) {
    if (typeof callback !== "function") return newHandle()
    Qt.callLater(function() {
      if (!root) return
      callback(value, "")
    })
    return newHandle()
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
