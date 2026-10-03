import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons

import "OutlookOAuth.js" as Ms
import "Outlook.js" as Outlook
import "Credentials.js" as Credentials
import "Secrets.js" as Secrets
import "ImapProtocol.js" as Imap

// Microsoft sign-in for a personal Outlook mailbox, and the token storage
// behind it. It wears the same surface `AuthManager` wears, because
// `MailAccount`, the setup page and the transport all ask either manager the
// same questions without knowing which one they hold.
//
// Where each secret lives, and why:
//   - the Microsoft access token stays in this process and is never written
//     anywhere
//   - the refresh token crosses the process boundary over stdin and is kept by
//     GNOME Keyring, under a kind of its own so it can never be found by, or
//     overwrite, a Gmail entry
//   - the public client id lives in the 0600 credentials file, because there
//     is no secret and no Cloud project for the user to create
//
// The one behaviour that differs from Gmail's: Microsoft rotates the refresh
// token on every exchange, so the new one is written back each time. Losing it
// signs the mailbox out, which is why a refresh that arrives without one keeps
// the token already saved.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir
  property int oauthPort: Ms.DEFAULT_PORT
  property var scopes: Ms.SCOPES

  // Which mailbox this manager signs in. An address is only known after the
  // sign-in has reported it, so this starts empty and is filled by the
  // account list once `accountIdentified` has run.
  property string accountId: ""

  // The address the account was configured with, pushed down from the row.
  // The id-token claim is preferred once it arrives; this is what names the
  // mailbox before the browser has answered, and after a restart if a refresh
  // returns no id token.
  property string email: ""
  property string loginHint: ""

  readonly property var callbackTheme: ({
    background: String(Color.background),
    foreground: String(Color.foreground),
    accent: String(Color.accent),
    urgent: String(Color.urgent),
    fontFamily: Style.font.family
  })

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string credentialsPath: Credentials.path(home)

  // The raw file, kept so a save can carry every Google client it already
  // holds through untouched. The Outlook slot is read out of this text.
  property string credentialsRawText: ""
  property bool credentialsChecked: false
  readonly property string clientId:
    Credentials.outlookEffective(credentialsRawText).clientId
  readonly property bool credentialsPresent:
    Credentials.isOutlookConfigured(credentialsRawText)
  readonly property string clientDescription:
    Credentials.describeOutlook(clientId)
  property bool credentialsWriteBusy: false

  property string accessToken: ""
  property double accessTokenExpiresAt: 0
  property string grantedScope: ""
  property bool loggedIn: false
  property bool sessionChecked: false
  // True once the keyring yielded a refresh token, even while a temporary
  // network failure prevents it becoming an access token. This is not a
  // signed-out account: the saved grant is still the route back to ready.
  property bool savedSessionPresent: false
  readonly property bool recoveringSession: savedSessionPresent && !loggedIn
  property int refreshRetryAttempt: 0
  property bool loginBusy: false
  property bool refreshBusy: false
  readonly property bool sessionBusy: refreshBusy || secretLookup.running
  property string lastError: ""

  // The address Microsoft signed in, read from the id token's claims.
  property string signedInEmail: ""

  // The email part of `outlook:<address>`, so a restart can name the mailbox
  // even before a token has been exchanged.
  readonly property string accountAddress: {
    var id = String(accountId || "")
    var colon = id.indexOf(":")
    return colon >= 0 ? id.substring(colon + 1) : id
  }
  readonly property string address: signedInEmail !== "" ? signedInEmail : accountAddress

  // What `ImapClient` dials. The username is the address the token is presented
  // as; the servers are fixed by Microsoft.
  readonly property var settings: Imap.normalizeSettings(Outlook.settingsFor(address))

  // The transport asks for the token, not a password, and formats it for the
  // script's XOAUTH2 mode.
  readonly property bool oauth: true
  readonly property bool transportOAuth: true

  readonly property var requiredTools: ["socat", "secret-tool", "openssl", "xdg-open"]
  property var missingTools: []
  property bool toolsChecked: false
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0

  property var tokenWaiters: []
  property string lookupPurpose: ""
  property bool lookupHandled: false
  property var lookupAttributes: []
  property string keyringWriteToken: ""
  property string credentialsWritePayload: ""
  // Held only until this mailbox learns its own address, which the profile
  // read settles a second or two after signing in.
  property string unnamedRefreshToken: ""

  property string pkceVerifier: ""
  property string pkceChallenge: ""
  property string oauthState: ""
  property bool callbackHandled: false
  property bool exchangingCode: false
  property var tokenRequest: null
  property int tokenRequestSerial: 0
  property bool logoutPendingClear: false

  signal loginSucceeded()
  signal loggedOut()
  signal sessionUnavailable(string reason)
  signal credentialsSaved()

  function safeError(value) {
    return Ms.redact(String(value || ""))
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

  // The one entry point the transport uses. A refresh already in flight is
  // joined rather than duplicated, so a burst of requests after the token
  // expires produces one token call, not twenty.
  function withAccessToken(callback) {
    if (typeof callback !== "function") return
    if (tokenIsFresh()) {
      callback(accessToken, "")
      return
    }
    if (!credentialsPresent) {
      callback("", "Outlook sign-in is not configured on this machine")
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
      savedSessionPresent = false
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
    var result = Credentials.parseOutlook(text)
    if (!result.ok) {
      lastError = result.error
      return false
    }
    if (credentialsWriteBusy) return false
    lastError = ""
    credentialsWriteBusy = true
    credentialsWritePayload = Credentials.withOutlookClient(credentialsRawText,
      result.clientId)
    credentialsWriter.command = [pluginDir + "/scripts/config-store.sh", "credentials.json"]
    credentialsWriter.running = true
    return true
  }

  function applyCredentials(raw) {
    var text = String(raw || "")
    var configured = Credentials.isOutlookConfigured(text)
    var changed = Credentials.outlookEffective(text).clientId !== clientId
    credentialsRawText = text
    credentialsChecked = true
    if (changed) {
      // A different client means a different grant; whatever is in memory
      // belongs to the old one.
      resetMemorySession()
      savedSessionPresent = false
      refreshRetryAttempt = 0
      refreshRetry.stop()
      sessionChecked = false
      if (configured) restoreSession()
      else sessionChecked = true
    }
  }

  // -------------------------------------------------------------- keyring

  function startSecretLookup() {
    var attributes = Credentials.outlookKeyringAttributes(accountId)
    if (attributes.length === 0 || (accountId === "" && unnamedRefreshToken === "")) {
      handleSecretLookup("")
      return
    }
    lookupHandled = false
    lookupAttributes = attributes
    secretLookup.command = ["secret-tool", "lookup"].concat(attributes)
    secretLookup.running = true
  }

  function handleSecretLookup(raw) {
    if (lookupHandled) return
    lookupHandled = true
    var token = String(raw || "").trim()
    var purpose = lookupPurpose
    lookupPurpose = ""
    if (!token) {
      savedSessionPresent = false
      resetMemorySession()
      sessionChecked = true
      if (purpose === "request") finishWaiters("", "Sign in to Outlook first")
      return
    }
    savedSessionPresent = true
    refreshWithToken(token, purpose)
  }

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
      Credentials.outlookKeyringAttributes(accountId))
    keyringStore.running = true
  }

  function clearStoredToken(attributes) {
    if (keyringClear.running || accountId === "") return
    var selected = attributes && attributes.length
      ? attributes : Credentials.outlookKeyringAttributes(accountId)
    if (selected.length === 0) return
    keyringClear.command = ["secret-tool", "clear"].concat(selected)
    keyringClear.running = true
  }

  // ---------------------------------------------------------------- tokens

  // Qt's QML XMLHttpRequest has no `timeout`, so a Timer calling `abort()` is
  // what there is. This matters more than a list load: a session restore that
  // never answers leaves `sessionChecked` false and the panel waiting forever.
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
      var result = Ms.parseTokenResponse(request.status, request.responseText,
        previousRefreshToken)
      if (typeof callback === "function") callback(result)
    }
    request.open("POST", Ms.TOKEN_URL)
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
    postTokenRequest(Ms.formBody({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: scopes.join(" ")
    }), refreshToken, function(result) {
      refreshToken = ""
      root.refreshBusy = false
      root.sessionChecked = true
      if (!result.ok) {
        root.resetMemorySession()
        root.lastError = root.safeError(result.error)
        if (Ms.refreshFailureDisposition(result) === "signed_out") {
          // A revoked or expired grant is never coming back. Dropping it here
          // means the panel offers "Sign in" instead of retrying forever.
          root.savedSessionPresent = false
          refreshRetry.stop()
          root.clearStoredToken(root.lookupAttributes)
        } else {
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
    if (result.account) signedInEmail = result.account
    loggedIn = true
    savedSessionPresent = true
    refreshRetryAttempt = 0
    refreshRetry.stop()
    lastError = ""
    // Microsoft rotates the refresh token on every exchange; the new one is
    // the only one that will still work on the next refresh.
    if (result.refreshToken) storeRefreshToken(result.refreshToken)
  }

  // ---------------------------------------------------------------- login

  function beginLogin() {
    if (loginBusy || refreshBusy) return
    // A missing plugin directory means the helper scripts cannot be spawned at
    // all. Saying so beats waiting forever: a process that never starts emits
    // no `exited`, so nothing else here would ever report it.
    if (pluginDir === "") {
      lastError = "This plugin's files could not be located. Reinstall it or restart the shell"
      return
    }
    if (!credentialsPresent) {
      lastError = "Outlook sign-in is not configured. Add the client id to "
        + credentialsPath
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
    refreshRetry.interval = Ms.refreshRetryDelay(refreshRetryAttempt)
    refreshRetryAttempt++
    refreshRetry.start()
  }

  function handlePkce(raw) {
    if (!loginBusy || pkceVerifier !== "") return
    var result = Ms.parsePkceOutput(raw)
    if (!result.ok) {
      failLogin("Could not start a secure Microsoft sign-in. Please try again")
      return
    }
    pkceVerifier = result.verifier
    pkceChallenge = result.challenge
    oauthState = result.state
    // socat answers exactly one connection and exits, which is all the
    // loopback redirect needs and leaves nothing listening afterwards.
    callbackListener.command = [
      "socat", "-T", "180",
      "TCP4-LISTEN:" + Ms.normalizedPort(oauthPort) + ",bind=127.0.0.1,reuseaddr",
      "STDIO"
    ]
    callbackListener.running = true
    authTimeout.restart()
  }

  function openAuthorizationPage() {
    if (!loginBusy || callbackHandled || pkceChallenge === "") return
    var url = Ms.authorizationUrl({
      clientId: clientId,
      challenge: pkceChallenge,
      state: oauthState,
      port: oauthPort,
      scopes: scopes,
      loginHint: loginHint !== "" ? loginHint : address
    })
    Quickshell.execDetached(["xdg-open", url])
  }

  function handleCallbackLine(rawLine) {
    if (!loginBusy || callbackHandled) return
    var line = String(rawLine || "").replace(/\r$/, "")
    if (line.indexOf("GET ") !== 0) return
    callbackHandled = true
    authTimeout.stop()
    var callback = Ms.parseCallbackRequestLine(line, Ms.CALLBACK_PATH)
    // A mismatched state means this response did not come from the request
    // this process started, so the code in it is not exchanged.
    if (!callback.ok || callback.state !== oauthState) {
      callbackListener.write(Ms.failureResponse(callbackTheme, callback.error))
      callbackStopTimer.restart()
      failLogin(callback.ok
        ? "Microsoft sign-in could not be verified. Please try again"
        : callback.error, true)
      return
    }
    callbackListener.write(Ms.successResponse(callbackTheme))
    callbackStopTimer.restart()
    exchangeAuthorizationCode(callback.code)
  }

  function exchangeAuthorizationCode(code) {
    exchangingCode = true
    var requestBody = Ms.formBody({
      client_id: clientId,
      code: code,
      code_verifier: pkceVerifier,
      grant_type: "authorization_code",
      redirect_uri: Ms.redirectUri(oauthPort),
      scope: scopes.join(" ")
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
      // No required list passed: the check demands only the resource scopes
      // Microsoft actually reports. See OutlookOAuth.js.
      var missing = Ms.missingScopes(result.scope)
      if (missing.length > 0) {
        root.resetMemorySession()
        root.sessionChecked = true
        root.lastError = Ms.missingScopeMessage(missing)
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
    lastError = safeError(reason || "Microsoft sign-in failed. Please try again")
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
    signedInEmail = ""
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
    // No file is the ordinary first-run state: the built-in client is empty,
    // so sign-in reports that it is not configured rather than crashing.
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
    onTriggered: root.failLogin("Microsoft sign-in took too long. Please try again")
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
        root.failLogin("Could not start a secure Microsoft sign-in. Please try again")
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
    onStarted: {
      authOpenDelay.restart()
    }
    onExited: function(exitCode) {
      if (root.loginBusy && !root.callbackHandled && !root.exchangingCode)
        root.failLogin(exitCode === 0
          ? "The Microsoft sign-in window closed before it finished"
          : "Could not listen on port " + Ms.normalizedPort(root.oauthPort)
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
