.pragma library

// The app's icons, by name. Each is a Nerd Font glyph from the Material
// Design Icons range the font bundles (`nf-md-*`, U+F0001–U+F1AF0) — the
// same range the Omarchy shell draws its own bar and panel icons from, so
// the window's verbs look like the desktop's. The desktop font is
// JetBrainsMono Nerd Font, which is what makes a character an icon.
//
// A table rather than literals in QML: the choice of glyph is a decision, it
// is testable here, and a view only ever asks for a name. Codepoints are the
// Material Design Icons ones (materialdesignicons.com), which Nerd Fonts
// keep unchanged.
//
// Outline variants throughout, where the set has one: the app's icons were
// stroked drawings before, and the outline glyphs keep that weight next to
// the shell's.
var GLYPHS = {
  reply: 0xF0F20,        // reply-outline
  replyAll: 0xF0F1F,     // reply-all-outline
  forward: 0xF0932,      // share-outline — the mail-forward arrow, not "next"
  archive: 0xF120E,      // archive-outline
  download: 0xF0DA9,     // download-outline — keeping the file, not opening it
  trash: 0xF0A7A,        // trash-can-outline — the can, not the bin
  spam: 0xF0CE6,         // alert-octagon-outline
  unread: 0xF01F0,       // email-outline
  star: 0xF04D2,         // star-outline
  browser: 0xF03CC,      // open-in-new
  refresh: 0xF0450,      // refresh
  send: 0xF048A,         // send — the plane, solid: the outline one hatches at 16px
  sent: 0xF10DD,         // email-send-outline — balanced with the sidebar's outline glyphs
  undo: 0xF054C,         // undo
  menu: 0xF035C,         // menu
  plus: 0xF0415,         // plus
  close: 0xF0156,        // close
  back: 0xF004D,         // arrow-left
  chevronLeft: 0xF0141,  // chevron-left
  chevronRight: 0xF0142, // chevron-right
  chevronDown: 0xF0140,  // chevron-down
  eye: 0xF06D0,          // eye-outline
  eyeOff: 0xF06D1,       // eye-off-outline
  inbox: 0xF1274,        // inbox-outline
  compose: 0xF0EE4,      // email-edit-outline — a draft; New message itself is the plane
  edit: 0xF0CB6,         // pencil-outline
  label: 0xF04FC,        // tag-outline
  mail: 0xF01F0,         // email-outline
  gmail: 0xF02AB,        // gmail — the mark, when not drawn with the accent
  sidebar: 0xF10AA,      // dock-left
  check: 0xF012C,        // check
  attachment: 0xF03E2,   // paperclip
  calendar: 0xF0B66,     // calendar-blank-outline
  video: 0xF0BDC,        // video-outline
  pin: 0xF0931,          // pin-outline
  people: 0xF000F,       // account-multiple-outline
  agent: 0xF167A         // robot-outline — the message agent
}

// The filled form, for the names that have a state to show. A filled star
// says "on" at a glance where a stroked one does not.
var FILLED = {
  star: 0xF04CE          // star
}

var RANGE_FIRST = 0xF0001
var RANGE_LAST = 0xF1AF0

function has(name) {
  return Object.prototype.hasOwnProperty.call(GLYPHS, String(name || ""))
}

// The character to draw, or "" for a name nobody defined — an empty slot is
// visible in a test where a wrong glyph is not.
function glyph(name, filled) {
  var key = String(name || "")
  if (!has(key)) return ""
  var code = filled === true && Object.prototype.hasOwnProperty.call(FILLED, key)
    ? FILLED[key] : GLYPHS[key]
  return String.fromCodePoint(code)
}

function names() {
  return Object.keys(GLYPHS)
}
