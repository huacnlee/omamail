const assert = require("assert")
const { load, deepEqual } = require("./load")

const recipients = load("compose/Recipients.js")

const contacts = [
  { name: "Jane Doe", email: "jane@example.com" },
  { name: "Morgan Reed", email: "morgan@example.com" },
  { name: "Jane Duplicate", email: "JANE@example.com" },
  { name: "", email: "invalid" }
]

deepEqual(recipients.normalize(contacts), [
  { name: "Jane Doe", email: "jane@example.com" },
  { name: "Morgan Reed", email: "morgan@example.com" }
])

deepEqual(recipients.suggest(contacts, "ja", 5), [
  { name: "Jane Doe", email: "jane@example.com" }
])
deepEqual(recipients.suggest(contacts, "Morgan <morgan@example.com>, ja", 5), [
  { name: "Jane Doe", email: "jane@example.com" }
])
assert.strictEqual(recipients.suggest(contacts, "jane@example.com, ", 5).length, 0)
assert.strictEqual(recipients.suggest(contacts, "jane@example.com", 5).length, 0)

assert.strictEqual(
  recipients.accept("other@example.com, ja", contacts[0]),
  "other@example.com, Jane Doe <jane@example.com>"
)
// A contact with no name is its address, which is the branch `address()` takes
// when there is no phrase to put in front of one.
assert.strictEqual(
  recipients.accept("ja", { name: "", email: "jane@example.com" }),
  "jane@example.com"
)
assert.strictEqual(
  recipients.append("first@example.com", contacts[0]),
  "first@example.com, Jane Doe <jane@example.com>"
)
assert.strictEqual(
  recipients.append("", contacts[0]),
  "Jane Doe <jane@example.com>"
)
assert.strictEqual(
  recipients.append("Jane Doe <jane@example.com>", contacts[0]),
  "Jane Doe <jane@example.com>"
)

deepEqual(recipients.filter(contacts, "morgan"), [
  { name: "Morgan Reed", email: "morgan@example.com" }
])
deepEqual(recipients.filter(contacts, "").length, 2)

console.log("recipient tests passed")
