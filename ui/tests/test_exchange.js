const assert = require("assert")
const { load } = require("./load")

const exchange = load("providers/ExchangeProtocol.js")
const accounts = load("account/Accounts.js")

// The modules run in their own realm, so their arrays and objects are compared by value.
const deepEqual = (actual, expected, message) =>
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), message)

const URL = "https://mail.example.org/EWS/Exchange.asmx"
const settings = (values) => accounts.makeExchangeSettings(Object.assign({ ewsUrl: URL }, values))

// ------------------------------------------------------ what a form may hold

{
  const problem = (url, address, username) => exchange.validateSettings(settings({ ewsUrl: url, username }), address === undefined ? "ada@example.org" : address)
  assert.strictEqual(problem(URL), "")
  assert.strictEqual(problem("https://MAIL.Example.org:8443/ews/exchange.asmx"), "", "IIS compares the path in lower case")
  assert.strictEqual(problem(""), "Enter the address of the Exchange web service")
  assert.strictEqual(problem("http://mail.example.org/EWS/Exchange.asmx"), "The server address must start with https://")
  assert.strictEqual(problem("https://mail.example.org/owa"), "The server address must end in /EWS/Exchange.asmx")
  // Not valid, and never read as a host: the address names evil.example, not good.example.
  for (const bad of ["https://good.example@evil.example/EWS/Exchange.asmx", "https://mail.example.org:99999/EWS/Exchange.asmx",
      "https://mail.example.org/EWS/Exchange.asmx?x=1", "https://mail.example.org/EWS/Exchange.asmx#f",
      "https://mail.example.org\\EWS/Exchange.asmx", "https://mail example.org/EWS/Exchange.asmx"])
    assert.ok(problem(bad).indexOf("not a valid server address") > 0, bad)
  assert.strictEqual(exchange.serverHost(settings({ ewsUrl: "https://Mail.Example.org:8443/EWS/Exchange.asmx" })),
    "mail.example.org:8443")
  assert.strictEqual(exchange.serverHost(settings({ ewsUrl: URL })), "mail.example.org", "the usual port is not shown")
  assert.strictEqual(exchange.serverHost(settings({ ewsUrl: "https://good@evil.example/EWS/Exchange.asmx" })), "")

  // The address becomes the account id, so it has to be one the backend takes.
  for (const bad of ["a..b@example.org", ".a@example.org", "a.@example.org", "ada@localhost", "a b@example.org",
      "aK@example.org", "ada@-example.org"])
    assert.ok(problem(URL, bad).indexOf("plain ASCII letters") > 0, bad)
  assert.strictEqual(problem(URL, "Ada+tag@Mail.Example.org"), "")
  assert.strictEqual(problem(URL, "ada@example.org", "EXAMPLE\\ada"), "")
  assert.strictEqual(problem(URL, "", ""), "Enter the username for this mailbox")
  assert.ok(problem(URL, "ada@example.org", "a\nb").indexOf("control characters") > 0)

  // The server is typed: nothing here would guess one from the address.
  assert.strictEqual(exchange.suggestEwsUrl, undefined)

  // A password is good for one server and one login; an empty login is the address.
  const key = (values, address) => exchange.serverKey(settings(values), address)
  assert.strictEqual(key({}, "ada@example.org"), key({ username: "ada@example.org" }, "ada@example.org"))
  assert.strictEqual(key({ ewsUrl: URL.toUpperCase().replace("HTTPS", "https") }, "ada@example.org"), key({}, "ada@example.org"))
  assert.notStrictEqual(key({}, "ada@example.org"), key({ username: "EXAMPLE\\ada" }, "ada@example.org"))
  assert.notStrictEqual(key({}, "ada@example.org"), key({ ewsUrl: "https://other.example.org/EWS/Exchange.asmx" }, "ada@example.org"))
  assert.strictEqual(key({ authScheme: "ntlm" }, "ada@example.org"), key({}, "ada@example.org"), "the method is not part of it")

  // NTLM, once a sign-in used it, replaces `auto`, and nothing else is changed.
  deepEqual(exchange.settingsAfterSignIn(settings({}), { scheme: "ntlm" }), { ewsUrl: URL, username: "", authScheme: "ntlm" })
  // Basic never is: one sign-in that something stripped of NTLM must not decide every later one.
  assert.strictEqual(exchange.settingsAfterSignIn(settings({}), { scheme: "basic" }), null, "a Basic sign-in leaves auto")
  assert.strictEqual(exchange.settingsAfterSignIn(settings({ authScheme: "ntlm" }), { scheme: "basic" }), null, "a pinned method stays")
  for (const answer of [{ scheme: "" }, { scheme: "kerberos" }, null])
    assert.strictEqual(exchange.settingsAfterSignIn(settings({}), answer), null)
}

// ---------------------------------------------------------- a pasted password

{
  // The line breaks a paste ends with go, as IMAP's do; what is left is kept exactly.
  for (const suffix of ["\r", "\n", "\r\n", "\n\n", "\r\n\r\n", "\n\r"])
    assert.strictEqual(exchange.typedPassword(" pass word " + suffix), " pass word ", JSON.stringify(suffix))
  for (const kept of ["app-password", " leading and trailing ", "päss密碼🔑", " nbsp", "a\"'b\\c:$()", ""])
    assert.strictEqual(exchange.typedPassword(kept), kept, JSON.stringify(kept))
  assert.strictEqual(exchange.typedPassword(undefined), "")
  for (const breaks of ["\r\n", "\n\n\r"])
    assert.strictEqual(exchange.typedPassword(breaks), "", "line breaks alone are no password")
  // Every other control the backend refuses is refused here, never removed.
  const controls = []
  for (let code = 0; code < 0x20; code++) controls.push(code)
  for (let code = 0x7f; code <= 0x9f; code++) controls.push(code)
  for (const code of controls) {
    const c = String.fromCharCode(code)
    assert.strictEqual(exchange.typedPassword("before" + c + "after"), null, "embedded " + code)
    if (code !== 10 && code !== 13)
      assert.strictEqual(exchange.typedPassword("password" + c), null, "trailing " + code)
  }
  for (const value of ["\npassword", "a\r\nb\r\n", "password\t\r\n", "password\u0085\n"])
    assert.strictEqual(exchange.typedPassword(value), null, JSON.stringify(value))
  assert.ok(exchange.PASSWORD_CONTROL.indexOf("control character") > 0)
}

// ------------------------------------------------------ the connected backend

{
  // Nothing is sent to a backend that has no Exchange methods, or none at all yet.
  assert.strictEqual(exchange.backendProblem({ ready: true, apiVersion: 8 }), "")
  assert.strictEqual(exchange.backendProblem({ ready: true, apiVersion: 9 }), "")
  assert.ok(exchange.backendProblem({ ready: true, apiVersion: 7 }).indexOf("Update the mail backend") === 0)
  assert.strictEqual(exchange.backendProblem({ ready: false, apiVersion: 8 }), "Waiting for the mail backend to start")
  assert.strictEqual(exchange.backendProblem(null), "Waiting for the mail backend to start")
}

// ------------------------------------------------------------ what it says

{
  // Every code the backend can answer has a sentence of its own, in plain words
  // and never a server's: unknown ones get the one generic line.
  const generic = exchange.sentence("something_new")
  const codes = ["exchange_access_denied", "exchange_auth_failed", "exchange_auth_scheme_unsupported",
    "exchange_tls_failed", "exchange_network_failed", "exchange_connection_closed", "exchange_invalid_response",
    "exchange_dns_failed", "exchange_timeout", "exchange_url_invalid", "exchange_redirect_refused",
    "exchange_response_too_large", "exchange_message_too_large", "exchange_message_not_found",
    "exchange_attachment_not_found", "exchange_folder_unavailable", "exchange_send_failed", "exchange_send_rejected",
    "exchange_send_not_attempted", "exchange_draft_unconfirmed", "exchange_stale_item", "exchange_cancelled", "exchange_throttled", "exchange_settings_invalid", "exchange_server_error", "exchange_unsupported_server",
    "backend_needs_update", "credential_store_unavailable", "auth_keyring_failed", "auth_account_missing",
    "auth_account_invalid", "accounts_invalid", "auth_secret_invalid"]
  for (const code of codes) {
    const text = exchange.sentence(code)
    assert.notStrictEqual(text, generic, code + " has a sentence of its own")
    assert.ok(!/exchange_|_/.test(text.replace(/EWS\/Exchange\.asmx/, "")), code + " does not show the code")
  }
  for (const code of ["auth_keyring_failed", "auth_account_missing", "auth_account_invalid", "accounts_invalid",
      "auth_secret_invalid"])
    assert.ok(!/server/i.test(exchange.sentence(code)), code + " is this computer's to fix, not the server's")
  assert.strictEqual(exchange.sentence({ code: -32000, message: "exchange_timeout" }), exchange.sentence("exchange_timeout"),
    "a backend error and a bare code read the same")
  assert.strictEqual(exchange.sentence(null), generic)
  assert.strictEqual(exchange.sentence("exchange_send_failed").indexOf("Check Sent") > 0, true,
    "an unconfirmed send says to look before trying again")
  assert.ok(exchange.sentence("exchange_draft_unconfirmed").indexOf("may already be in Drafts") > 0,
    "a draft whose answer was lost is not a plain failure")

  // A refused password is "sign in again" to somebody who is reading mail, and a
  // wrong password to somebody who has just typed one.
  for (const code of ["exchange_unauthorized", "auth_signed_out", "credential_missing"]) {
    assert.strictEqual(exchange.needsPassword(code), true, code)
    assert.strictEqual(exchange.sentence(code), "Sign in to this mailbox again")
    assert.strictEqual(exchange.sentence(code, true), "The server rejected that username or password")
  }
  for (const code of ["exchange_access_denied", "exchange_auth_failed", "exchange_network_failed", ""])
    assert.strictEqual(exchange.needsPassword(code), false,
      code + " is not a refused password: freezing the mailbox for it would punish a good one")
}

// -------------------------------------------------- what a check taught us

{
  const roles = (extra) => Object.assign({ inbox: { total: 1, unread: 0 }, sent: { total: 1, unread: 0 },
    drafts: { total: 0, unread: 0 }, trash: { total: 0, unread: 0 }, junk: { total: 0, unread: 0 } }, extra)
  deepEqual(exchange.absentMailboxes({ roles: roles() }), [])
  deepEqual(exchange.absentMailboxes({ roles: roles({ junk: null }) }), ["spam"], "Junk is the rail's spam")
  deepEqual(exchange.absentMailboxes({ roles: roles({ junk: null, trash: null }) }), ["spam", "trash"])
  assert.strictEqual(exchange.absentMailboxes(null), null, "nothing read draws every row")
  assert.strictEqual(exchange.absentMailboxes({ ok: true }), null)
  deepEqual(exchange.refusals({ refusals: { send: "No Sent folder" } }), { send: "No Sent folder" })
  deepEqual(exchange.refusals({ refusals: {} }), {}, "a check that refused nothing leaves the ceiling")
  assert.strictEqual(exchange.refusals(null), null)
}

console.log("Exchange.js ok")
