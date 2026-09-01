const assert = require("assert")
const { load } = require("./load")

const direction = load("message/Direction.js")

// ------------------------------------------------------------ first strong

assert.strictEqual(direction.strongDirectionOf("Hello world"), "ltr")
assert.strictEqual(direction.strongDirectionOf("مرحبا بالعالم"), "rtl")
assert.strictEqual(direction.strongDirectionOf("سلام دنیا"), "rtl", "Persian")
assert.strictEqual(direction.strongDirectionOf("שלום עולם"), "rtl", "Hebrew")
assert.strictEqual(direction.strongDirectionOf("ܫܠܡܐ"), "rtl", "Syriac")
assert.strictEqual(direction.strongDirectionOf("ދިވެހި"), "rtl", "Thaana")

// A neutral run in front of the first letter is skipped, which is the whole
// point of P2: the year, the bullet and the bracket say nothing about which
// way the line runs.
assert.strictEqual(direction.strongDirectionOf("2024 مرحبا"), "rtl", "digits are neutral")
assert.strictEqual(direction.strongDirectionOf("— مرحبا"), "rtl", "dash is neutral")
assert.strictEqual(direction.strongDirectionOf("(!) שלום"), "rtl", "punctuation is neutral")
assert.strictEqual(direction.strongDirectionOf("١٢٣ مرحبا"), "rtl", "Arabic-Indic digits are neutral")
assert.strictEqual(direction.strongDirectionOf("2024 hello"), "ltr")

// The line above cannot fail on the question it names: Arabic follows the
// digits, so "rtl" is the answer whether they were skipped or read as strong
// right-to-left. These can. The Arabic block holds its own digits, and they are
// AN — they assert nothing — so what decides is the Latin word after them.
assert.strictEqual(direction.strongDirectionOf("١٢٣ hello"), "ltr",
  "Arabic-Indic digits are in the Arabic block and still assert nothing")
assert.strictEqual(direction.strongDirectionOf("۲۰۲۴ hello"), "ltr",
  "and so are the extended ones Persian writes")
assert.strictEqual(direction.strongDirectionOf("٢٠٢٤٫٥ hello"), "ltr",
  "with the separators that hold a number together")
assert.strictEqual(direction.strongDirectionOf("١٢٣"), "",
  "a subject that is nothing but Arabic-Indic digits chose no direction")

// A byte order mark says nothing about direction, and sits one code point past
// the end of Arabic presentation forms-B. Outlook and a good many PHP mailers
// put one at the front of a plain text part, so a range that ran to the end of
// the block laid an English message out right to left.
assert.strictEqual(direction.strongDirectionOf("\uFEFFHello world"), "ltr",
  "a byte order mark is not an Arabic letter")
assert.strictEqual(direction.strongDirectionOf("\uFEFFمرحبا"), "rtl")
assert.strictEqual(direction.strongDirectionOf("\uFEFC"), "rtl",
  "and the last character that really is one still is")

// An emoji in front of the subject is how most marketing mail is written, and
// every one of them is Other Neutral: it says nothing about the sentence after
// it. The same goes for the combining marks, the supplemental punctuation and
// the fullwidth punctuation, none of which are letters.
assert.strictEqual(direction.strongDirectionOf("🎉 مرحبا"), "rtl", "an emoji is neutral")
assert.strictEqual(direction.strongDirectionOf("🇸🇦 مرحبا"), "rtl", "so is a flag")
assert.strictEqual(direction.strongDirectionOf("🎉 Hello"), "ltr")
assert.strictEqual(direction.strongDirectionOf("\u0301 مرحبا"), "rtl", "a combining mark is neutral")
assert.strictEqual(direction.strongDirectionOf("\uFF01 مرحبا"), "rtl", "fullwidth punctuation is neutral")
assert.strictEqual(direction.strongDirectionOf("\uFF21bc"), "ltr",
  "but a fullwidth letter is a letter")

// The marks are the exception, and have to stay in front of the neutral check:
// U+200F sits inside the punctuation range, and it is an author saying outright
// which way this runs.
assert.strictEqual(direction.strongDirectionOf("\u200Fhello"), "rtl",
  "a right-to-left mark answers even before a Latin word")
assert.strictEqual(direction.strongDirectionOf("\u200Eمرحبا"), "ltr",
  "and a left-to-right mark answers before an Arabic one")

// Nothing strong at all is not an answer. A caller that treated it as "ltr"
// would pin a `dir` onto a document that has no business carrying one.
assert.strictEqual(direction.strongDirectionOf(""), "")
assert.strictEqual(direction.strongDirectionOf("123 —— !!"), "")
assert.strictEqual(direction.strongDirectionOf(null), "")
assert.strictEqual(direction.strongDirectionOf(undefined), "")

// Scripts with no case of their own are still strong left-to-right.
assert.strictEqual(direction.strongDirectionOf("こんにちは"), "ltr", "Japanese")
assert.strictEqual(direction.strongDirectionOf("你好"), "ltr", "Chinese")
assert.strictEqual(direction.strongDirectionOf("नमस्ते"), "ltr", "Devanagari")
assert.strictEqual(direction.strongDirectionOf("Привет"), "ltr", "Cyrillic")

// Above the BMP the character is a surrogate pair, and reading its halves as
// two BMP characters would answer for a script that is not there.
assert.strictEqual(direction.strongDirectionOf("\u{1E900}"), "rtl", "Adlam")
assert.strictEqual(direction.strongDirectionOf("\u{10A00}"), "rtl", "Kharoshthi")
assert.strictEqual(direction.strongDirectionOf("\u{1D400}"), "ltr", "maths capital A")

// The marks and controls say a direction outright.
assert.strictEqual(direction.strongDirectionOf("‏مرحبا"), "rtl", "RLM")
assert.strictEqual(direction.strongDirectionOf("‎Hello"), "ltr", "LRM")
assert.strictEqual(direction.strongDirectionOf("‫مرحبا"), "rtl", "RLE")
assert.strictEqual(direction.strongDirectionOf("‪Hello"), "ltr", "LRE")

// An isolate is sealed: what is inside it cannot decide the paragraph.
assert.strictEqual(
  direction.strongDirectionOf("⁦مرحبا⁩ hello"), "ltr",
  "an isolated Arabic run does not set the paragraph direction")
assert.strictEqual(
  direction.strongDirectionOf("⁦hello⁩ مرحبا"), "rtl",
  "the first strong character outside the isolate wins")

// ------------------------------------------------------------ the prefixes
//
// The bug this module exists for: every message in a thread after the first
// carries a Latin prefix, so first-strong alone puts the whole thread on the
// wrong edge.

assert.strictEqual(direction.strongDirectionOf("Re: مرحبا"), "ltr", "the bug, unfixed")
assert.strictEqual(direction.subjectDirectionOf("Re: مرحبا"), "rtl", "the bug, fixed")

assert.strictEqual(direction.subjectDirectionOf("Fwd: שלום"), "rtl")
assert.strictEqual(direction.subjectDirectionOf("FW: مرحبا"), "rtl")
assert.strictEqual(direction.subjectDirectionOf("AW: مرحبا"), "rtl", "German reply")
assert.strictEqual(direction.subjectDirectionOf("TR: مرحبا"), "rtl", "French forward")
assert.strictEqual(direction.subjectDirectionOf("SV: שלום"), "rtl", "Swedish reply")
assert.strictEqual(direction.subjectDirectionOf("Re[2]: مرحبا"), "rtl", "a counted reply")
assert.strictEqual(direction.subjectDirectionOf("Re(3): مرحبا"), "rtl")
assert.strictEqual(direction.subjectDirectionOf("(fwd) مرحبا"), "rtl")

// Stacked, which is what a thread that has been round a few times looks like.
assert.strictEqual(direction.subjectDirectionOf("Fwd: Re: مرحبا"), "rtl")
assert.strictEqual(direction.subjectDirectionOf("[team] Re: مرحبا"), "rtl")
assert.strictEqual(direction.subjectDirectionOf("Re: [announce] Fwd: שלום"), "rtl")

// The prefixes do not change an answer that was already right.
assert.strictEqual(direction.subjectDirectionOf("Re: hello there"), "ltr")
assert.strictEqual(direction.subjectDirectionOf("hello there"), "ltr")

// Stripping must not invent an answer where the subject itself is the prefix.
// `ltr` would render the same and would also be defensible; `` is the one that
// does not claim the subject chose it.
assert.strictEqual(direction.subjectDirectionOf("Re:"), "")
assert.strictEqual(direction.subjectDirectionOf("Re: 2024"), "")

// A subject that only looks like a prefix keeps its own direction.
assert.strictEqual(direction.subjectDirectionOf("Retirement مرحبا"), "ltr",
  "`Retirement` is not `Re:`")
assert.strictEqual(direction.subjectDirectionOf("Results: مرحبا"), "ltr",
  "an unlisted word before a colon is part of the subject")

// A subject made only of prefixes terminates rather than looping.
assert.strictEqual(direction.subjectDirectionOf("Re: Re: Re: Re: Re: Re:"), "")

// --------------------------------------------------------------- the modes

assert.strictEqual(direction.normalizeMode("Right to left"), "Right to left")
assert.strictEqual(direction.normalizeMode("Left to right"), "Left to right")
assert.strictEqual(direction.normalizeMode("Auto"), "Auto")
assert.strictEqual(direction.normalizeMode("nonsense"), "Auto", "an unknown mode is Auto")
assert.strictEqual(direction.normalizeMode(null), "Auto")
assert.strictEqual(direction.normalizeMode(undefined), "Auto")
assert.strictEqual(direction.MODE_DEFAULT, "Auto")

// An explicit mode never reads the text. That is what makes it explicit.
assert.strictEqual(direction.resolve("Hello world", "Right to left"), "rtl")
assert.strictEqual(direction.resolve("مرحبا", "Left to right"), "ltr")
assert.strictEqual(direction.resolve("Hello world", "Auto"), "ltr")
assert.strictEqual(direction.resolve("مرحبا", "Auto"), "rtl")
assert.strictEqual(direction.resolve("123", "Auto"), "", "Auto may still have no answer")
assert.strictEqual(direction.resolve("123", "Right to left"), "rtl",
  "a forced mode answers even where the text does not")

// The mode on its own, for the fields Qt already resolves correctly.
assert.strictEqual(direction.forced("Auto"), "", "Auto adds nothing of its own")
assert.strictEqual(direction.forced("Right to left"), "rtl")
assert.strictEqual(direction.forced("Left to right"), "ltr")
assert.strictEqual(direction.forced(null), "")

assert.strictEqual(direction.resolveSubject("Re: مرحبا", "Auto"), "rtl")
assert.strictEqual(direction.resolveSubject("Re: مرحبا", "Left to right"), "ltr")

// ------------------------------------------------------------- the helpers

assert.strictEqual(direction.isRightToLeft("rtl"), true)
assert.strictEqual(direction.isRightToLeft("ltr"), false)
assert.strictEqual(direction.isRightToLeft(""), false)

assert.strictEqual(direction.hasAnswer("rtl"), true)
assert.strictEqual(direction.hasAnswer("ltr"), true)
assert.strictEqual(direction.hasAnswer(""), false)

assert.strictEqual(direction.attributeFor("rtl"), " dir=\"rtl\"")
assert.strictEqual(direction.attributeFor("ltr"), " dir=\"ltr\"")
assert.strictEqual(direction.attributeFor(""), "",
  "no answer puts no attribute in the document")

assert.strictEqual(direction.startEdge("rtl"), "right")
assert.strictEqual(direction.startEdge("ltr"), "left")
assert.strictEqual(direction.startEdge(""), "left")
assert.strictEqual(direction.endEdge("rtl"), "left")
assert.strictEqual(direction.endEdge("ltr"), "right")

// ------------------------------------------------------------------ a body
//
// The plain reading of an HTML message is not only the sender's words: Html.js
// writes `[image 1]` where a picture stood, and a remote image is blocked until
// the reader asks for it — so a newsletter opening with a logo hands this a
// string starting with a Latin "i" that omamail wrote itself.
assert.strictEqual(direction.resolveBody("[image 1]مرحبا بالعالم", "Auto"), "rtl",
  "a marker this client wrote is not the message saying which way it runs")
assert.strictEqual(direction.resolveBody("[image 1][image 2]مرحبا", "Auto"), "rtl")
assert.strictEqual(direction.resolveBody("[image] مرحبا", "Auto"), "rtl",
  "the reader's own bare marker too")
assert.strictEqual(direction.resolveBody("[image 1]Hello", "Auto"), "ltr")
assert.strictEqual(direction.resolveBody("[image 1]", "Auto"), "",
  "a body that is nothing but pictures chose no direction")

// Only from the front. A marker further in sits after whatever already
// answered, so removing it would change nothing and looking for it would cost.
assert.strictEqual(direction.resolveBody("Hello [image 1] مرحبا", "Auto"), "ltr")

// A chosen direction answers before any of this, as it does everywhere.
assert.strictEqual(direction.resolveBody("[image 1]Hello", "Right to left"), "rtl")
assert.strictEqual(direction.resolveBody("مرحبا", "Left to right"), "ltr")

console.log("direction tests passed")
