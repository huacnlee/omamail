.pragma library

// What the Exchange provider knows without asking a server: which settings are
// well formed, the sentences its failures are told in, and what a check teaches
// the rail. The network is Rust's. The address rules mirror the native ones so
// a typo is caught on the form; Rust refuses a bad one again before any
// credential is built, and where the two disagree Rust is right.

var EWS_EXAMPLE = "https://mail.example.org/EWS/Exchange.asmx"

// The first backend API with the `exchange.*` methods: an older backend has none
// of them, so the setup page sends nothing to it.
var MINIMUM_API = 8

// Why the connected backend cannot sign in an Exchange mailbox, or "".
function backendProblem(backend) {
  if (!backend || backend.ready !== true) return "Waiting for the mail backend to start"
  return Number(backend.apiVersion) >= MINIMUM_API ? ""
    : "Update the mail backend to sign in: the one installed has no Exchange support"
}

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).replace(/^\s+|\s+$/g, "")
}

// The host and port of a server address, or the sentence for what is wrong with
// it. The authority pattern admits no userinfo, so a host is never one a
// hostile address smuggled in beside a credential field.
function parseUrl(url) {
  var text = String(url || "")
  if (text === "") return { error: "Enter the address of the Exchange web service" }
  if (!/^https:\/\//i.test(text)) return { error: "The server address must start with https://" }
  var match = /^https:\/\/([a-z0-9._-]+|\[[0-9a-f:.]+\])(?::([0-9]{1,5}))?(\/[^\s?#\\]*)?$/i.exec(text)
  var port = match && match[2] !== undefined ? Number(match[2]) : 443
  if (!match || text.length > 2048 || port < 1 || port > 65535)
    return { error: "That is not a valid server address. It should look like " + EWS_EXAMPLE }
  if (!/\/ews\/exchange\.asmx$/i.test(match[3] || ""))
    return { error: "The server address must end in /EWS/Exchange.asmx" }
  return { error: "", host: match[1].toLowerCase(), port: port }
}

// The server for the line under an account's name; a port only when unusual.
function serverHost(settings) {
  var parsed = parseUrl((settings || {}).ewsUrl)
  if (parsed.error !== "") return ""
  return parsed.port === 443 ? parsed.host : parsed.host + ":" + parsed.port
}

// The login the server is shown: an empty one means the address.
function login(settings, address) {
  return trimmed((settings || {}).username) || trimmed(address)
}

// A password is good for one server and one login, nothing else.
function serverKey(settings, address) {
  return String((settings || {}).ewsUrl || "").toLowerCase() + "\n" + login(settings, address)
}

// A dot-atom local part (letters, digits and the other characters RFC 5322
// allows in one) and a dotted DNS domain in at most 1024 bytes with the
// `exchange:` prefix, as the backend's account id takes it. Case-insensitive
// without lowering the text, which would let the Kelvin sign through as a k.
var ADDRESS = /^[a-z0-9.!#$%&'*+\/=?^_\u0060{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i

function addressAllowed(address) {
  return address.length <= 1015 && ADDRESS.test(address) && !/^\.|\.@|\.\./.test(address)
}

// A sentence for what is wrong with these settings, or "".
function validateSettings(settings, address) {
  var problem = parseUrl((settings || {}).ewsUrl).error
  if (problem !== "") return problem
  var mailbox = trimmed(address)
  if (mailbox !== "" && !addressAllowed(mailbox))
    return "Exchange mailbox addresses must use plain ASCII letters, digits and punctuation only"
  var name = login(settings, address)
  if (name === "") return "Enter the username for this mailbox"
  if (name.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(name))
    return "That username is too long or has control characters"
  return ""
}

var PASSWORD_CONTROL = "The password contains a control character. Enter it again"

// The password a field holds, or `null` when it cannot be one. A paste from a
// line brings its line break, and the run of CR and LF it ends with is not part
// of the password, as `ImapAuth` has it. Any other control character is
// refused, not removed: cleaning it away would verify and save a password
// nobody typed. C1 controls are refused here as well, because the backend's
// `char::is_control` refuses them anyway and this sentence says why where its
// generic error would not. Spaces, quotes, backslashes and every other
// character are kept exactly.
function typedPassword(text) {
  var value = String(text === undefined || text === null ? "" : text).replace(/[\r\n]+$/, "")
  return /[\u0000-\u001f\u007f-\u009f]/.test(value) ? null : value
}

// The settings to keep after a sign-in: NTLM, once the server signed in with it,
// replaces `auto`, so a later connection that is offered only Basic is refused
// rather than sent the password. Basic is never kept: a first sign-in through
// something that stripped the NTLM offer would make a one-time downgrade
// permanent. `null` when nothing changes.
function settingsAfterSignIn(settings, result) {
  var values = settings || {}
  if (values.authScheme !== "auto" || String(result && result.scheme || "") !== "ntlm") return null
  return { ewsUrl: values.ewsUrl, username: values.username, authScheme: "ntlm" }
}

// The code of whatever a failed call handed back: a backend error's `message`
// or a bare string.
function errorCode(error) {
  if (error === undefined || error === null) return ""
  return trimmed(typeof error === "object" ? error.message : error)
}

// The password was refused by the server, or is no longer in the keyring: either
// way it has to be typed again, and nothing else is wrong with the mailbox.
function needsPassword(error) {
  var code = errorCode(error)
  return code === "exchange_unauthorized" || code === "auth_signed_out" || code === "credential_missing"
}

var SENTENCES = {
  exchange_access_denied: "The server refused access to this mailbox or message. Ask your administrator if it keeps happening",
  exchange_auth_failed: "The server's sign-in reply could not be used. A proxy that inspects secure connections can cause this",
  exchange_auth_scheme_unsupported: "This server offers no sign-in method that Omamail supports (NTLM or Basic)",
  exchange_tls_failed: "The server's secure connection could not be verified",
  exchange_network_failed: "The mail server could not be reached",
  exchange_connection_closed: "The server closed the connection before it answered",
  exchange_invalid_response: "The server's answer was not what an Exchange server sends. Check the address and whether something in between is rewriting the request",
  exchange_dns_failed: "The server name could not be looked up. Check the address and your network connection",
  exchange_timeout: "The mail server took too long to answer",
  exchange_url_invalid: "The server address is not valid. It should look like " + EWS_EXAMPLE,
  exchange_redirect_refused: "The server sent the request somewhere else, which Omamail does not follow. Enter the address it points to",
  exchange_response_too_large: "The server's answer was larger than Omamail accepts",
  exchange_message_too_large: "This message is larger than Omamail opens from Exchange (about 24 MB)",
  exchange_message_not_found: "That message is no longer in the mailbox",
  exchange_attachment_not_found: "That attachment is no longer on the server",
  exchange_folder_unavailable: "A folder this needs was not found on the server",
  exchange_send_failed: "The server did not confirm sending. Check Sent before trying again",
  exchange_send_rejected: "The server rejected this message",
  exchange_send_not_attempted: "The message was not sent. It is safe to try again",
  exchange_draft_unconfirmed: "The server did not confirm saving the draft. It may already be in Drafts",
  exchange_stale_item: "The message changed on the server while it was being updated. Try again",
  exchange_cancelled: "Cancelled",
  exchange_throttled: "The server asked to slow down. Try again in a moment",
  exchange_settings_invalid: "The server settings for this mailbox are incomplete. Open the mailbox settings",
  exchange_server_error: "The server reported an error while handling the request",
  exchange_unsupported_server: "This Exchange server is not supported: Omamail needs Exchange 2013 SP1 or later",
  backend_needs_update: "Update the mail backend to use this mailbox",
  credential_store_unavailable: "The credential store is unavailable",
  auth_keyring_failed: "The system keyring could not be read. Check that it is unlocked",
  auth_account_missing: "This mailbox's settings were not found. Open the mailbox settings",
  auth_account_invalid: "This mailbox's saved entry cannot be used to find its password. Open the mailbox settings",
  accounts_invalid: "The saved list of mailboxes could not be read",
  auth_secret_invalid: "The password saved in the system keyring cannot be used. Enter it again"
}

// The sentence for a code, which is one of Rust's static ones, so nothing a
// server wrote is ever passed on. A refused password reads differently to
// somebody just signing in, for whom "sign in again" is no answer.
function sentence(error, signingIn) {
  var code = errorCode(error)
  if (needsPassword(code))
    return signingIn === true ? "The server rejected that username or password" : "Sign in to this mailbox again"
  return SENTENCES[code] || "The mail server could not complete this request"
}

// What a check taught the rail. The refusals are the capabilities this account
// withdraws from the provider's ceiling, as `Registry.can` reads them, in the
// backend's own sentences; `null` says nothing has been read.
function refusals(result) {
  return result && result.refusals && typeof result.refusals === "object" ? result.refusals : null
}

// The rail rows whose folder the server has not got: Junk is the rail's `spam`.
// `null` until a check has answered, which draws every row.
function absentMailboxes(result) {
  var roles = result && result.roles
  if (!roles || typeof roles !== "object") return null
  var out = []
  if (!roles.junk) out.push("spam")
  if (!roles.trash) out.push("trash")
  return out
}
