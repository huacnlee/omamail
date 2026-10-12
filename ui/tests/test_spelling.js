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

test("Windows expand whole words, preserve offsets and cap hostile tokens", () => {
  const r = spelling()
  deepEqual(r.wordWindow("hello mispelled here ", 8, 12), { start: 6, end: 15 })
  const text = "wrod ".repeat(20000)
  const window = r.wordWindow(text, 0, text.length)
  assert.ok(window.end - window.start <= r.MAX_WINDOW_CHARACTERS)
  assert.equal(text[window.end - 1], " ")
  const hostile = "a".repeat(100000) + " wrod "
  const seen = []
  r.misspelledRanges(hostile, w => { seen.push(w); return true })
  assert.equal(seen.length, 0, "a huge token never reaches the native checker")
  r.misspelledRanges("a".repeat(129) + " wrod ", w => { seen.push(w); return true })
  assert.deepEqual(seen, ["wrod"], "an over-budget token is skipped, not split")
  deepEqual(r.misspelledRanges("a".repeat(129) + "\nwrod ", () => true), [{ start: 130, end: 134 }])
})

test("Quoted lines skip lookup including an initial window in the middle of a quote", () => {
  const r = spelling()
  const text = "wrod \n  > mispelled wrod \n\t> more wrod \nunquoted "
  const seen = []
  const ranges = r.misspelledRanges(text, w => { seen.push(w); return true })
  assert.deepEqual(seen, ["wrod", "unquoted"])
  assert.equal(ranges.length, 2)
  assert.equal(r.quotedAt(text, text.indexOf("mispelled")), true)
  assert.equal(r.quotedAt(text, text.indexOf("unquoted")), false)
  const window = r.wordWindow(text, text.indexOf("mispelled") + 2, text.indexOf("more") + 2)
  const pass = r.createPass(text, window, 0, text.length, 1)
  while (!pass.done) r.advancePass(pass, () => { throw Error("quote reached checker") }, () => 0)
})

test("Range, token, character and deterministic time budgets yield without losing work", () => {
  const r = spelling()
  const text = "wrod ".repeat(10000)
  const window = r.wordWindow(text, 0, text.length)
  const pass = r.createPass(text, window, 0, text.length, 7)
  const paint = []
  r.advancePass(pass, () => true, () => 0, range => paint.push(range))
  assert.equal(pass.ranges.length, r.MAX_SLICE_WORDS)
  assert.equal(pass.done, false)
  let clock = 0
  const timed = r.createPass(text, window, 0, text.length, 7)
  r.advancePass(timed, () => true, () => { clock += 4; return clock })
  assert.equal(timed.ranges.length, 1)
  while (!pass.done) r.advancePass(pass, () => true, () => 0)
  assert.equal(pass.ranges.length, r.MAX_UNDERLINE_RANGES)
  const blank = r.createPass(" ".repeat(20000), { start: 0, end: 20000 }, 0, 20000, 0)
  r.advancePass(blank, () => true, () => 0)
  assert.equal(blank.done, false)
  assert.ok(blank.index <= r.MAX_SLICE_CHARACTERS)
  const narrow = r.createPass(text, window, 1000, 1100, 0)
  while (!narrow.done) r.advancePass(narrow, () => true, () => 0)
  assert.ok(narrow.ranges.length > 0)
  assert.ok(narrow.ranges.every(x => x.start >= 1000 && x.end <= 1100))
})

test("Cached verdicts avoid repeat queries, are bounded and invalidate with the session", () => {
  const r = spelling()
  const session = load("compose/SpellingSession.js")
  let count = 0
  let cache = r.createCache()
  const checker = () => { count++; return true }
  assert.equal(r.cachedVerdict(cache, "__proto__", checker), true)
  assert.equal(r.cachedVerdict(cache, "__proto__", checker), true)
  assert.equal(count, 1)
  let notifications = 0
  const adapter = { resetCache() { cache = r.createCache() }, checkerChanged() { notifications++ } }
  session.subscribe(adapter)
  session.changed()
  assert.equal(notifications, 1)
  r.cachedVerdict(cache, "__proto__", checker)
  assert.equal(count, 2, "Ignore and language notifications discard stale verdicts")
  for (let i = 0; i <= r.MAX_CACHE_WORDS; i++) r.cachedVerdict(cache, "w" + i, checker)
  assert.ok(cache.size <= r.MAX_CACHE_WORDS)
  session.unsubscribe(adapter)
  session.changed()
  assert.equal(notifications, 1)
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
