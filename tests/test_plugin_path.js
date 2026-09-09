const assert = require("assert")
const { load } = require("./load")

const path = load("PluginPath.js")

// ------------------------------------------------- the manifest decides first
//
// A first-party load still carries __sourceDir and must keep using it.
assert.strictEqual(
  path.resolve({ id: "omamail", __sourceDir: "/usr/share/omarchy/shell/plugins/omamail" },
    "file:///elsewhere/"),
  "/usr/share/omarchy/shell/plugins/omamail")

// The shell deletes the key for a third-party plugin, so an absent key falls
// through to the component's own directory. This is the bug: it used to be "".
assert.strictEqual(
  path.resolve({ id: "omamail" }, "file:///home/me/.config/omarchy/plugins/omamail/"),
  "/home/me/.config/omarchy/plugins/omamail")
assert.strictEqual(path.resolve(null, "file:///plugins/omamail/"), "/plugins/omamail")
assert.strictEqual(path.resolve(undefined, "file:///plugins/omamail/"), "/plugins/omamail")

// An empty field is no answer, not a decision: the component's own URL is used.
// Keying behaviour on delete-versus-blank would make the fix depend on which
// idiom the shell happens to sanitise with.
assert.strictEqual(
  path.resolve({ id: "omamail", __sourceDir: "" }, "file:///plugins/omamail/"), "/plugins/omamail")

// No plugin lives at the filesystem root, and "/" would build "//scripts/…" while
// passing every caller's test for an empty directory.
assert.strictEqual(path.resolve({}, "file:///"), "")
assert.strictEqual(path.resolve({ __sourceDir: "/" }, "file:///plugins/omamail/"), "/plugins/omamail")

// ------------------------------------------------------------ normalisation
//
// Applied to whichever branch answered, so no command is built as "dir//scripts".
assert.strictEqual(path.resolve({ __sourceDir: "/plugins/omamail/" }, ""), "/plugins/omamail")
assert.strictEqual(path.resolve({}, "file:///plugins/omamail/"), "/plugins/omamail")
assert.strictEqual(path.withoutTrailingSlash("/"), "/")
assert.strictEqual(path.withoutTrailingSlash(""), "")

// --------------------------------------------------------------- percent-encoding
//
// Qt leaves "#", "%" and "?" percent-encoded inside a path (it normalises a space
// back out), so a plugin under a directory named with one is not found unless they
// are decoded back. The space case is here because callers other than
// Qt.resolvedUrl may still pass one.
assert.strictEqual(path.pathFromDirUrl("file:///home/a%20b/omamail/"), "/home/a b/omamail/")
assert.strictEqual(path.pathFromDirUrl("file:///home/pct%25dir/"), "/home/pct%dir/")
assert.strictEqual(path.pathFromDirUrl("file:///home/%C3%BCber/"), "/home/über/")
assert.strictEqual(
  path.resolve({}, "file:///home/a%20b/plugins/omamail/"), "/home/a b/plugins/omamail")

// A query or fragment is cut before decoding, so an encoded one in the path
// survives rather than being treated as a delimiter.
assert.strictEqual(path.pathFromDirUrl("file:///home/dir/?v=1"), "/home/dir/")
assert.strictEqual(path.pathFromDirUrl("file:///home/dir/#frag"), "/home/dir/")
assert.strictEqual(path.pathFromDirUrl("file:///home/has%23hash/"), "/home/has#hash/")

// A sequence that is not valid UTF-8 throws; it comes back empty rather than
// taking the whole binding down silently.
assert.strictEqual(path.pathFromDirUrl("file:///home/bad%ZZdir/"), "")
assert.strictEqual(path.pathFromDirUrl("file:///home/bad%E0%A4dir/"), "")

// ------------------------------------------------------------- what is refused
//
// Only file:/// names a path here. file://host/share names another machine, and
// a fixed seven-character strip would silently make it relative.
assert.strictEqual(path.pathFromDirUrl("file://host/share/omamail/"), "")
assert.strictEqual(path.pathFromDirUrl("qrc:/omamail/"), "")
assert.strictEqual(path.pathFromDirUrl("https://example.com/omamail/"), "")
assert.strictEqual(path.pathFromDirUrl(""), "")
assert.strictEqual(path.pathFromDirUrl(null), "")
assert.strictEqual(path.pathFromDirUrl(undefined), "")

// The leading slash of an absolute path survives the scheme strip.
assert.strictEqual(path.pathFromDirUrl("file:///a"), "/a")

// A component URL that cannot be read leaves pluginDir empty, which every
// caller already guards, rather than producing a wrong path.
assert.strictEqual(path.resolve({}, "qrc:/omamail/"), "")

console.log("test_plugin_path.js ok")
