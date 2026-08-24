import QtQuick
import Quickshell
import Quickshell.Io

import "JmapApi.js" as Jmap
import "Credentials.js" as Credentials

// A JMAP account's bearer token. It is verified against the session endpoint
// before being stored, kept in GNOME Keyring, and passed to the transport only
// through callbacks — never a command line or the world-readable shell config.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir
  property string accountId: ""

  property string accessToken: ""
  property bool tokenChecked: false
  readonly property bool loggedIn: accessToken !== ""
  readonly property bool credentialsPresent: accountId !== ""
  property bool loginBusy: false
  readonly property bool sessionBusy: secretLookup.running || keyringStore.running
  readonly property bool recoveringSession: sessionBusy && !loggedIn
  property string lastError: ""

  readonly property var requiredTools: ["secret-tool"]
  property var missingTools: []
  property bool toolsChecked: false
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0

  property var tokenWaiters: []
  property bool lookupHandled: false
  property string pendingToken: ""
  property string keyringWriteToken: ""

  signal loginSucceeded()
  signal loggedOut()
  signal sessionUnavailable(string reason)
  signal credentialsSaved()
  signal verifyRequested(string token)

  function safeError(value) {
    return Jmap.redact(String(value || ""))
  }

  function finishWaiters(value, error) {
    var pending = tokenWaiters.slice()
    tokenWaiters = []
    for (var i = 0; i < pending.length; i++) {
      try { pending[i](value || "", safeError(error)) }
      catch (e) { /* consumers own their callback errors */ }
    }
  }

  function withAccessToken(callback) {
    if (typeof callback !== "function") return
    if (accessToken !== "") {
      callback(accessToken, "")
      return
    }
    if (tokenChecked) {
      callback("", "No API token saved for this mailbox. Sign in again")
      return
    }
    var next = tokenWaiters.slice()
    next.push(callback)
    tokenWaiters = next
    if (!secretLookup.running) startSecretLookup()
  }

  function restoreSession() {
    if (secretLookup.running || accessToken !== "") return
    startSecretLookup()
  }

  function startSecretLookup() {
    lookupHandled = false
    secretLookup.command = ["secret-tool", "lookup"]
      .concat(Credentials.jmapKeyringAttributes(accountId))
    secretLookup.running = true
  }

  function handleSecretLookup(line) {
    if (lookupHandled) return
    lookupHandled = true
    tokenChecked = true
    var value = String(line || "")
    if (value === "") {
      finishWaiters("", "No API token saved for this mailbox. Sign in again")
      if (accountId !== "") sessionUnavailable("Sign in to this mailbox")
      return
    }
    accessToken = value
    finishWaiters(accessToken, "")
    loginSucceeded()
  }

  function signIn(secret) {
    var value = String(secret || "").trim()
    if (value === "") {
      lastError = "Enter the API token for this mailbox"
      return false
    }
    lastError = ""
    loginBusy = true
    pendingToken = value
    verifyRequested(value)
    return true
  }

  function completeSignIn(ok, error) {
    loginBusy = false
    if (!ok) {
      pendingToken = ""
      lastError = safeError(error) || "The JMAP server rejected that API token"
      return
    }
    accessToken = pendingToken
    pendingToken = ""
    tokenChecked = true
    lastError = ""
    storeToken()
    loginSucceeded()
  }

  function storeToken() {
    if (accessToken === "") return
    keyringWriteToken = accessToken
    keyringStore.command = [pluginDir + "/scripts/keyring-store.sh"]
      .concat(Credentials.jmapKeyringAttributes(accountId))
    keyringStore.running = true
  }

  function logout() {
    accessToken = ""
    pendingToken = ""
    tokenChecked = true
    keyringClear.command = ["secret-tool", "clear"]
      .concat(Credentials.jmapKeyringAttributes(accountId))
    keyringClear.running = true
    loggedOut()
  }

  function invalidateAccessToken() {
    accessToken = ""
    tokenChecked = true
  }

  function beginLogin() { /* the setup form supplies the token */ }
  function cancelLogin() {
    loginBusy = false
    pendingToken = ""
  }

  onAccountIdChanged: {
    accessToken = ""
    tokenChecked = false
    lookupHandled = false
  }

  Component.onCompleted: {
    toolProbe.command = ["sh", "-c",
      "command -v secret-tool >/dev/null 2>&1 || echo secret-tool"]
    toolProbe.running = true
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
        root.lastError = "Signed in, but the API token could not be saved. "
          + "You may need to enter it again after a restart"
      else root.credentialsSaved()
    }
  }

  Process {
    id: keyringClear
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
  }
}
