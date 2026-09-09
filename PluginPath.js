.pragma library

// Where the plugin's own directory comes from, so that pluginDir + "/scripts/…"
// names a file that is really there.
//
// Omarchy's shell hands a third-party plugin a sanitised manifest:
// publicPluginManifest() deletes the source directory unless the plugin is
// first-party. A pluginDir read from that field alone was empty on every
// ordinary install, so each helper resolved to "/scripts/…" and failed to start
// without raising anything the interface could show.
//
// The answer the engine always has is the component's own URL. Measured on Qt
// 6.11.2, it keeps the symlink a file was loaded through rather than resolving
// it away, so a checkout linked in by make install and a cloned install name the
// directory the same way, and the mailto handler written from it stays valid.
//
// This depends on Service.qml sitting at the plugin root, which is what
// manifest.json names as the service entry point. tests/test_service_source.sh
// holds that invariant, because a nested entry point would make this a wrong
// directory rather than no directory, and a wrong one fails as silently as the
// bug above.

function withoutTrailingSlash(path) {
  var text = String(path === undefined || path === null ? "" : path)
  return text.length > 1 && text.charAt(text.length - 1) === "/"
    ? text.substring(0, text.length - 1) : text
}

// No plugin lives at the filesystem root, and "/" would build "//scripts/…"
// while satisfying every caller's test for an empty directory. An answer that
// cannot be a plugin directory is no answer.
function pluginDirectory(path) {
  var text = withoutTrailingSlash(path)
  return text === "/" ? "" : text
}

// file:/// is the only form that names a path on this machine. file://host/share
// names another one, and stripping a fixed seven characters from that would turn
// it into a relative path instead of refusing it.
function pathFromDirUrl(url) {
  var text = String(url === undefined || url === null ? "" : url)
  if (text.indexOf("file:///") !== 0) return ""
  var path = text.substring(7)
  // A query or fragment would not survive being read as part of the path. Qt
  // does not put one in the URL of a directory, so this only orders the two
  // steps correctly for anything else that calls in.
  var mark = path.search(/[?#]/)
  if (mark >= 0) path = path.substring(0, mark)
  // Qt leaves "#", "%" and "?" percent-encoded inside a path, so a plugin under
  // a directory named with one is not found unless they are decoded back. A
  // malformed sequence throws, which in a property binding would take the whole
  // value down; report no answer instead.
  try {
    return decodeURIComponent(path)
  } catch (e) {
    return ""
  }
}

// componentDirUrl is Qt.resolvedUrl(".") from the file that wants the directory.
// The manifest wins where the shell supplied it, which is every first-party load.
function resolve(manifest, componentDirUrl) {
  var declared = manifest && typeof manifest === "object"
    ? pluginDirectory(manifest.__sourceDir) : ""
  return declared !== "" ? declared : pluginDirectory(pathFromDirUrl(componentDirUrl))
}
