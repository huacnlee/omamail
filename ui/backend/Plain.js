.pragma library

// A value a QML signal handed over, made plain JavaScript again.
//
// Qt 6.12 carries a `var` signal argument through QVariant, so a JavaScript
// array reaches the handler as a sequence object and an object as a reference
// object, with every array and object inside it converted the same way. They
// read like the originals (a length, indices, `map`, `instanceof Array`,
// JSON), but `Array.isArray` says no to a sequence, so each
// `Array.isArray(x) ? x : []` in these libraries reads a list as empty. Qt
// 6.11 handed over the value itself. The backend's `notification` is such a
// signal, and so is every list the app passes from one object to another.
//
// Arrays and sequences come back as arrays, plain and reference objects as
// objects, all the way down. Anything else (a scalar, a function, a Date, a
// QObject, a value type such as a point or a url) is returned as it is. Past
// MAX_DEPTH levels a value is returned uncopied, so a cycle ends.
var MAX_DEPTH = 64

function plain(value) { return copied(value, 0) }

function copied(value, depth) {
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return value
  var out
  if (isList(value)) {
    out = []
    for (var i = 0; i < value.length; i++) out.push(copied(value[i], depth + 1))
    return out
  }
  if (!isRecord(value)) return value
  out = {}
  for (var key in value) out[key] = copied(value[key], depth + 1)
  return out
}

// An array, or a sequence: built on Array.prototype, which is itself an
// array, so this holds for one made in another realm (the node tests) too.
function isList(value) {
  if (Array.isArray(value)) return true
  for (var proto = Object.getPrototypeOf(value); proto !== null; proto = Object.getPrototypeOf(proto))
    if (Array.isArray(proto)) return true
  return false
}

// An object literal, or the reference object Qt 6.12 makes of one. A QObject,
// a Date and a value type carry a tag or a prototype of their own.
//
// The reference object is known only by its tag, which is Qt's internal class
// name: nothing else tells it from a url, which also says `[object Object]`
// and has a prototype of its own, and copying a url key by key would empty
// it. If Qt renames the tag, objects stop being copied, the lists inside them
// arrive as sequences again, and the QML tests for those readers fail; the
// release workflow runs only the node tests, which build their stand-in with
// this tag, so it would not notice.
function isRecord(value) {
  var tag = Object.prototype.toString.call(value)
  if (tag === "[object V4ReferenceObject]") return true
  var proto = Object.getPrototypeOf(value)
  return tag === "[object Object]" && (proto === null || Object.getPrototypeOf(proto) === null)
}
