const assert = require("assert")
const { load } = require("./load")

const providers = load("calendar/Providers.js")

// Every card names a kind the plugin has, a fixed HTTPS address or a hint
// for one, and only a known help host.
const ids = {}
for (const preset of providers.LIST) {
  assert.ok(!ids[preset.id], "ids are unique: " + preset.id)
  ids[preset.id] = true
  assert.ok(["caldav", "google"].indexOf(preset.kind) >= 0, preset.id + " has a known kind")
  if (preset.kind === "caldav") {
    const address = preset.url || preset.urlHint
    assert.ok(/^https:\/\//.test(address), preset.id + " starts from an HTTPS address")
  }
  if (preset.helpUrl) assert.ok(providers.isHelpUrl(preset.helpUrl), preset.id + " links a known help page")
}
assert.ok(providers.find("icloud"), "iCloud is a card")
assert.strictEqual(providers.find("nope"), null)

const icloud = providers.formFor("icloud")
assert.strictEqual(icloud.url, "https://caldav.icloud.com/")
assert.strictEqual(icloud.kind, "caldav")
assert.ok(icloud.note.indexOf("app-specific") >= 0)

const other = providers.formFor("caldav")
assert.strictEqual(other.url, "", "a server the user runs has no address to prefill")
assert.ok(other.urlHint.indexOf("https://") === 0)

const unknown = providers.formFor("")
assert.strictEqual(unknown.kind, "caldav")
assert.strictEqual(unknown.usernameHint, "Username")

assert.strictEqual(providers.formFor("google").kind, "google")
assert.strictEqual(providers.isHelpUrl("https://support.apple.com/102654"), true)
assert.strictEqual(providers.isHelpUrl("https://evil.example/support.apple.com/"), false)
assert.strictEqual(providers.isHelpUrl("http://support.apple.com/102654"), false, "HTTPS only")

console.log("test_calendar_providers.js ok")
