.pragma library

// Spelling presentation rules shared by the composer and optional adapter.
// Positions are UTF-16 offsets, matching Qt's text document API.
var MAX_WINDOW_CHARACTERS = 20000
var MAX_UNDERLINE_RANGES = 400
var MAX_WORD_CHARACTERS = 128
var MAX_CHUNK_CHARACTERS = 256
var MAX_CACHE_WORDS = 4096
var SLICE_MILLISECONDS = 8
var MAX_SLICE_WORDS = 12
var MAX_SLICE_CHARACTERS = 512

// Do not split a token at a window edge or traverse an arbitrarily long word.
// If expansion cannot fit the cap, skip that token rather than check a fragment.
function wordWindow(text, start, end) {
  var length = text.length
  var from = Math.max(0, Math.min(length, Math.floor(start)))
  var to = Math.max(from, Math.min(length, Math.ceil(end)))
  var walked = 0
  while (from > 0 && isWordChar(text.charAt(from - 1)) && walked < MAX_WORD_CHARACTERS) {
    from -= 1; walked += 1
  }
  if (from > 0 && isWordChar(text.charAt(from - 1))) {
    from = Math.max(0, Math.min(length, Math.floor(start)))
    while (from < length && isWordChar(text.charAt(from)) && from - start < MAX_WORD_CHARACTERS) from += 1
  }
  to = Math.min(to, from + MAX_WINDOW_CHARACTERS)
  var originalEnd = to
  while (to < length && isWordChar(text.charAt(to))
      && to - originalEnd < MAX_WORD_CHARACTERS && to - from < MAX_WINDOW_CHARACTERS) to += 1
  if (to < length && isWordChar(text.charAt(to))) {
    while (to > from && isWordChar(text.charAt(to - 1))) to -= 1
  }
  return { start: from, end: to }
}

// Find the containing paragraph with the native string search, then examine
// only its bounded indentation. No quoted words reach the dictionary checker.
function quotedAt(text, position) {
  var at = text.lastIndexOf("\n", Math.max(0, position) - 1) + 1
  var first = at
  while (at < text.length && (text.charAt(at) === " " || text.charAt(at) === "\t")
      && at - first < MAX_WORD_CHARACTERS) at += 1
  return text.charAt(at) === ">" || text.charAt(at) === " " || text.charAt(at) === "\t"
}

// A bounded chunk rule, not URL parsing: none of its word fragments are prose.
// Retain the document string in a pass so window edges cannot hide a prefix/@.
function nonProseAt(text, position) {
  var at = Math.max(0, Math.min(text.length, Math.floor(position)))
  if ((at === text.length || chunkDelimiter(text.charAt(at)))
      && at > 0 && isWordChar(text.charAt(at - 1))) at -= 1
  if (at === text.length || chunkDelimiter(text.charAt(at))) return false
  var from = at
  var to = at
  while (from > 0 && !chunkDelimiter(text.charAt(from - 1))) {
    if (at - from >= MAX_CHUNK_CHARACTERS) return true
    from -= 1
  }
  while (to < text.length && !chunkDelimiter(text.charAt(to))) {
    if (to - from >= MAX_CHUNK_CHARACTERS) return true
    to += 1
  }
  var chunk = text.substring(from, to)
  if (chunk.indexOf("://") >= 0 || /^(?:mailto:|www\.)/i.test(chunk)) return true
  var email = chunk.indexOf("@")
  while (email >= 0) {
    if (isWordChar(chunk.charAt(email - 1)) && isWordChar(chunk.charAt(email + 1))) return true
    email = chunk.indexOf("@", email + 1)
  }
  return false
}

function chunkDelimiter(character) { return /[\s<>()\[\]"',;]/.test(character) }

function createPass(text, window, visibleStart, visibleEnd, revision) {
  return { documentText: text, text: text.substring(window.start, window.end), offset: window.start,
    index: 0, documentLength: text.length, quoted: quotedAt(text, window.start),
    lineStart: false, visibleStart: visibleStart, visibleEnd: visibleEnd,
    revision: revision, ranges: [], skipLong: window.start > 0
      && isWordChar(text.charAt(window.start - 1)) && isWordChar(text.charAt(window.start)),
    done: window.end <= window.start }
}

function nextWord(pass, limit) {
  var text = pass.text
  while (pass.index < text.length && pass.index < limit) {
    var ch = text.charAt(pass.index)
    if (ch === "\n") {
      pass.index += 1; pass.lineStart = true; pass.quoted = false; pass.skipLong = false; continue
    }
    if (pass.lineStart) {
      if (ch === " " || ch === "\t") { pass.index += 1; continue }
      pass.quoted = ch === ">"; pass.lineStart = false
    }
    if (pass.skipLong) {
      if (isWordChar(ch)) { pass.index += 1; continue }
      pass.skipLong = false
    }
    if (pass.quoted || !isWordChar(ch)) { pass.index += 1; continue }
    var start = pass.index
    while (pass.index < text.length && isWordChar(text.charAt(pass.index))
        && pass.index - start <= MAX_WORD_CHARACTERS) pass.index += 1
    var end = pass.index
    if (pass.offset + end >= pass.documentLength) continue // unfinished final word
    if (end - start > MAX_WORD_CHARACTERS) { pass.skipLong = true; continue }
    while (start < end && isApostrophe(text.charAt(start))) start += 1
    while (end > start && isApostrophe(text.charAt(end - 1))) end -= 1
    if (end > start) return { start: pass.offset + start, end: pass.offset + end,
      word: text.substring(start, end) }
  }
  return null
}

// The injected clock makes the time rule deterministic in tests. `paint` runs
// inside the same slice so native geometry and delegate creation share its budget.
function advancePass(pass, isMisspelled, clock, paint) {
  var began = clock()
  var count = 0
  var limit = pass.index + MAX_SLICE_CHARACTERS
  while (!pass.done && count < MAX_SLICE_WORDS && clock() - began < SLICE_MILLISECONDS) {
    var range = nextWord(pass, limit)
    if (!range) { pass.done = pass.index >= pass.text.length; break }
    count += 1
    if (nonProseAt(pass.documentText, range.start)) continue
    if (isMisspelled(range.word) && range.end > pass.visibleStart && range.start < pass.visibleEnd) {
      var stored = { start: range.start, end: range.end }
      if (paint && paint(stored) === false) continue
      pass.ranges.push(stored)
      if (pass.ranges.length >= MAX_UNDERLINE_RANGES) pass.done = true
    }
  }
  return pass.done
}

function createCache() { return { words: ({}), size: 0 } }
function cachedVerdict(cache, word, check) {
  // Prefixing keeps arbitrary words such as __proto__ away from object keys.
  var key = "$" + word
  if (Object.prototype.hasOwnProperty.call(cache.words, key)) return cache.words[key]
  if (cache.size >= MAX_CACHE_WORDS) { cache.words = ({}); cache.size = 0 }
  var verdict = check(word)
  cache.words[key] = verdict; cache.size += 1
  return verdict
}

function isWordChar(character) {
  // Letters/digits in common scripts and apostrophes within words. Surrogate
  // halves (such as emoji) delimit words without changing UTF-16 positions.
  return /[0-9A-Za-z\u00C0-\u024F\u0300-\u036F\u0370-\u03FF\u0400-\u04FF'\u2019]/.test(character)
}

function isApostrophe(character) { return character === "'" || character === "\u2019" }

// Persisted dictionary names are untrusted. Do not trim: trailing controls
// and whitespace must be rejected before a value can reach Sonnet.
function validLanguage(value) {
  return typeof value === "string" && value.length <= 24
    && /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8}){0,2}$/.test(value)
    && !/[\r\n]/.test(value)
}

function resolveLanguage(setting, systemLocaleName) {
  if (validLanguage(setting)) return setting
  return validLanguage(systemLocaleName) ? systemLocaleName : ""
}

function decodeSettings(settings) {
  var values = settings || ({})
  return {
    enabled: values.spellingEnabled === true,
    language: validLanguage(values.spellingLanguage) ? values.spellingLanguage : ""
  }
}

// A long word can wrap within itself. Collect one underline per visual line,
// using caret positions one past the final character for each segment.
function underlineSegments(start, end, rectangleAt, leftEdge, rightEdge) {
  var segments = []
  if (end <= start) return segments
  var first = rectangleAt(start)
  var previous = first
  var direction = 1
  for (var at = start + 1; at <= end; at++) {
    var next = rectangleAt(at)
    if (next.y !== previous.y) {
      var edge = direction < 0 ? leftEdge : rightEdge
      segments.push({ x: Math.min(first.x, edge), y: first.y + first.height - 1,
        width: Math.max(2, Math.abs(edge - first.x)) })
      first = next
    } else if (next.x !== previous.x) {
      direction = next.x < previous.x ? -1 : 1
    }
    previous = next
  }
  if (previous.x !== first.x) {
    segments.push({ x: Math.min(first.x, previous.x), y: first.y + first.height - 1,
      width: Math.max(2, Math.abs(previous.x - first.x)) })
  }
  return segments
}
