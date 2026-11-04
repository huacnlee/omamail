.pragma library

.import "MicrosoftOAuth.js" as Microsoft

// What the Microsoft 365 provider knows without asking anybody: how the answers
// of the device sign-in are read, the sentence for every failure, and what a
// mailbox check teaches the rail. No transport and no token: Rust makes every
// request, keeps the refresh token in the keyring and the access token in memory.

// The first backend API with the `m365.*` methods.
var MIN_API_VERSION = 8

// An Application (client) ID in the one spelling the backend keys a saved
// sign-in by (a GUID, lower case), else "". There is no built-in one: each
// person enters the ID of their own app (Outlook's is another registration).
function clientId(value) {
  return Microsoft.isValidClientId(value) ? Microsoft.trimmed(value).toLowerCase() : ""
}

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim()
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// Text that came from an answer and reaches a label: one bounded plain line.
function lineText(value, limit) {
  var text = trimmed(String(value).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g, " "))
  return text.length > limit ? text.substring(0, limit - 3) + "..." : text
}

var SIGN_IN_AGAIN = "Sign in to Microsoft 365 again"

// Every code the backend answers with, and the sentence a person gets for it.
// The codes are Rust's static ones, so no server text is passed on.
var SENTENCES = {
  auth_account_missing: "This mailbox is not set up on this computer",
  auth_keyring_failed: "The system keyring is locked or unavailable. Unlock it: the mailbox's sign-in is kept there",
  backend_needs_update: "Update the mail backend to use this mailbox",
  credential_store_unavailable: "The credential store is unavailable",
  m365_access_denied: "Microsoft refused access to this mailbox or message. Ask your administrator if it keeps happening",
  m365_attachment_not_found: "That attachment is no longer in the mailbox",
  m365_auth_failed: "Microsoft refused this sign-in. Check the Application (client) ID and that the app allows public client flows and accounts of your organization, then try again",
  m365_bad_response: "Microsoft's answer was not what Omamail expected. Try again in a moment",
  m365_cancelled: "Cancelled",
  m365_consent_required: "Your organization's administrator has to approve this app before it can open the mailbox. Ask them to grant consent for it, then sign in again. If the page named another company, your browser was signed in to a different Microsoft account: try a private window",
  m365_declined: "The sign-in was declined on the Microsoft page. Press Sign in to try again",
  m365_draft_unconfirmed: "Microsoft did not confirm saving the draft. It may already be in Drafts",
  m365_expired: "The code ran out before it was used. Press Sign in for a new one",
  m365_folder_unavailable: "A folder this needs was not found in the mailbox",
  m365_invalid_request: "Omamail could not make that request. Try again",
  m365_invalid_response: "Microsoft's answer was not what Omamail expected. Try again in a moment",
  m365_message_not_found: "That message is no longer in the mailbox",
  m365_message_too_large: "This message is too large to send through Microsoft 365. Remove an attachment or make it smaller, then try again",
  m365_network_failed: "Microsoft 365 could not be reached. Check your connection",
  m365_not_a_draft: "That message is not a draft, so it was left in place",
  m365_request_limit: "Too many requests are waiting. Try again in a moment",
  m365_response_too_large: "Microsoft's answer was larger than Omamail accepts",
  m365_send_failed: "Microsoft did not confirm sending. Check Sent before trying again",
  m365_send_not_attempted: "The message was not sent. It is safe to try again",
  m365_send_rejected: "Microsoft 365 rejected this message",
  m365_server_error: "Microsoft 365 reported an error while handling the request. Try again in a moment",
  m365_signed_out: SIGN_IN_AGAIN,
  m365_tenant_invalid: "Microsoft could not find an organization for that address. Check the address",
  m365_throttled: "Microsoft asked Omamail to slow down. Try again in a moment",
  m365_timeout: "Microsoft 365 took too long to answer",
  m365_tls_failed: "The secure connection to Microsoft could not be verified",
  m365_wrong_account: "The code was entered with a different Microsoft account than this mailbox's. Press Sign in again; if the browser offers the wrong account, open the page in a private window",
  request_timed_out: "Microsoft 365 took too long to answer"
}

var GENERIC = "Microsoft 365 could not complete this request"

// The same code from a read is a message too large to open, not one refused.
var TOO_LARGE_TO_OPEN = "This message is larger than Omamail opens from Microsoft 365"
var READS = ["m365.read", "m365.messages", "m365.attachment"]

// A sign-in that could not be saved has to be done again; a saved one that a
// locked keyring hides is checked again by itself (`TRANSIENT`).
var NOT_SAVED = "The sign-in could not be saved in the system keyring. Unlock it, then sign in again"

// The Rust code of whatever a failed call handed back: the `message` of a
// backend error, or a bare string.
function errorCode(error) {
  if (error === undefined || error === null) return ""
  return trimmed(typeof error === "object" ? error.message : error)
}

function sentence(error) {
  var code = errorCode(error)
  return Object.prototype.hasOwnProperty.call(SENTENCES, code) ? SENTENCES[code] : GENERIC
}

// A code that means there is no sign-in to use: nothing else ends a session,
// since a refused message or a network that is down leaves the account as it was.
function isSignedOut(error) {
  return errorCode(error) === "m365_signed_out"
}

// No saved sign-in, or no such mailbox in the list yet, which is the moment
// between typing an address and the file holding it. Neither is a failure.
function isNothingSaved(error) {
  return isSignedOut(error) || errorCode(error) === "auth_account_missing"
}

// Failures that pass by themselves, which a restored session waits out. A
// locked keyring is one: unlocking it is all a saved sign-in needs.
var TRANSIENT = ["m365_network_failed", "m365_timeout", "request_timed_out", "m365_throttled",
  "m365_server_error", "m365_request_limit", "m365_bad_response", "auth_keyring_failed"]

function isTransient(error) {
  return TRANSIENT.indexOf(errorCode(error)) >= 0
}

// A request whose answer never came: the backend's frame ran out before it
// started, the window stopped waiting, the answer stopped arriving part-way,
// the backend stopped, or what came back could not be read and the window
// stopped it. What it did is not known.
var LOST = ["request_timed_out", "Backend request timed out", "Backend response timed out",
  "Backend stopped", "Invalid backend response"]

function isLostAnswer(error) {
  return LOST.indexOf(errorCode(error)) >= 0
}

// What a sign-out that failed leaves behind. One that could not wait for the
// sign-in to be free (`m365_timeout`: a refresh was waiting on the keyring) may
// not have been done, and the mailbox may then be signed in again at the next start.
var SIGN_OUT_UNFINISHED = "Signing out could not be completed while the sign-in was in use, so it may still be "
  + "saved on this computer. Unlock the system keyring if it asks, and sign out again if the mailbox comes back signed in"

function signOutFailure(error) {
  if (errorCode(error) === "m365_timeout") return SIGN_OUT_UNFINISHED
  return "The saved sign-in could not be removed. " + sentence(error)
}

// Steps up to five minutes: a laptop that wakes without a network is not asking
// Microsoft every few seconds.
var RETRY_DELAYS = [5000, 15000, 60000, 300000]

// A typed search that is only quotes or operators comes back as JSON-RPC's
// "Invalid params", which for a search means there was nothing to look for.
function requestSentence(method, params, error) {
  var code = errorCode(error)
  var typed = /^\s*text:/i.test(String(params && params.query || ""))
  if (method === "m365.list" && typed && (code === "invalid_params" || (error && error.code === -32602)))
    return "That search has nothing Microsoft 365 can look for"
  if (code === "m365_message_too_large" && READS.indexOf(method) >= 0) return TOO_LARGE_TO_OPEN
  return sentence(error)
}

// "" when the backend can be asked for mail, else the sentence for why not. A
// backend stating no API version is taken at its word, so a test can stand in.
function backendProblem(backend) {
  if (!backend || backend.ready !== true) return "Mail backend is unavailable"
  if (typeof backend.apiVersion === "number" && backend.apiVersion < MIN_API_VERSION)
    return SENTENCES.backend_needs_update
  return ""
}

// ------------------------------------------------------------- the sign-in

// What `m365.signInBegin` answered, or null when it cannot be used. The code is
// entered by a person on Microsoft's page, so what is shown of it is bounded and
// plain, and the page to open is Microsoft's own, over HTTPS, and nothing else.
// The interval between two polls is the backend's, held to a ceiling.
function beginResult(result) {
  var value = isObject(result) ? result : {}
  var requestId = trimmed(value.requestId)
  var code = trimmed(value.userCode)
  var link = Microsoft.verificationUri(value.verificationUri)
  var interval = Math.floor(Number(value.interval))
  if (requestId === "" || requestId.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(requestId)
      || !/^[A-Za-z0-9-]{4,32}$/.test(code) || link === "") return null
  return { requestId: requestId, userCode: code, verificationUri: link,
    interval: interval > 0 ? Math.min(30, interval) : 5 }
}

// What `m365.signInPoll` answered: `{ state, code, who }`. A state that is none
// of the five is a failed sign-in, never a pending one: a poll that went on for
// ever on a reply nobody understood would be a sign-in that never ends. `code`
// is the sentence's code for a sign-in that ended without a mailbox, `who` the
// account Microsoft reported for a wrong one.
function pollResult(result) {
  var value = isObject(result) ? result : {}
  var state = value.state
  if (state === "pending" || state === "signedIn") return { state: state, code: "", who: "" }
  if (state === "declined" || state === "expired") return { state: state, code: "m365_" + state, who: "" }
  if (state !== "failed") return { state: "failed", code: "m365_invalid_response", who: "" }
  var code = errorCode(value.error)
  return { state: "failed", who: typeof value.signedInAs === "string" ? lineText(value.signedInAs, 80) : "",
    code: Object.prototype.hasOwnProperty.call(SENTENCES, code) ? code : "m365_auth_failed" }
}

// Whether the backend may have saved a sign-in for this poll: it says so, or it
// stopped waiting while Microsoft or the keyring still had the exchange
// (`pending` with `m365_exchange_running`), or the answer was lost. A token
// request that failed, its own `m365_timeout` included, saved nothing.
function pollMayHaveSaved(result, failure) {
  if (failure) return isLostAnswer(failure)
  var value = isObject(result) ? result : {}
  return value.state === "signedIn" || (value.state === "pending" && value.warning === "m365_exchange_running")
}

// The wrong-account sentence names the account Microsoft reported when it did.
function failureSentence(code, who, address) {
  if (code === "auth_keyring_failed") return NOT_SAVED
  if (code !== "m365_wrong_account" || who === "") return sentence(code)
  return "The code was entered as " + who + ", not " + trimmed(address)
    + ". Press Sign in again; if the browser keeps offering that account, open the page in a private window"
}

// ------------------------------------------------- what a check taught us

// Whether a check's answer proves a signed-in mailbox: it said so.
function verified(result) {
  return isObject(result) && result.ok === true
}

// The capabilities this account withdraws from the provider's ceiling, as
// `Registry.can` reads them: `{ capability: sentence }`. `null` says nothing
// has been read.
function refusals(result) {
  if (!verified(result)) return null
  var out = {}
  var raw = isObject(result.refusals) ? result.refusals : {}
  for (var key in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, key) || raw[key] === null || raw[key] === false) continue
    out[key] = lineText(typeof raw[key] === "string" ? raw[key] : "", 300) || "This mailbox cannot do that"
  }
  return out
}

// The rail rows whose folder the mailbox lacks, as `Registry.mailboxes` takes
// them (the rail's Junk is `spam`). Null until a check has answered, which
// draws every row.
var OPTIONAL_ROLES = [["archive", "archive"], ["junk", "spam"], ["trash", "trash"]]

function absentMailboxes(result) {
  if (!verified(result) || !isObject(result.roles)) return null
  var out = []
  for (var i = 0; i < OPTIONAL_ROLES.length; i++) {
    if (!isObject(result.roles[OPTIONAL_ROLES[i][0]])) out.push(OPTIONAL_ROLES[i][1])
  }
  return out
}
