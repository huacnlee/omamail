import QtQuick
import Quickshell
import Quickshell.Io

import "ImapProtocol.js" as Imap
import "Credentials.js" as Credentials
import "Secrets.js" as Secrets

// An IMAP account's sign-in, which is a server address and a password — or,
// for Microsoft 365 XOAUTH2, an access token from `ortie`.
//
// It is the counterpart to `AuthManager`, and deliberately the same shape from
// outside: `MailAccount` asks either of them whether it is `loggedIn`, and asks
// for a credential with one call whose callback takes `(value, error)`. What
// differs is everything inside. Password IMAP has no browser and nothing that
// expires. XOAUTH2 still has no browser here: `ortie` already holds the
// refresh token, and `ortie token show` is what refreshes.
//
// Where the secret lives follows the same rule as the Gmail refresh token:
// GNOME Keyring, never the process table, keyed by account. XOAUTH2 tokens
// live under ortie's own keyring entry, not the IMAP password slot.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir
  readonly property string home: Quickshell.env("HOME") || ""

  // Which mailbox this signs in. Unlike Gmail's, an IMAP account knows its own
  // address from the moment it is created — the user typed it — so this is set
  // before anything is asked of the server rather than after a profile read.
  property string accountId: ""

  // Server settings, pushed down from the account entry. Held as the validated
  // shape rather than as whatever was in the file.
  property var settings: Imap.normalizeSettings(null)
  readonly property bool usesXoauth2: Imap.usesXoauth2(settings)
  readonly property string tokenAccount: Imap.tokenAccountOf(settings)

  readonly property bool configured: Imap.validateSettings(settings).ok

  // The password, once the keyring has answered. Held in this process for as
  // long as the account exists, exactly as the access token is: every request
  // needs it, and a keyring round trip per request would be both slow and a
  // stream of authorisation prompts on some setups.
  property string password: ""
  property bool passwordChecked: false
  readonly property bool loggedIn: configured && password !== ""

  // The same three names `AuthManager` exposes, because `MailAccount` reads
  // them without knowing which provider it has.
  readonly property bool credentialsPresent: configured
  property bool loginBusy: false
  readonly property bool sessionBusy: secretLookup.running || keyringStore.running
  property string lastError: ""

  // Password IMAP needs secret-tool. XOAUTH2 also needs ortie on PATH or in
  // ~/.local/bin. curl is checked by the client either way.
  readonly property var requiredTools: usesXoauth2
    ? ["secret-tool", "curl", "ortie"]
    : ["secret-tool", "curl"]
  property var probedMissing: []
  property var missingTools: []
  property bool toolsChecked: false
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0

  function applyMissingTools() {
    var found = []
    for (var i = 0; i < probedMissing.length; i++) {
      var name = probedMissing[i]
      if (name === "ortie" && !usesXoauth2) continue
      found.push(name)
    }
    missingTools = found
  }

  onUsesXoauth2Changed: applyMissingTools()

  property var credentialWaiters: []
  property bool lookupHandled: false
  property string pendingPassword: ""

  signal loginSucceeded()
  signal loggedOut()
  signal sessionUnavailable(string reason)
  signal credentialsSaved()

  function safeError(value) {
    return Imap.redact(String(value || ""))
  }

  function finishWaiters(value, error) {
    var pending = credentialWaiters.slice()
    credentialWaiters = []
    for (var i = 0; i < pending.length; i++) {
      try { pending[i](value || "", safeError(error)) }
      catch (e) { /* consumers own their callback errors */ }
    }
  }

  // The one entry point the transport uses. Hands back curl credentials —
  // `user:password`, or `oauth2-bearer:<user>:<token>` for XOAUTH2 — so
  // nothing downstream has to know how they are joined.
  function withCredentials(callback) {
    if (typeof callback !== "function") return
    if (!configured) {
      callback("", "Add this mailbox's server settings first")
      return
    }
    if (password !== "") {
      callback(Imap.imapCredentials(settings, password), "")
      return
    }
    if (passwordChecked) {
      callback("", usesXoauth2
        ? "No OAuth token for this mailbox. Run the Microsoft OAuth setup (ortie)"
        : "No password saved for this mailbox. Sign in again")
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
      passwordChecked = true
      return
    }
    if (secretLookup.running) return
    startSecretLookup()
  }

  function startSecretLookup() {
    lookupHandled = false
    if (usesXoauth2) {
      if (tokenAccount === "") {
        handleSecretLookup("")
        return
      }
      var bin = home !== "" ? (home + "/.local/bin/ortie") : "ortie"
      secretLookup.command = [bin, "token", "show", "-a", tokenAccount]
      secretLookup.running = true
      return
    }
    var attributes = Credentials.imapKeyringAttributes(accountId)
    if (attributes.length === 0) {
      handleSecretLookup("")
      return
    }
    secretLookup.command = ["secret-tool", "lookup"].concat(attributes)
    secretLookup.running = true
  }

  function handleSecretLookup(line) {
    if (lookupHandled) return
    lookupHandled = true
    passwordChecked = true
    loginBusy = false
    var value = String(line || "")
    if (value === "") {
      var missing = usesXoauth2
        ? "No OAuth token for this mailbox. Run the Microsoft OAuth setup (ortie)"
        : "No password saved for this mailbox. Sign in again"
      finishWaiters("", missing)
      // Only a mailbox that is otherwise ready to go is worth complaining
      // about: an account still being typed into has no password by design.
      if (configured)
        sessionUnavailable(usesXoauth2
          ? "Sign in with Microsoft OAuth"
          : "Sign in to this mailbox")
      return
    }
    password = value
    finishWaiters(Imap.imapCredentials(settings, password), "")
    loginSucceeded()
  }

  // Called by the setup page once the user has filled the form in. The password
  // is verified by using it — a mailbox that answers a NOOP is a mailbox that
  // will answer everything else — rather than by being written down first and
  // failing silently later. XOAUTH2 has no password to paste: the token helper
  // already signed in, so this just asks it for a token.
  function signIn(secret) {
    if (usesXoauth2) {
      var oauthCheck = Imap.validateSettings(settings)
      if (!oauthCheck.ok) {
        lastError = oauthCheck.error
        return false
      }
      lastError = ""
      loginBusy = true
      pendingPassword = ""
      startSecretLookup()
      return true
    }
    var value = String(secret || "")
    if (value === "") {
      lastError = "Enter the password for this mailbox"
      return false
    }
    var check = Imap.validateSettings(settings)
    if (!check.ok) {
      lastError = check.error
      return false
    }
    lastError = ""
    loginBusy = true
    pendingPassword = value
    verifyRequested(settings, settings.username + ":" + value)
    return true
  }

  // The client owns the transport, so it performs the check and reports back.
  signal verifyRequested(var settings, string credentials)

  function completeSignIn(ok, error) {
    loginBusy = false
    if (!ok) {
      pendingPassword = ""
      lastError = safeError(error) || "The server rejected that username or password"
      return
    }
    password = pendingPassword
    pendingPassword = ""
    passwordChecked = true
    lastError = ""
    storePassword()
    loginSucceeded()
  }

  function storePassword() {
    if (usesXoauth2) return
    var attributes = Credentials.imapKeyringAttributes(accountId)
    if (attributes.length === 0 || password === "") return
    keyringWriteSecret = password
    keyringStore.command = [pluginDir + "/scripts/keyring-store.sh"].concat(attributes)
    keyringStore.running = true
  }

  property string keyringWriteSecret: ""

  function logout() {
    password = ""
    pendingPassword = ""
    passwordChecked = true
    var attributes = Credentials.imapKeyringAttributes(accountId)
    if (attributes.length > 0) {
      keyringClear.command = ["secret-tool", "clear"].concat(attributes)
      keyringClear.running = true
    }
    loggedOut()
  }

  // Kept so `MailAccount` can call the same thing on either provider. An IMAP
  // password does not expire, so there is nothing to invalidate — but a server
  // that has started rejecting it should not be asked a hundred more times
  // with the same value.
  function invalidateAccessToken() {
    password = ""
    passwordChecked = false
  }

  // The Gmail manager has these; an IMAP account reaches neither, and
  // `MailAccount` should not have to ask which provider it holds before
  // calling one.
  function beginLogin() { /* the setup form drives sign-in, not a browser */ }
  function cancelLogin() { loginBusy = false }

  onAccountIdChanged: {
    // A different mailbox has a different password. Dropping the one in memory
    // is what stops an account rename from leaving the previous account's
    // credential in front of the new one's server.
    password = ""
    passwordChecked = false
    lookupHandled = false
  }

  Component.onCompleted: {
    toolProbe.command = ["sh", "-c",
      "for tool in secret-tool curl; do command -v \"$tool\" >/dev/null 2>&1 || echo \"$tool\"; done; "
        + "command -v ortie >/dev/null 2>&1 || test -x \"$HOME/.local/bin/ortie\" || echo ortie"]
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
        root.probedMissing = found
        root.applyMissingTools()
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
        root.lastError = "Signed in, but the password could not be saved. "
          + "You may need to enter it again after a restart"
    }
  }

  Process {
    id: keyringClear
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
  }
}
