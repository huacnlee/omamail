import QtQuick
import Quickshell
import Quickshell.Io

import "JmapProtocol.js" as Jmap
import "Credentials.js" as Credentials
import "Secrets.js" as Secrets

// A JMAP account's sign-in, which is a server address and an API token.
//
// The counterpart to `AuthManager` and `ImapAuth`, and deliberately the same
// shape from outside: `MailAccount` asks any of them whether it is `loggedIn`
// and asks for a credential with one call whose callback takes
// `(value, error)`.
//
// Simpler than either. There is no browser and no refresh, because a token is
// issued once by the user and lasts until they revoke it — and unlike a
// password there is no username to pair it with, since the session resource
// names the account itself.
//
// The token lives in GNOME Keyring, written over stdin so it never reaches the
// process table, and keyed by account so two mailboxes cannot overwrite each
// other.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir

  property string accountId: ""

  // The server this account is on, as the user typed it. Normalised here
  // rather than trusted, so a host from a hand-edited accounts.json passes the
  // same check as one typed into the form.
  property string configuredHost: ""
  readonly property string host: Jmap.normalizeHost(configuredHost)
  readonly property bool configured: Jmap.isValidHost(configuredHost)

  // The token, once the keyring has answered. Held for as long as the account
  // exists, exactly as the access token and the IMAP password are: every
  // request needs it, and a keyring round trip per request would be slow and,
  // on some setups, a stream of authorisation prompts.
  property string token: ""
  property bool tokenChecked: false
  readonly property bool loggedIn: configured && token !== ""

  // The names `MailAccount` reads without knowing which provider it holds.
  readonly property bool credentialsPresent: configured
  property bool loginBusy: false
  readonly property bool sessionBusy: secretLookup.running || keyringStore.running
  readonly property bool recoveringSession: configured && !tokenChecked
  property string lastError: ""

  // secret-tool keeps the token; curl is the client's transport for the parts
  // that are not XHR. Neither is exotic, and both are checked before the setup
  // page offers to save anything.
  readonly property var requiredTools: ["secret-tool", "curl"]
  property var missingTools: []
  property bool toolsChecked: false
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0

  property var credentialWaiters: []
  property bool lookupHandled: false
  property string pendingToken: ""

  signal loginSucceeded()
  signal loggedOut()
  signal sessionUnavailable(string reason)
  signal credentialsSaved()

  // The client owns the transport, so it performs the check and reports back
  // through `completeSignIn`.
  signal verifyRequested(string host, string token)

  // A token is a bearer credential: anything holding it is the account. It must
  // never reach an error string, which is shown on screen and may be copied
  // into a bug report.
  function safeError(value) {
    var text = String(value || "")
    if (root.pendingToken !== "") text = text.split(root.pendingToken).join("<token>")
    if (root.token !== "") text = text.split(root.token).join("<token>")
    return text
  }

  function finishWaiters(value, error) {
    var pending = credentialWaiters.slice()
    credentialWaiters = []
    for (var i = 0; i < pending.length; i++) {
      try { pending[i](value || "", safeError(error)) }
      catch (e) { /* consumers own their callback errors */ }
    }
  }

  // The one entry point the transport uses.
  function withToken(callback) {
    if (typeof callback !== "function") return
    if (!configured) {
      callback("", "Add this mailbox's server address first")
      return
    }
    if (token !== "") {
      callback(token, "")
      return
    }
    if (tokenChecked) {
      callback("", "No token saved for this mailbox. Sign in again")
      return
    }

    var next = credentialWaiters.slice()
    next.push(callback)
    credentialWaiters = next
    if (secretLookup.running) return
    startSecretLookup()
  }

  function restoreSession() {
    if (!configured) {
      tokenChecked = true
      return
    }
    if (secretLookup.running) return
    startSecretLookup()
  }

  function startSecretLookup() {
    var attributes = Credentials.jmapKeyringAttributes(accountId)
    if (attributes.length === 0) {
      handleSecretLookup("")
      return
    }
    lookupHandled = false
    secretLookup.command = ["secret-tool", "lookup"].concat(attributes)
    secretLookup.running = true
  }

  function handleSecretLookup(line) {
    if (lookupHandled) return
    lookupHandled = true
    tokenChecked = true
    var value = String(line || "")
    if (value === "") {
      finishWaiters("", "No token saved for this mailbox. Sign in again")
      // Only a mailbox otherwise ready to go is worth complaining about: an
      // account still being typed into has no token by design.
      if (configured) sessionUnavailable("Sign in to this mailbox")
      return
    }
    token = value
    finishWaiters(token, "")
    loginSucceeded()
  }

  // Called by the setup page once the form is filled in. The token is verified
  // by using it — a server that answers the session resource will answer
  // everything else — rather than being written down first and failing later.
  function signIn(secret) {
    var value = String(secret || "").trim()
    if (value === "") {
      lastError = "Enter this mailbox's API token"
      return false
    }
    if (!configured) {
      lastError = "Enter the address of the JMAP server"
      return false
    }
    lastError = ""
    loginBusy = true
    pendingToken = value
    verifyRequested(host, value)
    return true
  }

  function completeSignIn(ok, error) {
    loginBusy = false
    if (!ok) {
      pendingToken = ""
      lastError = safeError(error) || "The server refused that token"
      return
    }
    token = pendingToken
    pendingToken = ""
    tokenChecked = true
    lastError = ""
    storeToken()
    loginSucceeded()
  }

  function storeToken() {
    var attributes = Credentials.jmapKeyringAttributes(accountId)
    if (attributes.length === 0 || token === "") return
    keyringWriteSecret = token
    keyringStore.command = [pluginDir + "/scripts/keyring-store.sh"].concat(attributes)
    keyringStore.running = true
  }

  property string keyringWriteSecret: ""

  function logout() {
    token = ""
    pendingToken = ""
    tokenChecked = true
    var attributes = Credentials.jmapKeyringAttributes(accountId)
    if (attributes.length > 0) {
      keyringClear.command = ["secret-tool", "clear"].concat(attributes)
      keyringClear.running = true
    }
    loggedOut()
  }

  // A token does not expire, so there is nothing to refresh — but a server that
  // has started refusing it should not be asked a hundred more times with the
  // same value.
  function invalidateAccessToken() {
    token = ""
    tokenChecked = false
  }

  // The Gmail manager has these; a token account reaches neither, and
  // `MailAccount` should not have to ask which provider it holds.
  function beginLogin() { /* the setup form drives sign-in, not a browser */ }
  function cancelLogin() { loginBusy = false }

  onAccountIdChanged: {
    // A different mailbox has a different token. Dropping the one in memory is
    // what stops a rename from leaving the previous account's credential in
    // front of the new one's server.
    token = ""
    tokenChecked = false
    lookupHandled = false
  }

  Component.onCompleted: {
    toolProbe.command = ["sh", "-c",
      "for tool in secret-tool curl; do command -v \"$tool\" >/dev/null 2>&1 || echo \"$tool\"; done"]
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
    stdout: StdioCollector { id: secretOutput; waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(exitCode) {
      // One trailing newline is the pipe's; everything else is the secret.
      var value = exitCode === 0 ? Secrets.fromKeyring(secretOutput.text) : ""
      root.handleSecretLookup(value)
    }
  }

  Process {
    id: keyringStore
    stdinEnabled: true
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onStarted: {
      write(root.keyringWriteSecret + "\n")
      root.keyringWriteSecret = ""
    }
    onExited: function(exitCode) {
      root.keyringWriteSecret = ""
      if (exitCode !== 0)
        root.lastError = "Signed in, but the token could not be saved. "
          + "You may need to enter it again after a restart"
    }
  }

  Process {
    id: keyringClear
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
  }
}
