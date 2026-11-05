.pragma library

// The one-time code in a sign-in message, if it has exactly one.
//
// A verification mail is read for one string and then thrown away, so the
// reader lifts that string out of it and offers it on its own. Everything here
// decides; nothing here copies. The rule is conservative on purpose: a card
// that shows a coupon, an order number or a year as a "code" is worse than no
// card, because the clipboard is the next thing it touches.
//
// A candidate counts only when the words around it say it is a code and none
// of them say it is something else. More than one distinct candidate is not an
// answer: the message is ambiguous and the reader shows nothing.

// The scan stops here. Codes sit at the top of the mail that carries them, and
// this runs on the GUI thread every time a message opens.
var MAX_SCAN = 6000
var MAX_LINE = 400

// Words that name a one-time code. Only these: "security", "login" and
// "token" sit beside addresses, deposits and account numbers in ordinary mail
// as often as beside a code. "code" is matched inside words as well, which is
// how most languages compound it.
var CODE_WORDS = /code|codice|código|\botp\b|passcode|one[- ]?time|verification|\bverify\b|\b2fa\b|\bpin\b|\bkod\b|einmal|コード|验证码|驗證碼|인증/i
// Stronger evidence, needed before a word-like candidate such as AB12CD is
// believed: those collide with booking references, tracking ids and serials.
var STRONG_WORDS = /verification|\bverify\b|one[- ]?time|\botp\b|passcode|\b2fa\b|security code|sign[- ]?in code|log[- ]?in code|login code|access code/i
// Words that say a number in the same sentence is anything but a sign-in code.
var OTHER_WORDS = /promo|coupon|checkout|\bcart\b|\bshop|purchase|discount|voucher|referral|gift|redeem|% ?off|\boff\b|\bsale\b|\bsave\b|offer|\bdeal\b|\border\b(?! to\b)|tracking|shipment|parcel|invoice|receipt|booking|reservation|itinerary|flight|ticket|account (?:number|no)|\bacct\b|routing|iban|postal|\bzip\b|reference|\bref\b|phone (?:number|no)|\btel[:.]|\bfax\b|serial|version|\bv\d/i
// An amount, not a code: "INR 5000", "Rs. 5000", "amount 5000".
var CURRENCY_BEFORE = /(?:\b(?:INR|USD|EUR|GBP|AUD|CAD|JPY|CHF|Rs\.?|RM|amount|total|balance)|[$€£¥₹])\s*$/i
// A code named right before it — "code: 2024", "OTP is 1999" — which is the
// only phrasing that lets a number in the range of years be a code.
var NAMED_BEFORE = /(?:code|\botp\b|passcode|\bpin\b)\s*(?:is\s*)?:?\s*$/i
// Where a sentence ends. A second number after this is not about the code.
var SENTENCE_END = /[.!?](?:\s|$)/

// Leftmost-first, so a G- prefix and a grouped code win over the digits
// inside them. Word boundaries are checked by hand below rather than with a
// lookbehind, which not every engine the reader runs in can be trusted with.
var CANDIDATE = /G-(\d{4,8})|(\d{3})[ -](\d{3})|(\d{4,8})|([A-Z0-9]{6,8})/g

function isWordChar(ch) {
  return /[A-Za-z0-9_]/.test(ch)
}

// Whether what surrounds a match makes it part of something larger: a price,
// a decimal, a date, a time, a phone number, a URL or an identifier.
function boundedBy(text, start, end) {
  var before = start > 0 ? text.charAt(start - 1) : ""
  var after = end < text.length ? text.charAt(end) : ""
  var afterNext = end + 1 < text.length ? text.charAt(end + 1) : ""
  if (before !== "" && (isWordChar(before) || "$€£¥₹#/\\:.,+-@=&?%*'\"".indexOf(before) >= 0))
    return false
  if (after !== "" && (isWordChar(after) || "%$€£¥₹@/\\*".indexOf(after) >= 0)) return false
  if ((after === "." || after === "," || after === ":" || after === "-") && /[0-9A-Za-z]/.test(afterNext))
    return false
  // "0800 123 4567": the first group of a number that goes on.
  if (after === " " && /[0-9]/.test(afterNext)) return false
  return true
}

function lineAround(text, index) {
  var start = text.lastIndexOf("\n", index - 1) + 1
  var end = text.indexOf("\n", index)
  if (end < 0) end = text.length
  return { start: start, end: end }
}

// The part of `value` after its last finished sentence.
function lastSentence(value) {
  var cut = 0
  var re = /[.!?](?:\s|$)/g
  var match
  while ((match = re.exec(value)) !== null) cut = match.index + match[0].length
  return value.substring(cut)
}

// The part of `value` before its first finished sentence.
function firstSentence(value) {
  var match = SENTENCE_END.exec(value)
  return match ? value.substring(0, match.index) : value
}

// The nearest earlier line with something on it, which is where "Your code
// is:" sits when the code is set out on a line of its own.
function previousLine(text, lineStart) {
  var end = lineStart - 1
  while (end > 0) {
    var start = text.lastIndexOf("\n", end - 1) + 1
    var value = text.substring(start, end).trim()
    if (value !== "") return value.length > MAX_LINE ? value.substring(value.length - MAX_LINE) : value
    end = start - 1
  }
  return ""
}

function isYear(digits) {
  if (digits.length !== 4) return false
  var value = Number(digits)
  return value >= 1900 && value <= 2099
}

function candidateFrom(match) {
  if (match[1] !== undefined) return { code: match[1], display: match[1], word: false, year: false }
  if (match[2] !== undefined)
    return { code: match[2] + match[3], display: match[2] + " " + match[3], word: false, year: false }
  if (match[4] !== undefined)
    return { code: match[4], display: match[4], word: false, year: isYear(match[4]) }
  var word = match[5]
  // A word-like code is letters and digits together. All letters is a word,
  // all digits was already a digit match above.
  if (!/[0-9]/.test(word) || !/[A-Z]/.test(word)) return null
  return { code: word, display: word, word: true, year: false }
}

// The sentence a candidate sits in, split at the candidate, and the line above
// it when the candidate stands alone or follows a colon. Evidence is read from
// that sentence only: a second number after a full stop — an expiry time, an
// account number — is not about the code.
function contextFor(text, index, endIndex) {
  var line = lineAround(text, index)
  var before = lastSentence(text.substring(Math.max(line.start, index - 120), index))
  var after = firstSentence(text.substring(endIndex, Math.min(line.end, endIndex + 120)))
  var lineOnly = before.trim() === "" && after.trim() === ""
  return {
    before: before,
    after: after,
    above: lineOnly || /:\s*$/.test(before) ? lastSentence(previousLine(text, line.start).replace(/[.!?\s]+$/, "")) : ""
  }
}

function accepted(candidate, context) {
  var near = context.before + " " + context.above
  var trailing = /^\s*(?:is|est|ist|es|é|è)\b[^.\n]{0,30}(?:code|pin|otp|passcode)/i.test(context.after)
  var words = candidate.word ? STRONG_WORDS : CODE_WORDS
  if (!words.test(near) && !trailing) return false
  if (candidate.year && !NAMED_BEFORE.test(context.before)
      && !(context.before.trim() === "" && NAMED_BEFORE.test(context.above))) return false
  if (CURRENCY_BEFORE.test(context.before)) return false
  if (OTHER_WORDS.test(context.before + " " + context.after)) return false
  if (context.above !== "" && context.before.trim() === "" && OTHER_WORDS.test(context.above)) return false
  return true
}

function searchable(subject, body) {
  var head = String(subject === undefined || subject === null ? "" : subject)
    .replace(/[\r\n]+/g, " ").substring(0, MAX_LINE)
  var text = String(body === undefined || body === null ? "" : body).substring(0, MAX_SCAN)
  return head + "\n\n" + text.replace(/\r\n?/g, "\n").replace(/[   ]/g, " ")
}

// `{code, display}` for the one code in the message, or null. `code` is what
// goes on the clipboard — digits and letters only — and `display` is the same
// value grouped the way the sender grouped it.
function detect(subject, body) {
  var text = searchable(subject, body)
  if (!CODE_WORDS.test(text)) return null
  var found = null
  var re = new RegExp(CANDIDATE.source, "g")
  var match
  while ((match = re.exec(text)) !== null) {
    var start = match.index
    var end = start + match[0].length
    if (!boundedBy(text, start, end)) continue
    var candidate = candidateFrom(match)
    if (!candidate) continue
    if (!accepted(candidate, contextFor(text, start, end))) continue
    if (found && found.code !== candidate.code) return null
    if (!found) found = { code: candidate.code, display: candidate.display }
  }
  return found
}

// Whether a code is safe to hand to the clipboard: the characters `detect`
// produces and nothing else, so a value can never start with a dash and read
// as an option wherever the host passes it on.
function copyable(code) {
  return /^[A-Za-z0-9]{4,8}$/.test(String(code || ""))
}

// Whether a message is recent enough that its code is the one being waited
// for. Codes last minutes; one opened an hour later is being read, not used,
// and copying it then would replace something the owner copied on purpose.
var FRESH_MS = 15 * 60 * 1000
var CLOCK_SKEW_MS = 5 * 60 * 1000

function fresh(date, now) {
  if (date === undefined || date === null || date === "") return false
  var when = new Date(date).getTime()
  var at = Number(now)
  if (!isFinite(when) || !isFinite(at)) return false
  return when <= at + CLOCK_SKEW_MS && at - when <= FRESH_MS
}
