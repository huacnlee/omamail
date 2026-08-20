const fs = require("fs")
const path = require("path")
const vm = require("vm")

const ROOT = path.dirname(__dirname)

// The QML JS modules are plain scripts with two directives only the QML engine
// understands: `.pragma library`, and `.import "Other.js" as Other` for the one
// resource that is built out of others. Stripping the first and resolving the
// second by hand leaves ordinary JavaScript, which runs in a vm context — so
// the tests exercise exactly the file the shell loads rather than a copy.
//
// Paths are module-relative ("cache/Cache.js"), because the layout groups by
// module rather than by file type and a bare filename would no longer say where
// the thing lives.
const IMPORT_SOURCE = '^\\s*\\.import\\s+"([^"]+)"\\s+as\\s+(\\w+)\\s*$'

function load(relativePath) {
  const file = path.join(ROOT, relativePath)
  const raw = fs.readFileSync(file, "utf8")

  const context = {}
  vm.createContext(context)

  // Every match is collected before any of them is followed. A global regexp
  // carries `lastIndex` between calls, so recursing out of the middle of an
  // exec loop — which is exactly what following an import does — leaves the
  // outer loop reading a position into a string it has never seen.
  const imports = [...raw.matchAll(new RegExp(IMPORT_SOURCE, "gm"))]

  // QML resolves an import against the importing file's own directory.
  for (const [, target, qualifier] of imports) {
    context[qualifier] = load(path.relative(ROOT, path.resolve(path.dirname(file), target)))
  }

  const source = raw
    .replace(/^\.pragma library\s*$/m, "")
    .replace(new RegExp(IMPORT_SOURCE, "gm"), "")

  vm.runInContext(source, context)
  return context
}

module.exports = { load, ROOT }

// Objects built inside the vm context have that realm's prototypes, so
// assert.deepStrictEqual rejects them against literals declared out here.
// Round-tripping through JSON compares the values, which is what the tests
// are actually about.
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function deepEqual(actual, expected, message) {
  if (message === undefined) require("assert").deepStrictEqual(plain(actual), plain(expected))
  else require("assert").deepStrictEqual(plain(actual), plain(expected), message)
}

module.exports.deepEqual = deepEqual
