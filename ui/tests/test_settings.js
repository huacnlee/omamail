const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { load, deepEqual } = require("./load")
const settings = load("settings/Settings.js")
const bridge = load("bar/Bridge.js")
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../../manifest.json"), "utf8"))

for (const key of ["spellingEnabled", "spellingLanguage"]) {
  assert.equal(settings.DEFAULTS[key], manifest.barWidget.defaults[key])
}
deepEqual(settings.normalize(null), settings.DEFAULTS)
assert.equal(settings.normalize({ spellingEnabled: false }).spellingEnabled, false)
assert.equal(settings.normalize({ aiAgent: "Claude", calendarSnoozeMinutes: 10 }).aiAgent, "Claude")
assert.equal(settings.normalize({ spellingLanguage: null, aiModel: undefined }).spellingLanguage, "en_US")
assert.equal(settings.normalize({ aiModel: undefined }).aiModel, "")
assert.equal(settings.DEFAULTS.aiAgent, "System default", "normalization does not mutate defaults")
deepEqual(bridge.settings({ spellingEnabled: false, spellingLanguage: "en_GB", secret: "synthetic" }, settings.DEFAULTS), {
  spellingEnabled: false, spellingLanguage: "en_GB"
})
console.log("settings: defaults, normalization and filtered bar preferences pass")
