const assert = require("assert")
const { load, deepEqual } = require("./load")
const palette = load("calendar/Palette.js")

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

console.log("test_calendar_palette.js ok")
