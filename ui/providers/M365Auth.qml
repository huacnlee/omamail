import QtQuick

import "M365Protocol.js" as M365

// A Microsoft 365 mailbox's sign-in: one code, entered on Microsoft's own page.
//
// The same shape from outside as `OutlookAuth`: `MailAccount` asks whether it is
// `loggedIn`, starts a sign-in with `beginLogin` and hears of the result by
// signal. Everything behind that is Rust's: it asks Microsoft for the code, keeps
// the refresh token in the keyring and the access token in memory. Nothing that
// could authenticate anybody reaches this object.
//
//   1. `m365.signInBegin` answers with a code and Microsoft's page, which is
//      opened and the code shown to be entered there.
//   2. `m365.signInPoll` is asked every `interval` seconds until the person has
//      finished (`signedIn`), refused (`declined`), run out of time (`expired`)
//      or Microsoft refused (`failed`).
//   3. `m365.verify` proves the mailbox before the window shows it as signed in,
//      and the folders it found teach the rail what it draws. A saved session is
//      restored by the same check, with nothing typed.
Item {
  id: root

  visible: false
  width: 0
  height: 0

  property var backend: null
  property var platform: null
  property string accountId: ""
  property string address: ""
  property string clientId: ""

  readonly property string effectiveClientId: M365.clientId(clientId)
  readonly property bool configured: accountId !== "" && effectiveClientId !== ""
  readonly property bool credentialsPresent: configured

  property bool loggedIn: false
  property bool loginBusy: false
  property bool removalBusy: false
  // "", "starting", "waiting" or "checking": what the page says it is doing.
  property string signInStage: ""
  // A restore is owed from the start until it ends: the mailbox then does not
  // look signed out for the second the backend takes to come up.
  property bool restoreOwed: true
  property bool restoring: false
  readonly property bool recoveringSession: !loggedIn && !loginBusy && configured && restoreOwed
  readonly property bool sessionBusy: restoring
  property string lastError: ""
  property string userCode: ""
  property string verificationUri: ""
  // The last passing check's answer, which the client draws the rail from.
  property var checked: null

  // Wall-clock steps are scaled by this, which is only ever not 1 in a test.
  property real timeScale: 1
  // Bumped whenever what is in the air stops being wanted: a cancel, a sign-out,
  // another mailbox. An answer that comes back for an older one is dropped.
  property int generation: 0
  property string requestId: ""
  property int retryAttempt: 0
  // Sign-outs asked for before the backend was up: `{accountId, clientId}`.
  property var owedSignOuts: []
  // Every sign-in this object asked the backend for, `{accountId, clientId}`. One of
  // an ID typed before may still be exchanging its code there, and a sign-out ends
  // only the sign-ins of the ID it names, so signing out names each of them.
  property var signInClients: []
  // The backend may hold a sign-in of this mailbox the window has not seen: a
  // poll's answer was lost, or came late while a newer sign-in was under way. A
  // sign-in that ends without a mailbox removes it.
  property bool grantUnknown: false

  // Read by `MailAccount` for every provider: nothing here needs a tool.
  readonly property bool toolsChecked: true
  readonly property bool toolsPresent: true
  readonly property var missingTools: []

  signal loginSucceeded()
  signal loggedOut()
  signal sessionUnavailable(string reason)

  function clearCode() {
    pollTimer.stop()
    requestId = ""
    userCode = ""
    verificationUri = ""
    signInStage = ""
  }

  // The mailbox check, which proves a session and says what the mailbox has.
  // `done(result, code)`, with a code only when it did not.
  function check(done) {
    var gen = generation
    backend.call("m365.verify", { accountId: accountId }, function(result, failure) {
      if (!root || gen !== root.generation) return
      done(result, failure ? (M365.errorCode(failure) || "m365_invalid_response")
        : (M365.verified(result) ? "" : "m365_invalid_response"))
    })
  }

  function accept(result) {
    clearCode()
    checked = result
    loggedIn = true
    loginBusy = false
    restoring = false
    restoreOwed = false
    retryAttempt = 0
    retryTimer.stop()
    lastError = ""
    grantUnknown = false
    loginSucceeded()
  }

  function beginLogin() {
    if (loginBusy || loggedIn || removalBusy) return
    var problem = M365.backendProblem(backend)
    if (problem === "" && !configured) problem = "Add this mailbox's Application (client) ID first"
    if (problem !== "") {
      lastError = problem
      return
    }
    // A restore still waiting is not the answer to a sign-in that was asked for.
    var gen = ++generation
    retryTimer.stop()
    restoring = false
    restoreOwed = false
    lastError = ""
    loginBusy = true
    signInStage = "starting"
    var asked = { accountId: accountId, clientId: effectiveClientId }
    if (!signInClients.some(function(known) {
      return known.accountId === asked.accountId && known.clientId === asked.clientId
    })) signInClients = signInClients.concat([asked])
    backend.call("m365.signInBegin", { accountId: accountId, address: address, clientId: effectiveClientId },
      function(result, failure) {
        if (!root || gen !== root.generation) return
        var begin = failure ? null : M365.beginResult(result)
        if (!begin) {
          root.failSignIn(failure ? M365.errorCode(failure) : "m365_invalid_response")
          return
        }
        root.requestId = begin.requestId
        root.userCode = begin.userCode
        root.verificationUri = begin.verificationUri
        root.signInStage = "waiting"
        pollTimer.interval = Math.max(1, Math.round(begin.interval * 1000 * root.timeScale))
        // The app has no private-window helper: the page tells the person what
        // to do if the browser offers the wrong account.
        if (root.platform && typeof root.platform.openExternal === "function")
          root.platform.openExternal(begin.verificationUri)
        pollTimer.restart()
      })
  }

  function poll() {
    if (signInStage !== "waiting") return
    var gen = generation
    var account = accountId
    var client = effectiveClientId
    backend.call("m365.signInPoll", { requestId: requestId }, function(result, failure) {
      if (!root) return
      if (gen !== root.generation) {
        // Cancelled while Microsoft was answering: the backend may keep a sign-in nobody
        // wants. A newer one of the same app writes the same keyring item: a sign-out now
        // would end it while it waits, so it is left to that one's outcome, and would delete
        // what it saved while it is signed in or its check is to be asked again. One of
        // another app has an item of its own, which signing this one out leaves alone.
        if (!M365.pollMayHaveSaved(result, failure)) return
        var same = account === root.accountId && client === root.effectiveClientId
        if (same && root.loginBusy) root.grantUnknown = true
        else if (!same || !(root.loggedIn || root.restoreOwed)) root.forget(account, client)
        return
      }
      // The answer never came: the same request is asked again, and holds its outcome.
      if (failure && M365.isLostAnswer(failure)) {
        root.grantUnknown = true
        pollTimer.restart()
        return
      }
      if (failure) {
        root.failSignIn(M365.errorCode(failure))
        return
      }
      var answer = M365.pollResult(result)
      if (answer.state === "pending") {
        // Still at Microsoft's or the keyring's: what comes of it is asked for next time.
        if (M365.pollMayHaveSaved(result, null)) root.grantUnknown = true
        pollTimer.restart()
      } else if (answer.state === "signedIn") {
        // The one saved is this one, wanted; the check decides what becomes of it.
        root.grantUnknown = false
        root.prove()
      } else root.failSignIn(answer.code, answer.who)
    })
  }

  // The code was entered: what the page shows from here is the mailbox being
  // checked, not a code that has done its work.
  function prove() {
    clearCode()
    signInStage = "checking"
    check(function(result, code) {
      if (code === "") {
        accept(result)
        return
      }
      // A check that failed for a reason that stays leaves nothing signed in
      // behind it. The network failing does not undo the sign-in: it is checked
      // again the way a saved one is, with no new code.
      if (M365.isTransient(code)) {
        clearCode()
        loginBusy = false
        restoreOwed = true
        lastError = M365.sentence(code)
        scheduleRetry()
        sessionUnavailable(lastError)
        return
      }
      forget()
      failSignIn(code)
    })
  }

  function failSignIn(code, who) {
    clearCode()
    loginBusy = false
    if (grantUnknown) forget()
    lastError = M365.failureSentence(code, who || "", address)
    sessionUnavailable(lastError)
  }

  // Cuts a sign-in short, which is not a failure and says nothing. The backend's
  // own wait for the code ends at its expiry.
  function cancelLogin() {
    if (!loginBusy) return
    var entered = signInStage === "checking"
    generation++
    clearCode()
    loginBusy = false
    lastError = ""
    // The code was entered, so the backend holds a sign-in nobody wants.
    if (entered || grantUnknown) forget()
  }

  // Asked when the account is built and again when the backend comes up: the
  // saved sign-in is proven by the same check. Quiet when there is none, since a
  // mailbox being added has none by design.
  function restoreSession() {
    if (loginBusy || restoring || loggedIn || removalBusy || !configured || !restoreOwed) return
    var problem = M365.backendProblem(backend)
    if (problem !== "") {
      // One that is not up yet is waited for; one that is up and too old is not.
      if (backend && backend.ready === true) {
        restoreOwed = false
        lastError = problem
        sessionUnavailable(problem)
      }
      return
    }
    restoring = true
    check(function(result, code) {
      restoring = false
      if (code === "") {
        accept(result)
      } else if (M365.isNothingSaved(code)) {
        restoreOwed = false
        checked = null
      } else {
        lastError = M365.sentence(code)
        restoreOwed = M365.isTransient(code)
        if (restoreOwed) scheduleRetry()
        sessionUnavailable(lastError)
      }
    })
  }

  function scheduleRetry() {
    var step = M365.RETRY_DELAYS[Math.min(retryAttempt++, M365.RETRY_DELAYS.length - 1)]
    retryTimer.interval = Math.max(1, Math.round(step * timeScale))
    retryTimer.restart()
  }

  // Called by the client when a request found the sign-in gone while the window
  // thought it was there: the refresh token was revoked or removed elsewhere.
  function noteSignedOut() {
    if (!loggedIn) return
    loggedIn = false
    checked = null
    restoreOwed = false
    lastError = M365.sentence("m365_signed_out")
    sessionUnavailable(lastError)
  }

  // Deletes a saved sign-in, this mailbox's unless another is named. One asked
  // for before the backend is up is sent when it is. A backend that cannot says
  // so, because one left behind would be restored at the next start as if
  // nothing had happened.
  function forget(account, client) {
    var request = { accountId: account || accountId, clientId: client || effectiveClientId }
    if (request.accountId === "" || request.clientId === "") return
    if (request.accountId === accountId && request.clientId === effectiveClientId) grantUnknown = false
    if (!backend || backend.ready !== true) {
      owedSignOuts = owedSignOuts.concat([request])
      return
    }
    backend.call("m365.signOut", request, function(result, failure) {
      if (root && failure && request.accountId === root.accountId)
        root.lastError = M365.signOutFailure(failure)
    })
  }

  // This mailbox's sign-in, and any of another ID this object asked for: its
  // exchange may still save a grant that would be restored at the next start.
  function forgetEvery() {
    forget()
    for (var i = 0; i < signInClients.length; i++) {
      var asked = signInClients[i]
      if (asked.accountId === accountId && asked.clientId !== effectiveClientId)
        forget(asked.accountId, asked.clientId)
    }
  }

  function sendOwedSignOuts() {
    var owed = owedSignOuts
    owedSignOuts = []
    for (var i = 0; i < owed.length; i++) forget(owed[i].accountId, owed[i].clientId)
  }

  function reset() {
    generation++
    removalBusy = false
    clearCode()
    retryTimer.stop()
    loginBusy = false
    restoring = false
    loggedIn = false
    checked = null
    lastError = ""
    retryAttempt = 0
    grantUnknown = false
  }

  // Also for a mailbox that was never signed in.
  function logout() {
    reset()
    restoreOwed = false
    forgetEvery()
    loggedOut()
  }

  // Removal must keep this account alive until the backend confirms its saved
  // sign-in is gone. A per-account queue dies with its delegate, and a failed
  // keyring deletion must leave a visible account the person can retry.
  function forgetCredential(done) {
    if (removalBusy) { if (typeof done === "function") done(false); return }
    var requests = []
    function add(account, client) {
      if (account !== root.accountId || client === "") return
      if (!requests.some(function(known) { return known.clientId === client }))
        requests.push({ accountId: account, clientId: client })
    }
    add(accountId, effectiveClientId)
    for (var i = 0; i < signInClients.length; i++) add(signInClients[i].accountId, signInClients[i].clientId)
    for (var j = 0; j < owedSignOuts.length; j++) add(owedSignOuts[j].accountId, owedSignOuts[j].clientId)
    if (requests.length === 0) { if (typeof done === "function") done(true); return }
    var problem = M365.backendProblem(backend)
    if (problem !== "") {
      lastError = "The mailbox was not removed. " + problem + ". Try Remove account again when it is ready"
      if (typeof done === "function") done(false)
      return
    }
    reset()
    restoreOwed = false
    removalBusy = true
    loggedOut()
    var gen = generation
    var remaining = requests.length
    var failureText = ""
    for (var k = 0; k < requests.length; k++) {
      backend.call("m365.signOut", requests[k], function(result, failure) {
        if (!root || gen !== root.generation) return
        if (failure || !result || result.signedOut !== true)
          failureText = M365.signOutFailure(failure || "m365_invalid_response")
        if (--remaining !== 0) return
        root.removalBusy = false
        if (failureText !== "") root.lastError = "The mailbox was not removed. " + failureText
        else root.owedSignOuts = root.owedSignOuts.filter(function(owed) { return owed.accountId !== root.accountId })
        if (typeof done === "function") done(failureText === "")
      })
    }
  }

  // A different mailbox has a different sign-in, and whatever was in the air
  // belongs to the old one.
  onAccountIdChanged: {
    reset()
    restoreOwed = true
    Qt.callLater(function() { if (root) root.restoreSession() })
  }

  Connections {
    target: root.backend
    ignoreUnknownSignals: true
    function onReadyChanged() {
      if (root.backend.ready === true) root.sendOwedSignOuts()
      root.restoreSession()
    }
  }

  Timer {
    id: pollTimer
    onTriggered: root.poll()
  }

  Timer {
    id: retryTimer
    onTriggered: root.restoreSession()
  }
}
