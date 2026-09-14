const assert = require("assert")
const { load, deepEqual } = require("../../ui/tests/load")

const ShellTheme = load("../app/qml/imports/qs/Commons/ShellTheme.js")

deepEqual(ShellTheme.parse(`
  # comment
  [font]
  base-size = 14
  body-small = "12" # inline comment
  [spacing]
  scale-with-font = false
`), {
  "font.base-size": "14",
  "font.body-small": "12",
  "spacing.scale-with-font": "false"
})

const resolved = ShellTheme.resolve(`
[font]
base-size = 14
body = 15
icon = 18
[spacing]
scale = 1.25
scale-with-font = true
control-height = 32
panel-padding = 20
[style]
normal-fill-alpha = 0.05
selected-color = accent
[controls]
hover-cursor-color = "#abc"
focus-border-width = 2
[popups]
background = background
background-alpha = 0.95
text = foreground
border = "#aabbccdd"
border-alpha = 0.4
`, `
[font]
base-size = 16
[spacing]
scale-with-font = off
control-height = 36
[controls]
selected-color = foreground
`)

assert.strictEqual(resolved.font.baseSize, 16)
deepEqual(resolved.font.overrides, { body: 15, icon: 18 })
assert.strictEqual(resolved.spacing.scale, 1.25)
assert.strictEqual(resolved.spacing.scaleWithFont, false)
assert.strictEqual(resolved.spacing.overrides["control-height"], 36)
assert.strictEqual(resolved.spacing.overrides["panel-padding"], 20)
assert.strictEqual(resolved.controls["normal-fill-alpha"], 0.05)
assert.strictEqual(resolved.controls["selected-color"], "foreground")
assert.strictEqual(resolved.controls["hover-cursor-color"], "#abc")
assert.strictEqual(resolved.controls["focus-border-width"], 2)
deepEqual(resolved.popups, {
  background: "background", "background-alpha": 0.95,
  text: "foreground", border: "#aabbccdd", "border-alpha": 0.4
})

const invalid = ShellTheme.resolve(`
[font]
base-size = 0
body = NaN
caption = -1
[spacing]
scale = -2
scale-with-font = perhaps
control-height = -1
[controls]
normal-fill-alpha = 2
selected-color = chartreuse
normal-border-width = -1
[popups]
background = nope
border-alpha = -0.1
unknown = accent
[unknown]
thing = 9
`, "")

deepEqual(invalid, {
  font: { baseSize: 12, overrides: {} },
  spacing: { scale: 1, scaleWithFont: true, overrides: {} },
  controls: {}, popups: {}
})

// User values replace theme values before validation, matching Omarchy's
// mergeShell behavior: an invalid explicit override resets that token to its
// default instead of silently reviving the hidden theme value.
const invalidOverride = ShellTheme.resolve(`
[font]
base-size = 15
[controls]
normal-fill-alpha = 0.1
`, `
[font]
base-size = broken
[controls]
normal-fill-alpha = 7
`)
assert.strictEqual(invalidOverride.font.baseSize, 12)
assert.strictEqual(invalidOverride.controls["normal-fill-alpha"], undefined)

console.log("shell theme tests passed")
