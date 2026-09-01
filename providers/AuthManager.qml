import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons

import "OAuth.js" as OAuth
import "Credentials.js" as Credentials
import "Secrets.js" as Secrets

// Google sign-in and token storage. Nothing else in the plugin needs to know
// what a refresh token looks like: callers ask for `withAccessToken` and get a
// live bearer token or an error string.
//
// Where each secret lives, and why:
//   - the access token stays in this process and is never written anywhere
//   - the refresh token crosses the process boundary over stdin and is kept by
//     GNOME Keyring, keyed by client id so two Cloud projects cannot collide
//   - the OAuth client id and secret live in a 0600 file under ~/.config,
//     because shell.json — where plugin settings go — is world-readable
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir
  property int oauthPort: OAuth.DEFAULT_PORT
  property var scopes: OAuth.SCOPES

  // Which mailbox this manager signs in. An OAuth client belongs to a Cloud
  // project rather than to a mailbox, so two accounts may share one — the
  // keyring entry has to be keyed on both or they overwrite each other and one
  // gets signed out at random.
  property string accountId: ""

  // The browser page after Google redirects is the only part of this app that
  // renders outside Quickshell, so it takes the active theme with it.
  readonly property var callbackTheme: ({
    background: String(Color.background),
    foreground: String(Color.foreground),
    accent: String(Color.accent),
    urgent: String(Color.urgent),
    fontFamily: Style.font.family
  })

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string credentialsPath: Credentials.path(home)

  property var credentials: Credentials.effective("")
  property bool credentialsChecked: false
  property bool usingBuiltinClient: Credentials.hasBuiltin()
  readonly property bool credentialsPresent: Credentials.isConfigured(credentials)
  readonly property string clientId: credentials ? String(credentials.clientId || "") : ""
  readonly property string clientDescription: Credentials.describe(credentials)

  property string accessToken: ""
  property double accessTokenExpiresAt: 0
  property string grantedScope: ""
  property bool loggedIn: false
  property bool sessionChecked: false
  // True after the keyring yielded a refresh token, even while a temporary
  // network failure prevents it from becoming an access token. This is not a
  // signed-out account: the saved grant is still the route back to ready.
  property bool savedSessionPresent: false
  readonly property bool recoveringSession: savedSessionPresent && !loggedIn
  property int refreshRetryAttempt: 0
  property bool loginBusy: false
  property bool refreshBusy: false
  property bool credentialsWriteBusy: false
  readonly property bool sessionBusy: refreshBusy || lookupRunning
  property string lastError: ""

  // Everything the sign-in needs that Omarchy does not guarantee is present.
  readonly property var requiredTools: ["socat", "secret-tool", "openssl", "xdg-open"]
  property var missingTools: []
  property bool toolsChecked: false
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0

  property var tokenWaiters: []
  property string lookupPurpose: ""
  property bool lookupHandled: false
  property var lookupAttributes: []
  property var savedTokenAttributes: []
  // One lookup at a time, whichever of the two processes is carrying it.
  readonly property bool lookupRunning: secretLookup.running || legacySearch.running
  property string keyringWriteToken: ""
  property string credentialsWritePayload: ""

  property string pkceVerifier: ""
  property string pkceChallenge: ""
  property string oauthState: ""
  property bool callbackHandled: false
  property bool exchangingCode: false
  property var tokenRequest: null
  property int tokenRequestSerial: 0
  property bool logoutPendingClear: false
  property string loginHint: ""

  signal loginSucceeded()
  signal loggedOut()
  signal sessionUnavailable(string reason)
  signal credentialsSaved()

  function safeError(value) {
    return OAuth.redact(String(value || ""))
  }

  function tokenIsFresh() {
    return accessToken !== "" && Date.now() + 60000 < accessTokenExpiresAt
  }

  function resetMemorySession() {
    accessToken = ""
    accessTokenExpiresAt = 0
    loggedIn = false
  }

  function invalidateAccessToken() {
    accessToken = ""
    accessTokenExpiresAt = 0
  }

  function finishWaiters(token, error) {
    var pending = tokenWaiters.slice()
    tokenWaiters = []
    for (var i = 0; i < pending.length; i++) {
      try { pending[i](token || "", safeError(error)) }
      catch (e) { /* consumers own their callback errors */ }
    }
  }

  // The only entry point the API transport uses. A refresh already in flight
  // is joined rather than duplicated, so a burst of requests after the token
  // expires produces one token call, not twenty.
  function withAccessToken(callback) {
    if (typeof callback !== "function") return
    if (tokenIsFresh()) {
      callback(accessToken, "")
      return
    }
    if (!credentialsPresent) {
      callback("", "Connect a Google Cloud OAuth client first")
      return
    }

    var next = tokenWaiters.slice()
    next.push(callback)
    tokenWaiters = next
    if (refreshBusy || lookupRunning) return

    lookupPurpose = "request"
    startSecretLookup()
  }

  function restoreSession() {
    sessionChecked = false
    if (!credentialsPresent) {
      savedSessionPresent = false
      sessionChecked = true
      resetMemorySession()
      return
    }
    if (lookupRunning || refreshBusy) return
    lookupPurpose = "restore"
    startSecretLookup()
  }

  // ------------------------------------------------------------ credentials

  function saveCredentials(text) {
    var result = Credentials.parse(text)
    if (!result.ok) {
      lastError = result.error
      return false
    }
    if (credentialsWriteBusy) return false
    lastError = ""
    credentialsWriteBusy = true
    credentialsWritePayload = Credentials.serialize(result.credentials)
    credentialsWriter.command = [pluginDir + "/scripts/config-store.sh", "credentials.json"]
    credentialsWriter.running = true
    return true
  }

  // The user's own client file wins; a client shipped with the plugin is the
  // fallback. Today nothing is shipped, so this resolves to the file or to
  // nothing at all — see Credentials.BUILTIN for why.
  function applyCredentials(raw) {
    var loaded = Credentials.effective(raw, accountId)
    usingBuiltinClient = Credentials.usingBuiltin(raw, accountId)
    var changed = String(loaded.clientId) !== String(credentials.clientId)
    credentials = loaded
    credentialsChecked = true
    if (changed) {
      // A different client means a different keyring entry and a different
      // grant; whatever is in memory belongs to the old one.
      resetMemorySession()
      savedSessionPresent = false
      refreshRetryAttempt = 0
      refreshRetry.stop()
      sessionChecked = false
      if (Credentials.isConfigured(loaded)) restoreSession()
      else sessionChecked = true
    }
  }

  // -------------------------------------------------------------- keyring

  // Older grants are detected so the panel can ask for Calendar permission.
  // Their tokens stay in the keyring and are never treated as current grants.
  property bool triedLegacyLookup: false
  property int secretLookupStage: 0
  property var legacyAttributes: []

  // Two keyring entries are not tied to an address: the pre-multi-account one
  // keyed by client alone, and the one written for a mailbox that had not
  // learned its address yet, which keys on a literal stand-in. Either can be
  // found by *any* account sharing the client, and both belong to whichever
  // mailbox was signed in before accounts were separated — the first one.
  //
  // Only that one may claim them. Without this a mailbox you have just added
  // restores the token of the mailbox you already had, signs itself in, reports
  // that same address, and collapses back into it — which is exactly what
  // adding a second account did.
  property bool mayAdoptLegacyToken: true

  function startSecretLookup() {
    if (!clientId) {
      handleSecretLookup("")
      return
    }
    // A mailbox with no address has never signed in under one, so there is
    // nothing of its own to find — only somebody else's.
    if (accountId === "" && !mayAdoptLegacyToken) {
      handleSecretLookup("")
      return
    }
    lookupHandled = false
    triedLegacyLookup = false
    secretLookupStage = 0
    lookupAttributes = Credentials.refreshTokenAttributes(clientId, accountId, 0)
    secretLookup.command = ["secret-tool", "lookup"].concat(lookupAttributes)
    secretLookup.running = true
  }

  function startNextSecretLookup() {
    lookupHandled = false
    secretLookupStage++
    var attributes = []
    if (secretLookupStage === 1) {
      triedLegacyLookup = false
      attributes = Credentials.previousGrantKeyringAttributes(clientId, accountId)
    } else if (secretLookupStage === 2 && mayAdoptLegacyToken) {
      triedLegacyLookup = true
      attributes = Credentials.legacyKeyringAttributes(clientId)
    } else if (secretLookupStage <= 3) {
      secretLookupStage = 3
      triedLegacyLookup = false
      attributes = Credentials.renamedKeyringAttributes(clientId, accountId)
    } else if (secretLookupStage === 4 && mayAdoptLegacyToken) {
      triedLegacyLookup = true
      attributes = Credentials.renamedLegacyKeyringAttributes(clientId)
    }
    if (!attributes.length) {
      handleSecretLookup("")
      return
    }
    // A legacy read looks before it leaps. Its attributes are a wildcard over
    // "account", so asking for the token outright can answer with a named
    // mailbox's. See Credentials.hasLoneLegacyEntry.
    if (triedLegacyLookup) {
      legacySearch.reset()
      legacyAttributes = attributes
      legacySearch.command = ["secret-tool", "search", "--all"].concat(attributes)
      legacySearch.running = true
      return
    }
    lookupAttributes = attributes
    secretLookup.command = ["secret-tool", "lookup"].concat(attributes)
    secretLookup.running = true
  }

  // The legacy entry's token, asked for only once the search has said that
  // entry is the one a lookup would answer with. Refusing is not an error:
  // what a mailbox with no token of its own gets is the next stage, and then
  // the sign-in button.
  //
  // A search that did not exit cleanly is refused as well. Fail-closed covers
  // the ordinary failures on its own, since a search that found nothing counts
  // no matches, but a killed one can leave a whole record on stdout with its
  // attributes cut short.
  function readLegacyToken(exitCode, matches, attributed, named) {
    if (exitCode !== 0 || !Credentials.hasLoneLegacyEntry(matches, attributed, named)) {
      handleSecretLookup("")
      return
    }
    lookupHandled = false
    lookupAttributes = legacyAttributes
    secretLookup.command = ["secret-tool", "lookup"].concat(legacyAttributes)
    secretLookup.running = true
  }

  function handleSecretLookup(raw) {
    if (lookupHandled) return
    lookupHandled = true
    var token = String(raw || "").trim()
    if (!token && secretLookupStage < 4 && clientId !== "") {
      startNextSecretLookup()
      return
    }
    var purpose = lookupPurpose
    lookupPurpose = ""
    if (!token) {
      savedSessionPresent = false
      resetMemorySession()
      sessionChecked = true
      if (purpose === "request") finishWaiters("", "Sign in to Gmail first")
      return
    }
    // Every fallback entry predates the Calendar grant marker. Refreshing it
    // would report a live Gmail session while Calendar returns 403. Keep the
    // saved token for Google's incremental consent flow, but require sign-in.
    if (secretLookupStage > 0) {
      token = ""
      savedSessionPresent = false
      savedTokenAttributes = []
      refreshRetryAttempt = 0
      refreshRetry.stop()
      resetMemorySession()
      sessionChecked = true
      lastError = "Sign in again to add Google Calendar permission"
      if (purpose === "request") finishWaiters("", lastError)
      else sessionUnavailable(lastError)
      return
    }
    savedSessionPresent = true
    savedTokenAttributes = lookupAttributes.slice()
    refreshWithToken(token, purpose)
  }

  // Held only until this mailbox learns its own address, which the profile
  // fetch settles a second or two after signing in.
  //
  // Writing it immediately meant writing it under a name-less key, and any
  // other mailbox sharing the client could then find it — which is how a newly
  // added mailbox ended up restoring the session of one that already existed
  // and reporting itself as that address. Waiting costs a second and leaves the
  // keyring with nothing ambiguous in it.
  property string unnamedRefreshToken: ""

  onAccountIdChanged: {
    if (accountId === "" || unnamedRefreshToken === "") return
    var held = unnamedRefreshToken
    unnamedRefreshToken = ""
    storeRefreshToken(held)
  }

  function storeRefreshToken(refreshToken) {
    if (!refreshToken) return
    if (accountId === "") {
      unnamedRefreshToken = String(refreshToken)
      return
    }
    if (keyringStore.running) return
    keyringWriteToken = String(refreshToken)
    keyringStore.command = [pluginDir + "/scripts/keyring-store.sh"].concat(
      Credentials.keyringAttributes(clientId, accountId))
    keyringStore.running = true
  }

  function clearStoredToken(attributes) {
    if (keyringClear.running || !clientId) return
    var selected = attributes && attributes.length
      ? attributes : Credentials.keyringAttributes(clientId, accountId)
    keyringClear.command = ["secret-tool", "clear"].concat(selected)
    keyringClear.running = true
  }

  // ---------------------------------------------------------------- tokens

  // How long the token endpoint may hang before the sign-in gives up on it.
  //
  // Qt's QML XMLHttpRequest has no `timeout` and no `ontimeout`; a `Timer`
  // calling `abort()` is what there is. See `GmailApiClient.requestTimeoutMs`
  // for the measurements, and for why thirty seconds.
  //
  // This one matters more than a list load does: a session restore that never
  // answers leaves `sessionChecked` false, and the panel waits on it for a
  // session that is never coming.
  readonly property int tokenTimeoutMs: 30000

  function postTokenRequest(body, previousRefreshToken, callback) {
    var serial = ++tokenRequestSerial
    var request = new XMLHttpRequest()
    tokenRequest = request

    var deadline = tokenDeadlineComponent.createObject(root, { interval: tokenTimeoutMs })
    function disarm() {
      if (!deadline) return
      deadline.stop()
      deadline.destroy()
      deadline = null
    }

    request.onreadystatechange = function() {
      if (request.readyState !== XMLHttpRequest.DONE) return
      disarm()
      if (serial !== root.tokenRequestSerial) return
      if (root.tokenRequest === request) root.tokenRequest = null
      // `abort()` drives readyState to DONE with status 0, so a request the
      // deadline gave up on lands here as the failure it is —
      // `parseTokenResponse` already reads a zero status as "could not reach
      // Google", which is the honest thing to tell somebody whose network went
      // away mid sign-in.
      var result = OAuth.parseTokenResponse(request.status, request.responseText,
        previousRefreshToken)
      if (typeof callback === "function") callback(result)
    }
    request.open("POST", OAuth.TOKEN_URL)
    request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded")
    request.send(body)

    if (deadline) {
      deadline.triggered.connect(function() {
        if (!root) return
        if (request.abort) request.abort()
      })
      deadline.start()
    }
  }

  Component {
    id: tokenDeadlineComponent

    Timer {
      repeat: false
    }
  }

  function refreshWithToken(refreshToken, purpose) {
    refreshBusy = true
    postTokenRequest(OAuth.formBody({
      client_id: clientId,
      client_secret: credentials.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken
    }), refreshToken, function(result) {
      refreshToken = ""
      root.refreshBusy = false
      root.sessionChecked = true
      if (!result.ok) {
        root.resetMemorySession()
        root.lastError = root.safeError(result.error)
        if (OAuth.refreshFailureDisposition(result) === "signed_out") {
          // A revoked or expired grant is never coming back. Dropping it here
          // means the panel offers "Sign in" instead of retrying forever.
          root.savedSessionPresent = false
          refreshRetry.stop()
          root.clearStoredToken(root.savedTokenAttributes)
        } else {
          // The keyring token is still valid evidence of a saved session. Keep
          // it and retry until the network can exchange it for an access token.
          root.scheduleRefreshRetry()
        }
        if (purpose === "request") root.finishWaiters("", root.lastError)
        else root.sessionUnavailable(root.lastError)
        return
      }
      root.acceptToken(result)
      root.finishWaiters(root.accessToken, "")
    })
  }

  function acceptToken(result) {
    accessToken = result.accessToken
    accessTokenExpiresAt = Date.now() + result.expiresIn * 1000
    if (result.scope) grantedScope = result.scope
    loggedIn = true
    savedSessionPresent = true
    refreshRetryAttempt = 0
    refreshRetry.stop()
    lastError = ""
    if (result.refreshToken) storeRefreshToken(result.refreshToken)
  }

  // ---------------------------------------------------------------- login

  function beginLogin() {
    if (loginBusy || refreshBusy) return
    if (!credentialsPresent) {
      lastError = "Connect a Google Cloud OAuth client first"
      return
    }
    if (!toolsPresent && toolsChecked) {
      lastError = "Missing " + missingTools.join(", ")
      return
    }
    lastError = ""
    loginBusy = true
    callbackHandled = false
    exchangingCode = false
    pkceGenerator.command = [pluginDir + "/scripts/pkce.sh"]
    pkceGenerator.running = true
  }

  function scheduleRefreshRetry() {
    if (!savedSessionPresent || refreshRetry.running) return
    refreshRetry.interval = OAuth.refreshRetryDelay(refreshRetryAttempt)
    refreshRetryAttempt++
    refreshRetry.start()
  }

  function handlePkce(raw) {
    if (!loginBusy || pkceVerifier !== "") return
    var result = OAuth.parsePkceOutput(raw)
    if (!result.ok) {
      failLogin("Could not start a secure Google sign-in. Please try again")
      return
    }
    pkceVerifier = result.verifier
    pkceChallenge = result.challenge
    oauthState = result.state
    // socat answers exactly one connection and exits, which is all the
    // loopback redirect needs and leaves nothing listening afterwards.
    callbackListener.command = [
      "socat", "-T", "180",
      "TCP4-LISTEN:" + OAuth.normalizedPort(oauthPort) + ",bind=127.0.0.1,reuseaddr",
      "STDIO"
    ]
    callbackListener.running = true
    authTimeout.restart()
  }

  function openAuthorizationPage() {
    if (!loginBusy || callbackHandled || pkceChallenge === "") return
    Quickshell.execDetached(["xdg-open", OAuth.authorizationUrl({
      clientId: clientId,
      challenge: pkceChallenge,
      state: oauthState,
      port: oauthPort,
      scopes: scopes,
      loginHint: loginHint
    })])
  }

  function handleCallbackLine(rawLine) {
    if (!loginBusy || callbackHandled) return
    var line = String(rawLine || "").replace(/\r$/, "")
    if (line.indexOf("GET ") !== 0) return
    callbackHandled = true
    authTimeout.stop()
    var callback = OAuth.parseCallbackRequestLine(line, OAuth.CALLBACK_PATH)
    // A mismatched state means this response did not come from the request
    // this process started, so the code in it is not exchanged.
    if (!callback.ok || callback.state !== oauthState) {
      callbackListener.write(OAuth.failureResponse(callbackTheme, callback.error))
      callbackStopTimer.restart()
      failLogin(callback.ok
        ? "Google sign-in could not be verified. Please try again"
        : callback.error, true)
      return
    }
    callbackListener.write(OAuth.successResponse(callbackTheme))
    callbackStopTimer.restart()
    exchangeAuthorizationCode(callback.code)
  }

  function exchangeAuthorizationCode(code) {
    exchangingCode = true
    var requestBody = OAuth.formBody({
      client_id: clientId,
      client_secret: credentials.clientSecret,
      code: code,
      code_verifier: pkceVerifier,
      grant_type: "authorization_code",
      redirect_uri: OAuth.redirectUri(oauthPort)
    })
    code = ""
    clearPkce()

    postTokenRequest(requestBody, "", function(result) {
      root.exchangingCode = false
      root.loginBusy = false
      if (!result.ok) {
        root.lastError = root.safeError(result.error)
        root.sessionUnavailable(root.lastError)
        return
      }
      // A user can untick individual permissions on Google's consent screen.
      // The resulting token works for reading and fails at the first archive,
      // which is a far worse experience than saying so now.
      var missing = OAuth.missingScopes(result.scope, root.scopes)
      if (missing.length > 0) {
        root.resetMemorySession()
        root.sessionChecked = true
        root.lastError = OAuth.missingScopeMessage(missing)
        root.finishWaiters("", root.lastError)
        root.sessionUnavailable(root.lastError)
        return
      }

      root.acceptToken(result)
      root.sessionChecked = true
      root.finishWaiters(root.accessToken, "")
      root.loginSucceeded()
    })
    requestBody = ""
  }

  function clearPkce() {
    pkceVerifier = ""
    pkceChallenge = ""
    oauthState = ""
  }

  function failLogin(reason, listenerAlreadyAnswered) {
    lastError = safeError(reason || "Google sign-in failed. Please try again")
    loginBusy = false
    exchangingCode = false
    authTimeout.stop()
    authOpenDelay.stop()
    if (!listenerAlreadyAnswered && callbackListener.running) callbackListener.running = false
    clearPkce()
    sessionUnavailable(lastError)
  }

  function cancelLogin() {
    authTimeout.stop()
    authOpenDelay.stop()
    callbackStopTimer.stop()
    if (callbackListener.running) callbackListener.running = false
    if (pkceGenerator.running) pkceGenerator.running = false
    tokenRequestSerial++
    if (tokenRequest && tokenRequest.abort) tokenRequest.abort()
    tokenRequest = null
    refreshBusy = false
    loginBusy = false
    exchangingCode = false
    callbackHandled = false
    clearPkce()
  }

  function logout() {
    cancelLogin()
    refreshRetry.stop()
    refreshRetryAttempt = 0
    savedSessionPresent = false
    resetMemorySession()
    sessionChecked = true
    grantedScope = ""
    lastError = ""
    finishWaiters("", "Signed out")
    if (keyringStore.running) logoutPendingClear = true
    else clearStoredToken()
    loggedOut()
  }

  function checkTools() {
    toolProbe.command = ["sh", "-c",
      "for tool in " + requiredTools.join(" ")
        + "; do command -v \"$tool\" >/dev/null 2>&1 || printf '%s\\n' \"$tool\"; done"]
    toolProbe.running = true
  }

  Component.onCompleted: checkTools()

  // ------------------------------------------------------------- processes

  FileView {
    id: credentialsFile
    path: root.credentialsPath
    watchChanges: true
    printErrors: false
    onLoaded: root.applyCredentials(text())
    onFileChanged: reload()
    // No file is the normal first-run state, not an error: fall through to
    // whatever client is built in.
    onLoadFailed: root.applyCredentials("")
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

  Process {
    id: credentialsWriter
    stdinEnabled: true
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onStarted: {
      write(root.credentialsWritePayload + "\n")
      root.credentialsWritePayload = ""
    }
    onExited: function(exitCode) {
      root.credentialsWritePayload = ""
      root.credentialsWriteBusy = false
      if (exitCode !== 0) {
        root.lastError = "Could not save the OAuth client to " + root.credentialsPath
        return
      }
      // The FileView is watching the same path, but reload explicitly so the
      // panel advances the moment the write lands rather than on a file event.
      credentialsFile.reload()
      root.credentialsSaved()
    }
  }

  Timer {
    id: authOpenDelay
    interval: 120
    onTriggered: root.openAuthorizationPage()
  }

  Timer {
    id: callbackStopTimer
    interval: 250
    onTriggered: if (callbackListener.running) callbackListener.running = false
  }

  Timer {
    id: authTimeout
    interval: 180000
    onTriggered: root.failLogin("Google sign-in took too long. Please try again")
  }

  Timer {
    id: refreshRetry
    repeat: false
    onTriggered: root.restoreSession()
  }

  Process {
    id: pkceGenerator
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) { root.handlePkce(line) }
    }
    onExited: function(exitCode) {
      if (root.loginBusy && root.pkceVerifier === "" && exitCode !== 0)
        root.failLogin("Could not start a secure Google sign-in. Please try again")
    }
  }

  Process {
    id: callbackListener
    stdinEnabled: true
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) { root.handleCallbackLine(line) }
    }
    stderr: StdioCollector { waitForEnd: true }
    // The browser only opens once the listener is actually accepting, or the
    // redirect races it and lands on a closed port.
    onStarted: authOpenDelay.restart()
    onExited: function(exitCode) {
      if (root.loginBusy && !root.callbackHandled && !root.exchangingCode)
        root.failLogin(exitCode === 0
          ? "The Google sign-in window closed before it finished"
          : "Could not listen on port " + OAuth.normalizedPort(root.oauthPort)
            + ". Close whatever is using it, or change the port in settings")
    }
  }

  Process {
    id: secretLookup
    stdout: StdioCollector { id: secretLookupOutput; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      // One trailing newline is the pipe's; everything else is the secret.
      var value = exitCode === 0 ? Secrets.fromKeyring(secretLookupOutput.text) : ""
      root.handleSecretLookup(value)
    }
  }

  // Whether a legacy entry is there at all. The matches come back on stdout
  // and their attributes on stderr, so the two are counted apart and neither
  // is read as the other's.
  //
  // Counted line by line rather than collected: a search keyed on the client
  // alone loads every matching mailbox's token, and stdout carries all of
  // them. Nothing here needs a secret, only how many of each line there were,
  // so none is held.
  Process {
    id: legacySearch
    property int matchCount: 0
    property int attributedCount: 0
    property int namedCount: 0

    function reset() {
      matchCount = 0
      attributedCount = 0
      namedCount = 0
    }

    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        if (Credentials.isKeyringMatchLine(line)) legacySearch.matchCount++
      }
    }
    stderr: SplitParser {
      splitMarker: "\n"
      onRead: function(line) {
        if (Credentials.isKeyringAttributedLine(line)) legacySearch.attributedCount++
        if (Credentials.isKeyringNamedLine(line)) legacySearch.namedCount++
      }
    }
    onExited: function(exitCode) {
      root.readLegacyToken(exitCode, matchCount, attributedCount, namedCount)
      reset()
    }
  }

  Process {
    id: keyringStore
    stdinEnabled: true
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onStarted: {
      write(root.keyringWriteToken + "\n")
      root.keyringWriteToken = ""
    }
    onExited: function(exitCode) {
      root.keyringWriteToken = ""
      if (exitCode !== 0)
        root.lastError = "Signed in, but the session could not be saved. You may need to sign in again after a restart"
      if (root.logoutPendingClear) {
        root.logoutPendingClear = false
        root.clearStoredToken()
      }
    }
  }

  Process {
    id: keyringClear
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
  }
}
