import QtQuick
import Quickshell
import Quickshell.Io

import "ImapProtocol.js" as Imap
import "Outlook.js" as Outlook
import "MicrosoftOAuth.js" as Microsoft
import "Credentials.js" as Credentials
import "Secrets.js" as Secrets

// Microsoft sign-in for the Outlook provider. The refresh token lives in
// GNOME Keyring; native backend clients handle OAuth, IMAP and SMTP networking.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir
  property var backend: null
  property string accountId: ""
  property string configuredClientId: ""
  readonly property string clientId: Microsoft.effectiveClientId(configuredClientId)
  property string configuredEmail: ""
  // The account entry's server settings. Outlook's servers are fixed by
  // `Outlook.settings` whatever these say; only two readings are taken from
  // them — the tenant the sign-in is addressed to, which `normalizeTenant`
  // keeps to one path segment of Microsoft's own URL, and whether the mailbox
  // sends through Graph, a mode with one fixed address of its own.
  property var entrySettings: null
  readonly property string tenant: Microsoft.normalizeTenant(entrySettings ? entrySettings.tenant : "")
  readonly property string configuredSend: entrySettings ? String(entrySettings.send || "") : ""
  // Microsoft grants this token for its own mail service. Persisted generic
  // IMAP settings must never select its destination or disable transport TLS.
  readonly property var settings: Outlook.settings(configuredEmail, tenant, configuredSend)
  property var scopes: Microsoft.SCOPES
  // What the code on screen is for: the mail sign-in, or the second one
  // that allows Microsoft Graph. A Graph exchange refused for want of consent
  // sets `graphConsentNeeded`, and the next sign-in is the Graph one —
  // offered on the setup page while the mail session stands. The Graph
  // sign-in that follows a mail sign-in, for a tenant that sends through
  // Graph, holds `loginSucceeded` until it is answered.
  property string devicePurpose: "mail"
  property bool graphConsentNeeded: false
  property bool graphRoundOfSignIn: false
  // A Graph sign-in asked for from the setup page, on a mailbox that is
  // signed in and stays so: not `loginBusy`, which would take the mailbox
  // out of service for the code's duration.
  property bool graphRoundBusy: false
  // Bumped when such a round is cut short, so its answers arriving after
  // are let go of without touching anything of the mail session's; and
  // counted grants, so a refusal answered after a grant does not undo it.
  property int graphRoundSerial: 0
  property int graphGrants: 0
  // The mail session's account, by tenant and object id, from the id
  // token that came with its token: what the Graph sign-in is held to.
  property string accountKey: ""

  readonly property string authMode: "oauth2"
  readonly property bool configured: Imap.validateSettings(settings).ok
  readonly property bool credentialsPresent: configured && Microsoft.isValidClientId(clientId)

  property string accessToken: ""
  property double accessTokenExpiresAt: 0
  property bool loggedIn: false
  property bool sessionChecked: false
  property bool savedSessionPresent: false
  readonly property bool recoveringSession: savedSessionPresent && !loggedIn
  property bool loginBusy: false
  property bool refreshBusy: false
  readonly property bool sessionBusy: !!lookupProcess || refreshBusy || restoreQueued
  property string lastError: ""

  readonly property var requiredTools: ["secret-tool", "xdg-open"]
  property var missingTools: []
  property bool toolsChecked: false
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0

  property var tokenWaiters: []
  property int sessionGeneration: 0
  property bool sessionEnabled: true
  property var lookupProcess: null
  property bool restoreQueued: false
  property var keyringJobs: []
  property var keyringJob: null
  property int refreshRetryAttempt: 0

  property string deviceCode: ""
  property string userCode: ""
  property string verificationUri: ""
  property double deviceExpiresAt: 0
  property int devicePollIntervalMs: 5000
  property string pendingAccessToken: ""
  property string pendingRefreshToken: ""
  property double pendingExpiresIn: 0
  property string pendingIdToken: ""

  // The requests in flight, each answered on its own: a refresh and a Graph
  // exchange may overlap, and neither's answer is dropped for the other's.
  // `cancelLogin` lets go of them all, and an answer let go of is not
  // delivered.
  property var tokenRequests: []
  property int tokenRequestCount: 0
  readonly property int tokenTimeoutMs: 30000

  signal loginSucceeded()
  // A Graph sign-in that did not go through, with what to do about it: for
  // the setup page, since the mailbox itself is signed in and `lastError`
  // is the mailbox's.
  signal graphRefused(string reason)
  signal loggedOut()
  signal sessionUnavailable(string reason)
  signal credentialsSaved()
  signal verifyRequested(var settings, string credentials)

  function sessionContext() {
    return { generation: sessionGeneration, accountId: accountId, clientId: clientId }
  }

  function isCurrent(context) {
    return !!context && context.generation === sessionGeneration
      && context.accountId === accountId && context.clientId === clientId
  }

  function safeError(value) {
    return Microsoft.redact(String(value || ""))
  }

  function tokenIsFresh() {
    return accessToken !== "" && Date.now() + 60000 < accessTokenExpiresAt
  }

  function resetMemorySession() {
    accessToken = ""
    accessTokenExpiresAt = 0
    loggedIn = false
    graphAccessToken = ""
    graphAccessTokenExpiresAt = 0
    graphConsentNeeded = false
    accountKey = ""
    // A mailbox no longer signed in has no Graph code to finish.
    cancelGraphRound()
  }

  // ------------------------------------------------------------- Graph

  // A token of Graph's audience, for a tenant that sends through Graph. The
  // refresh token in the keyring is exchanged for it the same way the mail
  // token is refreshed, with Graph's scope in place of IMAP's; nothing new is
  // signed in to, and a rotated refresh token is stored back as before.
  property string graphAccessToken: ""
  property double graphAccessTokenExpiresAt: 0
  property var graphWaiters: []
  property var graphLookupProcess: null
  property bool graphQueued: false
  property bool graphProbeQueued: false

  function graphTokenIsFresh() {
    return graphAccessToken !== "" && Date.now() < graphAccessTokenExpiresAt - 60000
  }

  function finishGraphWaiters(token, error) {
    var waiting = graphWaiters
    graphWaiters = []
    for (var i = 0; i < waiting.length; i++) {
      waiting[i](sessionEnabled ? token : "", sessionEnabled ? error : "Signed out")
    }
  }

  function withGraphToken(callback) {
    if (typeof callback !== "function") return
    if (!sessionEnabled) {
      callback("", "Signed out")
      return
    }
    if (graphTokenIsFresh()) {
      callback(graphAccessToken, "")
      return
    }
    if (!credentialsPresent) {
      callback("", "Add this Outlook mailbox and its OAuth client first")
      return
    }
    var next = graphWaiters.slice()
    next.push(callback)
    graphWaiters = next
    if (graphLookupProcess || loginBusy || graphRoundBusy) return
    startGraphLookup()
  }

  function startGraphLookup() {
    if (graphLookupProcess || graphWaiters.length === 0) return
    // Behind a sign-in, the waiters are answered by whatever ends it.
    if (loginBusy || graphRoundBusy) return
    if (keyringJob || keyringJobs.length > 0) {
      graphQueued = true
      return
    }
    graphQueued = false
    if (backend && accountId) {
      handleGraphLookup("", sessionContext())
      return
    }
    var context = sessionContext()
    var attributes = Credentials.outlookKeyringAttributes(clientId, accountId)
    if (attributes.length === 0) {
      handleGraphLookup("", context)
      return
    }
    var process = lookupComponent.createObject(root, {
      context: context,
      purpose: "graph",
      command: ["secret-tool", "lookup"].concat(attributes)
    })
    if (!process) {
      handleGraphLookup("", context)
      return
    }
    graphLookupProcess = process
    process.running = true
  }

  function handleGraphLookup(raw, context) {
    if (!isCurrent(context) || !sessionEnabled) {
      // A lookup from before a cancel, exiting now: waiters queued behind
      // it since are asked for again, or nothing would.
      if (sessionEnabled && graphWaiters.length > 0) Qt.callLater(root.startGraphLookup)
      return
    }
    var grants = graphGrants
    var refreshToken = String(raw || "")
    if (refreshToken === "" && !(backend && accountId)) {
      finishGraphWaiters("", "Sign in to Outlook first")
      return
    }
    if (backend && accountId) refreshToken = ""
    postForm(Microsoft.tokenUrlFor(tenant),
      Microsoft.graphRefreshBody(clientId, refreshToken),
      function(status, text) {
        if (!root.isCurrent(context) || !root.sessionEnabled) return
        // A Graph sign-in went through while this was out: its answer is
        // the newer one, and this refusal or grant is of a token since
        // replaced.
        if (grants !== root.graphGrants && root.graphTokenIsFresh()) {
          root.finishGraphWaiters(root.graphAccessToken, "")
          return
        }
        var result = Microsoft.parseTokenResponse(status, text, refreshToken)
        refreshToken = ""
        if (!result.ok) {
          // For want of consent is the one refusal a sign-in mends; the
          // setup page offers it while this is set.
          if (result.consentRequired) root.graphConsentNeeded = true
          // A dead session is Microsoft's own words for it, not a missing
          // permission.
          root.finishGraphWaiters("", root.safeError(result.consentRequired
            ? Microsoft.graphConsentMessage() : result.error))
          return
        }
        if (Microsoft.missingGraphScope(result.scope)) {
          // Issued without the permission: what a Graph sign-in collects.
          // The refresh token it came with is the live one, whatever else.
          if (result.refreshToken) root.storeRefreshToken(result.refreshToken)
          root.graphConsentNeeded = true
          root.finishGraphWaiters("", Microsoft.graphConsentMessage())
          return
        }
        root.acceptGraphToken(result)
      })
  }

  function acceptGraphToken(result) {
    graphGrants++
    graphConsentNeeded = false
    graphAccessToken = result.accessToken
    graphAccessTokenExpiresAt = Date.now() + result.expiresIn * 1000
    if (result.refreshToken) storeRefreshToken(result.refreshToken)
    finishGraphWaiters(graphAccessToken, "")
  }

  // Whether this client is consented for Graph is found out with the
  // refresh token in hand, straight after the mail sign-in of a tenant that
  // sends through Graph, and mended by a second code where it is not —
  // rather than at the first send. Any other refusal is sending's to
  // report: the mailbox is signed in.
  function probeGraphConsent(refreshToken) {
    if (backend && (keyringJob || keyringJobs.length > 0)) { graphProbeQueued = true; return }
    var context = sessionContext()
    if (backend && accountId) refreshToken = ""
    postForm(Microsoft.tokenUrlFor(tenant),
      Microsoft.graphRefreshBody(clientId, refreshToken),
      function(status, text) {
        if (!root.isCurrent(context) || !root.sessionEnabled) return
        var result = Microsoft.parseTokenResponse(status, text, refreshToken)
        refreshToken = ""
        // Refused for want of consent, or issued without the permission:
        // either is what the second code collects.
        if ((!result.ok && result.consentRequired) || (result.ok && Microsoft.missingGraphScope(result.scope))) {
          if (result.ok && result.refreshToken) root.storeRefreshToken(result.refreshToken)
          root.graphConsentNeeded = true
          root.graphRoundOfSignIn = true
          root.startDeviceFlow("graph")
          return
        }
        if (result.ok) {
          root.acceptGraphToken(result)
        } else {
          var message = "Microsoft Graph could not be checked: " + root.safeError(result.error) + ". Sending will ask again"
          root.finishGraphWaiters("", message)
          root.graphRefused(message)
        }
        root.graphRoundOfSignIn = false
        root.loginBusy = false
        root.loginSucceeded()
      })
  }

  // The Graph sign-in answered: a token of Graph's audience, and a refresh
  // token consented for both resources, kept in place of the mail one —
  // the same user's and client's, and exchangeable for either.
  function acceptGraphSignIn(result) {
    // The mail sign-in is verified by logging in to the mailbox with its
    // token; this one by the name on its id token, since a code entered
    // as someone else would file that someone's token as the mailbox's.
    if (!Microsoft.sameAccount(result.idToken, configuredEmail, accountKey)) {
      failGraphRound(Microsoft.otherAccountMessage(Microsoft.signedInAs(result.idToken), configuredEmail))
      return
    }
    if (Microsoft.missingGraphScope(result.scope)) {
      // Issued to the right account without the permission: its refresh
      // token is the live one all the same.
      if (result.refreshToken) storeRefreshToken(result.refreshToken)
      failGraphRound(Microsoft.graphScopeMessage())
      return
    }
    cancelDeviceLogin()
    loginBusy = false
    graphRoundBusy = false
    lastError = ""
    acceptGraphToken(result)
    var afterSignIn = graphRoundOfSignIn
    graphRoundOfSignIn = false
    if (afterSignIn) loginSucceeded()
  }

  // The Graph sign-in failing leaves the mail one as it was: the account is
  // not told its session is gone, only what Graph will say when asked.
  function failGraphRound(reason) {
    var message = Microsoft.graphRefusedMessage(safeError(reason || "Microsoft sign-in failed"))
    loginBusy = false
    graphRoundBusy = false
    cancelDeviceLogin()
    finishGraphWaiters("", message)
    graphRefused(message)
    var afterSignIn = graphRoundOfSignIn
    graphRoundOfSignIn = false
    if (afterSignIn) loginSucceeded()
  }

  function invalidateAccessToken() {
    if (backend && accountId) backend.call("auth.invalidate", { accountId: accountId }, function() {})
    accessToken = ""
    accessTokenExpiresAt = 0
  }

  function finishWaiters(token, error) {
    var context = sessionContext()
    var pending = tokenWaiters.slice()
    tokenWaiters = []
    for (var i = 0; i < pending.length; i++) {
      // A consumer can synchronously sign out or switch accounts. Remaining
      // callbacks still belong to the session captured above.
      var current = isCurrent(context) && sessionEnabled
      try { pending[i](current ? (token || "") : "",
        current ? safeError(error) : "Session changed") }
      catch (e) { /* consumers own their callback errors */ }
    }
  }

  function withCredentials(callback) {
    if (typeof callback !== "function") return
    if (!sessionEnabled) {
      callback("", "Signed out")
      return
    }
    if (tokenIsFresh()) {
      callback(accessToken, "")
      return
    }
    if (!credentialsPresent) {
      callback("", "Add this Outlook mailbox and its OAuth client first")
      return
    }
    var next = tokenWaiters.slice()
    next.push(callback)
    tokenWaiters = next
    if (refreshBusy || lookupProcess || loginBusy) return
    startSecretLookup()
  }

  function restoreSession() {
    if (!sessionEnabled || loginBusy) return
    sessionChecked = false
    if (!credentialsPresent || accountId === "") {
      savedSessionPresent = false
      sessionChecked = true
      resetMemorySession()
      return
    }
    if (lookupProcess || refreshBusy) return
    startSecretLookup()
  }

  function startSecretLookup() {
    // A preceding store/clear must finish before a lookup can observe the key.
    if (keyringJob || keyringJobs.length > 0) {
      restoreQueued = true
      return
    }
    restoreQueued = false
    if (backend && accountId) {
      savedSessionPresent = true
      refreshWithToken("", sessionContext())
      return
    }
    var context = sessionContext()
    var attributes = Credentials.outlookKeyringAttributes(clientId, accountId)
    if (attributes.length === 0) {
      handleSecretLookup("", context)
      return
    }
    var process = lookupComponent.createObject(root, {
      context: context,
      command: ["secret-tool", "lookup"].concat(attributes)
    })
    if (!process) {
      handleSecretLookup("", context)
      return
    }
    lookupProcess = process
    process.running = true
  }

  function handleSecretLookup(raw, context) {
    if (!isCurrent(context) || !sessionEnabled) return
    var token = String(raw || "")
    if (token === "") {
      savedSessionPresent = false
      resetMemorySession()
      sessionChecked = true
      finishWaiters("", "Sign in to Outlook first")
      return
    }
    savedSessionPresent = true
    refreshWithToken(token, context)
  }

  function storeRefreshToken(token) {
    var attributes = Credentials.outlookKeyringAttributes(clientId, accountId)
    if (!token || attributes.length === 0) return
    enqueueKeyringJob("store", attributes, String(token))
  }

  function clearStoredToken() {
    var attributes = Credentials.outlookKeyringAttributes(clientId, accountId)
    if (attributes.length === 0) return
    enqueueKeyringJob("clear", attributes, "")
  }

  // Jobs own immutable destinations. Serialize them so logout's clear cannot
  // race a preceding store, even when the account host is reused meanwhile.
  function enqueueKeyringJob(kind, attributes, token) {
    var next = keyringJobs.slice()
    next.push({ kind: kind, attributes: attributes.slice(), token: token,
      context: sessionContext() })
    keyringJobs = next
    runKeyringJob()
  }

  function runKeyringJob() {
    if (keyringJob) return
    if (keyringJobs.length === 0) {
      if (restoreQueued) Qt.callLater(root.restoreSession)
      if (graphQueued) Qt.callLater(root.startGraphLookup)
      if (graphProbeQueued) { graphProbeQueued = false; Qt.callLater(function() { root.probeGraphConsent("") }) }
      return
    }
    var next = keyringJobs.slice()
    keyringJob = next.shift()
    keyringJobs = next
    if (backend && keyringJob.context.accountId) {
      var job = keyringJob
      backend.call(job.kind === "store" ? "auth.store" : "auth.clear", {
        accountId: job.context.accountId, clientId: job.context.clientId,
        token: job.kind === "store" ? job.token : ""
      }, function(result, error) {
        if (root.keyringJob !== job) return
        root.keyringJob = null
        if (error && root.isCurrent(job.context)) root.lastError = "Could not update the saved Microsoft session"
        root.runKeyringJob()
      })
      job.token = ""
      return
    }
    keyringProcess.command = keyringJob.kind === "store"
      ? [pluginDir + "/scripts/keyring-store.sh"].concat(keyringJob.attributes)
      : ["secret-tool", "clear"].concat(keyringJob.attributes)
    keyringProcess.running = true
  }

  function postForm(url, body, callback) {
    var id = ++tokenRequestCount
    var request = { abort: function() {
      var kept = []
      for (var i = 0; i < root.tokenRequests.length; i++) {
        if (root.tokenRequests[i].id !== id) kept.push(root.tokenRequests[i])
      }
      root.tokenRequests = kept
    } }
    tokenRequests = tokenRequests.concat([{ id: id, request: request }])
    function finish(result, error) {
      var live = false
      for (var i = 0; i < root.tokenRequests.length; i++) {
        if (root.tokenRequests[i].id === id) live = true
      }
      if (!live) return
      request.abort()
      callback(error ? 0 : result.status, error ? "" : result.body)
    }
    if (!backend || !backend.ready) { finish(null, true); return }
    var endpoint = url === Microsoft.deviceUrlFor(tenant) ? "device" : "token"
    if (url !== Microsoft.deviceUrlFor(tenant) && url !== Microsoft.tokenUrlFor(tenant)) {
      finish(null, true)
      return
    }
    if (endpoint === "token" && body.indexOf("grant_type=refresh_token") >= 0 && accountId) {
      backend.call("auth.token", { provider: "outlook", accountId: accountId,
        resource: body.indexOf("graph.microsoft.com") >= 0 ? "graph" : "mail" }, function(result, error) {
        var code = error === "auth_signed_out" ? "invalid_grant" : "temporarily_unavailable"
        var failure = error === "auth_consent_required"
          ? { error: "interaction_required", error_codes: [65001] } : { error: code }
        finish({ status: error ? 400 : 200, body: JSON.stringify(error ? failure : result) }, "")
      })
      return
    }
    backend.call("auth.form", { provider: "outlook", endpoint: endpoint,
      tenant: tenant, body: body }, finish)
  }

  function refreshWithToken(refreshToken, context) {
    if (backend && accountId) refreshToken = ""
    refreshBusy = true
    // The mail scopes alone: a token is for one resource, and Microsoft
    // refuses a refresh that names two. The Graph exchange asks for its own.
    postForm(Microsoft.tokenUrlFor(tenant),
      Microsoft.refreshTokenBody(clientId, refreshToken, Microsoft.SCOPES),
      function(status, text) {
        if (!root.isCurrent(context) || !root.sessionEnabled) return
        var result = Microsoft.parseTokenResponse(status, text, refreshToken)
        refreshToken = ""
        root.refreshBusy = false
        root.sessionChecked = true
        if (!result.ok) {
          root.resetMemorySession()
          root.lastError = root.safeError(result.error)
          if (Microsoft.refreshFailureDisposition(result) === "signed_out") {
            root.savedSessionPresent = false
            refreshRetry.stop()
            root.clearStoredToken()
          } else {
            root.scheduleRefreshRetry()
          }
          root.finishWaiters("", root.lastError)
          root.sessionUnavailable(root.lastError)
          return
        }
        root.acceptToken(result)
        root.finishWaiters(root.accessToken, "")
      })
  }

  function acceptToken(result) {
    var key = Microsoft.accountKey(result.idToken)
    if (key !== "") accountKey = key
    accessToken = result.accessToken
    accessTokenExpiresAt = Date.now() + result.expiresIn * 1000
    loggedIn = true
    savedSessionPresent = true
    refreshRetryAttempt = 0
    refreshRetry.stop()
    lastError = ""
    if (result.refreshToken) storeRefreshToken(result.refreshToken)
  }

  function scheduleRefreshRetry() {
    if (!savedSessionPresent || refreshRetry.running) return
    refreshRetry.interval = Microsoft.refreshRetryDelay(refreshRetryAttempt)
    refreshRetryAttempt++
    refreshRetry.start()
  }

  function beginLogin() {
    if (loginBusy || graphRoundBusy || refreshBusy) return
    if (!credentialsPresent) {
      lastError = "Add the mailbox address and Microsoft OAuth client ID first"
      return
    }
    if (!toolsPresent && toolsChecked) {
      lastError = "Missing " + missingTools.join(", ")
      return
    }
    // Signed in for mail and refused Graph for want of consent: the code
    // asked for is Graph's, and the mail session stands. A saved session
    // not restored yet signs in for mail first, whatever Graph said.
    var forGraph = graphConsentNeeded && loggedIn
    if (forGraph) {
      // The mailbox stays in service: nothing of the mail session is let
      // go of, and only Graph's code is busy.
      lastError = ""
      graphRoundOfSignIn = false
      graphRoundBusy = true
      startDeviceFlow("graph")
      return
    }
    cancelLogin()
    sessionEnabled = true
    lastError = ""
    loginBusy = true
    startDeviceFlow("mail")
  }

  // One device-code round: the code and the page to enter it on, then the
  // poll until Microsoft answers with a token or a refusal.
  function startDeviceFlow(purpose) {
    var context = sessionContext()
    var round = graphRoundSerial
    devicePurpose = purpose
    postForm(Microsoft.deviceUrlFor(tenant),
      Microsoft.deviceAuthorizationBody(clientId,
        purpose === "graph" ? Microsoft.GRAPH_SIGN_IN_SCOPES : scopes),
      function(status, text) {
        if (!root.isCurrent(context) || round !== root.graphRoundSerial) return
        var result = Microsoft.parseDeviceResponse(status, text)
        if (!result.ok) {
          root.failLogin(result.error)
          return
        }
        root.deviceCode = result.deviceCode
        root.userCode = result.userCode
        root.verificationUri = result.verificationUri
        root.deviceExpiresAt = Date.now() + result.expiresIn * 1000
        root.devicePollIntervalMs = result.interval * 1000
        Quickshell.execDetached(["xdg-open", root.verificationUri])
        devicePoll.interval = root.devicePollIntervalMs
        devicePoll.start()
      })
  }

  function pollDeviceCode() {
    if (!(loginBusy || graphRoundBusy) || deviceCode === "") return
    if (Date.now() >= deviceExpiresAt) {
      failLogin("The Microsoft sign-in code expired. Please try again")
      return
    }
    var context = sessionContext()
    var round = graphRoundSerial
    postForm(Microsoft.tokenUrlFor(tenant),
      Microsoft.deviceTokenBody(clientId, deviceCode),
      function(status, text) {
        if (!root.isCurrent(context) || round !== root.graphRoundSerial) return
        var result = Microsoft.parseTokenResponse(status, text, "")
        if (result.pending) {
          if (result.slowDown) root.devicePollIntervalMs += 5000
          devicePoll.interval = root.devicePollIntervalMs
          devicePoll.start()
          return
        }
        if (!result.ok) {
          root.failLogin(result.error)
          return
        }
        if (root.devicePurpose === "graph") {
          root.acceptGraphSignIn(result)
          return
        }
        var missing = Microsoft.missingMailScopes(result.scope)
        if (missing.length > 0) {
          root.failLogin(Microsoft.missingScopeMessage(missing))
          return
        }
        if (!result.refreshToken) {
          root.failLogin("Microsoft sign-in did not grant offline access. Check the app registration and sign in again")
          return
        }
        root.pendingAccessToken = result.accessToken
        root.pendingRefreshToken = result.refreshToken
        root.pendingExpiresIn = result.expiresIn
        root.pendingIdToken = result.idToken
        // The code has been entered: what the page shows from here is the
        // mailbox being verified, or Graph's own code.
        root.deviceCode = ""
        root.userCode = ""
        root.verificationUri = ""
        root.verifyRequested(root.settings, root.pendingAccessToken)
      })
  }

  function completeSignIn(ok, error, generation) {
    if (generation !== sessionGeneration || !loginBusy || pendingAccessToken === "") return
    if (!ok) {
      clearPendingToken()
      failLogin(error || "Outlook rejected this mailbox sign-in")
      return
    }
    var result = ({
      accessToken: pendingAccessToken,
      refreshToken: pendingRefreshToken,
      expiresIn: pendingExpiresIn,
      idToken: pendingIdToken
    })
    clearPendingToken()
    sessionChecked = true
    acceptToken(result)
    finishWaiters(accessToken, "")
    if (configuredSend === "graph") {
      // The sign-in's tail is Graph's from here: cut short, the mail half
      // is in and is said so.
      graphRoundOfSignIn = true
      probeGraphConsent(result.refreshToken)
      return
    }
    loginBusy = false
    loginSucceeded()
    if (graphWaiters.length > 0) startGraphLookup()
  }

  function clearPendingToken() {
    pendingAccessToken = ""
    pendingRefreshToken = ""
    pendingExpiresIn = 0
    pendingIdToken = ""
  }

  function cancelDeviceLogin() {
    devicePoll.stop()
    deviceCode = ""
    userCode = ""
    verificationUri = ""
    deviceExpiresAt = 0
    devicePurpose = "mail"
    clearPendingToken()
  }

  function failLogin(reason) {
    if (devicePurpose === "graph") {
      failGraphRound(reason)
      return
    }
    lastError = safeError(reason || "Microsoft sign-in failed. Please try again")
    loginBusy = false
    cancelDeviceLogin()
    finishWaiters("", lastError)
    // Graph's waiters were parked behind this sign-in.
    finishGraphWaiters("", lastError)
    sessionUnavailable(lastError)
  }

  // A Graph sign-in asked for from the setup page, cut short: the code goes
  // and its waiters are told, and nothing of the mail session — a refresh
  // in flight, its waiters, a lookup — is touched.
  function cancelGraphRound() {
    if (!graphRoundBusy) return
    graphRoundSerial++
    graphRoundBusy = false
    cancelDeviceLogin()
    finishGraphWaiters("", "Sign-in cancelled")
  }

  function cancelLogin() {
    // Cancel on a settings-page Graph code, the mailbox staying signed in,
    // is that code's alone. Signing out or changing identity is everything's:
    // a mail refresh in flight would otherwise be left busy for good, its
    // answer refused for the session being over.
    if (graphRoundBusy && !loginBusy && sessionEnabled) {
      cancelGraphRound()
      return
    }
    sessionGeneration++
    var oldLookup = lookupProcess
    lookupProcess = null
    if (oldLookup) oldLookup.running = false
    restoreQueued = false
    graphProbeQueued = false
    refreshRetry.stop()
    // Where what is cut short is the Graph tail of a sign-in — the check
    // or the second code — the mail half is in and is said so.
    var afterSignIn = graphRoundOfSignIn && sessionEnabled
    graphRoundOfSignIn = false
    cancelDeviceLogin()
    var open = tokenRequests
    tokenRequests = []
    for (var i = 0; i < open.length; i++) {
      if (open[i].request && open[i].request.abort) open[i].request.abort()
    }
    refreshBusy = false
    loginBusy = false
    graphRoundBusy = false
    finishWaiters("", "Sign-in cancelled")
    // Graph's waiters, parked behind the sign-in or the Graph round's own,
    // are answered either way.
    finishGraphWaiters("", "Sign-in cancelled")
    if (afterSignIn) loginSucceeded()
  }

  function logout() {
    if (backend && accountId) backend.call("auth.invalidate", { accountId: accountId }, function() {})
    sessionEnabled = false
    cancelLogin()
    refreshRetry.stop()
    refreshRetryAttempt = 0
    savedSessionPresent = false
    resetMemorySession()
    sessionChecked = true
    lastError = ""
    finishWaiters("", "Signed out")
    finishGraphWaiters("", "Signed out")
    clearStoredToken()
    loggedOut()
  }

  function checkTools() {
    toolProbe.command = ["sh", "-c",
      "for tool in " + requiredTools.join(" ")
        + "; do command -v \"$tool\" >/dev/null 2>&1 || printf '%s\\n' \"$tool\"; done"]
    toolProbe.running = true
  }

  function changeIdentity() {
    sessionEnabled = false
    resetMemorySession()
    cancelLogin()
    savedSessionPresent = false
    sessionChecked = false
    sessionEnabled = true
    var context = sessionContext()
    Qt.callLater(function() {
      if (root.isCurrent(context)) root.restoreSession()
    })
  }

  onAccountIdChanged: changeIdentity()
  onClientIdChanged: changeIdentity()

  Component.onCompleted: checkTools()

  Timer {
    id: devicePoll
    repeat: false
    onTriggered: root.pollDeviceCode()
  }

  Timer {
    id: refreshRetry
    repeat: false
    onTriggered: root.restoreSession()
  }

  Process {
    id: toolProbe
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var missing = String(text || "").split("\n")
        var found = []
        for (var i = 0; i < missing.length; i++) {
          var name = missing[i].trim()
          if (name) found.push(name)
        }
        root.missingTools = found
        root.toolsChecked = true
      }
    }
  }

  Component {
    id: lookupComponent
    Process {
      id: lookup
      required property var context
      // "session" restores the mail token; "graph" asks for Graph's.
      property string purpose: "session"
      stdout: StdioCollector { waitForEnd: true }
      stderr: StdioCollector { waitForEnd: true }
      onExited: function(exitCode) {
        if (root.lookupProcess === lookup) root.lookupProcess = null
        if (root.graphLookupProcess === lookup) root.graphLookupProcess = null
        var value = exitCode === 0 ? Secrets.fromKeyring(stdout.text) : ""
        if (purpose === "graph") root.handleGraphLookup(value, context)
        else root.handleSecretLookup(value, context)
        destroy()
      }
    }
  }

  Process {
    id: keyringProcess
    stdinEnabled: true
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onStarted: {
      if (root.keyringJob.kind === "store") write(root.keyringJob.token + "\n")
      root.keyringJob.token = ""
    }
    onExited: function(exitCode) {
      var job = root.keyringJob
      root.keyringJob = null
      if (exitCode !== 0 && root.isCurrent(job.context)) {
        root.lastError = job.kind === "store"
          ? "Signed in, but the Microsoft session could not be saved. You may need to sign in again after a restart"
          : "The Microsoft session could not be removed from the keyring. Try signing out again"
      }
      root.runKeyringJob()
    }
  }

}
