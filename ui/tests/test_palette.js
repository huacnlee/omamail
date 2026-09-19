const assert = require("assert")
const { load, deepEqual } = require("./load")
const palette = load("components/Palette.js")

deepEqual(palette.keys(), ["accent", "red", "green", "yellow", "blue", "magenta", "cyan"])

const parsed = palette.parse([
  'accent = "#ff7a00"',
  'red = "#d45941"',
  'color2 = "#578c60"',
  'yellow = "#c9b26d"',
  'color4 = "#5fa2d5"',
  'magenta = "#b07aa1"',
  'color6 = "#7ec0ae"'
].join("\n"))
deepEqual(parsed, {
  accent: "#ff7a00", red: "#d45941", green: "#578c60",
  yellow: "#c9b26d", blue: "#5fa2d5", magenta: "#b07aa1", cyan: "#7ec0ae"
})

assert.strictEqual(palette.normalizeKey("blue"), "blue")
assert.strictEqual(palette.normalizeKey("unknown"), "")
assert.strictEqual(palette.defaultKey("work-team"), palette.defaultKey("work-team"),
  "the fallback is stable")
assert.ok(palette.keys().indexOf(palette.defaultKey("work-team")) >= 0)

// A palette with colour in it is used as the theme wrote it. The "white"
// theme's six ANSI slots are one grey ramp, and identity colours drawn from
// them would be six greys that name the same thing.
assert.strictEqual(palette.chromatic(parsed), true)
assert.strictEqual(palette.chromatic({
  red: "#2a2a2a", green: "#3a3a3a", yellow: "#4a4a4a",
  blue: "#1a1a1a", magenta: "#2e2e2e", cyan: "#3e3e3e"
}), false)
assert.strictEqual(palette.chromatic({}), false)
assert.strictEqual(palette.chromatic(null), false)
assert.strictEqual(palette.saturation("#808080"), 0)
assert.ok(palette.saturation("#40a02b") >= 0.25)
assert.strictEqual(palette.rgb("#40a02b")[0], 0x40 / 255)
assert.strictEqual(palette.rgb("nonsense"), null)

// The generated identity colour: a valid, stable value for an identity, and a
// darker one on a light panel than on a dark one so it stays readable.
const light = palette.generatedColor("account:me@example.org", true)
const dark = palette.generatedColor("account:me@example.org", false)
assert.ok(/^#[0-9a-f]{6}$/.test(light), "a light panel gets a hex colour")
assert.ok(/^#[0-9a-f]{6}$/.test(dark), "a dark panel gets a hex colour")
assert.strictEqual(palette.generatedColor("account:me@example.org", true), light,
  "the same identity keeps its colour")
assert.notStrictEqual(light, dark, "the panel's lightness reaches the colour")
const hue = palette.identityHue("account:me@example.org")
assert.ok(hue >= 0 && hue < 360, "a hue inside the circle")
assert.strictEqual(palette.identityHue("account:me@example.org"), hue, "the hue is stable")

// Each named slot keeps its meaning where the theme has none to give: a
// greyscale theme's "yellow" is a grey, so the name's own hue is drawn instead.
assert.strictEqual(palette.keyHue("yellow"), 48)
assert.strictEqual(palette.keyHue("accent"), null)
assert.strictEqual(palette.keyHue("nope"), null)
const yellow = palette.rgb(palette.generatedHueColor(palette.keyHue("yellow"), true))
assert.ok(yellow[0] > 0.4 && yellow[1] > 0.3 && yellow[2] < 0.2,
  "the yellow slot is drawn yellow, not grey: " + yellow)
const red = palette.rgb(palette.generatedHueColor(palette.keyHue("red"), true))
assert.ok(red[0] > red[1] && red[0] > red[2], "the red slot is drawn red")

console.log("test_palette.js ok")
