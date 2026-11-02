import QtQuick
import Quickshell
import Quickshell.Io
import "Themes.js" as Themes

// The installed Omarchy themes, and where each one lives.
//
// A theme is a directory with a colors.toml in it. Omarchy's own
// bin/omarchy-theme-dir prefers the user's copy in ~/.config/omarchy/themes
// over the installed one of the same name; this keeps that rule and offers the
// merged list to the Settings row, and the winning directory to Paint.
//
// Reading the directories rather than asking a program keeps the answer honest
// when OMARCHY_PATH is unset — which it is inside a plugin's environment — and
// avoids handing a settings value to anything that takes options. The scan is
// one `find` with a fixed argv: no shell, no user text in a command string, and
// nothing it can do but list the files asked for. Names are still validated
// before they are used as a path segment, because a directory listing is not
// trusted input either.
QtObject {
  id: root

  // The roots to scan, most specific first. Defaults to Omarchy's own order;
  // tests set it outright.
  property var roots: Themes.themeRoots(Quickshell.env("HOME"), Quickshell.env("OMARCHY_PATH"))

  // Whether a scan has finished at least once, so a caller can tell "no themes"
  // from "not asked yet".
  property bool scanned: false

  property var userThemes: []
  property var systemThemes: []

  // Everything installed, one entry per name, sorted by the name a person
  // reads. `user` says the user's copy won.
  readonly property var installed: Themes.mergeEntries(userThemes, systemThemes)

  // The picker's options: Follow Omarchy first, then every installed theme by
  // display name. A value is the directory name, which is what gets stored.
  readonly property var options: {
    var list = [{ value: Themes.FOLLOW, label: "Follow Omarchy" }]
    var entries = installed
    for (var i = 0; i < entries.length; i++) list.push({ value: entries[i].name, label: entries[i].label })
    return list
  }

  // Where a theme lives, "" when it is not installed.
  function directoryFor(name) {
    var wanted = Themes.normalizeName(name)
    if (wanted === Themes.FOLLOW) return ""
    var entries = installed
    for (var i = 0; i < entries.length; i++) if (entries[i].name === wanted) return entries[i].dir
    return ""
  }

  function labelFor(name) {
    var wanted = Themes.normalizeName(name)
    if (wanted === Themes.FOLLOW) return "Follow Omarchy"
    var entries = installed
    for (var i = 0; i < entries.length; i++) if (entries[i].name === wanted) return entries[i].label
    return Themes.displayName(wanted)
  }

  function scanCommand() {
    var command = ["find"]
    var wanted = []
    for (var i = 0; i < roots.length; i++) {
      var path = String(roots[i] || "")
      // An absolute path that cannot be read as an option. Roots come from the
      // environment or a test, not from a settings file, but find would still
      // read a "-x" as one.
      if (path.charAt(0) !== "/") continue
      wanted.push(path)
    }
    if (wanted.length === 0) return []
    command = command.concat(wanted)
    // themes/<name>/colors.toml, one level under each root: exactly the shape
    // of an Omarchy theme, and nothing deeper.
    return command.concat(["-mindepth", "2", "-maxdepth", "2", "-name", "colors.toml", "-type", "f"])
  }

  // find prints one path per line. Each is a theme: the directory is the path
  // without colors.toml, and its name is the last segment.
  function parse(output) {
    var lines = String(output === undefined || output === null ? "" : output).split("\n")
    var user = []
    var system = []
    var userRoot = roots.length > 0 ? String(roots[0] || "") + "/" : ""
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/^\s+|\s+$/g, "")
      if (line.length <= 11 || line.substring(line.length - 11) !== "colors.toml") continue
      var dir = line.substring(0, line.length - 11).replace(/\/$/, "")
      var slash = dir.lastIndexOf("/")
      var name = slash >= 0 ? dir.substring(slash + 1) : dir
      if (!Themes.validName(name)) continue
      var entry = { name: name, dir: dir }
      if (userRoot !== "" && line.indexOf(userRoot) === 0) user.push(entry)
      else system.push(entry)
    }
    return { user: user, system: system }
  }

  function refresh() {
    var command = scanCommand()
    if (command.length === 0) return
    scan.command = command
    scan.running = false
    scan.running = true
  }

  property Process scan: Process {
    id: scan
    running: false
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var found = root.parse(text)
        root.userThemes = found.user
        root.systemThemes = found.system
        root.scanned = true
      }
    }
  }
}
