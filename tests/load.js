const fs = require("fs")
const path = require("path")
const vm = require("vm")

const ROOT = path.dirname(__dirname)

// The QML JS modules are plain scripts with a `.pragma library` directive that
// only the QML engine understands. Stripping it leaves ordinary JavaScript,
// which runs in a vm context so the tests exercise exactly the file the shell
// loads rather than a copy.
//
// Resolved against lib/, because that is where all of them live: these are the
// files with no QML in them, which is exactly why the tests can reach them
// without a compositor.
function load(relativePath) {
  const source = fs
    .readFileSync(path.join(ROOT, "lib", relativePath), "utf8")
    .replace(/^\.pragma library\s*$/m, "")
  const context = {}
  vm.createContext(context)
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
