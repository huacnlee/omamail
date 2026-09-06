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
  insecure: false
})
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
