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

test("Settings default to enabled system language and only explicit false disables checking", () => {
  const rules = spelling()
  for (const settings of [null, {}, { spellingEnabled: "no" }, { spellingEnabled: 0 }]) {
    deepEqual(rules.decodeSettings(settings), { enabled: true, language: "" })
  }
  deepEqual(rules.decodeSettings({ spellingEnabled: false, spellingLanguage: "en_GB" }), { enabled: false, language: "en_GB" })
  deepEqual(rules.decodeSettings({ spellingLanguage: "" }), { enabled: true, language: "" })
})

test("Language uses the system locale unless a short dictionary code overrides it", () => {
  const rules = spelling()
  for (const valid of ["en", "en_US", "de-DE", "eng_Latn_US", "sr_Latn", "es_419"]) {
    assert.equal(rules.validLanguage(valid), true)
    assert.equal(rules.resolveLanguage(valid, "de_DE"), valid)
  }
  for (const hostile of [null, 42, {}, "", "C", " en_US", "en_US ", "en_US\n",
    "en_US\r\n", "en_US\0", "../x", "en/US", "en\\US", "en..US", "éé", "a".repeat(500)]) {
    assert.equal(rules.validLanguage(hostile), false, JSON.stringify(hostile))
    assert.equal(rules.resolveLanguage(hostile, "de_DE"), "de_DE")
    deepEqual(rules.decodeSettings({ spellingLanguage: hostile }), { enabled: true, language: "" })
  }
  assert.equal(rules.resolveLanguage("", "zz_ZZ"), "zz_ZZ", "no silent English fallback")
  assert.equal(rules.resolveLanguage("", "C"), "", "an unsupported system locale never reaches Sonnet")
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
