.pragma library

// What an Exchange mailbox's password needs remembered beyond the window's
// account host, which is rebuilt whenever the list of accounts changes: the
// keyring writes not yet answered, a sign-out's delete owed until the backend
// is up, and a write that landed after a sign-out and has to be taken out
// again. Keyed by account id, in this process only: the plugin and the
// standalone app each keep their own.

var writes = {}
var owed = {}
var sending = {}
var failed = {}
var forgets = {}

function writing(account) {
  return writes[account] || 0
}

function owes(account) {
  return owed[account] === true
}

function generation(account) {
  return forgets[account] || 0
}

// A sign-out, removal or change of server let the account's password go.
function forgot(account) {
  if (account === "") return
  forgets[account] = generation(account) + 1
}

// A keyring write's callback, counted until it is answered whether or not the
// host that asked still exists. A write that lands after the account let its
// password go is taken out again through the keyring it went to: the window's
// service, which outlives every host. No host has to be there to do it.
function tracked(account, keyring, done) {
  var asked = generation(account)
  writes[account] = writing(account) + 1
  var answered = false
  return function(ok) {
    if (!answered) {
      answered = true
      if (writing(account) > 1) writes[account] = writing(account) - 1
      else delete writes[account]
      if (ok === true && generation(account) !== asked && keyring
          && typeof keyring.credentialDelete === "function")
        keyring.credentialDelete("exchange-password", account, "", function() {})
    }
    if (typeof done === "function") done(ok)
  }
}

// Sign-outs made before the backend was up, sent by whichever Exchange host
// sees it ready; a sign-in to the account cancels its own.
function owe(account) {
  if (account !== "") owed[account] = true
}

function cancelOwed(account) {
  if (deleting(account)) return
  delete owed[account]
  delete failed[account]
}

function owedAccounts() {
  return Object.keys(owed)
}

// An owed delete on its way: a sign-in now would race it to the keyring.
function deleting(account) {
  return sending[account] === true
}

function claimOwed(account) {
  if (!owes(account) || sending[account] === true) return false
  sending[account] = true
  return true
}

// The keyring refused an owed delete: kept per address, so the mailbox's own
// host says so whichever host sent it, until a retry or a sign-in clears it.
function owedAnswered(account, forgotten) {
  delete sending[account]
  if (forgotten) {
    delete owed[account]
    delete failed[account]
  } else {
    failed[account] = true
  }
}

function signOutFailed(account) {
  return failed[account] === true
}

// For tests, which share one engine: everything back to how a start finds it.
function reset() {
  writes = {}
  owed = {}
  sending = {}
  failed = {}
  forgets = {}
}
