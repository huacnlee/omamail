const assert = require("assert")
const { load } = require("./load")

const P = load("account/People.js")

const ada = { id: "people/c1", name: "Ada Lovelace", emails: [{ value: "ada@example.com", type: "Work" }],
  phones: [{ value: "+32 470 12 34 56", type: "Mobile" }], organization: "Analytical", saved: true }
const other = { id: "local:bob@example.com", name: "", emails: [{ value: "bob@example.com" }], phones: [], saved: false }
const phoneOnly = { id: "people/c2", name: "", emails: [], phones: [{ value: "0470 99 88 77" }], saved: true }

assert.strictEqual(P.displayName(ada), "Ada Lovelace")
assert.strictEqual(P.displayName(other), "bob@example.com", "a nameless row is called by its address")
assert.strictEqual(P.displayName(phoneOnly), "0470 99 88 77")
assert.strictEqual(P.initials(ada), "AL")
assert.strictEqual(P.initials(other), "B", "the domain is not part of the badge")
assert.strictEqual(P.initials({}), "?")

assert.strictEqual(P.filter([ada, other], "", false).length, 2)
assert.deepStrictEqual(P.filter([ada, other], "", true).map(p => p.id), ["people/c1"], "saved only by default")
assert.strictEqual(P.filter([ada, other], "lovel", false).length, 1)
assert.strictEqual(P.filter([ada, other], "BOB@", false).length, 1, "addresses match, case aside")
assert.strictEqual(P.filter([ada, other], "analyt", false).length, 1, "and the organisation")
assert.strictEqual(P.filter([ada, phoneOnly], "470123", false).length, 1, "a phone matches without its spacing")
assert.strictEqual(P.filter([ada, phoneOnly], "47", false).length, 0, "but not on two digits")
assert.strictEqual(P.filter(null, "x", false).length, 0)

assert.strictEqual(P.recipient(ada), "Ada Lovelace <ada@example.com>")
assert.strictEqual(P.recipient(other), "bob@example.com")
assert.strictEqual(P.recipient({ name: 'A "B" <C>', emails: [] }, "c@example.com"), "A B C <c@example.com>")
assert.strictEqual(P.recipient(phoneOnly), "", "nobody to write to")
assert.strictEqual(P.section(ada), "A")
assert.strictEqual(P.section({ name: "émile" }), "#")
const company = { name: "", organization: "Proximus", emails: [], phones: [{ value: "080033800" }], saved: true }
assert.strictEqual(P.displayName(company), "Proximus", "a nameless number is called by its company")
assert.strictEqual(P.subtitle(company), "080033800")
assert.strictEqual(P.subtitle(ada), "Analytical")
assert.strictEqual(P.subtitle(other), "", "nothing the title did not say")
assert.deepStrictEqual([phoneOnly, ada, company].sort(P.compare).map(P.displayName),
  ["Ada Lovelace", "Proximus", "0470 99 88 77"], "letters first, unnamed numbers last")
console.log("people: ok")
