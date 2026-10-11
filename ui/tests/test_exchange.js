const assert = require("assert")
const { load, deepEqual } = require("./load")

const accounts = load("account/Accounts.js")
const exchange = load("providers/Exchange.js")
const microsoft = load("providers/MicrosoftOAuth.js")
const provider = load("providers/Registry.js")

// ---------------------------------------------------------------- provider registry

// Exchange is a recognised provider and appears in the chooser list.
assert.ok(provider.ids().indexOf("exchange") >= 0, "exchange appears in provider list")
assert.strictEqual(provider.get("exchange").name, "Exchange")
assert.strictEqual(provider.get("exchange").auth, "oauth")

// ---------------------------------------------------------------- IMAP settings

// Exchange routes to the Office 365 IMAP endpoint.
deepEqual(exchange.settings("ada@contoso.com", "organizations", ""), {
  imapHost: "outlook.office365.com",
  imapPort: 993,
  smtpHost: "smtp.office365.com",
  smtpPort: 587,
  username: "ada@contoso.com",
  aliases: [],
  insecure: false,
  send: ""
})

// A non-work tenant (empty string, "consumers") uses the personal SMTP host.
assert.strictEqual(
  exchange.settings("ada@outlook.com", "consumers", "").smtpHost,
  "smtp-mail.outlook.com",
  "a consumer tenant uses the personal SMTP relay"
)
assert.strictEqual(
  exchange.settings("ada@contoso.com", "organizations", "").smtpHost,
  "smtp.office365.com",
  "a work tenant uses the Microsoft 365 SMTP relay"
)

// The username is always the email address, trimmed.
assert.strictEqual(exchange.settings("  Ada@Contoso.com  ", "organizations", "").username, "Ada@Contoso.com")

// ---------------------------------------------------------------- account IDs

// Exchange account IDs carry the "exchange:" prefix so an Exchange and an
// Outlook mailbox at the same address remain two distinct accounts.
assert.strictEqual(
  accounts.accountId("ada@contoso.com", "exchange"),
  "exchange:ada@contoso.com"
)
assert.strictEqual(
  accounts.accountId("ada@contoso.com", "outlook"),
  "outlook:ada@contoso.com"
)
// Both can coexist in the same list without one overwriting the other.
var list = accounts.emptyList()
list = accounts.add(list, { email: "ada@contoso.com", provider: "outlook" })
list = accounts.add(list, { email: "ada@contoso.com", provider: "exchange" })
assert.strictEqual(accounts.count(list), 2, "exchange and outlook are distinct accounts for the same address")
assert.strictEqual(accounts.find(list, "outlook:ada@contoso.com").provider, "outlook")
assert.strictEqual(accounts.find(list, "exchange:ada@contoso.com").provider, "exchange")

// ---------------------------------------------------------------- provider recognition

// "exchange" is a known provider string; anything else normalises to gmail.
assert.strictEqual(accounts.makeAccount({ email: "ada@contoso.com", provider: "exchange" }).provider, "exchange")
assert.strictEqual(accounts.makeAccount({ email: "ada@contoso.com", provider: "Exchange" }).provider, "exchange")
assert.strictEqual(accounts.makeAccount({ email: "ada@contoso.com", provider: " exchange " }).provider, "exchange")

// The PROVIDERS list includes exchange so an upgraded install that saved an
// exchange account does not lose it by reading it as gmail.
assert.ok(accounts.PROVIDERS.indexOf("exchange") >= 0, "exchange is in the recognised provider list")

// ---------------------------------------------------------------- address repair

// Exchange shares the IMAP-style username repair path: an account saved with
// a bare username in the email field is recovered from imap.username on load.
const damaged = JSON.stringify({ version: accounts.VERSION, accounts: [{
  email: "ada", provider: "exchange", imap: {
    imapHost: "outlook.office365.com", smtpHost: "smtp.office365.com",
    username: "ada@contoso.com" } }], activeId: "" })
const mended = accounts.load(damaged)
assert.strictEqual(mended.accounts[0].email, "ada@contoso.com",
  "the address is recovered from the username it was folded into")
assert.strictEqual(mended.accounts[0].id, "exchange:ada@contoso.com",
  "and the account becomes selectable")

// A username that is not a valid email cannot repair the row.
const stillDamaged = accounts.load(JSON.stringify({ version: accounts.VERSION, accounts: [{
  email: "ada", provider: "exchange", imap: { username: "ada" } }], activeId: "" }))
assert.strictEqual(stillDamaged.accounts[0].email, "ada")
assert.strictEqual(stillDamaged.accounts[0].id, "")

// ---------------------------------------------------------------- calendar provider

// Exchange authenticates through Microsoft; its calendar provider is "microsoft"
// so that the calendar tab knows which OAuth path to use for discovery.
assert.strictEqual(accounts.calendarProvider({ provider: "exchange" }), "microsoft")

// ---------------------------------------------------------------- BUILTIN_CLIENT_ID

// A client ID is set. The exact value is not tested here — that is the Azure
// registration's concern — but it must be a non-empty GUID-like string so the
// QML setup page can start the device flow without prompting the user for one.
assert.ok(microsoft.BUILTIN_CLIENT_ID.length > 0, "a built-in client ID is set")
assert.ok(microsoft.isValidClientId(microsoft.BUILTIN_CLIENT_ID),
  "the built-in client ID passes the GUID format check")

console.log("test_exchange.js ok")
