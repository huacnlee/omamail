import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons

import "OAuth.js" as OAuth
import "Credentials.js" as Credentials

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
  property bool loginBusy: false
  property bool refreshBusy: false
  property bool credentialsWriteBusy: false
  readonly property bool sessionBusy: refreshBusy || secretLookup.running
  property string lastError: ""

  // Everything the sign-in needs that Omarchy does not guarantee is present.
  readonly property var requiredTools: ["socat", "secret-tool", "openssl", "xdg-open"]
  property var missingTools: []
  property bool toolsChecked: false
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0

  property var tokenWaiters: []
  property string lookupPurpose: ""
  property bool lookupHandled: false
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
    if (refreshBusy || secretLookup.running) return

    lookupPurpose = "request"
    startSecretLookup()
  }

  function restoreSession() {
    sessionChecked = false
    if (!credentialsPresent) {
      sessionChecked = true
      resetMemorySession()
      return
    }
    if (secretLookup.running || refreshBusy) return
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
      sessionChecked = false
      if (Credentials.isConfigured(loaded)) restoreSession()
      else sessionChecked = true
    }
  }

  // -------------------------------------------------------------- keyring

  // An install that predates multi-account stored its token under the client id
  // alone. Reading that once, and rewriting under the new attributes, is the
  // difference between an upgrade and a silent sign-out.
  property bool triedLegacyLookup: false

  function startSecretLookup() {
    if (!clientId) {
      handleSecretLookup("")
      return
    }
    lookupHandled = false
    triedLegacyLookup = false
    secretLookup.command = ["secret-tool", "lookup"].concat(
      Credentials.keyringAttributes(clientId, accountId))
    secretLookup.running = true
  }

  function startLegacyLookup() {
    lookupHandled = false
    triedLegacyLookup = true
    secretLookup.command = ["secret-tool", "lookup"].concat(
      Credentials.legacyKeyringAttributes(clientId))
    secretLookup.running = true
  }

  function handleSecretLookup(raw) {
    if (lookupHandled) return
    lookupHandled = true
    var token = String(raw || "").trim()
    if (!token && !triedLegacyLookup && clientId !== "") {
      startLegacyLookup()
      return
    }
    var purpose = lookupPurpose
    lookupPurpose = ""
    if (!token) {
      resetMemorySession()
      sessionChecked = true
      if (purpose === "request") finishWaiters("", "Sign in to Gmail first")
      return
    }
    refreshWithToken(token, purpose)
  }

  function storeRefreshToken(refreshToken) {
    if (!refreshToken || keyringStore.running) return
    keyringWriteToken = String(refreshToken)
    keyringStore.command = [pluginDir + "/scripts/keyring-store.sh"].concat(
      Credentials.keyringAttributes(clientId, accountId))
    keyringStore.running = true
  }

  function clearStoredToken() {
    if (keyringClear.running || !clientId) return
    keyringClear.command = ["secret-tool", "clear"].concat(
      Credentials.keyringAttributes(clientId, accountId))
    keyringClear.running = true
  }

  // ---------------------------------------------------------------- tokens

  function postTokenRequest(body, previousRefreshToken, callback) {
    var serial = ++tokenRequestSerial
    var request = new XMLHttpRequest()
    tokenRequest = request
    request.onreadystatechange = function() {
      if (request.readyState !== XMLHttpRequest.DONE) return
      if (serial !== root.tokenRequestSerial) return
      if (root.tokenRequest === request) root.tokenRequest = null
      var result = OAuth.parseTokenResponse(request.status, request.responseText,
        previousRefreshToken)
      if (typeof callback === "function") callback(result)
    }
    request.open("POST", OAuth.TOKEN_URL)
    request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded")
    request.send(body)
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
        // A revoked or expired grant is never coming back. Dropping it here
        // means the panel offers "Sign in" instead of retrying forever.
        if (result.invalidGrant) root.clearStoredToken()
        if (purpose === "request") root.finishWaiters("", root.lastError)
        else root.sessionUnavailable(root.lastError)
        return
      }
      root.acceptToken(result)
      root.finishWaiters(root.accessToken, "")
    })
  }

  function acceptToken(result) {
    // Rewriting after a legacy read is what completes the migration; without it
    // the old entry stays authoritative and a second account would still clash.
    if (triedLegacyLookup && !result.refreshToken) triedLegacyLookup = false
    accessToken = result.accessToken
    accessTokenExpiresAt = Date.now() + result.expiresIn * 1000
    if (result.scope) grantedScope = result.scope
    loggedIn = true
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
      root.acceptToken(result)
      root.sessionChecked = true

      // A user can untick individual permissions on Google's consent screen.
      // The resulting token works for reading and fails at the first archive,
      // which is a far worse experience than saying so now.
      var missing = OAuth.missingScopes(result.scope, root.scopes)
      if (missing.length > 0) root.lastError = OAuth.missingScopeMessage(missing)

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
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: function(line) { root.handleSecretLookup(line) }
    }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      if (!root.lookupHandled) root.handleSecretLookup("")
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
