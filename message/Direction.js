.pragma library

// Which way a piece of a message runs.
//
// Qt already resolves a paragraph's direction from its first strong character,
// and it does it well: an Arabic body, an Arabic line inside a Latin one, and a
// Hebrew subject in a `Text` all come out right without being told. This module
// exists for the three places that answer is wrong or unavailable.
//
// 1. A reply prefix is Latin. `Re: مرحبا` has a strong `R` in front of it, so
//    first-strong says left-to-right and the whole subject aligns against the
//    wrong edge for every message in a thread after the first — which is most
//    of them. The prefix is not part of what the subject says, so it is not
//    part of what decides which way the subject runs.
// 2. Qt's rich text engine honours the `dir` attribute and ignores the CSS
//    `direction` property. A sender who writes `style="direction:rtl"` — which
//    is what a mail template built for a browser writes — gets a left-to-right
//    layout with the text jammed against the wrong margin. Html.js translates
//    one spelling into the other, and needs this module to know what it is
//    translating to.
// 3. A reader may want the answer overridden. First-strong is a guess about a
//    document, and a mailbox that is mostly one direction is better served by
//    saying so once than by having the guess re-made per message.
//
// The rules here are the ones from the Unicode bidirectional algorithm (UAX #9)
// that decide a paragraph's direction — P2, "find the first character of type
// L, AL, or R while skipping over any characters between an isolate initiator
// and its matching PDI", and P3, "if a character is found in P2 and it is of
// type AL or R, then set the paragraph level to one; otherwise, set it to
// zero". Not the whole algorithm: the rest of it is Qt's job and Qt does it.

// ----------------------------------------------------------------- the modes
//
// What the setting stores. Spelled as the words the settings schema shows,
// because the shell hands a plugin the label the user picked rather than a key
// behind it — the same arrangement `heavyMessageRendering` already uses.
var AUTO = "Auto"
var LEFT_TO_RIGHT = "Left to right"
var RIGHT_TO_LEFT = "Right to left"
var MODE_DEFAULT = AUTO

// What a resolved answer is. Lowercase because these are also what goes into
// the `dir` attribute, and a document that carried `dir="Right to left"` would
// be silently ignored rather than loudly wrong.
var LTR = "ltr"
var RTL = "rtl"
// No strong character at all: a subject that is a number, a body that is a
// row of dashes. The caller decides what to do with it, because "unknown" and
// "left-to-right" are the same rendering but not the same fact — a document
// gets no `dir` at all rather than one asserting a direction nobody chose.
var UNKNOWN = ""

function normalizeMode(value) {
  var text = String(value === undefined || value === null ? "" : value)
  if (text === RIGHT_TO_LEFT) return RIGHT_TO_LEFT
  if (text === LEFT_TO_RIGHT) return LEFT_TO_RIGHT
  return AUTO
}

function isRightToLeft(direction) {
  return String(direction) === RTL
}

// ------------------------------------------------------- strong and neutral
//
// The classification runs on code points rather than on UTF-16 units, because
// the RTL blocks above the BMP — Kharoshthi, Old Hungarian, Adlam, the Arabic
// mathematical alphabets — are written as surrogate pairs, and a scan that
// read the halves separately would see two unassigned BMP characters and call
// a wholly right-to-left message left-to-right.

// Every right-to-left block Unicode defines, as [first, last] pairs. This list
// is the one thing here that has to be complete: a script missing from it is
// classified strong left-to-right by the fallback below, which is a wrong
// answer rather than an absent one.
var RTL_RANGES = [
  [0x0590, 0x05FF], // Hebrew
  [0x0600, 0x07BF], // Arabic, Syriac, Arabic Supplement, Thaana
  [0x07C0, 0x085F], // NKo, Samaritan, Mandaic
  [0x0860, 0x08FF], // Syriac Supplement, Arabic Extended-A and -B
  [0xFB1D, 0xFB4F], // Hebrew presentation forms
  [0xFB50, 0xFDFF], // Arabic presentation forms-A
  [0xFE70, 0xFEFC], // Arabic presentation forms-B (the last assigned is FEFC)
  [0x10800, 0x10CFF], // Cypriot, Phoenician, Kharoshthi, Old Hungarian
  [0x10D00, 0x10FFF], // Hanifi Rohingya, Sogdian, Elymaic, Old Sogdian
  [0x1E800, 0x1EFFF] // Mende Kikakui, Adlam, Arabic mathematical alphabets
]

// The marks and the embedding controls, which say a direction outright instead
// of being a character that happens to have one.
var LEFT_TO_RIGHT_MARK = 0x200E
var RIGHT_TO_LEFT_MARK = 0x200F
var ARABIC_LETTER_MARK = 0x061C
var LEFT_TO_RIGHT_EMBEDDING = 0x202A
var RIGHT_TO_LEFT_EMBEDDING = 0x202B
var LEFT_TO_RIGHT_OVERRIDE = 0x202D
var RIGHT_TO_LEFT_OVERRIDE = 0x202E
var LEFT_TO_RIGHT_ISOLATE = 0x2066
var RIGHT_TO_LEFT_ISOLATE = 0x2067
var FIRST_STRONG_ISOLATE = 0x2068
var POP_DIRECTIONAL_ISOLATE = 0x2069

function isRtlCode(code) {
  for (var i = 0; i < RTL_RANGES.length; i++) {
    if (code >= RTL_RANGES[i][0] && code <= RTL_RANGES[i][1]) return true
  }
  return false
}

// Neutral rather than "not a letter": the question P2 asks is which characters
// may be skipped over, and digits are the ones that matter. A subject that
// opens with a year — `2024 مرحبا` — is right-to-left, and a scan that treated
// `2` as strong left-to-right would get it backwards. European and Arabic
// digits are both types of their own (EN and AN) and neither is strong.
function isNeutralCode(code) {
  // Controls, space, the ASCII digits, and the two runs of ASCII punctuation
  // and symbols on either side of the capital letters.
  if (code <= 0x0040) return true
  if (code >= 0x005B && code <= 0x0060) return true
  // The punctuation after the small letters, then Latin-1 punctuation, signs
  // and currency, which run to the first accented letter at 0x00C0.
  if (code >= 0x007B && code <= 0x00BF) return true
  if (code === 0x00D7 || code === 0x00F7) return true // × ÷
  // The Arabic block's own numbers. These sit inside the strong ranges below,
  // so they are only reachable because `directionOfCode` asks this question
  // first — see the note there.
  if (code >= 0x0600 && code <= 0x0605) return true // Arabic number signs (AN)
  if (code >= 0x0660 && code <= 0x066C) return true // Arabic-Indic digits and separators
  if (code === 0x06DD || code === 0x08E2) return true // end of ayah, disputed end of ayah
  if (code >= 0x06F0 && code <= 0x06F9) return true // extended Arabic-Indic digits
  if (code >= 0x10E60 && code <= 0x10E7E) return true // Rumi numeral symbols (AN)
  if (code >= 0x0300 && code <= 0x036F) return true // combining marks (NSM)
  if (code >= 0x2000 && code <= 0x2BFF) return true // punctuation, symbols, arrows
  if (code >= 0x2E00 && code <= 0x2E7F) return true // supplemental punctuation
  if (code >= 0x3000 && code <= 0x303F) return true // CJK punctuation
  if (code >= 0xFE00 && code <= 0xFE0F) return true // variation selectors
  // Fullwidth punctuation, in the three runs around the fullwidth letters —
  // which are strong left-to-right and are not here.
  if (code >= 0xFF01 && code <= 0xFF20) return true
  if (code >= 0xFF3B && code <= 0xFF40) return true
  if (code >= 0xFF5B && code <= 0xFF65) return true
  // U+FEFF is the byte order mark, which says nothing about direction and
  // arrives at the front of a great many plain text parts. It sits just past
  // the end of Arabic presentation forms-B, so a range that reached the end of
  // the block would have read a BOM as a strong Arabic letter — and an English
  // message that carried one would have been laid out right to left.
  if (code === 0xFEFF) return true
  // Emoji and the pictographic symbols beside them. A subject opening with one
  // is the house style of most of the mail anybody receives, and every one of
  // them is Other Neutral: the emoji says nothing about which way the sentence
  // after it runs.
  if (code >= 0x1F000 && code <= 0x1F0FF) return true // mahjong, dominoes, cards
  if (code >= 0x1F1E6 && code <= 0x1F1FF) return true // regional indicators (flags)
  if (code >= 0x1F300 && code <= 0x1FAFF) return true // pictographs and symbols
  return false
}

// The direction a single code point asserts, or UNKNOWN when it asserts none.
//
// The neutral question comes before the range question, and the order is the
// whole of it. A block is a range of code points and a direction class is not:
// the Arabic block holds the Arabic-Indic digits, which are AN and assert
// nothing, so a scan that asked "is this in a right-to-left block?" first
// answered RTL for a digit and never reached the line written to say otherwise.
// That put `١٢٣ hello` on the right and — because `outgoingDirection` reads a
// body by this same rule — grew a `dir="rtl"` HTML twin onto an English message
// whose first character happened to be an Arabic-Indic number.
//
// The marks stay in front of both: an explicit RLM or ALM is the author saying
// outright which way this runs, and U+200F sits inside the neutral punctuation
// range.
function directionOfCode(code) {
  if (code === RIGHT_TO_LEFT_MARK || code === ARABIC_LETTER_MARK) return RTL
  if (code === LEFT_TO_RIGHT_MARK) return LTR
  if (isNeutralCode(code)) return UNKNOWN
  if (isRtlCode(code)) return RTL
  // Everything left is a letter of some script, and every right-to-left script
  // was named above. Falling through to left-to-right rather than listing the
  // hundred that are keeps a newly encoded script — Latin, Cyrillic, Devanagari,
  // Han, or one that does not exist yet — rendering the way it did before.
  return LTR
}

// P2, as far as it goes here: the first strong character wins, an isolate is
// skipped over as a unit, and an embedding or an override answers on its own.
function strongDirectionOf(text) {
  var source = String(text === undefined || text === null ? "" : text)
  var depth = 0

  for (var i = 0; i < source.length; i++) {
    var code = source.charCodeAt(i)

    // A surrogate pair is one character. Reading its halves as two would put
    // an Adlam or Kharoshthi message on the wrong side of the window.
    if (code >= 0xD800 && code <= 0xDBFF && i + 1 < source.length) {
      var low = source.charCodeAt(i + 1)
      if (low >= 0xDC00 && low <= 0xDFFF) {
        code = (code - 0xD800) * 0x400 + (low - 0xDC00) + 0x10000
        i++
      }
    }

    // Inside an isolate the text is deliberately sealed off from the paragraph
    // it sits in, so nothing in it may decide the paragraph's own direction.
    if (code === LEFT_TO_RIGHT_ISOLATE || code === RIGHT_TO_LEFT_ISOLATE
        || code === FIRST_STRONG_ISOLATE) {
      depth++
      continue
    }
    if (code === POP_DIRECTIONAL_ISOLATE) {
      if (depth > 0) depth--
      continue
    }
    if (depth > 0) continue

    // An embedding or an override is the author saying which way this runs
    // rather than leaving it to be worked out.
    if (code === RIGHT_TO_LEFT_EMBEDDING || code === RIGHT_TO_LEFT_OVERRIDE) return RTL
    if (code === LEFT_TO_RIGHT_EMBEDDING || code === LEFT_TO_RIGHT_OVERRIDE) return LTR

    var direction = directionOfCode(code)
    if (direction !== UNKNOWN) return direction
  }
  return UNKNOWN
}

// --------------------------------------------------------------- a subject
//
// What a mail client puts in front of a subject is not part of the subject.
// `Re:` and `Fwd:` are the two that English writes, but a thread crosses
// clients and locales, so a reply from a German Outlook arrives as `AW:` and
// one from a French client as `RE:` or `TR:`. A mailing list adds `[list-name]`
// in front of whatever is already there.
//
// Listed rather than generalised to "any short word before a colon": that rule
// would also eat the `Bug:` off a subject line, and while stripping it happens
// to give the same answer here, a rule that quietly rewrites what it was asked
// about is the wrong shape for something this small.
var REPLY_PREFIX = new RegExp(
  "^[\\s\\u200E\\u200F]*(?:"
    // Re, Fw, Fwd and their translations, with the optional `[2]` or `(3)`
    // count that a client adds when a thread goes round more than once.
    + "(?:re|aw|sv|vs|vl|antw|antwort|fw|fwd|wg|tr|rv|rif|res|enc|encaminhado"
    + "|doorst|odp|ynt|ilt|回复|回覆|转发|轉發)"
    + "\\s*(?:[\\[\\(]\\s*\\d+\\s*[\\]\\)])?\\s*:"
    // A mailing list tag, which carries no direction of its own worth having.
    + "|\\[[^\\]]{0,64}\\]"
    // The parenthesised form some clients use instead of a prefix.
    + "|\\((?:fwd|fw)\\)"
  + ")[\\s\\u200E\\u200F]*", "i")

// Strips every prefix, not just the first: a thread that has been replied to
// and then forwarded arrives as `Fwd: Re: ...`, and one off a list as
// `[team] Re: ...`.
function withoutReplyPrefixes(subject) {
  var text = String(subject === undefined || subject === null ? "" : subject)
  // Bounded rather than `while (true)`: the expression can match empty on a
  // pathological subject, and a body of mail is not the place to find out.
  for (var i = 0; i < 12; i++) {
    var stripped = text.replace(REPLY_PREFIX, "")
    if (stripped === text) break
    text = stripped
  }
  return text
}

// The direction of what a subject actually says.
//
// A subject that is nothing but prefixes — `Re:`, or `Re: 2024` — answers
// UNKNOWN rather than reading the prefix back as the answer. The prefix is
// strong left-to-right and would give `ltr`, which is also what Qt does with
// the unaltered string, so the two render the same; UNKNOWN is the one that
// does not claim the choice was made on the subject's own account.
function subjectDirectionOf(subject) {
  return strongDirectionOf(withoutReplyPrefixes(subject))
}

// ------------------------------------------------------------ the decision
//
// One entry point for the views: hand it the text and the mode, get back what
// to draw. An explicit mode never looks at the text, which is the point of
// having one.
function resolve(text, mode) {
  var chosen = normalizeMode(mode)
  if (chosen === RIGHT_TO_LEFT) return RTL
  if (chosen === LEFT_TO_RIGHT) return LTR
  return strongDirectionOf(text)
}

// The direction the mode names on its own, without reading any text: RTL or
// LTR for a chosen one, UNKNOWN for Auto.
//
// This is what the fields Qt already gets right should be given. A sender's
// name, a recipient list and a one-line snippet all resolve correctly from
// their own first strong character, so on Auto there is nothing to add and the
// view leaves them alone; a chosen direction still has to reach them, because
// choosing one and having half the message ignore it is not a choice.
function forced(mode) {
  var chosen = normalizeMode(mode)
  if (chosen === RIGHT_TO_LEFT) return RTL
  if (chosen === LEFT_TO_RIGHT) return LTR
  return UNKNOWN
}

function resolveSubject(subject, mode) {
  var chosen = normalizeMode(mode)
  if (chosen === RIGHT_TO_LEFT) return RTL
  if (chosen === LEFT_TO_RIGHT) return LTR
  return subjectDirectionOf(subject)
}

// ------------------------------------------------------------------ a body

// The plain reading of a message is not only the sender's words. `Html.js`
// flattens a document by writing `[image 1]` where a picture stood, and a
// remote image is blocked until the reader asks for it — so an HTML newsletter
// that opens with a logo, which is most of them, hands this a string beginning
// with a Latin `i` that omamail wrote itself.
//
// That is the same mistake as reading `Re:` as part of a subject, on the body
// side: a marker this client put there is not the message saying which way it
// runs. It is removed before the question is asked, and only from the front,
// because a marker further in sits after whatever already answered.
var IMAGE_MARKERS = /^(?:\s*\[image(?:\s+\d+)?\])+/

function withoutImageMarkers(text) {
  return String(text === undefined || text === null ? "" : text).replace(IMAGE_MARKERS, "")
}

function resolveBody(text, mode) {
  var chosen = normalizeMode(mode)
  if (chosen === RIGHT_TO_LEFT) return RTL
  if (chosen === LEFT_TO_RIGHT) return LTR
  return strongDirectionOf(withoutImageMarkers(text))
}

// ---------------------------------------------------------- what QML needs
//
// A `Text` whose `horizontalAlignment` is never set follows the direction of
// its own text, which is the behaviour to keep wherever the answer is UNKNOWN.
// These say which edge to use only when there is an answer; the view leaves the
// property alone otherwise rather than asserting Qt's own default back at it.
function alignsRight(direction) {
  return String(direction) === RTL
}

function hasAnswer(direction) {
  return String(direction) === RTL || String(direction) === LTR
}

// ---------------------------------------------------------- what HTML needs
//
// The attribute, ready to be concatenated into a tag. Empty for UNKNOWN, so a
// document with nothing strong in it keeps Qt's per-paragraph resolution rather
// than being pinned to a direction by a wrapper.
function attributeFor(direction) {
  if (!hasAnswer(direction)) return ""
  return " dir=\"" + String(direction) + "\""
}

// Which physical edge a direction starts and ends on. The document stylesheets
// are written in physical properties because that is all Qt's rich text engine
// reads — it has no `margin-inline-start` — so the side has to be chosen when
// the sheet is built rather than left to the renderer.
function startEdge(direction) {
  return alignsRight(direction) ? "right" : "left"
}

function endEdge(direction) {
  return alignsRight(direction) ? "left" : "right"
}
