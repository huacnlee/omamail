const assert = require("assert")
const { load, deepEqual } = require("./load")

const microsoft = load("providers/MicrosoftOAuth.js")
const outlook = load("providers/Outlook.js")

const clientId = "12345678-1234-4abc-9def-1234567890ab"
deepEqual(outlook.settings("jane@hotmail.com"), {
  imapHost: "outlook.office365.com",
  imapPort: 993,
  smtpHost: "smtp-mail.outlook.com",
  smtpPort: 587,
  username: "jane@hotmail.com",
  aliases: [],
  insecure: false,
  send: ""
})

// A work or school mailbox submits through Microsoft 365's own SMTP host and
// may be told to send through Graph instead; a personal one is unchanged.
const work = outlook.settings("jane@contoso.com", "organizations", "graph")
assert.strictEqual(work.smtpHost, "smtp.office365.com")
assert.strictEqual(work.imapHost, "outlook.office365.com")
assert.strictEqual(work.send, "graph")
assert.strictEqual(outlook.settings("jane@hotmail.com", "", "smtp").send, "", "anything but graph is SMTP")

// The tenant is one path segment of Microsoft's URL and nothing else: a
// stored value cannot steer the sign-in to another host.
assert.strictEqual(microsoft.normalizeTenant(""), "consumers")
assert.strictEqual(microsoft.normalizeTenant(" Organizations "), "organizations")
assert.strictEqual(microsoft.normalizeTenant("contoso.onmicrosoft.com"), "contoso.onmicrosoft.com")
assert.strictEqual(microsoft.normalizeTenant("12345678-1234-4abc-9def-1234567890ab"), "12345678-1234-4abc-9def-1234567890ab")
assert.strictEqual(microsoft.normalizeTenant("evil.example/../consumers"), "consumers", "a path is not a tenant")
assert.strictEqual(microsoft.normalizeTenant("a..b"), "consumers")
assert.strictEqual(microsoft.normalizeTenant("login.microsoftonline.com?x"), "consumers")
assert.strictEqual(microsoft.tokenUrlFor("organizations"),
  "https://login.microsoftonline.com/organizations/oauth2/v2.0/token")
assert.strictEqual(microsoft.deviceUrlFor("bad tenant"), microsoft.DEVICE_URL,
  "an unusable tenant falls back to the consumer authority")
assert.strictEqual(microsoft.isWorkTenant("consumers"), false)
assert.strictEqual(microsoft.isWorkTenant("organizations"), true)

// Graph's token is asked for with the same refresh token and Graph's scope.
const graphBody = microsoft.graphRefreshBody(clientId, "refresh-secret")
assert.ok(graphBody.indexOf("grant_type=refresh_token") >= 0)
assert.ok(graphBody.indexOf("Mail.Send") >= 0)
assert.ok(graphBody.indexOf("Calendars.ReadWrite") >= 0, "one Graph token serves sending and the calendar")
assert.strictEqual(microsoft.missingCalendarScope("https://graph.microsoft.com/Mail.Send"), true)
assert.strictEqual(microsoft.missingCalendarScope("https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Calendars.ReadWrite"), false)
assert.ok(graphBody.indexOf("IMAP.AccessAsUser.All") < 0, "one resource per token")
assert.strictEqual(microsoft.missingGraphScope("https://graph.microsoft.com/Mail.Send"), false)
assert.strictEqual(microsoft.missingGraphScope("https://graph.microsoft.com/User.Read"), true)
// Microsoft lists Graph's scopes short; an answer listing none says nothing.
assert.strictEqual(microsoft.missingGraphScope("Mail.Send Calendars.ReadWrite openid profile"), false)
assert.strictEqual(microsoft.missingGraphScope("mail.send"), false)
assert.strictEqual(microsoft.missingGraphScope(""), false)
assert.strictEqual(microsoft.missingGraphScope("openid profile User.Read"), true)
deepEqual(microsoft.missingMailScopes(""), [])
deepEqual(microsoft.missingMailScopes("IMAP.AccessAsUser.All SMTP.Send"), [])
assert.ok(microsoft.graphScopeMessage().indexOf("Mail.Send") >= 0)
assert.strictEqual(microsoft.isValidClientId(clientId), true)
assert.strictEqual(microsoft.isValidClientId("not-a-guid"), false)
assert.strictEqual(microsoft.isValidClientId(""), false)
assert.strictEqual(microsoft.effectiveClientId("  " + clientId + "  "), clientId)

const deviceBody = microsoft.deviceAuthorizationBody(clientId)
assert.ok(deviceBody.indexOf("client_id=" + clientId) >= 0)
assert.ok(deviceBody.indexOf("offline_access") >= 0)
assert.ok(deviceBody.indexOf("IMAP.AccessAsUser.All") >= 0)
assert.ok(deviceBody.indexOf("SMTP.Send") >= 0)

assert.strictEqual(microsoft.verificationUri("https://microsoft.com/devicelogin"),
  "https://microsoft.com/devicelogin")
assert.strictEqual(microsoft.verificationUri("https://login.microsoftonline.com/common/oauth2/deviceauth"),
  "https://login.microsoftonline.com/common/oauth2/deviceauth")
assert.strictEqual(microsoft.verificationUri("https://login.microsoft.com/device"),
  "https://login.microsoft.com/device", "where a work or school tenant sends people")
assert.strictEqual(microsoft.verificationUri("https://www.microsoft.com/link"), "https://www.microsoft.com/link")
assert.strictEqual(microsoft.verificationUri("http://microsoft.com/devicelogin"), "")
assert.strictEqual(microsoft.verificationUri("https://microsoft.com.evil.example/devicelogin"), "")

const device = microsoft.parseDeviceResponse(200, JSON.stringify({
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "https://microsoft.com/devicelogin",
  expires_in: 900,
  interval: 7
}))
assert.strictEqual(device.ok, true)
assert.strictEqual(device.deviceCode, "device-secret")
assert.strictEqual(device.userCode, "ABCD-EFGH")
assert.strictEqual(device.interval, 7)
assert.strictEqual(microsoft.parseDeviceResponse(200, JSON.stringify({
  device_code: "secret", user_code: "code", verification_uri: "file:///tmp/trap"
})).ok, false, "the token service cannot make the desktop open a local URI")

deepEqual(microsoft.parseTokenResponse(400,
  JSON.stringify({ error: "authorization_pending" }), ""), {
  ok: false, pending: true, slowDown: false, error: ""
})
assert.strictEqual(microsoft.parseTokenResponse(400,
  JSON.stringify({ error: "slow_down" }), "").slowDown, true)

const token = microsoft.parseTokenResponse(200, JSON.stringify({
  access_token: "access",
  refresh_token: "refresh",
  expires_in: 3600,
  scope: microsoft.SCOPES.join(" ")
}), "")
assert.strictEqual(token.ok, true)
assert.strictEqual(token.accessToken, "access")
assert.strictEqual(token.refreshToken, "refresh")
deepEqual(microsoft.missingMailScopes(token.scope), [])
assert.strictEqual(microsoft.missingMailScopes(
  "https://outlook.office.com/IMAP.AccessAsUser.All").length, 1)
assert.ok(microsoft.missingScopeMessage([
  "https://outlook.office.com/SMTP.Send"
]).indexOf("SMTP.Send") >= 0)

const rotated = microsoft.parseTokenResponse(200, JSON.stringify({
  access_token: "next", expires_in: 3600
}), "saved-refresh")
assert.strictEqual(rotated.refreshToken, "saved-refresh")

const invalid = microsoft.parseTokenResponse(400,
  JSON.stringify({ error: "invalid_grant", error_description: "expired" }), "")
assert.strictEqual(invalid.invalidGrant, true)
assert.strictEqual(microsoft.refreshFailureDisposition(invalid), "signed_out")
assert.ok(microsoft.redact('{"access_token":"eyJsecret.payload.signature","device_code":"secret"}')
  .indexOf("secret") < 0)

console.log("test_microsoft_oauth.js ok")

// Every request names one resource, the device-code request included:
// the sign-in asks the mail scopes, the Graph sign-in Graph's with offline
// access, and neither names the other's resource.
assert.ok(microsoft.deviceAuthorizationBody(clientId, microsoft.SCOPES).indexOf("IMAP.AccessAsUser.All") >= 0)
assert.ok(microsoft.deviceAuthorizationBody(clientId, microsoft.SCOPES).indexOf("graph.microsoft.com") < 0,
  "the device-code request names the mail resource alone; two resources are refused (AADSTS28000)")
assert.ok(microsoft.GRAPH_SIGN_IN_SCOPES.indexOf("offline_access") >= 0)
assert.ok(microsoft.GRAPH_SIGN_IN_SCOPES.indexOf("openid") >= 0, "an id token names who entered the code")
assert.ok(microsoft.GRAPH_SIGN_IN_SCOPES.indexOf("profile") >= 0 && microsoft.GRAPH_SIGN_IN_SCOPES.indexOf("email") >= 0,
  "and by name where the mail session's id is not known")
assert.ok(microsoft.SCOPES.indexOf("openid") >= 0, "the mail token comes with the account's id")
deepEqual(microsoft.missingMailScopes("https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send"), [],
  "a token answer lists resource scopes alone")
assert.ok(microsoft.GRAPH_SIGN_IN_SCOPES.indexOf("https://graph.microsoft.com/Mail.Send") >= 0)
assert.ok(microsoft.deviceAuthorizationBody(clientId, microsoft.GRAPH_SIGN_IN_SCOPES).indexOf("outlook.office.com") < 0)
// A refusal for want of consent is told apart from a dead session, by the
// sub-error, the code, or the description; a plain bad grant is neither.
const unconsented = microsoft.parseTokenResponse(400,
  JSON.stringify({ error: "invalid_grant", suberror: "consent_required", error_codes: [65001] }), "")
assert.strictEqual(unconsented.consentRequired, true)
assert.strictEqual(microsoft.parseTokenResponse(400,
  JSON.stringify({ error: "invalid_grant", error_codes: [65001] }), "").consentRequired, true)
assert.strictEqual(microsoft.parseTokenResponse(400,
  JSON.stringify({ error: "interaction_required", error_description: "AADSTS65001: not consented" }), "").consentRequired, true)
assert.strictEqual(invalid.consentRequired, false)
assert.strictEqual(microsoft.parseTokenResponse(400,
  JSON.stringify({ error: "invalid_client", error_codes: [65001] }), "").consentRequired, false)
assert.ok(microsoft.graphConsentMessage().indexOf("Allow Microsoft Graph") >= 0)
assert.ok(microsoft.graphRefusedMessage("declined").indexOf("admin approval") >= 0)
assert.ok(microsoft.graphRefusedMessage("declined").indexOf("Mail.Send") >= 0)
// The name on an id token: the code entered as the mailbox's own account,
// as another, or as nobody the token names.
function idToken(claims) {
  return "h." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s"
}
assert.strictEqual(microsoft.signedInAs(idToken({ preferred_username: "Alice@Example.test" })), "alice@example.test")
assert.strictEqual(microsoft.signedInAs(idToken({ email: "alice@example.test", name: "Alice" })), "alice@example.test")
assert.strictEqual(microsoft.signedInAs(idToken({ upn: "alice@example.test" })), "alice@example.test")
assert.strictEqual(microsoft.signedInAs(idToken({ name: "Zoë ✓" })), "")
assert.strictEqual(microsoft.signedInAs("not a token"), "")
assert.strictEqual(microsoft.sameAccount(idToken({ preferred_username: "alice@example.test" }), "Alice@example.test"), true)
assert.strictEqual(microsoft.sameAccount(idToken({ preferred_username: "bob@example.test" }), "alice@example.test"), false)
assert.strictEqual(microsoft.sameAccount("", "alice@example.test"), true, "no name cannot be told and is let through")
// By id where the mail session's is known: a name means nothing then.
assert.strictEqual(microsoft.accountKey(idToken({ tid: "tenant-1", oid: "user-1" })), "tenant-1/user-1")
assert.strictEqual(microsoft.accountKey(idToken({ oid: "user-1" })), "")
assert.strictEqual(microsoft.sameAccount(idToken({ tid: "tenant-1", oid: "user-1", preferred_username: "jane@contoso.onmicrosoft.com" }),
  "jane@contoso.com", "tenant-1/user-1"), true, "the same account under another name")
assert.strictEqual(microsoft.sameAccount(idToken({ tid: "tenant-1", oid: "user-2", preferred_username: "alice@example.test" }),
  "alice@example.test", "tenant-1/user-1"), false, "another account under the same name")
assert.strictEqual(microsoft.sameAccount(idToken({ preferred_username: "alice@example.test" }), "alice@example.test", "tenant-1/user-1"),
  false, "no id where one is expected")
assert.ok(microsoft.otherAccountMessage("", "alice@example.test").indexOf("another Microsoft account") >= 0)
assert.ok(microsoft.otherAccountMessage("bob@example.test", "alice@example.test").indexOf("bob@example.test") >= 0)
assert.strictEqual(microsoft.parseTokenResponse(200, JSON.stringify({ access_token: "a", id_token: "h.p.s" }), "").idToken, "h.p.s")
assert.ok(microsoft.refreshTokenBody(clientId, "r", microsoft.SCOPES).indexOf("graph.microsoft.com") < 0,
  "a refresh names the mail resource alone; two resources in one token request are refused")
