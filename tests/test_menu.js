const assert = require("assert")
const { load, deepEqual } = require("./load")

const menu = load("components/Menu.js")

const entries = [
  { selectable: true },
  { selectable: false },
  { selectable: true },
  { selectable: false }
]

assert.strictEqual(menu.firstSelectable(entries), 0)
assert.strictEqual(menu.firstSelectable([{ selectable: false }]), -1)
assert.strictEqual(menu.nextSelectable(entries, 0, 1), 2)
assert.strictEqual(menu.nextSelectable(entries, 2, 1), 0, "down wraps")
assert.strictEqual(menu.nextSelectable(entries, 0, -1), 2, "up wraps")

deepEqual(menu.position(180, 190, 80, 60, 200, 200), { x: 120, y: 130 })
deepEqual(menu.position(10, 20, 80, 60, 200, 200), { x: 10, y: 20 })
deepEqual(menu.position(-10, -10, 260, 240, 200, 200), { x: 0, y: 0 })

console.log("menu tests passed")
