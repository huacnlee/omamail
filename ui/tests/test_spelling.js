const assert = require("node:assert/strict")
const { test } = require("node:test")
const { load, deepEqual } = require("./load")

// Load inside each test so the baseline demonstrates all four missing rules.
function spelling() { return load("compose/Spelling.js") }
function collectRanges(rules, text, checker) {
  const window = rules.wordWindow(text, 0, text.length)
  const pass = rules.createPass(text, window, window.start, window.end, 0)
  while (!pass.done) rules.advancePass(pass, checker, () => 0)
  return pass.ranges
}

test("Only completed body words are checked", () => {
  const rules = spelling()
  const seen = []
  const checker = word => { seen.push(word); return true }
  deepEqual(collectRanges(rules, "mispelled", checker), [])
  assert.equal(seen.length, 0, "the unfinished word never reaches the checker")
  for (const delimiter of [" ", ".", ",", "\n", "\t"]) {
    deepEqual(collectRanges(rules, "mispelled" + delimiter, checker), [{ start: 0, end: 9 }])
  }
  deepEqual(collectRanges(rules, "mispelled wrod", checker), [{ start: 0, end: 9 }])
  deepEqual(collectRanges(rules, "", checker), [])
})

test("Ranges keep UTF-16 offsets, apostrophes, combining marks and repeated words", () => {
  const rules = spelling()
  const wrong = word => word !== "correct"
  const text = "📨 'wrod', correct wrod.\n"
  deepEqual(collectRanges(rules, text, wrong), [{ start: 4, end: 8 }, { start: 19, end: 23 }])
  deepEqual(collectRanges(rules, "‘can’t’ cafe\u0301 Ελληνικά русский ", wrong), [
    { start: 1, end: 6 }, { start: 8, end: 13 }, { start: 14, end: 22 }, { start: 23, end: 30 }
  ])
  deepEqual(collectRanges(rules, "'' ’ 😀 ", wrong), [])
})

test("Email chunks skip every token without dictionary calls", () => {
  const r = spelling()
  for (const address of ["sam@example.com", "first.last+tag@sub.example.co.uk", "élise@exemple.fr"]) {
    for (const wrap of [["", ""], ["<", ">"], ["(", ")"], ["[", "]"], ['"', '"'], ["'", "'"], [",", ";"]]) {
      const text = "shedule " + wrap[0] + address + wrap[1] + " recieve "
      const seen = []
      const ranges = collectRanges(r, text, word => { seen.push(word); return true })
      assert.deepEqual(seen, ["shedule", "recieve"])
      deepEqual(ranges, [{ start: 0, end: 7 }, { start: text.indexOf("recieve"), end: text.indexOf("recieve") + 7 }])
      assert.equal(r.nonProseAt(text, text.indexOf(address)), true)
    }
  }
})

test("Link chunks skip schemes, mailto, www and misspelled paths/query/fragment", () => {
  const r = spelling()
  for (const link of ["http://x.y/recieve", "https://x.y/recieve?teh=wrod#shedule",
    "ftp://x.y/wrod", "file:///recieve", "a+b.c-d://wrod", "HTTPS://x.y/wrod",
    "www.x.y/recieve", "mailto:sam", "mailto:sam@example.com", "Re:http://x.y/recieve", "see:https://x.y/wrod", "1http://wrod"]) {
    for (const suffix of [" ", ". ", ", ", "; "]) {
      const text = "shedule (" + link + ")" + suffix + "recieve "
      const seen = []
      collectRanges(r, text, word => { seen.push(word); return true })
      assert.deepEqual(seen, ["shedule", "recieve"], text)
      assert.equal(r.nonProseAt(text, text.indexOf(link)), true)
    }
  }
  deepEqual(collectRanges(r, "see https://x.y/recieve. ", w => w !== "see"), [])
})

test("Incomplete @ and non-link prefixes do not suppress prose", () => {
  const r = spelling()
  for (const text of ["@ noon ", "me@ ", "@me ", "me@.noon ", "http:wrod "]) {
    assert.equal(r.nonProseAt(text, text.indexOf(" ") - 1), false, text)
    const seen = []
    collectRanges(r, text, word => { seen.push(word); return true })
    assert.ok(seen.length > 0, text)
  }
  const seen = []
  collectRanges(r, "Thanks shedule, sam@example.com ", word => { seen.push(word); return true })
  assert.deepEqual(seen, ["Thanks", "shedule"])
})

test("Non-prose spans survive window edges and caret ends", () => {
  const r = spelling()
  const text = "https://x.y/recieve?teh=wrod#shedule sam@example.com recieve "
  for (const word of ["recieve", "teh", "wrod", "shedule", "sam", "example", "com"]) {
    const at = text.indexOf(word)
    for (const position of [at, at + word.length]) assert.equal(r.nonProseAt(text, position), true)
    const window = r.wordWindow(text, at, at + word.length)
    const pass = r.createPass(text, window, at, at + word.length, 0)
    while (!pass.done) r.advancePass(pass, () => { throw Error("window fragment reached dictionary") }, () => 0)
  }
  assert.equal(r.nonProseAt(text, text.lastIndexOf("recieve")), false)
})

test("Overlong chunks are skipped with bounded scans and skipped words still yield", () => {
  const r = spelling()
  const cap = r.MAX_CHUNK_CHARACTERS
  const chunk = "wrod-".repeat(20000)
  for (const at of [0, 100, 50000, chunk.length - 1]) {
    let reads = 0
    const input = { length: chunk.length, charAt: index => { reads++; return chunk.charAt(index) } }
    assert.equal(r.nonProseAt(input, at), true)
    assert.ok(reads <= cap + 8, "the cap bounds character reads even in a huge chunk")
  }
  const exact = "-".repeat(cap - 4) + "wrod"
  assert.equal(r.nonProseAt(exact + " ", cap - 2), false)
  assert.equal(r.nonProseAt("-" + exact + " ", cap - 1), true)
  const text = chunk + " shedule "
  const window = { start: chunk.length - 40, end: text.length }
  const pass = r.createPass(text, window, 0, text.length, 0)
  const seen = []
  while (!pass.done) r.advancePass(pass, w => { seen.push(w); return true }, () => 0)
  assert.deepEqual(seen, ["shedule"])
  const repeated = "sam@example.com ".repeat(10000)
  const bounded = r.createPass(repeated, r.wordWindow(repeated, 0, repeated.length), 0, repeated.length, 0)
  r.advancePass(bounded, () => { throw Error("address reached dictionary") }, () => 0)
  assert.equal(bounded.done, false)
  assert.ok(bounded.index <= r.MAX_SLICE_CHARACTERS)
})

test("Settings default to disabled system language and only explicit true enables checking", () => {
  const rules = spelling()
  for (const settings of [null, {}, { spellingEnabled: "yes" }, { spellingEnabled: 1 }, { spellingEnabled: "true" }]) {
    deepEqual(rules.decodeSettings(settings), { enabled: false, language: "" })
  }
  deepEqual(rules.decodeSettings({ spellingEnabled: false, spellingLanguage: "en_GB" }), { enabled: false, language: "en_GB" })
  deepEqual(rules.decodeSettings({ spellingEnabled: true, spellingLanguage: "" }), { enabled: true, language: "" })
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
    deepEqual(rules.decodeSettings({ spellingEnabled: true, spellingLanguage: hostile }), { enabled: true, language: "" })
  }
  assert.equal(rules.resolveLanguage("", "zz_ZZ"), "zz_ZZ", "no silent English fallback")
  for (const locale of ["C", "POSIX", ""]) {
    assert.equal(rules.resolveLanguage("", locale), "", "an unset system locale never reaches Sonnet")
    assert.equal(rules.resolveLanguage("de_DE", locale), "de_DE")
  }
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
  collectRanges(r, hostile, w => { seen.push(w); return true })
  assert.equal(seen.length, 0, "a huge token never reaches the native checker")
  collectRanges(r, "a".repeat(129) + " wrod ", w => { seen.push(w); return true })
  assert.deepEqual(seen, ["wrod"], "an over-budget token is skipped, not split")
  deepEqual(collectRanges(r, "a".repeat(129) + "\nwrod ", () => true), [{ start: 130, end: 134 }])
})

test("Quoted lines skip lookup including an initial window in the middle of a quote", () => {
  const r = spelling()
  const text = "wrod \n  > mispelled wrod \n\t> more wrod \nunquoted "
  const seen = []
  const ranges = collectRanges(r, text, w => { seen.push(w); return true })
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
