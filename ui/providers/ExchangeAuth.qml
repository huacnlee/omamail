import QtQuick

import "ExchangeProtocol.js" as Exchange

// An Exchange account's sign-in: an address, a login and a password.
//
// The same shape from outside as `ImapAuth` and `JmapAuth`. Rust makes every
// request and reads the password from the keyring for each one. The keyring
// lookup at start does hand the password to this object, which only checks that
// there is one and keeps nothing of it; otherwise a password is here only in the
// body of the sign-in check and the keyring write behind it.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  required property string pluginDir
  property var backend: null
  property var platform: null
  property string accountId: ""
  // The login is the address until another is typed.
  property string address: ""
  property var settings: ({ ewsUrl: "", username: "", authScheme: "auto" })

  readonly property string authMode: "password"
  readonly property bool configured: Exchange.validateSettings(settings, address) === ""
  // The one thing a saved password is good for.
  readonly property string serverKey: Exchange.serverKey(settings, address)

  // Signed in is a password in the keyring for the server named now. It counts
  // only once the keyring has answered the write: the backend reads it from there
  // for every request, and one that began earlier would be told there is none.
  property bool stored: false
  property string storedKey: ""
  readonly property bool loggedIn: configured && stored && storedKey === serverKey

  readonly property bool credentialsPresent: configured
  property bool loginBusy: false
  property bool credentialLookupBusy: false
  readonly property bool sessionBusy: credentialLookupBusy
  property string lastError: ""

  readonly property var requiredTools: []
  property var missingTools: []
  property bool toolsChecked: true
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0

  property bool lookedUp: false
  property var waiters: []
  property int lookups: 0
  // The password being checked, here and nowhere else until the keyring has it,
  // and the server and login it is being checked against.
  property string pending: ""
  property string pendingKey: ""
  // Counts the times the mailbox was signed out or removed, so a write that
  // lands afterwards knows to take what it wrote out again.
  property int forgets: 0
  // Counts the sign-ins begun, so a sign-out's last word to the backend is not
  // said over a sign-in that began after it.
  property int signIns: 0

  signal loginSucceeded()
  signal loggedOut()
  signal sessionUnavailable(string reason)
  signal credentialsSaved()
  // Settings the account should keep in place of its own after a sign-in.
  signal settingsLearned(var values)
  // The client owns the transport, so it performs the check and reports back.
  signal verifyRequested(var settings, string address, string secret)

  function fail(text) {
    lastError = text
    return false
  }

  function finishWaiters(value, error) {
    var waiting = waiters
    waiters = []
    for (var i = 0; i < waiting.length; i++) {
      try { waiting[i](value, error) }
      catch (e) { /* consumers own their callback errors */ }
    }
  }

  // The one entry point `MailAccount` uses to ask whether there is a credential.
  function withCredentials(callback) {
    if (typeof callback !== "function") return
    if (!configured) callback(null, "Add this mailbox's server settings first")
    else if (stored) callback(true, "")
    else if (lookedUp) callback(null, "No password saved for this mailbox. Sign in again")
    else {
      waiters = waiters.concat([callback])
      lookup()
    }
  }

  function restoreSession() {
    if (configured) lookup()
    else lookedUp = true
  }

  function lookup() {
    if (credentialLookupBusy) return
    var account = accountId
    var key = serverKey
    if (!platform || typeof platform.credentialGet !== "function" || account === "") {
      answerLookup("", "credential_store_unavailable", key)
      return
    }
    var serial = ++lookups
    credentialLookupBusy = true
    platform.credentialGet("exchange-password", account, "", function(value, error) {
      if (serial !== root.lookups) return
      root.credentialLookupBusy = false
      if (account === root.accountId) root.answerLookup(error ? "" : value, error, key)
    })
  }

  // The keyring holds a password only for the saved server and login (the setup
  // page removes it before saving others), and only while those are still the
  // settings the lookup was started for.
  function answerLookup(value, error, key) {
    var missing = !error || error === "credential_missing"
    lookedUp = missing
    var found = missing && String(value || "") !== "" && key === serverKey
    var reason = missing ? "No password saved for this mailbox. Sign in again" : "The credential store is unavailable"
    if (found) {
      stored = true
      storedKey = key
    }
    if (!missing) lastError = reason
    finishWaiters(found ? true : null, found ? "" : reason)
    // An account still being typed into has no password by design.
    if (!found && configured) sessionUnavailable(missing ? "Sign in to this mailbox" : reason)
    if (found) loginSucceeded()
  }

  // Called by the setup page once the form is filled in. The password is verified
  // by using it, not by being written down first and failing later on a page with
  // no field to correct.
  function signIn(secret) {
    if (platform && platform.canAccessCredentials === false)
      return fail("Install or update the mail backend before signing in")
    if (!toolsPresent) return fail("Missing " + missingTools.join(", "))
    if (loginBusy) return false
    // What is checked is what is saved: a pasted line break goes, any other
    // control character refuses the password before it is sent or stored.
    var typed = Exchange.typedPassword(secret)
    if (typed === null) return fail(Exchange.PASSWORD_CONTROL)
    if (typed === "") return fail("Enter the password for this mailbox")
    var problem = Exchange.validateSettings(settings, address)
    if (address === "" || problem !== "") return fail(problem || "Add the email address for this mailbox")
    lastError = ""
    loginBusy = true
    signIns++
    pending = typed
    pendingKey = serverKey
    verifyRequested(settings, address, typed)
    return true
  }

  // `error` is the sentence when the check failed. A check that finds nothing
  // pending was cancelled or signed out meanwhile, and its password goes nowhere.
  function completeSignIn(ok, result, error) {
    var secret = pending
    pending = ""
    if (pendingKey !== serverKey) secret = ""
    if (secret === "" || !ok) {
      loginBusy = false
      if (secret !== "") fail(error || Exchange.sentence("exchange_unauthorized", true))
      return
    }
    store(secret, function(saved) {
      loginBusy = false
      if (!saved) {
        fail("The password could not be saved to the system keyring. Check that it is unlocked, then sign in again")
        return
      }
      stored = true
      storedKey = serverKey
      lastError = ""
      var learned = Exchange.settingsAfterSignIn(settings, result)
      if (learned) settingsLearned(learned)
      credentialsSaved()
      loginSucceeded()
    })
  }

  function store(secret, done) {
    var account = accountId
    var generation = forgets
    var value = secret
    if (!platform || typeof platform.credentialPut !== "function" || account === "") {
      done(false)
      return
    }
    platform.credentialPut("exchange-password", account, "", value, function(ok) {
      value = ""
      if (!root) return
      // Signed out or removed while it was written: what it wrote goes again,
      // and the sign-in it finished is over.
      if (generation !== root.forgets) {
        root.erase(account)
        if (account === root.accountId) root.loginBusy = false
      } else if (account === root.accountId) done(ok === true)
    })
  }

  // `done(removed)`: false when the keyring did not confirm the delete.
  function erase(account, done) {
    if (!platform || typeof platform.credentialDelete !== "function" || account === "") {
      if (typeof done === "function") done(true)
      return
    }
    platform.credentialDelete("exchange-password", account, "", function(ok) {
      if (typeof done === "function") done(ok === true)
    })
  }

  // The password goes before settings that name another server or login are
  // saved: the backend reads the two separately, and would otherwise hand the
  // old password to the new server in the time between. So does one already
  // kept for `next`, the account the settings are about to be saved as (a
  // removal whose delete failed leaves one there). A delete that fails must
  // stop the save, which `done(false)` tells the caller.
  function releaseStored(done, next) {
    stored = false
    pending = ""
    forgets++
    var other = String(next || "")
    if (other === "" || other === accountId) {
      erase(accountId, done)
      return
    }
    erase(accountId, function(first) {
      erase(other, function(second) { if (typeof done === "function") done(first && second) })
    })
  }

  // What removing the mailbox owes the keyring, and the backend its session.
  // The session goes at once, so a request that read the password and is waiting
  // for its turn is refused rather than signing in while the delete is slow; and
  // again once the keyring has answered, for one that read the password in
  // between. After that a request finds no password. The second goes only if no
  // sign-in to this mailbox has begun since, whose password it would refuse. The
  // backend outlives this object, which a removal ends.
  function forgetCredential() {
    var account = accountId
    var pipe = backend
    var begun = signIns
    function invalidate() {
      if (account !== "" && pipe && pipe.ready)
        pipe.call("exchange.invalidate", { accountId: account }, function() {})
    }
    invalidate()
    releaseStored(function() {
      if (!root || root.accountId !== account || root.signIns === begun) invalidate()
    })
    loginBusy = false
    lookedUp = true
  }

  function logout() {
    forgetCredential()
    loggedOut()
  }

  // The setup form drives sign-in, not a browser.
  function beginLogin() {}
  function cancelLogin() {
    pending = ""
    loginBusy = false
  }

  onAccountIdChanged: {
    stored = false
    lookedUp = false
    pending = ""
    loginBusy = false
    lookups++
    credentialLookupBusy = false
    finishWaiters(null, "The mailbox changed before its credential was loaded")
  }
}
