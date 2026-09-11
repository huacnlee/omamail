.pragma library

// What comes back from `secret-tool`, and what it is safe to change about it.
//
// A secret is bytes the user chose and the keyring stored, so the only thing
// this may remove is punctuation the pipe added. `secret-tool lookup` writes
// the value with no trailing newline of its own — which is the bug this exists
// for, because a `SplitParser` splitting on "\n" then never fires at all and a
// stored password reads back as no password at all — but the shells and stores
// around it are not all so careful, and one trailing newline is the shape a
// line-oriented pipe can add.
//
// Exactly one, and only at the end. `trim()` looks like the same thing and is
// not: a password may legitimately begin or end with a space, and a client that
// quietly removed it would authenticate as a different string and report the
// password as wrong, with nothing the user could do about it from the interface.
function fromKeyring(value) {
  var text = String(value === undefined || value === null ? "" : value)
  return text.charAt(text.length - 1) === "\n" ? text.substring(0, text.length - 1) : text
}
