import QtQuick
import Quickshell
import Quickshell.Io

import "JmapProtocol.js" as Jmap
import "Credentials.js" as Credentials
import "Secrets.js" as Secrets

// A JMAP account's sign-in, which is an address and one secret.
//
// Same shape from outside as `ImapAuth` and `AuthManager`: `MailAccount` asks
// whether it is `loggedIn` and asks for a credential with one call whose
// callback takes `(value, error)`. What differs is what a credential *is*
// here: a scheme, a username and a secret. Rust constructs and validates the
// Authorization header; QML never assembles one.
//
// The secret is an app password or an API token, and which of the two it is
// decides the scheme. That is detected rather than asked: the client sends the
// session GET with Basic and, only on a 401, once more with Bearer, and the
// scheme that answered is recorded on the account. Nothing here refreshes and
// nothing expires — a 401 afterwards is a credential that was revoked, which
// is the setup page's problem rather than a retry.
//
// Where the secret lives is the same rule as every other credential in this
// plugin: GNOME Keyring, written over stdin so it never reaches the process
// table, keyed by account so two mailboxes cannot overwrite each other.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  property var backend: null
  required property string pluginDir

  // Which mailbox this signs in. Known from the moment the address is typed,
  // as IMAP's is, rather than after a profile read.
  property string accountId: ""

  // The address, which is what discovery has to go on when no server was
  // typed and what the credential's username defaults to.
  property string address: ""

  // The account's `jmap` block, pushed down from the account entry in the
  // shape `Accounts.makeJmapSettings` normalises it to. Before the first
  // sign-in the session URL is either empty — discovery has not run — or
  // whatever the user typed into the disclosure, which is exactly what
  // `Jmap.discoveryPlan` takes as its typed server.
  property var settings: ({ sessionUrl: "", username: "", authScheme: "basic", accountId: "" })

  // A mailbox this client knows where to talk to. Unlike IMAP's, this is not
  // something the user typed: it is what sign-in learned and wrote down.
  readonly property bool configured: String((settings || {}).sessionUrl || "") !== ""
    && String((settings || {}).accountId || "") !== ""

  // The secret, once the keyring has answered. Held for as long as the account
  // exists, exactly as the IMAP password is: every request needs it, and a
  // keyring round trip per request would be both slow and a stream of
  // authorisation prompts on some setups.
  property string secret: ""
  property bool secretChecked: false
  readonly property bool loggedIn: configured && secret !== ""

  // The three names `MailAccount` reads without knowing which provider it has.
  readonly property bool credentialsPresent: configured
  property bool loginBusy: false
  readonly property bool sessionBusy: secretLookup.running || keyringStore.running
  property string lastError: ""

  // Which of the check's three waits is happening, 1 to 3, or 0 when nothing
  // is. The client reports it as it goes, because the client is what knows —
  // finding the server, checking the secret and reading the mailboxes are
  // three requests that look identical from outside, and naming which one is
  // running is the difference between "it is working" and "it is stuck". It
  // reports through `reportProgress` rather than writing here: this object
  // owns the value and is the one that clears it when the check ends.
  property int progressStep: 0

  function reportProgress(step) {
    var value = Math.floor(Number(step))
    progressStep = isFinite(value) && value > 0 ? value : 0
  }

  // Whether the last check ran out of places to look. The page opens its
  // server field on this rather than by reading the sentence it printed:
  // "nothing answered for that domain" is a state, and matching on the words
  // would break the first time somebody reworded them.
  property bool serverNeeded: false

  // Whether the credential that signed in may submit mail. A missing
  // submission capability does not fail sign-in — the mailbox reads perfectly
  // well — so the account signs in and the page says what it cannot do. The
  // standing refusal is the client's, read from the session (`Jmap.refusals`);
  // this is only what the last check found out, for the page's one sentence.
  property bool sendingOffered: true

  // secret-tool holds the credential. Rust owns all network requests.
  readonly property var requiredTools: ["secret-tool"]
  property var missingTools: []
  property bool toolsChecked: false
  readonly property bool toolsPresent: toolsChecked && missingTools.length === 0

  property var credentialWaiters: []
  property bool lookupHandled: false
  property string pendingSecret: ""

  signal loginSucceeded()
  signal loggedOut()
  signal sessionUnavailable(string reason)
  signal credentialsSaved()

  // What sign-in learned, for the account to write down: the session URL that
  // answered, the scheme that worked, and the account id every later request
  // names. `MailAccount` carries it up to the account list, which is the one
  // owner of the entry this object's `settings` are read from — nothing here
  // writes to itself, and the page only shows the URL. Emitted before
  // `loginSucceeded`, so the settings are on the account by the time anything
  // asks the client to fetch with them.
  signal sessionVerified(var result)

  function safeError(value) {
    return Jmap.redact(String(value || ""))
  }

  // Three fields rather than one string. The script joins them into whichever
  // header the scheme needs, and refuses a scheme it does not know before networking
  // starts — so there is no place here where an `Authorization` value is built.
  function credential() {
    var values = settings || {}
    var user = String(values.username || "")
    return Jmap.credential(values.authScheme, user !== "" ? user : String(address || ""), secret)
  }

  function finishWaiters(value, error) {
    var pending = credentialWaiters.slice()
    credentialWaiters = []
    for (var i = 0; i < pending.length; i++) {
      try { pending[i](value, safeError(error)) }
      catch (e) { /* consumers own their callback errors */ }
    }
  }

  // The one entry point the transport uses.
  function withCredentials(callback) {
    if (typeof callback !== "function") return
    if (!configured) {
      callback(null, "Sign in to this mailbox first")
      return
    }
    if (secret !== "") {
      callback(credential(), "")
      return
    }
    if (secretChecked) {
      callback(null, "No app password saved for this mailbox. Sign in again")
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
      secretChecked = true
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
    secretChecked = true
    var value = String(line || "")
    if (value === "") {
      finishWaiters(null, "No app password saved for this mailbox. Sign in again")
      // Only a mailbox that is otherwise ready to go is worth complaining
      // about: an account still being typed into has no secret by design.
      if (configured) sessionUnavailable("Sign in to this mailbox")
      return
    }
    secret = value
    finishWaiters(credential(), "")
    loginSucceeded()
  }

  // Called by the setup page once the form is filled in. The secret is
  // verified by using it — discovery, the session GET under each scheme in
  // turn, and one `Mailbox/get` — rather than being written down first and
  // failing later on a page with no field to correct.
  function signIn(value) {
    var typed = String(value || "")
    // "Save changes" re-verifies, and the field it would have come from is
    // empty on a signed-in page: nothing ever writes a saved secret back into
    // a text box. The one already held is what the server is asked about.
    if (typed === "" && secret !== "") typed = secret
    if (typed === "") {
      lastError = "Enter the app password or API token for this mailbox"
      return false
    }
    if (String(address || "") === "") {
      lastError = "Add the email address for this mailbox"
      return false
    }
    lastError = ""
    serverNeeded = false
    loginBusy = true
    pendingSecret = typed
    verifyRequested(settings, address, typed)
    return true
  }

  // The client owns the transport, so it performs the check and reports back.
  signal verifyRequested(var settings, string address, string secret)

  // `result` is what the check learned when it succeeded: `sessionUrl`,
  // `authScheme` and `accountId`. It is emitted before the secret is stored,
  // because the keyring entry is named after the account and the account is
  // not named until the page has written the address down.
  function completeSignIn(ok, result, error, needsServer) {
    loginBusy = false
    progressStep = 0
    if (!ok) {
      pendingSecret = ""
      lastError = safeError(error) || "The server rejected that app password or API token"
      serverNeeded = needsServer === true
      return
    }
    serverNeeded = false
    sendingOffered = !result || result.canSend !== false
    secret = pendingSecret
    pendingSecret = ""
    secretChecked = true
    lastError = ""
    sessionVerified(result || {})
    storeSecret()
    // A tick later than the rest of this, and deliberately: `sessionVerified`
    // is what has the account list write the session URL, the scheme and the
    // account id onto the entry, and only then is this object `configured`.
    // Emitting in the same turn would have `MailAccount` start fetching
    // against settings that had not landed yet.
    Qt.callLater(function() { if (root) root.loginSucceeded() })
  }

  function storeSecret() {
    var attributes = Credentials.jmapKeyringAttributes(accountId)
    if (attributes.length === 0 || secret === "") return
    keyringWriteSecret = secret
    keyringStore.command = [pluginDir + "/scripts/keyring-store.sh"].concat(attributes)
    keyringStore.running = true
  }

  property string keyringWriteSecret: ""

  function logout() {
    secret = ""
    pendingSecret = ""
    secretChecked = true
    var attributes = Credentials.jmapKeyringAttributes(accountId)
    if (attributes.length > 0) {
      keyringClear.command = ["secret-tool", "clear"].concat(attributes)
      keyringClear.running = true
    }
    loggedOut()
  }

  // Kept so `MailAccount` can call the same thing on any provider. An app
  // password does not expire, so there is nothing to invalidate — but a server
  // that has started refusing it should not be asked a hundred more times with
  // the same value.
  function invalidateAccessToken() {
    secret = ""
    secretChecked = false
  }

  // Gmail's manager has these; a JMAP account reaches neither, and
  // `MailAccount` should not have to ask which provider it holds before
  // calling one.
  function beginLogin() { /* the setup form drives sign-in, not a browser */ }
  function cancelLogin() {
    loginBusy = false
    progressStep = 0
  }

  onAccountIdChanged: {
    // A different mailbox has a different secret. Dropping the one in memory
    // is what stops an account rename from leaving the previous account's
    // credential in front of the new one's server.
    secret = ""
    secretChecked = false
    lookupHandled = false
  }

  Component.onCompleted: {
    toolProbe.command = ["sh", "-c",
      "for tool in secret-tool; do command -v \"$tool\" >/dev/null 2>&1 || echo \"$tool\"; done"]
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
        root.lastError = "Signed in, but the app password could not be saved. "
          + "You may need to enter it again after a restart"
    }
  }

  Process {
    id: keyringClear
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
  }
}
