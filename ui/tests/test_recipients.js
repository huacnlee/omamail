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

const own = [{email: "me@example.com"}, {email: "alias@example.com"}]
const sent = {
  from: {email: "ALIAS@example.com"},
  replyTo: {email: "different-reply@example.com"},
  to: [{email: "person@example.com"}, {email: "second@example.com"}, {email: "me@example.com"}],
  cc: [{email: "copy@example.com"}, {email: "PERSON@example.com"}, {email: "alias@example.com"}],
  bcc: [{email: "private@example.com"}]
}
deepEqual(recipients.replyFields(sent, "reply", own), {
  to: "person@example.com, second@example.com", cc: "", outgoing: true
})
deepEqual(recipients.replyFields(sent, "replyAll", own), {
  to: "person@example.com, second@example.com", cc: "copy@example.com", outgoing: true
})
deepEqual(recipients.replyFields({
  from: {email: "sender@example.com"}, replyTo: {email: "reply@example.com"},
  to: [{email: "me@example.com"}, {email: "other-account@example.com"}],
  cc: [{email: "copy@example.com"}, {email: "REPLY@example.com"}, {email: "alias@example.com"}]
}, "replyAll", own), {
  to: "reply@example.com", cc: "other-account@example.com, copy@example.com", outgoing: false
})
deepEqual(recipients.replyFields({from: own[0], to: own, cc: own}, "replyAll", own), {
  to: "", cc: "", outgoing: true
})
deepEqual(recipients.replyFields(null, "reply", own), {to: "", cc: "", outgoing: false})
// Header controls cannot create a second outgoing header from reply fields.
const hostile = recipients.replyFields({from: {email: "sender@example.com"},
  to: [{email: "me@example.com"}], cc: [{email: "copy@example.com\r\nBcc: hidden@example.com"}]
}, "replyAll", own)
assert(!/[\r\n]/.test(hostile.to + hostile.cc))

console.log("recipient tests passed")
