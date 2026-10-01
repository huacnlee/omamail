const assert = require("node:assert/strict")
const { test } = require("node:test")
const { load, deepEqual } = require("./load")

// Load inside each test so the baseline demonstrates all four missing rules.
function spelling() { return load("compose/Spelling.js") }

test("Only completed body words are checked", () => {
  const rules = spelling()
  const seen = []
  const checker = word => { seen.push(word); return true }
  deepEqual(rules.misspelledRanges("mispelled", checker), [])
  assert.equal(seen.length, 0, "the unfinished word never reaches the checker")
  for (const delimiter of [" ", ".", ",", "\n", "\t"]) {
    deepEqual(rules.misspelledRanges("mispelled" + delimiter, checker), [{ start: 0, end: 9 }])
  }
  deepEqual(rules.misspelledRanges("mispelled wrod", checker), [{ start: 0, end: 9 }])
  deepEqual(rules.misspelledRanges("", checker), [])
})

test("Ranges keep UTF-16 offsets, apostrophes, combining marks and repeated words", () => {
  const rules = spelling()
  const wrong = word => word !== "correct"
  const text = "📨 'wrod', correct wrod.\n"
  deepEqual(rules.misspelledRanges(text, wrong), [{ start: 4, end: 8 }, { start: 19, end: 23 }])
  deepEqual(rules.misspelledRanges("‘can’t’ cafe\u0301 Ελληνικά русский ", wrong), [
    { start: 1, end: 6 }, { start: 8, end: 13 }, { start: 14, end: 22 }, { start: 23, end: 30 }
  ])
  deepEqual(rules.misspelledRanges("'' ’ 😀 ", wrong), [])
})

test("Personal words reject malformed data and merge late disk reads with session additions", () => {
  const rules = spelling()
  for (const raw of ["", "{", "null", "[]", '{"words":{}}']) {
    deepEqual(rules.normalizePersonalWords(raw), [])
  }
  deepEqual(rules.normalizePersonalWords('{"words":["a","b","a","",42,null,{},"café"]}'), ["a", "b", "café"])
  const current = ["session", "shared"]
  deepEqual(rules.mergePersonalWords(current, '{"words":["disk","shared","disk"]}'), ["session", "shared", "disk"])
  assert.deepEqual(current, ["session", "shared"], "a merge does not mutate the session snapshot")
  deepEqual(rules.mergePersonalWords(current, "invalid"), current)
})

test("Settings default to enabled en_US and only explicit false disables checking", () => {
  const rules = spelling()
  for (const settings of [null, {}, { spellingEnabled: "no" }, { spellingEnabled: 0 }]) {
    deepEqual(rules.decodeSettings(settings), { enabled: true, language: "en_US" })
  }
  deepEqual(rules.decodeSettings({ spellingEnabled: false, spellingLanguage: "en_GB" }), { enabled: false, language: "en_GB" })
  deepEqual(rules.decodeSettings({ spellingLanguage: "" }), { enabled: true, language: "en_US" })
})

test("Underlines cover every visual line of a word and descending caret positions", () => {
  const rules = spelling()
  const positions = [
    { x: 20, y: 0, height: 10 }, { x: 30, y: 0, height: 10 },
    { x: 0, y: 10, height: 10 }, { x: 10, y: 10, height: 10 },
    { x: 0, y: 20, height: 10 }, { x: 10, y: 20, height: 10 }
  ]
  deepEqual(rules.underlineSegments(0, 5, at => positions[at], 0, 40), [
    { x: 20, y: 9, width: 20 }, { x: 0, y: 19, width: 40 }, { x: 0, y: 29, width: 10 }
  ])
  deepEqual(rules.underlineSegments(0, 1, at => ({ x: 20 - 10 * at, y: 0, height: 10 }), 0, 40), [
    { x: 10, y: 9, width: 10 }
  ])
  deepEqual(rules.underlineSegments(0, 0, at => positions[at], 0, 40), [])
})
