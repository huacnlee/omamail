const assert = require("assert")
const fs = require("fs")
const path = require("path")
const vm = require("vm")

const file = path.join(__dirname, "../qml/imports/qs/Commons/Theme.js")
const context = {}
vm.createContext(context)
vm.runInContext(fs.readFileSync(file, "utf8").replace(/^\.pragma library\s*$/m, ""), context)

const semantic = context.resolve(`
mode = "light"
background = "#fffcf0"
foreground = "#100f0f"
accent = "#205ea6"
red = "#d14d41"
yellow = "#ad8301"
green = "#66800b"
lighter_background = "#f2f0e5"
dark_background = "#e6e4d9"
muted = "#b7b5ac"
`)
assert.strictEqual(semantic.appearance, "light")
assert.strictEqual(semantic.surface, "#f2f0e5")
assert.strictEqual(semantic.inset, "#e6e4d9")
assert.strictEqual(semantic.border, "#b7b5ac")
assert.ok(context.contrast(semantic.urgent, semantic.background) >= 4.5)

const ansi = context.resolve(`
color0 = "#101010"
color7 = "#eeeeee"
color1 = "#ff5555"
color2 = "#55ff55"
color3 = "#ffff55"
color4 = "#5599ff"
color8 = "#555555"
`)
assert.strictEqual(ansi.accent, "#5599ff")
assert.strictEqual(ansi.background, "#101010")
assert.strictEqual(ansi.foreground, "#eeeeee")
assert.strictEqual(ansi.border, "#555555")
assert.strictEqual(ansi.bright, "#eeeeee")

const fallback = context.fallback()
const lightFallback = context.fallback("light")
assert.strictEqual(lightFallback.appearance, "light")
assert.strictEqual(lightFallback.background, "#ffffff")
assert.strictEqual(lightFallback.foreground, "#212121")
assert.strictEqual(lightFallback.accent, "#3264eb")
assert.strictEqual(lightFallback.surface, "#f5f5f5")
assert.strictEqual(lightFallback.inset, "#ececec")
assert.strictEqual(lightFallback.selection, "#d0d0d0")
assert.strictEqual(lightFallback.border, "#9e9e9e")
assert.ok(context.contrast(lightFallback.foreground, lightFallback.background) >= 4.5)
assert.ok(context.contrast(lightFallback.urgent, lightFallback.background) >= 4.5)
for (const broken of [
  "background = '#000000'\nforeground = '#ffffff'\naccent = 'blue'",
  "background = '#000000'\nforeground = '#ffffff'\naccent = '#123456'",
  "background = '#00000000'\nforeground = '#ffffff'\naccent = '#123456'",
  "background = '#000000'\nthis is malformed"
]) {
  assert.strictEqual(JSON.stringify(context.resolve(broken)), JSON.stringify(fallback),
    "an invalid theme falls back as one complete palette")
}

assert.strictEqual(JSON.stringify(context.resolve("broken", "light")),
  JSON.stringify(lightFallback), "invalid input uses the requested complete fallback")

assert.strictEqual(context.onAccent("#eeeeee"), "#000000")
assert.strictEqual(context.onAccent("#111111"), "#ffffff")
console.log("test_theme.js ok")
