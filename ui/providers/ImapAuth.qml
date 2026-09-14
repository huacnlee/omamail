import QtQuick
import Quickshell
import Quickshell.Io

import "ImapProtocol.js" as Imap

// An IMAP account's sign-in, which is a server address and a password.
//
// It is the counterpart to `AuthManager`, and deliberately the same shape from
// outside: `MailAccount` asks either of them whether it is `loggedIn`, and asks
// for a credential with one call whose callback takes `(value, error)`. What
// differs is everything inside — there is no browser, no token to refresh and
// nothing that expires.
//
// Where the secret lives follows the same rule as the refresh token: GNOME
// Keyring, written over stdin so it never reaches the process table, and keyed
// by account so two mailboxes cannot overwrite each other.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir
  property var backend: null
  property var platform: null

  // Which mailbox this signs in. Unlike Gmail's, an IMAP account knows its own
  // address from the moment it is created — the user typed it — so this is set
  // before anything is asked of the server rather than after a profile read.
  property string accountId: ""

  // Server settings, pushed down from the account entry. Held as the validated
  // shape rather than as whatever was in the file.
  property var settings: Imap.normalizeSettings(null)

  readonly property string authMode: "password"

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
  property bool credentialLookupBusy: false
  property bool credentialWriteBusy: false
  property int credentialLookupSerial: 0
  property string credentialWriteAccount: ""
  property string pendingCredentialDelete: ""
  readonly property bool sessionBusy: credentialLookupBusy || credentialWriteBusy
  property string lastError: ""

  // Native credential storage and network transport are backend capabilities.
  readonly property var requiredTools: []
  property var missingTools: []
  property bool toolsChecked: true
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0

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

  // The one entry point the transport uses. Hands back "user:password" — the
  // single credential field the native client consumes — rather than the two halves, so nothing
  // downstream has to know how they are joined.
  function withCredentials(callback) {
    if (typeof callback !== "function") return
    if (!configured) {
      callback("", "Add this mailbox's server settings first")
      return
    }
    if (password !== "") {
      callback(settings.username + ":" + password, "")
      return
    }
    if (passwordChecked) {
      callback("", "No password saved for this mailbox. Sign in again")
      return
    }

    var next = credentialWaiters.slice()
    next.push(callback)
    credentialWaiters = next
    if (credentialLookupBusy) return
    startSecretLookup()
  }

  function restoreSession() {
    if (!configured) {
      passwordChecked = true
      return
    }
    if (credentialLookupBusy) return
    startSecretLookup()
  }

  function startSecretLookup() {
    var boundAccount = accountId
    if (!platform || typeof platform.credentialGet !== "function" || boundAccount === "") {
      handleSecretLookup("", "credential_store_unavailable")
      return
    }
    lookupHandled = false
    var serial = ++credentialLookupSerial
    credentialLookupBusy = true
    platform.credentialGet("imap-password", boundAccount, "", function(value, error) {
      if (serial !== root.credentialLookupSerial) return
      root.credentialLookupBusy = false
      if (boundAccount !== root.accountId) return
      root.handleSecretLookup(error ? "" : value, error)
    })
  }

  function handleSecretLookup(line, error) {
    if (lookupHandled) return
    lookupHandled = true
    if (error && error !== "credential_missing") {
      passwordChecked = false
      lastError = "The credential store is unavailable"
      finishWaiters("", lastError)
      if (configured) sessionUnavailable(lastError)
      return
    }
    passwordChecked = true
    var value = String(line || "")
    if (value === "") {
      finishWaiters("", "No password saved for this mailbox. Sign in again")
      // Only a mailbox that is otherwise ready to go is worth complaining
      // about: an account still being typed into has no password by design.
      if (configured) sessionUnavailable("Sign in to this mailbox")
      return
    }
    password = value
    finishWaiters(settings.username + ":" + password, "")
    loginSucceeded()
  }

  // Called by the setup page once the user has filled the form in. The password
  // is verified by using it — a mailbox that answers a NOOP is a mailbox that
  // will answer everything else — rather than by being written down first and
  // failing silently later.
  function signIn(secret) {
    if (platform && platform.canAccessCredentials === false) {
      lastError = "Install or update the mail backend before signing in"
      return false
    }
    if (!toolsPresent) {
      lastError = "Missing " + missingTools.join(", ")
      return false
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
    if (!platform || typeof platform.credentialPut !== "function" || accountId === ""
        || password === "" || credentialWriteBusy) return
    var boundAccount = accountId
    var value = password
    credentialWriteBusy = true
    credentialWriteAccount = boundAccount
    platform.credentialPut("imap-password", boundAccount, "", value, function(ok, error) {
      value = ""
      root.credentialWriteBusy = false
      root.credentialWriteAccount = ""
      var deleteAccount = root.pendingCredentialDelete
      root.pendingCredentialDelete = ""
      if (deleteAccount !== "") {
        root.deleteCredential(deleteAccount)
        return
      }
      if (boundAccount !== root.accountId) return
      if (!ok) root.lastError = "Signed in, but the password could not be saved. "
        + "You may need to enter it again after a restart"
      else root.credentialsSaved()
    })
  }

  function deleteCredential(boundAccount) {
    if (platform && typeof platform.credentialDelete === "function" && boundAccount !== "")
      platform.credentialDelete("imap-password", boundAccount, "", function() {})
  }

  function logout() {
    var boundAccount = accountId
    password = ""
    pendingPassword = ""
    passwordChecked = true
    if (credentialWriteBusy && credentialWriteAccount === boundAccount)
      pendingCredentialDelete = boundAccount
    else deleteCredential(boundAccount)
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
    credentialLookupSerial++
    credentialLookupBusy = false
    finishWaiters("", "The mailbox changed before its credential was loaded")
    if (credentialWriteBusy && credentialWriteAccount !== "")
      pendingCredentialDelete = credentialWriteAccount
  }

}
