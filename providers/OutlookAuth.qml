import QtQuick
import Quickshell
import Quickshell.Io

import "ImapProtocol.js" as Imap
import "Outlook.js" as Outlook
import "MicrosoftOAuth.js" as Microsoft
import "Credentials.js" as Credentials
import "Secrets.js" as Secrets

// Microsoft sign-in for the Outlook provider. The refresh token lives in
// GNOME Keyring, the access token lives only in this process, and curl receives
// it over stdin for XOAUTH2 authentication to IMAP and SMTP.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir
  property string accountId: ""
  property string configuredClientId: ""
  readonly property string clientId: Microsoft.effectiveClientId(configuredClientId)
  property string configuredEmail: ""
  // Microsoft grants this token for its own mail service. Persisted generic
  // IMAP settings must never select its destination or disable transport TLS.
  readonly property var settings: Outlook.settings(configuredEmail)
  property var scopes: Microsoft.SCOPES

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

  readonly property var requiredTools: ["secret-tool", "curl", "xdg-open"]
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

  property var tokenRequest: null
  property int tokenRequestSerial: 0
  readonly property int tokenTimeoutMs: 30000

  signal loginSucceeded()
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
  }

  function invalidateAccessToken() {
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
      return
    }
    var next = keyringJobs.slice()
    keyringJob = next.shift()
    keyringJobs = next
    keyringProcess.command = keyringJob.kind === "store"
      ? [pluginDir + "/scripts/keyring-store.sh"].concat(keyringJob.attributes)
      : ["secret-tool", "clear"].concat(keyringJob.attributes)
    keyringProcess.running = true
  }

  function postForm(url, body, callback) {
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
      if (typeof callback === "function") callback(request.status, request.responseText)
    }
    request.open("POST", url)
    request.setRequestHeader("Content-Type", "application/x-www-form-urlencoded")
    request.send(body)

    if (deadline) {
      deadline.triggered.connect(function() {
        if (request.abort) request.abort()
      })
      deadline.start()
    }
  }

  function refreshWithToken(refreshToken, context) {
    refreshBusy = true
    postForm(Microsoft.TOKEN_URL,
      Microsoft.refreshTokenBody(clientId, refreshToken, scopes),
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
    if (loginBusy || refreshBusy) return
    if (!credentialsPresent) {
      lastError = "Add the mailbox address and Microsoft OAuth client ID first"
      return
    }
    if (!toolsPresent && toolsChecked) {
      lastError = "Missing " + missingTools.join(", ")
      return
    }
    cancelLogin()
    sessionEnabled = true
    var context = sessionContext()
    lastError = ""
    loginBusy = true
    postForm(Microsoft.DEVICE_URL,
      Microsoft.deviceAuthorizationBody(clientId, scopes),
      function(status, text) {
        if (!root.isCurrent(context)) return
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
    if (!loginBusy || deviceCode === "") return
    if (Date.now() >= deviceExpiresAt) {
      failLogin("The Microsoft sign-in code expired. Please try again")
      return
    }
    var context = sessionContext()
    postForm(Microsoft.TOKEN_URL,
      Microsoft.deviceTokenBody(clientId, deviceCode),
      function(status, text) {
        if (!root.isCurrent(context)) return
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
        root.deviceCode = ""
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
      expiresIn: pendingExpiresIn
    })
    clearPendingToken()
    loginBusy = false
    sessionChecked = true
    acceptToken(result)
    finishWaiters(accessToken, "")
    loginSucceeded()
  }

  function clearPendingToken() {
    pendingAccessToken = ""
    pendingRefreshToken = ""
    pendingExpiresIn = 0
  }

  function cancelDeviceLogin() {
    devicePoll.stop()
    deviceCode = ""
    userCode = ""
    verificationUri = ""
    deviceExpiresAt = 0
    clearPendingToken()
  }

  function failLogin(reason) {
    lastError = safeError(reason || "Microsoft sign-in failed. Please try again")
    loginBusy = false
    cancelDeviceLogin()
    finishWaiters("", lastError)
    sessionUnavailable(lastError)
  }

  function cancelLogin() {
    sessionGeneration++
    var oldLookup = lookupProcess
    lookupProcess = null
    if (oldLookup) oldLookup.running = false
    restoreQueued = false
    refreshRetry.stop()
    cancelDeviceLogin()
    tokenRequestSerial++
    if (tokenRequest && tokenRequest.abort) tokenRequest.abort()
    tokenRequest = null
    refreshBusy = false
    loginBusy = false
    finishWaiters("", "Sign-in cancelled")
  }

  function logout() {
    sessionEnabled = false
    cancelLogin()
    refreshRetry.stop()
    refreshRetryAttempt = 0
    savedSessionPresent = false
    resetMemorySession()
    sessionChecked = true
    lastError = ""
    finishWaiters("", "Signed out")
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

  Component {
    id: tokenDeadlineComponent
    Timer { repeat: false }
  }

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
      stdout: StdioCollector { waitForEnd: true }
      stderr: StdioCollector { waitForEnd: true }
      onExited: function(exitCode) {
        if (root.lookupProcess === lookup) root.lookupProcess = null
        var value = exitCode === 0 ? Secrets.fromKeyring(stdout.text) : ""
        root.handleSecretLookup(value, context)
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
