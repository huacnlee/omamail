const assert = require("assert")
const fs = require("fs")
const path = require("path")
const { load } = require("./load")

const icons = load("components/Icons.js")

// Every name resolves to exactly one character from the Nerd Font range that
// holds the Material Design Icons — the range the Omarchy shell draws from.
for (const name of icons.names()) {
  const text = icons.glyph(name)
  assert.strictEqual([...text].length, 1, `${name} is one glyph`)
  const code = text.codePointAt(0)
  assert.ok(code >= icons.RANGE_FIRST && code <= icons.RANGE_LAST, `${name} is in the nf-md range`)
}
assert.strictEqual(icons.glyph("nope"), "", "an unknown name draws nothing, visibly")
assert.strictEqual(icons.glyph(""), "")
assert.strictEqual(icons.glyph(null), "")

// A state has its own form only where one exists.
assert.notStrictEqual(icons.glyph("star", true), icons.glyph("star", false), "a set star is filled")
assert.strictEqual(icons.glyph("unread", true), icons.glyph("unread", false), "nothing else changes with filled")

// Two names that must not be confused with each other, because they sit in
// the same row: the mail-forward arrow is not "next".
assert.notStrictEqual(icons.glyph("forward"), icons.glyph("chevronRight"))

// Every icon a view asks for by name is defined. Scans the QML for the
// literal names handed to ActionIcon, IconButton, IconTextButton and
// ProviderLogo's fallback, so a typo in a view is a failed test rather than
// an empty slot in the window.
const root = path.join(__dirname, "..")
const files = [path.join(root, "App.qml")]
for (const entry of fs.readdirSync(path.join(root, "components"))) {
  if (entry.endsWith(".qml")) files.push(path.join(root, "components", entry))
}
const asked = new Set()
for (const file of files) {
  const text = fs.readFileSync(file, "utf8")
  for (const match of text.matchAll(/(?:iconName|fallbackIcon): "([A-Za-z]+)"/g)) asked.add(match[1])
  for (const match of text.matchAll(/ActionIcon \{[^}]*?\bname: "([A-Za-z]+)"/gs)) asked.add(match[1])
}
assert.ok(asked.size >= 20, `found the icon names the views use (${asked.size})`)
for (const name of asked) assert.ok(icons.has(name), `the views ask for "${name}", which Icons.js defines`)

console.log("test_icons.js ok")
