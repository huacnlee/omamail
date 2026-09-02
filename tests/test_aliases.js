const assert = require("assert")
const { load, deepEqual } = require("./load.js")

const aliases = load("account/Aliases.js")

deepEqual(aliases.parse("alias1@icloud.com, alias2@example.org"), [
  { email: "alias1@icloud.com", displayName: "", isPrimary: false, isDefault: false },
  { email: "alias2@example.org", displayName: "", isPrimary: false, isDefault: false }
])
deepEqual(aliases.parse("alias1@icloud.com (default), alias2@example.org"), [
  { email: "alias1@icloud.com", displayName: "", isPrimary: false, isDefault: true },
  { email: "alias2@example.org", displayName: "", isPrimary: false, isDefault: false }
])
deepEqual(aliases.parse("Work <alias1@icloud.com> (default), alias2@example.org"), [
  { email: "alias1@icloud.com", displayName: "Work", isPrimary: false, isDefault: true },
  { email: "alias2@example.org", displayName: "", isPrimary: false, isDefault: false }
])
deepEqual(aliases.parse(["alias@me.com", "not an email", "duplicate@me.com", "duplicate@me.com"]), [
  { email: "alias@me.com", displayName: "", isPrimary: false, isDefault: false },
  { email: "duplicate@me.com", displayName: "", isPrimary: false, isDefault: false }
])

// One default. A list naming two is not a state the composer can act on, so
// the first is kept and the rest read as ordinary aliases.
deepEqual(
  aliases.parse("a@me.com (default), b@me.com (default)").map(row => row.isDefault),
  [true, false])

assert.strictEqual(aliases.format([
  { email: "a@icloud.com" },
  { email: "b@icloud.com" }
]), "a@icloud.com, b@icloud.com")
assert.strictEqual(aliases.format([
  { email: "a@icloud.com", isDefault: true },
  { email: "b@icloud.com", displayName: "Work" }
]), "a@icloud.com (default), Work <b@icloud.com>")

// ----------------------------------------------------------- the round trip

// The settings page re-formats this list every time it opens and writes back
// what it shows, so anything `format` produces that `parse` reads differently
// is a value the user loses without touching the field.
function roundTrip(text) {
  return aliases.format(aliases.parse(text))
}

const commaName = "\"Lee, Jason\" <j@icloud.com>, second@icloud.com (default)"
deepEqual(aliases.parse(commaName), [
  { email: "j@icloud.com", displayName: "Lee, Jason", isPrimary: false, isDefault: false },
  { email: "second@icloud.com", displayName: "", isPrimary: false, isDefault: true }
])
assert.strictEqual(roundTrip(commaName), commaName,
  "a display name holding a comma survives being written back")
assert.strictEqual(roundTrip(roundTrip(commaName)), commaName,
  "and survives it a second time")

// A quotation mark in a name is escaped rather than ending the name early.
const quotedName = "\"Jay \\\"JJ\\\" Lee\" <jj@icloud.com>"
deepEqual(aliases.parse(quotedName), [
  { email: "jj@icloud.com", displayName: "Jay \"JJ\" Lee", isPrimary: false, isDefault: false }
])
assert.strictEqual(roundTrip(quotedName), quotedName)

// A name with nothing to escape is left as the user typed it.
assert.strictEqual(roundTrip("Work <b@icloud.com>"), "Work <b@icloud.com>")

// Newlines separate too, so a field that was pasted into keeps its entries.
deepEqual(aliases.parse("a@me.com\nb@me.com").map(row => row.email),
  ["a@me.com", "b@me.com"])

// A name that says "(default)" in the middle of itself is a name.
deepEqual(aliases.parse("\"Not (default) really\" <c@me.com>"), [
  { email: "c@me.com", displayName: "Not (default) really", isPrimary: false, isDefault: false }
])

assert.strictEqual(aliases.format(""), "")
deepEqual(aliases.parse(null), [])
deepEqual(aliases.parse(42), [])

// ------------------------------------------------------------- send-as list

// The mailbox's own address leads and is primary. Nothing else may claim that.
deepEqual(aliases.sendAsList("me@icloud.com", "work@icloud.com"), [
  { email: "me@icloud.com", displayName: "", isPrimary: true, isDefault: true },
  { email: "work@icloud.com", displayName: "", isPrimary: false, isDefault: false }
])

// An alias marked default takes it from the mailbox address, which is what
// makes the marker mean "the address the composer opens on".
deepEqual(aliases.sendAsList("me@icloud.com", "work@icloud.com (default)"), [
  { email: "me@icloud.com", displayName: "", isPrimary: true, isDefault: false },
  { email: "work@icloud.com", displayName: "", isPrimary: false, isDefault: true }
])

// An alias that repeats the mailbox address is the mailbox address.
deepEqual(aliases.sendAsList("me@icloud.com", "ME@icloud.com, other@icloud.com")
  .map(row => row.email), ["me@icloud.com", "other@icloud.com"])

// No address at all is an account still being set up, not a list with a blank
// row in it.
deepEqual(aliases.sendAsList("", ""), [])
deepEqual(aliases.sendAsList("", "work@icloud.com").map(row => row.email), ["work@icloud.com"])
deepEqual(aliases.sendAsList("me@icloud.com", null), [
  { email: "me@icloud.com", displayName: "", isPrimary: true, isDefault: true }
])

console.log("Aliases.js ok")
