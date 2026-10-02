.pragma library

// Spelling presentation rules, shared by the optional adapter and its stores.
// Positions are UTF-16 offsets, matching Qt's text document API.
function misspelledRanges(text, isMisspelled) {
  var ranges = []
  if (!text) return ranges
  var length = text.length
  var index = 0
  while (index < length) {
    if (!isWordChar(text.charAt(index))) { index += 1; continue }
    var start = index
    while (index < length && isWordChar(text.charAt(index))) index += 1
    var end = index
    // Nothing follows: this is the word still being typed. Earlier finished
    // words have already been collected, so stop.
    if (end >= length) break
    var wordStart = start
    var wordEnd = end
    while (wordStart < wordEnd && isApostrophe(text.charAt(wordStart))) wordStart += 1
    while (wordEnd > wordStart && isApostrophe(text.charAt(wordEnd - 1))) wordEnd -= 1
    if (wordEnd > wordStart) {
      var word = text.substring(wordStart, wordEnd)
      if (isMisspelled(word)) ranges.push({ start: wordStart, end: wordEnd })
    }
  }
  return ranges
}

function isWordChar(character) {
  // Letters/digits in common scripts and apostrophes within words. Surrogate
  // halves (such as emoji) delimit words without changing UTF-16 positions.
  return /[0-9A-Za-z\u00C0-\u024F\u0300-\u036F\u0370-\u03FF\u0400-\u04FF'\u2019]/.test(character)
}

function isApostrophe(character) { return character === "'" || character === "\u2019" }

function normalizePersonalWords(raw) {
  var parsed = null
  try { parsed = JSON.parse(String(raw || "")) } catch (e) { parsed = null }
  var list = (parsed && Array.isArray(parsed.words)) ? parsed.words : []
  var next = []
  for (var i = 0; i < list.length; i++) {
    var word = list[i]
    if (typeof word !== "string") continue
    if (word !== "" && next.indexOf(word) < 0) next.push(word)
  }
  return next
}

function mergePersonalWords(current, raw) {
  var onDisk = normalizePersonalWords(raw)
  var next = current.slice()
  for (var i = 0; i < onDisk.length; i++) {
    if (next.indexOf(onDisk[i]) < 0) next.push(onDisk[i])
  }
  return next
}

function decodeSettings(settings) {
  var values = settings || ({})
  return {
    enabled: values.spellingEnabled !== false,
    language: String(values.spellingLanguage || "en_US")
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
